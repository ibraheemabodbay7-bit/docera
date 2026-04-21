import nodemailer from "nodemailer";
import type { User } from "@shared/schema";

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  attachments?: Array<{ name: string; dataUrl: string }>;
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const [header, data] = dataUrl.split(",");
  const mimeType = header.split(":")[1].split(";")[0];
  return { buffer: Buffer.from(data, "base64"), mimeType };
}

export async function sendEmail(user: User, payload: EmailPayload): Promise<void> {
  if (!user.smtpHost || !user.smtpPort) {
    throw new Error("SMTP not configured");
  }

  const transport = nodemailer.createTransport({
    host: user.smtpHost,
    port: user.smtpPort,
    secure: user.smtpPort === 465,
    auth: {
      user: user.username,
      pass: user.smtpPassword ?? user.imapPassword ?? "",
    },
    tls: { rejectUnauthorized: false },
  });

  const attachments = (payload.attachments ?? []).map(att => {
    const { buffer, mimeType } = dataUrlToBuffer(att.dataUrl);
    return { filename: att.name, content: buffer, contentType: mimeType };
  });

  await transport.sendMail({
    from: `"${user.name || user.username}" <${user.username}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.body,
    html: `<p>${payload.body.replace(/\n/g, "<br>")}</p>`,
    attachments,
  });
}
