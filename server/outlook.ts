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

const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function refreshIfNeeded(user: User): Promise<User> {
  const u = user as any;
  if (!u.tokenExpiry) return user;
  const expiry = new Date(u.tokenExpiry).getTime();
  if (expiry > Date.now() + 60 * 1000) return user;
  if (!u.refreshToken) return user;

  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID ?? "",
    client_secret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    refresh_token: u.refreshToken,
    grant_type: "refresh_token",
    scope: "openid email profile Mail.Read Mail.Send offline_access",
  });

  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) return user;

  const data = await res.json();
  const updated = await storage.updateUser(user.id, {
    accessToken: data.access_token ?? u.accessToken,
    refreshToken: data.refresh_token ?? u.refreshToken,
    tokenExpiry: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : u.tokenExpiry,
  } as any);
  return updated ?? user;
}

async function graphGet(accessToken: string, path: string) {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Graph API error: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listInbox(user: User): Promise<EmailThread[]> {
  const refreshed = await refreshIfNeeded(user);
  const token = (refreshed as any).accessToken;
  if (!token) throw new Error("No access token");

  const data = await graphGet(
    token,
    "/me/mailFolders/inbox/messages?$top=30&$select=id,subject,from,bodyPreview,receivedDateTime,hasAttachments,isRead&$orderby=receivedDateTime desc"
  );

  return (data.value ?? []).map((msg: any) => ({
    id: msg.id,
    subject: msg.subject || "(no subject)",
    from: msg.from?.emailAddress?.address ?? "",
    fromName: msg.from?.emailAddress?.name ?? msg.from?.emailAddress?.address ?? "",
    snippet: msg.bodyPreview ?? "",
    date: msg.receivedDateTime,
    hasAttachment: msg.hasAttachments ?? false,
    unread: !msg.isRead,
  }));
}

export async function fetchMessage(user: User, messageId: string): Promise<EmailMessage | null> {
  const refreshed = await refreshIfNeeded(user);
  const token = (refreshed as any).accessToken;
  if (!token) return null;

  const msg = await graphGet(token, `/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,toRecipients,receivedDateTime,body,hasAttachments`);

  let attachments: EmailMessage["attachments"] = [];
  if (msg.hasAttachments) {
    try {
      const attData = await graphGet(token, `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`);
      attachments = (attData.value ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        mimeType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));
    } catch {}
  }

  const isHtml = msg.body?.contentType?.toLowerCase() === "html";

  return {
    id: msg.id,
    from: msg.from?.emailAddress?.address ?? "",
    fromName: msg.from?.emailAddress?.name ?? "",
    to: (msg.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(", "),
    subject: msg.subject || "(no subject)",
    date: msg.receivedDateTime,
    textBody: isHtml ? "" : (msg.body?.content ?? ""),
    htmlBody: isHtml ? (msg.body?.content ?? "") : "",
    attachments,
  };
}

export async function sendOutlook(
  user: User,
  { to, subject, body, attachments }: { to: string; subject: string; body: string; attachments?: Array<{ name: string; dataUrl: string }> }
): Promise<void> {
  const refreshed = await refreshIfNeeded(user);
  const token = (refreshed as any).accessToken;
  if (!token) throw new Error("No access token");

  const message: any = {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: to.split(",").map(addr => ({
      emailAddress: { address: addr.trim() },
    })),
  };

  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map(att => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: att.name,
      contentType: "application/pdf",
      contentBytes: att.dataUrl.split(",")[1] ?? "",
    }));
  }

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) throw new Error(`Failed to send: ${res.status}`);
}
