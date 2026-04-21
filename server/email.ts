import { Resend } from "resend";

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export interface SendDocumentEmailOpts {
  to: string;
  subject?: string;
  message?: string;
  docName: string;
  docType: string;
  dataUrl: string;
  /** Display name shown in the From field, e.g. "Ibrahim via Docera <no-reply@docera.app>" */
  senderDisplayName?: string | null;
}

export async function sendDocumentEmail(opts: SendDocumentEmailOpts): Promise<void> {
  const resend = getResendClient();

  if (!resend) {
    throw new Error(
      "Email is not configured. Add your RESEND_API_KEY in Replit Secrets to enable email sending."
    );
  }

  const systemEmail = process.env.EMAIL_FROM ?? "no-reply@docera.app";
  const displayName = opts.senderDisplayName?.trim()
    ? `${opts.senderDisplayName.trim()} via Docera`
    : "Docera";
  const from = `${displayName} <${systemEmail}>`;

  const ext = opts.docType === "pdf" ? ".pdf" : opts.docType === "png" ? ".png" : ".jpg";
  const filename = opts.docName.endsWith(ext) ? opts.docName : opts.docName + ext;
  const mimeType =
    opts.docType === "pdf"
      ? "application/pdf"
      : opts.docType === "png"
      ? "image/png"
      : "image/jpeg";

  if (!opts.dataUrl || opts.dataUrl.length < 50) {
    throw new Error(
      "This document has no exported file yet — please save or re-export it first."
    );
  }

  // Strip the data-URL header (e.g. "data:application/pdf;base64,") to get the
  // raw base64 payload, then hand it straight to Resend as a base64 string.
  const commaIdx = opts.dataUrl.indexOf(",");
  const base64Content = commaIdx >= 0 ? opts.dataUrl.slice(commaIdx + 1) : opts.dataUrl;

  const senderLabel = opts.senderDisplayName?.trim() ?? null;
  const bodyText = opts.message
    ? `${opts.message}\n\nThe document "${filename}" is attached.\n\n— ${displayName}`
    : `Please find the document "${filename}" attached.\n\n— ${displayName}`;

  const messageParagraph = opts.message
    ? `<p style="margin:0 0 24px 0;color:#444444;font-size:15px;line-height:1.7;">${opts.message.replace(/\n/g, "<br>")}</p>`
    : "";

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#fef7ed;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef7ed;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">

        <!-- Header -->
        <tr>
          <td style="background-color:#113e61;padding:24px 32px;">
            <span style="color:#fef7ed;font-size:22px;font-weight:800;letter-spacing:-0.5px;">Docera</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 20px 0;color:#111111;font-size:16px;line-height:1.6;">Hello,</p>
            ${messageParagraph}
            <p style="margin:0 0 24px 0;color:#444444;font-size:15px;line-height:1.7;">
              ${opts.message ? "The document below is attached to this email." : "Please find the attached document below."}
            </p>

            <!-- Document chip -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
              style="background-color:#f5efe6;border-radius:12px;border:1px solid #e5d9cc;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0 0 2px 0;font-size:11px;color:#888888;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Attached document</p>
                  <p style="margin:0;font-size:15px;color:#113e61;font-weight:700;">${filename}</p>
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0 0;font-size:13px;color:#999999;line-height:1.6;">
              Sent by <strong style="color:#555555;">${senderLabel ? senderLabel + " via Docera" : "Docera"}</strong>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background-color:#f5efe6;padding:16px 32px;border-top:1px solid #e5d9cc;">
            <p style="margin:0;color:#aaaaaa;font-size:12px;text-align:center;">Docera · Document management made simple</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const subject = opts.subject?.trim() || `Document from Docera – ${opts.docName}`;

  const result = await resend.emails.send({
    from,
    to: [opts.to],
    subject,
    text: bodyText,
    html: htmlBody,
    attachments: [
      {
        filename,
        content: base64Content,
        content_type: mimeType,
      },
    ],
  });

  if (result.error) {
    throw new Error(result.error.message ?? "Failed to send email via Resend");
  }
}
