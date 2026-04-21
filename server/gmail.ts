import { google } from "googleapis";
import type { User } from "@shared/schema";
import { storage } from "./storage";

export interface EmailThread {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  snippet: string;
  date: string;
  hasAttachment: boolean;
  unread: boolean;
  messageCount: number;
}

export interface EmailMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{ id: string; name: string; mimeType: string; size: number }>;
}

function getClient(user: User) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  client.setCredentials({
    access_token: user.accessToken ?? undefined,
    refresh_token: user.refreshToken ?? undefined,
    expiry_date: user.tokenExpiry ? new Date(user.tokenExpiry).getTime() : undefined,
  });
  return client;
}

async function refreshIfNeeded(user: User): Promise<User> {
  if (!user.tokenExpiry) return user;
  const expiry = new Date(user.tokenExpiry).getTime();
  if (expiry > Date.now() + 60 * 1000) return user;

  const auth = getClient(user);
  const { credentials } = await auth.refreshAccessToken();
  const updated = await storage.updateUser(user.id, {
    accessToken: credentials.access_token ?? user.accessToken,
    refreshToken: credentials.refresh_token ?? user.refreshToken,
    tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date) : user.tokenExpiry,
  });
  return updated ?? user;
}

function parseHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(from: string): { email: string; name: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].replace(/"/g, "").trim(), email: match[2].trim() };
  return { name: from, email: from };
}

function extractMessageParts(
  payload: any,
  result: { textBody: string; htmlBody: string; attachments: EmailMessage["attachments"] }
) {
  if (!payload) return;
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    if (payload.mimeType === "text/html") result.htmlBody = result.htmlBody || decoded;
    else if (payload.mimeType === "text/plain") result.textBody = result.textBody || decoded;
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data && !result.textBody) {
      result.textBody = Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (part.mimeType === "text/html" && part.body?.data && !result.htmlBody) {
      result.htmlBody = Buffer.from(part.body.data, "base64url").toString("utf-8");
    } else if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      result.attachments.push({
        id: part.body.attachmentId,
        name: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
      });
    }
    if (part.parts) extractMessageParts(part, result);
  }
}

function parseMessageData(msg: any): EmailMessage {
  const headers = msg.payload?.headers ?? [];
  const fromRaw = parseHeader(headers, "From");
  const { name, email } = parseFrom(fromRaw);
  const result = { textBody: "", htmlBody: "", attachments: [] as EmailMessage["attachments"] };
  extractMessageParts(msg.payload, result);
  return {
    id: msg.id!,
    from: email,
    fromName: name,
    to: parseHeader(headers, "To"),
    subject: parseHeader(headers, "Subject") || "(no subject)",
    date: parseHeader(headers, "Date"),
    ...result,
  };
}

export async function listInbox(
  user: User,
  opts: { pageToken?: string; maxResults?: number } = {}
): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const listRes = await gmail.users.threads.list({
    userId: "me",
    maxResults: opts.maxResults ?? 50,
    labelIds: ["INBOX"],
    pageToken: opts.pageToken,
  });

  const threads = listRes.data.threads ?? [];
  const nextPageToken = listRes.data.nextPageToken ?? undefined;

  if (threads.length === 0) return { threads: [], nextPageToken };

  const threadDetails = await Promise.all(
    threads.map(t =>
      gmail.users.threads.get({
        userId: "me",
        id: t.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      })
    )
  );

  const result: EmailThread[] = threadDetails.map(res => {
    const thread = res.data;
    const msgs = thread.messages ?? [];
    const latestMsg = msgs[msgs.length - 1];
    const firstMsg = msgs[0];
    const latestHeaders = latestMsg?.payload?.headers ?? [];
    const firstHeaders = firstMsg?.payload?.headers ?? [];
    const fromRaw = parseHeader(latestHeaders, "From");
    const { name, email } = parseFrom(fromRaw);
    const labelIds = latestMsg?.labelIds ?? [];
    const hasAtt = msgs.some(m =>
      (m.payload?.parts ?? []).some((p: any) => p.filename && p.filename.length > 0)
    );

    return {
      id: thread.id!,
      subject: parseHeader(firstHeaders, "Subject") || "(no subject)",
      from: email,
      fromName: name,
      snippet: latestMsg?.snippet ?? "",
      date: parseHeader(latestHeaders, "Date"),
      hasAttachment: hasAtt,
      unread: labelIds.includes("UNREAD"),
      messageCount: msgs.length,
    };
  });

  return { threads: result, nextPageToken };
}

export async function fetchThread(user: User, threadId: string): Promise<EmailMessage[]> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });

  return (res.data.messages ?? []).map(parseMessageData);
}

export async function fetchSenderMessages(user: User, fromEmail: string): Promise<EmailMessage[]> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const searchRes = await gmail.users.messages.list({
    userId: "me",
    q: `from:${fromEmail}`,
    maxResults: 12,
  });

  const messageIds = searchRes.data.messages ?? [];
  if (messageIds.length === 0) return [];

  const fullMessages = await Promise.all(
    messageIds.map(m =>
      gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "full",
      })
    )
  );

  const parsed = fullMessages
    .filter(r => r.data)
    .map(r => parseMessageData(r.data));

  parsed.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return parsed;
}

export async function fetchMessage(user: User, messageId: string): Promise<EmailMessage | null> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  if (!res.data) return null;
  return parseMessageData(res.data);
}

export async function fetchGmailAttachment(
  user: User,
  messageId: string,
  attachmentId: string
): Promise<{ dataUrl: string; mimeType: string } | null> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  if (!res.data?.data) return null;
  const base64 = res.data.data.replace(/-/g, "+").replace(/_/g, "/");
  return { dataUrl: `data:application/pdf;base64,${base64}`, mimeType: "application/pdf" };
}

export async function sendGmail(
  user: User,
  { to, subject, body, attachments }: { to: string; subject: string; body: string; attachments?: Array<{ name: string; dataUrl: string }> }
): Promise<void> {
  const refreshed = await refreshIfNeeded(user);
  const auth = getClient(refreshed);
  const gmail = google.gmail({ version: "v1", auth });

  const boundary = "boundary_docchat_" + Date.now();
  let raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ];

  for (const att of attachments ?? []) {
    const base64Data = att.dataUrl.split(",")[1] ?? "";
    raw.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${att.name}"`,
      `Content-Disposition: attachment; filename="${att.name}"`,
      `Content-Transfer-Encoding: base64`,
      "",
      base64Data
    );
  }

  raw.push(`--${boundary}--`);

  const message = raw.join("\r\n");
  const encoded = Buffer.from(message).toString("base64url");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw: encoded } });
}
