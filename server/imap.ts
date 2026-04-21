import { ImapFlow } from "imapflow";
import type { User } from "@shared/schema";

export interface EmailThread {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  snippet: string;
  date: Date;
  hasAttachment: boolean;
  unread: boolean;
}

export interface EmailMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: Date;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
}

function getImapSettings(user: User): { host: string; port: number; useSSL: boolean; pass: string } {
  return {
    host: user.imapHost ?? autoDetectHost(user.username, "imap"),
    port: user.imapPort ?? 993,
    useSSL: user.imapUseSSL ?? true,
    pass: user.imapPassword ?? "",
  };
}

export function autoDetectHost(email: string, type: "imap" | "smtp"): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const presets: Record<string, { imap: string; smtp: string; imapPort: number; smtpPort: number }> = {
    "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com", imapPort: 993, smtpPort: 587 },
    "googlemail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com", imapPort: 993, smtpPort: 587 },
    "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com", imapPort: 993, smtpPort: 587 },
    "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com", imapPort: 993, smtpPort: 587 },
    "live.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com", imapPort: 993, smtpPort: 587 },
    "yahoo.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", imapPort: 993, smtpPort: 465 },
    "ymail.com": { imap: "imap.mail.yahoo.com", smtp: "smtp.mail.yahoo.com", imapPort: 993, smtpPort: 465 },
    "icloud.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", imapPort: 993, smtpPort: 587 },
    "me.com": { imap: "imap.mail.me.com", smtp: "smtp.mail.me.com", imapPort: 993, smtpPort: 587 },
    "proton.me": { imap: "127.0.0.1", smtp: "127.0.0.1", imapPort: 1143, smtpPort: 1025 },
    "protonmail.com": { imap: "127.0.0.1", smtp: "127.0.0.1", imapPort: 1143, smtpPort: 1025 },
  };
  const preset = presets[domain];
  if (preset) return preset[type];
  return type === "imap" ? `imap.${domain}` : `smtp.${domain}`;
}

export function autoDetectPorts(email: string): { imapPort: number; smtpPort: number; imapSSL: boolean } {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (["yahoo.com", "ymail.com"].includes(domain)) return { imapPort: 993, smtpPort: 465, imapSSL: true };
  return { imapPort: 993, smtpPort: 587, imapSSL: true };
}

export function getEmailProvider(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (["gmail.com", "googlemail.com"].includes(domain)) return "Gmail";
  if (["outlook.com", "hotmail.com", "live.com"].includes(domain)) return "Outlook";
  if (["yahoo.com", "ymail.com"].includes(domain)) return "Yahoo Mail";
  if (["icloud.com", "me.com"].includes(domain)) return "iCloud Mail";
  return "Email";
}

async function createClient(user: User) {
  const settings = getImapSettings(user);
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.useSSL,
    auth: { user: user.username, pass: settings.pass },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

export async function listInbox(user: User, limit = 30): Promise<EmailThread[]> {
  const client = await createClient(user);
  const threads: EmailThread[] = [];
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const total = client.mailbox?.exists ?? 0;
      if (total === 0) return [];
      const start = Math.max(1, total - limit + 1);
      const messages = client.fetch(`${start}:*`, {
        uid: true, flags: true, envelope: true, bodyStructure: true,
        bodyParts: ["TEXT"],
      });
      for await (const msg of messages) {
        const env = msg.envelope;
        const from = env?.from?.[0];
        const hasAttachment = hasAttachmentInStructure(msg.bodyStructure);
        threads.push({
          id: String(msg.uid),
          subject: env?.subject ?? "(no subject)",
          from: from?.address ?? "",
          fromName: from?.name || from?.address?.split("@")[0] || "Unknown",
          snippet: extractTextSnippet(msg),
          date: env?.date ?? new Date(),
          hasAttachment,
          unread: !msg.flags?.has("\\Seen"),
        });
      }
      threads.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return threads;
}

export async function fetchMessage(user: User, uid: string): Promise<EmailMessage | null> {
  const client = await createClient(user);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      let result: EmailMessage | null = null;
      const messages = client.fetch(uid, {
        uid: true, flags: true, envelope: true, bodyStructure: true,
        source: true,
      }, { uid: true });
      for await (const msg of messages) {
        const env = msg.envelope;
        const from = env?.from?.[0];
        const to = env?.to?.[0];
        const attachments = extractAttachments(msg.bodyStructure, uid);
        const source = msg.source?.toString() ?? "";
        const { text, html } = parseEmailSource(source);
        result = {
          id: uid,
          from: from?.address ?? "",
          fromName: from?.name || from?.address?.split("@")[0] || "Unknown",
          to: to?.address ?? "",
          subject: env?.subject ?? "(no subject)",
          date: env?.date ?? new Date(),
          textBody: text,
          htmlBody: html,
          attachments,
        };
      }
      return result;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

function hasAttachmentInStructure(struct: any): boolean {
  if (!struct) return false;
  if (struct.disposition === "attachment") return true;
  if (Array.isArray(struct.childNodes)) {
    return struct.childNodes.some(hasAttachmentInStructure);
  }
  return false;
}

function extractTextSnippet(msg: any): string {
  try {
    const bodyText = msg.bodyParts?.get("text") ?? msg.bodyParts?.get("TEXT");
    if (bodyText) return bodyText.toString().slice(0, 120).replace(/\s+/g, " ").trim();
  } catch {}
  return "";
}

function extractAttachments(struct: any, uid: string, parts: any[] = [], partNum = ""): any[] {
  if (!struct) return parts;
  if (struct.disposition === "attachment" || (struct.type === "application" && struct.subtype === "octet-stream")) {
    parts.push({
      id: `${uid}-${partNum || struct.part || parts.length}`,
      name: struct.dispositionParameters?.filename ?? struct.parameters?.name ?? "attachment",
      mimeType: `${struct.type}/${struct.subtype}`,
      size: struct.size ?? 0,
    });
  }
  if (Array.isArray(struct.childNodes)) {
    struct.childNodes.forEach((child: any, i: number) => extractAttachments(child, uid, parts, `${partNum}${i + 1}`));
  }
  return parts;
}

function parseEmailSource(source: string): { text: string; html: string } {
  let text = "";
  let html = "";
  try {
    const boundary = source.match(/boundary="?([^"\r\n;]+)"?/i)?.[1];
    if (boundary) {
      const parts = source.split(`--${boundary}`);
      for (const part of parts) {
        if (part.includes("Content-Type: text/plain")) {
          const body = part.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
          text = decodeEmailBody(body, part.includes("base64") ? "base64" : "quoted-printable");
        } else if (part.includes("Content-Type: text/html")) {
          const body = part.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
          html = decodeEmailBody(body, part.includes("base64") ? "base64" : "quoted-printable");
        }
      }
    } else {
      const bodyPart = source.split(/\r?\n\r?\n/).slice(1).join("\n").trim();
      if (source.includes("Content-Type: text/html")) {
        html = bodyPart;
      } else {
        text = bodyPart;
      }
    }
  } catch {
    text = source.slice(0, 2000);
  }
  return { text: text.slice(0, 5000), html: html.slice(0, 20000) };
}

function decodeEmailBody(body: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch { return body; }
  }
  return body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch { return ""; }
  });
}
