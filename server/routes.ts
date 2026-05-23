import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { z } from "zod";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { google } from "googleapis";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

// Coerce express param (string | string[]) to string
const sp = (v: string | string[]): string => Array.isArray(v) ? (v[0] ?? "") : v;

// RFC 2047 encode a subject header value so non-ASCII chars are safe in MIME
const encodeSubject = (s: string) =>
  `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

// Quoted-printable encode body text so non-ASCII chars survive MIME transport
function toQuotedPrintable(str: string): string {
  return str.split('').map(char => {
    const code = char.charCodeAt(0);
    if (code > 127) {
      return encodeURIComponent(char).replace(/%/g, '=').toUpperCase();
    }
    return char;
  }).join('');
}

const GMAIL_WEB_CLIENT_ID = process.env.GMAIL_WEB_CLIENT_ID ?? "";
const GMAIL_WEB_CLIENT_SECRET = process.env.GMAIL_WEB_CLIENT_SECRET ?? "";
const GMAIL_RAILWAY_REDIRECT = process.env.GMAIL_REDIRECT_URI ?? "https://docera-production.up.railway.app/api/gmail/callback";

// Temporary in-memory store for OAuth tokens (keyed by random token, TTL 5 min)
const gmailTokenStore = new Map<string, { accessToken: string; refreshToken?: string; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of gmailTokenStore) {
    if (v.expiresAt < now) gmailTokenStore.delete(k);
  }
}, 60_000);

function parseGmailEmail(raw: string): { name: string; email: string } {
  if (!raw) return { name: "", email: "" };
  const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].replace(/['"]/g, "").trim(), email: m[2].trim().toLowerCase() };
  return { name: raw.trim(), email: raw.trim().toLowerCase() };
}

function getGmailHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractGmailAttachments(payload: Record<string, unknown>): Array<{ id: string; name: string; mimeType: string; size: number }> {
  const atts: Array<{ id: string; name: string; mimeType: string; size: number }> = [];
  function walk(p: Record<string, unknown>) {
    const body = p.body as Record<string, unknown> | undefined;
    if (body?.attachmentId && p.filename) {
      atts.push({ id: body.attachmentId as string, name: p.filename as string, mimeType: (p.mimeType as string) ?? "", size: (body.size as number) ?? 0 });
    }
    for (const part of (p.parts as Record<string, unknown>[]) ?? []) walk(part);
  }
  walk(payload);
  return atts;
}

function extractGmailBody(payload: Record<string, unknown>): string {
  if (!payload) return "";
  const mimeType = payload.mimeType as string | undefined;
  const body = payload.body as Record<string, unknown> | undefined;
  if (mimeType === "text/plain" && body?.data) {
    try { return Buffer.from(body.data as string, "base64").toString("utf-8").trim(); } catch { return ""; }
  }
  for (const part of (payload.parts as Record<string, unknown>[]) ?? []) {
    const text = extractGmailBody(part);
    if (text) return text;
  }
  return "";
}

function stripEmailQuotes(body: string): string {
  if (!body) return body;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^On\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d)/.test(trimmed)) {
      const lookahead = lines.slice(i, i + 5).join(" ");
      if (/wrote:/i.test(lookahead)) {
        return lines.slice(0, i).join("\n").trim();
      }
    }
    if (i > 0 && /^\s*>/.test(lines[i])) {
      return lines.slice(0, i).join("\n").trim();
    }
  }
  return body.trim();
}

function makeGmailClient(accessToken: string) {
  const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET);
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!(req.session as any)?.userId) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function getBaseUrl(req: Request): string {
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${host}`;
}

export async function registerRoutes(httpServer: Server, app: Express) {
  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({
        status: 'ok',
        db: 'connected',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        status: 'error',
        db: 'unreachable',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.get('/privacy', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Privacy Policy — Docera</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%),
        radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%),
        radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%),
        #b8c0cc;
      color: #1a1f2a;
      line-height: 1.7;
      font-size: 16px;
      min-height: 100vh;
    }
    header {
      background: rgba(232,236,242,0.82);
      backdrop-filter: blur(30px) saturate(160%);
      -webkit-backdrop-filter: blur(30px) saturate(160%);
      border-bottom: 0.5px solid rgba(255,255,255,0.4);
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .logo {
      font-size: 22px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.02em;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .updated {
      font-size: 13px;
      color: #4a5262;
      margin-bottom: 40px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #1a1f2a;
      margin-top: 36px;
      margin-bottom: 10px;
    }
    h3 {
      font-size: 15px;
      font-weight: 600;
      color: #1a1f2a;
      margin-top: 20px;
      margin-bottom: 8px;
    }
    p { margin-bottom: 14px; color: #2a3040; }
    ul {
      margin: 0 0 14px 20px;
      color: #2a3040;
    }
    ul li { margin-bottom: 6px; }
    a { color: #3a5fa0; }
    code {
      font-family: ui-monospace, monospace;
      font-size: 13px;
      background: rgba(0,0,0,0.06);
      padding: 2px 5px;
      border-radius: 4px;
    }
    hr {
      border: none;
      border-top: 0.5px solid rgba(255,255,255,0.4);
      margin: 40px 0;
    }
    .contact-box {
      background: rgba(255,255,255,0.55);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 0.5px solid rgba(255,255,255,0.4);
      border-radius: 12px;
      padding: 20px 24px;
      margin-top: 12px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.1);
    }
    .contact-box p { margin: 0; }
  </style>
</head>
<body>
  <header>
    <span class="logo">Docera</span>
  </header>
  <div class="container">
    <h1>Privacy Policy — Docera</h1>
    <p><strong>Last updated: May 22, 2026</strong></p>

    <p>This policy explains what Docera does with your data in plain English.</p>

    <h2>Who we are</h2>
    <p>Docera is an iOS app for scanning, organizing, and sharing documents. It's built and operated by Ibrahim Abu Dbay (referred to as "we" or "Docera" below).</p>

    <h2>What data Docera handles</h2>
    <p><strong>On your device (stored locally, never sent to our servers):</strong></p>
    <ul>
      <li>Scanned documents (the PDF or image you create from your camera, plus thumbnails and edit state)</li>
      <li>Photos shared into Docera from other apps (via the iOS share sheet)</li>
      <li>Your filename preferences, theme, and other app settings</li>
      <li>A cached copy of your account info so the app launches fast</li>
    </ul>

    <p><strong>On our servers (PostgreSQL on Railway, EU West):</strong></p>
    <ul>
      <li>An auto-generated account record for your device: a unique ID, an auto-generated username, your display name, and your trial/subscription state</li>
      <li>The session that keeps you signed in</li>
      <li>That's it. We do not store your scanned documents, your Gmail messages, your photos, or your contacts on our servers.</li>
    </ul>

    <p><strong>On your device in Safari/WebKit storage:</strong></p>
    <ul>
      <li>Gmail OAuth tokens (so you don't need to sign in every time)</li>
      <li>Display-name overrides for your contacts</li>
      <li>Your guest device ID</li>
    </ul>

    <h2>What we do with it</h2>
    <p>We use this data to:</p>
    <ul>
      <li>Show you your Gmail inbox inside the app</li>
      <li>Send documents to your contacts on your behalf, via your Gmail account</li>
      <li>Save and organize your scanned documents on your device</li>
      <li>Track your free trial and subscription status</li>
    </ul>
    <p>That's the full list. We don't profile you, build advertising audiences, or sell your data.</p>

    <h2>Third-party services we use</h2>
    <p>Docera relies on three services. Here's what each one sees:</p>

    <h3>Google (Gmail API)</h3>
    <ul>
      <li>What it sees: your Gmail messages (read), the emails you send through the app (write)</li>
      <li>Scopes: <code>gmail.readonly</code> and <code>gmail.send</code></li>
      <li>Docera's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.</li>
      <li>We do not use Gmail data to train AI or machine learning models.</li>
      <li>We do not sell or transfer Gmail data to any third party.</li>
      <li>We only use Gmail data to show your inbox and send emails on your behalf.</li>
    </ul>

    <h3>RevenueCat</h3>
    <ul>
      <li>What it sees: an anonymous identifier their SDK generates, your device platform, your app version, and Apple's purchase receipts when you subscribe or restore purchases</li>
      <li>Why: to verify and manage your subscription</li>
      <li>What's NOT sent: your name, email, or any personally identifying info from our side</li>
    </ul>

    <h3>Apple</h3>
    <ul>
      <li>What it sees: your subscription state, since billing is handled by Apple</li>
      <li>You can view and cancel subscriptions in your Apple ID settings at any time</li>
    </ul>

    <p>That's the complete list. There's no analytics service, no crash reporter, no advertising network, no email delivery provider, no AI service.</p>

    <h2>How authentication works</h2>
    <p>Docera does not have a username/password sign-up. There's no "create account" screen.</p>
    <p>When you first open the app, we automatically create a guest account tied to your device. This account exists on our server only so we can track your trial and subscription state. It has no email, no password, and no personally identifying information.</p>
    <p>If you connect your Gmail account, you grant Docera limited access through Google's standard OAuth flow. You can disconnect at any time from inside the app, and the tokens are deleted from your device.</p>
    <p>We never see or store your Google password.</p>

    <h2>Sharing your data</h2>
    <p>We do not sell your data. We do not rent it. We do not share it with anyone except the three services listed above, and only to the extent needed to provide the features you use.</p>
    <p>We may disclose data if legally required (court order, lawful request) or to protect against fraud or abuse — but this has not happened and we have no agreements requiring it.</p>

    <h2>Deleting your account and data</h2>
    <p>You can delete your Docera account and all associated data directly inside the app:</p>
    <p><strong>Profile → Delete Account → type DELETE → confirm</strong></p>
    <p>When you do this:</p>
    <ul>
      <li>All your documents, folders, clients, and history on our server are permanently deleted (cascade delete in a single transaction)</li>
      <li>All local data on your device is cleared (documents, settings, tokens)</li>
      <li>Your Gmail OAuth grant is revoked via Google's token revocation endpoint, so Docera disappears from your Google account's connected apps list</li>
      <li>Your session is destroyed</li>
    </ul>
    <p>This is immediate and cannot be undone.</p>
    <p><strong>Active subscriptions are handled separately.</strong> Apple manages your subscription. Deleting your Docera account does not cancel your Apple subscription. To cancel, go to Settings → [your name] → Subscriptions on your iPhone.</p>
    <p>If you can't access the app and want your data deleted, email <a href="mailto:ibraheemabodbay7@gmail.com">ibraheemabodbay7@gmail.com</a> and we'll process the request manually.</p>

    <h2>Data we briefly handle (but don't store)</h2>
    <p>Some Gmail data passes through our server in memory only, never written to a database or log:</p>
    <ul>
      <li>Email body text when you open a thread (proxied from Gmail to your device)</li>
      <li>Attachment binaries when you tap one (proxied from Gmail to your device)</li>
      <li>Recipient address and PDF binary when you send a document via Gmail</li>
    </ul>
    <p>These are processed in RAM during a single request and discarded.</p>

    <h2>Where your data lives geographically</h2>
    <ul>
      <li>Our server is hosted on Railway in the EU West region (Netherlands).</li>
      <li>Google processes Gmail data according to Google's own policies and infrastructure.</li>
      <li>RevenueCat processes purchase data on their infrastructure (US-based).</li>
    </ul>

    <h2>Security</h2>
    <ul>
      <li>All connections use HTTPS.</li>
      <li>Gmail authentication uses OAuth 2.0.</li>
      <li>We never see or store your Google account password.</li>
      <li>Session cookies are httpOnly and Secure in production.</li>
      <li>Gmail OAuth tokens are stored in your device's local app storage, not on our servers.</li>
    </ul>
    <p>We're a small operation, so we keep our attack surface minimal — fewer third parties, less data retained, less to go wrong.</p>

    <h2>Children</h2>
    <p>Docera is not intended for users under 13 (or under 16 in the European Union). We do not knowingly collect personal information from minors. If you believe a minor has used Docera, email us and we'll delete their data.</p>

    <h2>Changes to this policy</h2>
    <p>We may update this policy when we add features or change how we handle data. The "Last updated" date at the top will change, and significant changes will be announced inside the app.</p>

    <h2>Contact</h2>
    <p>For questions, requests, or anything privacy-related:</p>
    <p><strong><a href="mailto:ibraheemabodbay7@gmail.com">ibraheemabodbay7@gmail.com</a></strong></p>

    <hr/>
    <p><em>This policy applies only to the Docera iOS app. The Docera website is not currently functional for end users.</em></p>
  </div>
</body>
</html>`);
  });

  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Docera</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%),
        radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%),
        radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%),
        #b8c0cc;
      color: #1a1f2a;
      line-height: 1.7;
      font-size: 16px;
      min-height: 100vh;
    }
    header {
      background: rgba(232,236,242,0.82);
      backdrop-filter: blur(30px) saturate(160%);
      -webkit-backdrop-filter: blur(30px) saturate(160%);
      border-bottom: 0.5px solid rgba(255,255,255,0.4);
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .logo {
      font-size: 22px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.02em;
    }
    a { color: #3a5fa0; }
    .hero {
      text-align: center;
      padding: 80px 24px 56px;
    }
    .hero-title {
      font-size: 52px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.03em;
      line-height: 1.05;
      margin-bottom: 20px;
    }
    .tagline {
      font-size: 20px;
      color: #2a3040;
      max-width: 540px;
      margin: 0 auto 14px;
      line-height: 1.5;
    }
    .subhead {
      font-size: 15px;
      color: #4a5262;
      max-width: 500px;
      margin: 0 auto;
      line-height: 1.65;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 0 24px 80px;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 64px;
    }
    .feature-card {
      background: rgba(255,255,255,0.55);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 0.5px solid rgba(255,255,255,0.4);
      border-radius: 16px;
      padding: 28px 24px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.08);
    }
    .feature-title {
      font-size: 16px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.01em;
      margin-bottom: 8px;
    }
    .feature-body {
      font-size: 14px;
      color: #3a4252;
      line-height: 1.6;
      margin: 0;
    }
    .footer {
      text-align: center;
      padding: 40px 0 0;
      border-top: 0.5px solid rgba(255,255,255,0.4);
    }
    .app-store {
      font-size: 18px;
      font-weight: 600;
      color: #1a1f2a;
      letter-spacing: -0.01em;
      margin-bottom: 20px;
    }
    .footer-links {
      display: flex;
      justify-content: center;
      gap: 24px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .footer-links a { font-size: 14px; }
    .footer-copy {
      font-size: 13px;
      color: #4a5262;
      margin: 0;
    }
  </style>
</head>
<body>
  <header>
    <span class="logo">Docera</span>
  </header>
  <div class="hero">
    <h1 class="hero-title">Docera</h1>
    <p class="tagline">Scan, organise, and send documents from your Gmail inbox.</p>
    <p class="subhead">Built for solo professionals — accountants, lawyers, consultants — who live in their inbox and need a faster way to handle documents.</p>
  </div>
  <div class="container">
    <div class="features">
      <div class="feature-card">
        <p class="feature-title">Scan anywhere</p>
        <p class="feature-body">Capture documents with your iPhone camera. Automatic edge detection, perspective correction, and clean PDF export.</p>
      </div>
      <div class="feature-card">
        <p class="feature-title">Gmail, organised</p>
        <p class="feature-body">View your inbox the way it should be: by client, by thread, by document. Every PDF and photo a client has ever sent, in one place.</p>
      </div>
      <div class="feature-card">
        <p class="feature-title">Send in one tap</p>
        <p class="feature-body">Reply with a scan, share a document, forward an attachment — without leaving the app.</p>
      </div>
    </div>
    <div class="footer">
      <p class="app-store">Coming soon to the App Store</p>
      <div class="footer-links">
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="mailto:ibraheemabodbay7@gmail.com">ibraheemabodbay7@gmail.com</a>
      </div>
      <p class="footer-copy">© 2026 Docera</p>
    </div>
  </div>
</body>
</html>`);
  });

  app.get('/terms', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Terms of Service — Docera</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:
        radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%),
        radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%),
        radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%),
        #b8c0cc;
      color: #1a1f2a;
      line-height: 1.7;
      font-size: 16px;
      min-height: 100vh;
    }
    header {
      background: rgba(232,236,242,0.82);
      backdrop-filter: blur(30px) saturate(160%);
      -webkit-backdrop-filter: blur(30px) saturate(160%);
      border-bottom: 0.5px solid rgba(255,255,255,0.4);
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .logo {
      font-size: 22px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.02em;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    h1 {
      font-size: 32px;
      font-weight: 700;
      color: #1a1f2a;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .updated {
      font-size: 13px;
      color: #4a5262;
      margin-bottom: 40px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #1a1f2a;
      margin-top: 36px;
      margin-bottom: 10px;
    }
    p { margin-bottom: 14px; color: #2a3040; }
    ul {
      margin: 0 0 14px 20px;
      color: #2a3040;
    }
    ul li { margin-bottom: 6px; }
    a { color: #3a5fa0; }
    hr {
      border: none;
      border-top: 0.5px solid rgba(255,255,255,0.4);
      margin: 40px 0;
    }
    .contact-box {
      background: rgba(255,255,255,0.55);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 0.5px solid rgba(255,255,255,0.4);
      border-radius: 12px;
      padding: 20px 24px;
      margin-top: 12px;
      box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.1);
    }
    .contact-box p { margin: 0; }
  </style>
</head>
<body>
  <header>
    <span class="logo">Docera</span>
  </header>
  <div class="container">
    <h1>Terms of Service — Docera</h1>
    <p><strong>Last updated: May 22, 2026</strong></p>

    <p>Welcome to Docera. These terms govern your use of the Docera iOS app ("Docera", "the app"), operated by Ibrahim Abu Dbay ("we", "us", or "our"). By using Docera you agree to these terms.</p>

    <h2>1. Acceptance</h2>
    <p>By installing, opening, or using Docera, you agree to be bound by these Terms of Service and our <a href="/privacy">Privacy Policy</a>. If you do not agree, do not use the app.</p>

    <h2>2. Eligibility</h2>
    <p>You must be at least <strong>13 years old</strong> (or 16 if you are located in the European Union) to use Docera. If you are under the legal age of majority in your country, you confirm that a parent or legal guardian has agreed to these terms on your behalf.</p>
    <p>Docera is intended for adults and older minors who can independently manage their documents. It is not designed for, marketed to, or intended for children under these age thresholds.</p>

    <h2>3. How accounts work</h2>
    <p>Docera does not require you to create a username or password. When you first open the app, a guest account is automatically created and linked to your device. This account tracks your trial and subscription state on our server but contains no personally identifying information unless you choose to enter your name.</p>
    <p>If you connect a Google account to use Gmail features inside Docera, you do so via Google's standard OAuth 2.0 flow. We never see your Google password. You can disconnect at any time inside the app, and we will revoke your tokens.</p>
    <p>You are responsible for the security of the device on which you use Docera, since most of your data is stored locally.</p>

    <h2>4. Acceptable use</h2>
    <p>You agree NOT to use Docera to:</p>
    <ul>
      <li>Violate any applicable law or regulation</li>
      <li>Send spam, harassment, threats, or illegal content</li>
      <li>Access another person's data without authorization</li>
      <li>Reverse engineer, decompile, or otherwise attempt to extract the source code of the app, except to the extent expressly permitted by applicable law</li>
      <li>Interfere with or disrupt our servers or networks</li>
      <li>Use the app in jurisdictions where it is prohibited or subject to trade sanctions</li>
      <li>Misrepresent your identity or impersonate others when sending documents</li>
    </ul>

    <h2>5. Subscriptions and payments</h2>
    <p>Docera offers a free trial period followed by an optional paid subscription. Subscriptions are managed by Apple via the App Store:</p>
    <ul>
      <li>All payments are processed by Apple. We do not see or store your payment information.</li>
      <li>Your subscription renews automatically until cancelled.</li>
      <li>You can view, pause, or cancel your subscription at any time in your Apple ID settings (Settings → [your name] → Subscriptions on your iPhone).</li>
      <li>Subscription fees are non-refundable except where required by law. Refund requests must be made directly to Apple.</li>
      <li>Pricing and features may change over time. Material changes that affect existing subscribers will be communicated before they take effect.</li>
    </ul>
    <p>Cancelling your subscription will not delete your Docera account. To delete your account, see section 11.</p>

    <h2>6. Your content and data</h2>
    <p>Documents you scan, photos you import, and emails you send through Docera remain yours. We do not claim ownership of your content.</p>
    <p>Most of your content stays on your device. Some content briefly passes through our servers in memory only — for example, when you send a document by Gmail, the recipient address and PDF file pass through our server on their way to Google's Gmail API. These items are not stored, logged, or retained by us.</p>
    <p>Emails you send through Docera are sent from your own Gmail account using Google's Gmail API. Once sent, those emails are governed by Google's terms and the recipient's policies, not ours. We do not retain copies of the emails you send.</p>
    <p>For full details on what data we handle and how, see our <a href="/privacy">Privacy Policy</a>.</p>

    <h2>7. Intellectual property</h2>
    <p>The Docera app, brand, design, and code are owned by us and protected by copyright, trademark, and other laws. We grant you a limited, revocable, non-transferable, non-exclusive license to use Docera on devices you own or control, for personal or business use, subject to these terms.</p>
    <p>You may not copy, modify, distribute, sell, or create derivative works of Docera or any part of it without our written permission.</p>

    <h2>8. Third-party services</h2>
    <p>Docera works with a small number of third-party services:</p>
    <ul>
      <li><strong>Google Gmail API</strong> — used to read and send Gmail messages when you connect your Google account</li>
      <li><strong>Apple</strong> — used for in-app subscriptions and platform services</li>
      <li><strong>RevenueCat</strong> — used to verify and manage your subscription status</li>
    </ul>
    <p>Your use of these services is also subject to their own terms and privacy policies:</p>
    <ul>
      <li><a href="https://policies.google.com/terms" target="_blank" rel="noopener">Google Terms of Service</a></li>
      <li><a href="https://www.apple.com/legal/internet-services/itunes/" target="_blank" rel="noopener">Apple Media Services Terms</a></li>
      <li><a href="https://www.revenuecat.com/terms/" target="_blank" rel="noopener">RevenueCat Terms</a></li>
    </ul>
    <p>We are not responsible for the practices or content of these third-party services.</p>

    <h2>9. Disclaimers</h2>
    <p>Docera is provided "as is" and "as available" without warranties of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. We do not guarantee that the app will be uninterrupted, error-free, or that it will meet your specific needs.</p>
    <p>To the maximum extent permitted by law, we disclaim all implied warranties.</p>

    <h2>10. Limitation of liability</h2>
    <p>To the maximum extent permitted by law, our total liability to you for any claim arising out of or relating to these terms or your use of Docera is limited to the greater of: (a) the amount you paid us for the app in the 12 months immediately preceding the claim, or (b) USD $100.</p>
    <p>We will not be liable for indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or goodwill, even if we have been advised of the possibility of such damages.</p>

    <h2>11. Termination and account deletion</h2>
    <p>You can delete your Docera account and all associated data at any time, directly inside the app: <strong>Profile → Delete Account → type DELETE → confirm</strong>. This permanently removes your server-side data, clears local data on your device, and revokes any connected Gmail access.</p>
    <p>We may suspend or terminate your access to Docera if you violate these terms or if we are required to do so by law. We will give reasonable notice where possible.</p>

    <h2>12. Changes to these terms</h2>
    <p>We may update these terms from time to time. The "Last updated" date at the top will change, and significant changes will be communicated inside the app where practical. Continued use of Docera after updates means you accept the new terms.</p>

    <h2>13. Governing law</h2>
    <p>These terms are governed by the laws of the State of Israel, without regard to conflict-of-law principles. Any dispute will be resolved exclusively in the courts of Israel, except where local consumer protection laws give you the right to bring the claim in your home jurisdiction.</p>

    <h2>14. Contact</h2>
    <p>For questions about these terms:</p>
    <p><strong><a href="mailto:ibraheemabodbay7@gmail.com">ibraheemabodbay7@gmail.com</a></strong></p>

    <hr/>
    <p><em>These terms apply only to the Docera iOS app.</em></p>
  </div>
</body>
</html>`);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ── Guest access (shared dev stub — kept for tooling; blocked in production) ─
  app.post("/api/auth/guest", async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Guest access is not available in production" });
    }
    const guestEmail = "guest@dev.local";
    let guest = await storage.getUserByEmail(guestEmail);
    if (!guest) {
      guest = await storage.createUser({
        username: guestEmail,
        name: "Guest",
      });
    }
    (req.session as any).userId = guest.id;
    req.session.save(() =>
      res.json({ id: guest!.id, name: guest!.name, username: guest!.username })
    );
  });

  // ── Device-scoped guest access (testing mode) ─────────────────────────────
  // Each device supplies a persistent random ID stored in localStorage.
  // The server finds-or-creates an isolated account per device so no two
  // guests ever share data.  Works in all environments including production.
  app.post("/api/auth/guest-device", async (req, res) => {
    const schema = z.object({
      deviceId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid device ID" });

    const { deviceId } = parsed.data;
    const guestEmail = `guest_${deviceId}@docera.guest`;

    let user = await storage.getUserByEmail(guestEmail);
    if (!user) {
      user = await storage.createUser({
        username: guestEmail,
        name: "Guest",
      });
    }
    (req.session as any).userId = user.id;
    req.session.save(() =>
      res.json({ id: user!.id, name: user!.name, username: user!.username })
    );
  });

  app.get("/api/auth/me", async (req, res) => {
    if (!(req.session as any)?.userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUser((req.session as any).userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    res.json({ id: user.id, name: user.name, username: user.username, senderName: user.senderName ?? null });
  });

  app.put("/api/auth/profile", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      senderName: z.string().max(100).nullable().optional(),
    }).refine((d) => d.name !== undefined || d.senderName !== undefined, {
      message: "At least one field required",
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    const update: { name?: string; senderName?: string | null } = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.senderName !== undefined) update.senderName = parsed.data.senderName;
    const user = await storage.updateUser((req.session as any).userId!, update);
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ id: user.id, name: user.name, username: user.username, senderName: user.senderName ?? null });
  });

  app.delete("/api/auth/account", requireAuth, async (req, res) => {
    const userId = (req.session as any).userId!;
    const schema = z.object({
      gmailRefreshToken: z.string().optional(),
      gmailAccessToken: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    const tokens = parsed.success ? parsed.data : {};

    try {
      // Cascade delete in correct order to avoid FK violations.
      // Use a transaction so partial deletion can't strand the user.
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM document_events WHERE user_id = ${userId}`);
        await tx.execute(sql`DELETE FROM documents WHERE user_id = ${userId}`);
        await tx.execute(sql`DELETE FROM folders WHERE user_id = ${userId}`);
        await tx.execute(sql`DELETE FROM clients WHERE user_id = ${userId}`);
        await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);
      });

      // Revoke Google OAuth tokens (best effort, do not fail deletion if this errors).
      // Per Google OAuth 2.0 Policy: revoke when no longer needed.
      const tokenToRevoke = tokens.gmailRefreshToken || tokens.gmailAccessToken;
      if (tokenToRevoke) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });
        } catch (revokeErr) {
          console.error("[delete-account] Google token revocation failed:", revokeErr);
          // Do not abort — user data is already deleted on our side
        }
      }

      // Destroy session
      await new Promise<void>((resolve) => {
        req.session.destroy(() => resolve());
      });

      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Account deletion failed";
      console.error("[delete-account]", message);
      res.status(500).json({ error: "deletion_failed", message });
    }
  });

  // ── Subscription / Stripe ─────────────────────────────────────────────────

  app.get("/api/subscription", requireAuth, async (req, res) => {
    if (process.env.BYPASS_SUBSCRIPTION === "true") {
      return res.json({ status: "active", active: true, currentPeriodEnd: null, trialEnd: null, bypassed: true, hasStripeCustomer: false });
    }
    const userId = (req.session as any).userId!;

    // Auto-start 3-day trial on first use if no trial exists yet
    const userBeforeCheck = await storage.getUser(userId);
    if (userBeforeCheck && !userBeforeCheck.trialStartedAt && !userBeforeCheck.isSubscribed && !userBeforeCheck.stripeSubscriptionId) {
      await storage.startTrial(userId);
    }

    const { status, currentPeriodEnd } = await storage.getUserSubscriptionStatus(userId);
    const active = status === "active" || status === "trialing";
    const isTrialing = status === "trialing";
    const trialEnd = (isTrialing || status === "expired") ? currentPeriodEnd : null;
    res.json({ status, active, currentPeriodEnd, trialEnd, hasStripeCustomer: false });
  });

  // ── Native IAP activation (called from client after RevenueCat confirms purchase) ──
  app.post("/api/subscription/native-activate", requireAuth, async (req, res) => {
    const userId = (req.session as any).userId!;
    await storage.setSubscribed(userId, true);
    res.json({ status: "active", active: true });
  });

  // ── Folders ───────────────────────────────────────────────────────────────

  app.get("/api/folders", requireAuth, async (req, res) => {
    const folderList = await storage.getFolders((req.session as any).userId!);
    res.json(folderList);
  });

  app.post("/api/folders", requireAuth, async (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Name required" });
    const folder = await storage.createFolder({ userId: (req.session as any).userId!, name: parsed.data.name });
    res.json(folder);
  });

  app.put("/api/folders/:id", requireAuth, async (req, res) => {
    const schema = z.object({ name: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Name required" });
    const folder = await storage.updateFolder(sp(req.params.id), { name: parsed.data.name });
    if (!folder) return res.status(404).json({ error: "Not found" });
    res.json(folder);
  });

  app.delete("/api/folders/:id", requireAuth, async (req, res) => {
    await storage.deleteFolder(sp(req.params.id));
    res.json({ ok: true });
  });

  // ── Clients ───────────────────────────────────────────────────────────────

  app.get("/api/clients", requireAuth, async (req, res) => {
    const clientList = await storage.getClients((req.session as any).userId!);
    res.json(clientList);
  });

  app.post("/api/clients", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      email: z.string().email().nullable().optional(),
      phone: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const client = await storage.createClient({
      userId: (req.session as any).userId!,
      name: parsed.data.name,
      email: parsed.data.email ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
    });
    res.json(client);
  });

  app.put("/api/clients/:id", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      email: z.string().email().nullable().optional(),
      phone: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const existing = await storage.getClient(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const client = await storage.updateClient(sp(req.params.id), parsed.data);
    if (!client) return res.status(404).json({ error: "Not found" });
    res.json(client);
  });

  app.delete("/api/clients/:id", requireAuth, async (req, res) => {
    const existing = await storage.getClient(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    await storage.deleteClient(sp(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/clients/:id/documents", requireAuth, async (req, res) => {
    const existing = await storage.getClient(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const docs = await storage.getDocumentsByClient(sp(req.params.id), (req.session as any).userId!);
    res.json(docs);
  });

  // ── Documents ─────────────────────────────────────────────────────────────

  app.get("/api/documents", requireAuth, async (req, res) => {
    const { folderId } = req.query;
    const docs = await storage.getDocuments(
      (req.session as any).userId!,
      folderId === "null" ? null : folderId as string | undefined
    );
    res.json(docs);
  });

  app.post("/api/documents", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1),
      type: z.string(),
      dataUrl: z.string(),
      size: z.number(),
      folderId: z.string().nullable().optional(),
      pages: z.string().optional(),
      thumbUrl: z.string().optional(),
      status: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const doc = await storage.createDocument({
      userId: (req.session as any).userId!,
      name: parsed.data.name,
      type: parsed.data.type,
      dataUrl: parsed.data.dataUrl,
      size: parsed.data.size,
      folderId: parsed.data.folderId ?? null,
      pages: parsed.data.pages ?? "[]",
      thumbUrl: parsed.data.thumbUrl ?? "",
      status: parsed.data.status ?? "draft",
    });
    // Auto-create "created" event
    await storage.createDocumentEvent({
      documentId: doc.id,
      userId: (req.session as any).userId!,
      type: "created",
      label: "Document created",
    });
    res.json(doc);
  });

  // Full content update — replaces PDF export + editable pages data
  app.patch("/api/documents/:id", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      dataUrl: z.string().optional(),
      size: z.number().optional(),
      pages: z.string().optional(),
      thumbUrl: z.string().optional(),
      status: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const existing = await storage.getDocument(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const doc = await storage.updateDocumentContent(sp(req.params.id), parsed.data);
    if (!doc) return res.status(404).json({ error: "Not found" });
    // Auto-create "edited" event when content (pages/dataUrl) changes
    if (parsed.data.dataUrl || parsed.data.pages) {
      await storage.createDocumentEvent({
        documentId: doc.id,
        userId: (req.session as any).userId!,
        type: "edited",
        label: "Document edited",
      });
    }
    res.json(doc);
  });

  // Duplicate a document
  app.post("/api/documents/:id/duplicate", requireAuth, async (req, res) => {
    const src = await storage.getDocument(sp(req.params.id));
    if (!src || src.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const newName = src.name.replace(/ \(Copy\)$/, "") + " (Copy)";
    const copy = await storage.duplicateDocument(sp(req.params.id), newName);
    if (!copy) return res.status(500).json({ error: "Failed to duplicate" });
    await storage.createDocumentEvent({
      documentId: copy.id,
      userId: (req.session as any).userId!,
      type: "created",
      label: `Duplicated from "${src.name}"`,
    });
    res.json(copy);
  });

  app.get("/api/documents/:id", requireAuth, async (req, res) => {
    const doc = await storage.getDocument(sp(req.params.id));
    if (!doc || doc.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    res.json(doc);
  });

  app.put("/api/documents/:id", requireAuth, async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).optional(),
      folderId: z.string().nullable().optional(),
      status: z.string().optional(),
      clientId: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      isFavorite: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const existing = await storage.getDocument(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const doc = await storage.updateDocument(sp(req.params.id), parsed.data);
    if (!doc) return res.status(404).json({ error: "Not found" });
    // Auto-create events for rename and status changes
    if (parsed.data.name && parsed.data.name !== existing.name) {
      await storage.createDocumentEvent({
        documentId: doc.id,
        userId: (req.session as any).userId!,
        type: "renamed",
        label: `Renamed to "${parsed.data.name}"`,
      });
    }
    if (parsed.data.status && parsed.data.status !== existing.status) {
      const label = `Status changed to ${parsed.data.status.charAt(0).toUpperCase() + parsed.data.status.slice(1)}`;
      await storage.createDocumentEvent({
        documentId: doc.id,
        userId: (req.session as any).userId!,
        type: "status_changed",
        label,
      });
    }
    if ("clientId" in parsed.data && parsed.data.clientId !== existing.clientId) {
      if (parsed.data.clientId) {
        const client = await storage.getClient(parsed.data.clientId);
        await storage.createDocumentEvent({
          documentId: doc.id,
          userId: (req.session as any).userId!,
          type: "client_assigned",
          label: `Assigned to ${client?.name ?? "client"}`,
        });
      } else {
        await storage.createDocumentEvent({
          documentId: doc.id,
          userId: (req.session as any).userId!,
          type: "client_removed",
          label: "Removed from client",
        });
      }
    }
    res.json(doc);
  });

  app.delete("/api/documents/:id", requireAuth, async (req, res) => {
    const existing = await storage.getDocument(sp(req.params.id));
    if (!existing || existing.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    await storage.deleteDocument(sp(req.params.id));
    res.json({ ok: true });
  });

  // ── Document Events ────────────────────────────────────────────────────────

  app.get("/api/documents/:id/events", requireAuth, async (req, res) => {
    const doc = await storage.getDocument(sp(req.params.id));
    if (!doc || doc.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const events = await storage.getDocumentEvents(sp(req.params.id));
    res.json(events);
  });

  // Manual event (e.g. "exported", "sent", custom note)
  app.post("/api/documents/:id/events", requireAuth, async (req, res) => {
    const schema = z.object({
      type: z.string().min(1),
      label: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const doc = await storage.getDocument(sp(req.params.id));
    if (!doc || doc.userId !== (req.session as any).userId) return res.status(404).json({ error: "Not found" });
    const event = await storage.createDocumentEvent({
      documentId: sp(req.params.id),
      userId: (req.session as any).userId!,
      type: parsed.data.type,
      label: parsed.data.label,
    });
    res.json(event);
  });

  // ── Gmail OAuth: exchange auth code for tokens ────────────────────────────
  app.post("/api/gmail/exchange-token", async (req, res) => {
    const schema = z.object({
      code: z.string().min(1),
      redirectUri: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const { code, redirectUri } = parsed.data;
    const isIosNative = redirectUri.startsWith("com.googleusercontent.apps");

    try {
      if (isIosNative) {
        // iOS native flow — public client, no client_secret
        const params = new URLSearchParams({
          code,
          client_id: process.env.GMAIL_IOS_CLIENT_ID ?? "",
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        });
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; error_description?: string };
        if (!tokenRes.ok) {
          return res.status(500).json({ error: tokens.error_description ?? "Token exchange failed" });
        }
        return res.json({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      } else {
        // Web flow — confidential client with secret
        const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, redirectUri);
        const { tokens } = await oauth2Client.getToken(code);
        return res.json({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Token exchange failed";
      console.error("[gmail/exchange-token]", msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── Gmail OAuth callback: exchanges code, stores token, redirects to app ──
  app.get("/api/gmail/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) return res.status(400).send("Missing code");
    try {
      const oauth2Client = new google.auth.OAuth2(
        GMAIL_WEB_CLIENT_ID,
        GMAIL_WEB_CLIENT_SECRET,
        GMAIL_RAILWAY_REDIRECT,
      );
      const { tokens } = await oauth2Client.getToken(code);
      const accessToken = tokens.access_token;
      if (!accessToken) throw new Error("No access token returned");
      const refreshToken = tokens.refresh_token ?? undefined;
      const key = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      gmailTokenStore.set(key, { accessToken, refreshToken, expiresAt: Date.now() + 5 * 60 * 1000 });
      res.redirect(`com.docera.app://gmail-success?token=${key}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Callback failed";
      console.error("[gmail/callback]", msg);
      res.status(500).send(msg);
    }
  });

  // ── Gmail get-token: retrieve and delete token from store ─────────────────
  app.get("/api/gmail/get-token", (req, res) => {
    const key = req.query.key as string | undefined;
    if (!key) return res.status(400).json({ error: "Missing key" });
    const entry = gmailTokenStore.get(key);
    if (!entry) return res.status(404).json({ error: "Token not found or expired" });
    if (entry.expiresAt < Date.now()) {
      gmailTokenStore.delete(key);
      return res.status(410).json({ error: "Token expired" });
    }
    gmailTokenStore.delete(key);
    res.json({ accessToken: entry.accessToken, refreshToken: entry.refreshToken ?? null });
  });

  // ── Gmail refresh token ───────────────────────────────────────────────────
  app.post("/api/gmail/refresh-token", async (req, res) => {
    const schema = z.object({ refreshToken: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    try {
      const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, GMAIL_RAILWAY_REDIRECT);
      oauth2Client.setCredentials({ refresh_token: parsed.data.refreshToken });
      const { credentials } = await oauth2Client.refreshAccessToken();
      res.json({ accessToken: credentials.access_token });
    } catch (err) {
      res.status(401).json({ error: "refresh_failed" });
    }
  });

  // ── Gmail send: send email with PDF attachment using caller's access token ─
  app.post("/api/gmail/send", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      to: z.string().min(1),
      subject: z.string().min(1),
      message: z.string().optional(),
      pdfBase64: z.string().min(50),
      documentName: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });

    const { accessToken, to, subject, message, pdfBase64, documentName } = parsed.data;
    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET);
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const boundary = `docera_${Date.now()}`;
    const body = message || "Please find the attached document from Docera.";
    const mime = [
      `MIME-Version: 1.0`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      toQuotedPrintable(body),
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${documentName}.pdf"`,
      ``,
      pdfBase64,
      `--${boundary}--`,
    ].join("\r\n");

    try {
      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(mime).toString("base64url") },
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send via Gmail";
      console.error("[gmail/send]", msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── Gmail: list ALL messages grouped by contact ───────────────────────────
  app.post("/api/gmail/messages", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      refreshToken: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, GMAIL_RAILWAY_REDIRECT);
    oauth2Client.setCredentials({
      access_token: parsed.data.accessToken,
      refresh_token: parsed.data.refreshToken ?? undefined,
    });
    if (parsed.data.refreshToken) {
      try { await oauth2Client.refreshAccessToken(); } catch {}
    }
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = profile.data.emailAddress?.toLowerCase() ?? "";

      const [inboxList, sentList] = await Promise.all([
        gmail.users.messages.list({ userId: "me", q: "in:inbox", maxResults: 200 }),
        gmail.users.messages.list({ userId: "me", q: "in:sent", maxResults: 100 }),
      ]);
      const allIds = [
        ...(inboxList.data.messages ?? []).map(m => m.id!),
        ...(sentList.data.messages ?? []).map(m => m.id!),
      ];
      const uniqueIds = [...new Set(allIds)].slice(0, 250);

      const details = await Promise.all(
        uniqueIds.map(id =>
          gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Date", "Subject"] })
            .then(r => r.data).catch(() => null)
        )
      );

      type ContactEntry = {
        email: string; name: string; lastSubject: string; lastDate: string;
        lastMessage: string; messageCount: number; lastDirection: "sent" | "received";
        hasUnread: boolean; hasAttachments: boolean; hasSentMail: boolean;
      };
      const contactMap = new Map<string, ContactEntry>();

      for (const msg of details) {
        if (!msg?.payload?.headers) continue;
        const h = msg.payload.headers as Array<{ name?: string | null; value?: string | null }>;
        const from = parseGmailEmail(getGmailHeader(h, "From"));
        const to = parseGmailEmail(getGmailHeader(h, "To"));
        const date = getGmailHeader(h, "Date");
        const subject = getGmailHeader(h, "Subject");
        const isSent = from.email === myEmail;
        const contact = isSent ? to : from;
        if (!contact.email || contact.email === myEmail) continue;
        const labels = msg.labelIds ?? [];
        const isUnread = labels.includes("UNREAD");
        const hasAtt = labels.includes("HAS_ATTACHMENT");
        const snippet = msg.snippet ?? "";

        const existing = contactMap.get(contact.email);
        const msgTime = new Date(date || 0).getTime();
        if (!existing || msgTime > new Date(existing.lastDate).getTime()) {
          contactMap.set(contact.email, {
            email: contact.email,
            name: contact.name || contact.email,
            lastSubject: subject,
            lastDate: date,
            lastMessage: snippet,
            messageCount: (existing?.messageCount ?? 0) + 1,
            lastDirection: isSent ? "sent" : "received",
            hasUnread: isUnread || (existing?.hasUnread ?? false),
            hasAttachments: hasAtt || (existing?.hasAttachments ?? false),
            hasSentMail: isSent || (existing?.hasSentMail ?? false),
          });
        } else {
          existing.messageCount++;
          if (isUnread) existing.hasUnread = true;
          if (hasAtt) existing.hasAttachments = true;
          if (isSent) existing.hasSentMail = true;
        }
      }

      const contacts = Array.from(contactMap.values())
        .sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime());

      const scoredContacts = contacts.map(c => {
        const emailLower = c.email.toLowerCase();
        const subject = (c.lastSubject ?? '').toLowerCase();
        let isImportant = false;

        if (c.lastDirection === 'sent') isImportant = true;
        if (c.messageCount > 2) isImportant = true;
        if (c.hasAttachments) isImportant = true;

        const promoDomains = ['netflix.com','aliexpress.com','booking.com','amazon.com','amazon.co','ebay.com','spotify.com','facebook.com','instagram.com','twitter.com','linkedin.com','youtube.com','tiktok.com','uber.com','paypal.com','google.com','apple.com','microsoft.com','dropbox.com','zoom.us','shein.com','zara.com','noon.com','talabat.com','careem.com'];
        const automatedPrefixes = ['noreply@','no-reply@','donotreply@','do-not-reply@','notification@','newsletter@','mailer@','postmaster@','alerts@','updates@','news@','promotions@','info@','hello@','team@','support@','marketing@','members@','automated@','system@','bounce@'];

        if (promoDomains.some(d => emailLower.includes(d))) isImportant = false;
        if (automatedPrefixes.some(p => emailLower.includes(p))) isImportant = false;

        const promoKeywords = ['unsubscribe','discount','sale','offer','otp','verify your','confirm your email','password reset','your order','shipping update','delivery','track your','limited time','expires soon','click here'];
        if (promoKeywords.some(k => subject.includes(k)) && c.messageCount <= 1) isImportant = false;

        if (c.hasSentMail) isImportant = true;

        return { ...c, isImportant, score: isImportant ? 10 : 0 };
      });

      res.json({ myEmail, contacts: scoredContacts });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const status = (e?.response as Record<string, unknown>)?.status as number ?? 500;
      const msg = err instanceof Error ? err.message : "Failed";
      console.error("[gmail/messages]", msg);
      res.status(status).json({ error: msg });
    }
  });

  // ── Gmail: messages for a specific contact (all emails, with body text) ───
  app.post("/api/gmail/thread-messages", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      contactEmail: z.string().min(1),
      refreshToken: z.string().optional().nullable(),
      olderThan: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const { accessToken, contactEmail } = parsed.data;
    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, GMAIL_RAILWAY_REDIRECT);
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: parsed.data.refreshToken ?? undefined,
    });
    if (parsed.data.refreshToken) {
      try { await oauth2Client.refreshAccessToken(); } catch {}
    }
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = profile.data.emailAddress?.toLowerCase() ?? "";

      // Phase 1: fetch metadata for up to 100 messages (headers only, fast)
      // Use in:anywhere so SENT messages (not in INBOX) are also returned
      const q = `(from:${contactEmail} OR to:${contactEmail}) in:anywhere`;
      const list = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 100,
      });
      const ids = (list.data.messages ?? []).map(m => m.id!);
      console.log(`[thread-messages] pool size: ${ids.length}`);

      const metaResults: Array<unknown> = [];
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const chunkResults = await Promise.all(
          chunk.map(id => gmail.users.messages.get({
            userId: "me", id,
            format: "metadata",
            metadataHeaders: ["Date", "From", "To", "Subject"],
          }).then(r => r.data).catch(() => null))
        );
        metaResults.push(...chunkResults);
      }

      type MetaMsg = { id: string; date: string; internalDate: number };
      const allMeta: MetaMsg[] = (metaResults as Array<Record<string, unknown> | null>)
        .filter(Boolean)
        .map(msg => {
          const h = ((msg!.payload as Record<string, unknown>)?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;
          const date = getGmailHeader(h, "Date");
          return { id: msg!.id as string, date, internalDate: new Date(date).getTime() };
        })
        .sort((a, b) => a.internalDate - b.internalDate);

      // Phase 2: filter and paginate on metadata
      const limit = 15;
      const olderThanTime = parsed.data.olderThan ? new Date(parsed.data.olderThan).getTime() : null;
      const filtered = olderThanTime
        ? allMeta.filter(m => m.internalDate < olderThanTime)
        : allMeta;

      console.log(`[thread-messages] filtered: ${filtered.length}, hasMore: ${filtered.length > limit}`);

      const hasMore = filtered.length > limit;
      const toFetch = filtered.slice(Math.max(0, filtered.length - limit));

      // Phase 3: fetch full details only for the 15 messages we need
      const fullDetails: Array<unknown> = await Promise.all(
        toFetch.map(m => gmail.users.messages.get({ userId: "me", id: m.id, format: "full" })
          .then(r => r.data).catch(() => null))
      );

      const paginated = (fullDetails as Array<Record<string, unknown> | null>).filter(Boolean).map(msg => {
        const h = ((msg!.payload as Record<string, unknown>)?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;
        const from = parseGmailEmail(getGmailHeader(h, "From"));
        const to = parseGmailEmail(getGmailHeader(h, "To"));
        const date = getGmailHeader(h, "Date");
        const subject = getGmailHeader(h, "Subject");
        const isSent = from.email === myEmail;
        const attachments = extractGmailAttachments(msg!.payload as Record<string, unknown> ?? {});
        const rawBody = extractGmailBody(msg!.payload as Record<string, unknown> ?? {});
        const body = stripEmailQuotes(rawBody.replace(/\s*—\s*Sent via Docera\s*/gi, "").trim());
        return {
          id: msg!.id as string,
          direction: isSent ? "sent" : "received",
          fromName: from.name,
          fromEmail: from.email,
          toEmail: to.email,
          date,
          subject,
          body,
          snippet: (msg!.snippet as string) ?? "",
          attachments,
        };
      }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      res.json({ myEmail, messages: paginated, hasMore, total: filtered.length });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const status = (e?.response as Record<string, unknown>)?.status as number ?? 500;
      const msg = err instanceof Error ? err.message : "Failed";
      console.error("[gmail/thread-messages]", msg);
      res.status(status).json({ error: msg });
    }
  });

  // ── Gmail: /api/gmail/contact-attachments ─────────────────────────────────
  app.post("/api/gmail/contact-attachments", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      contactEmail: z.string().min(1),
      refreshToken: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const { accessToken, contactEmail } = parsed.data;
    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, GMAIL_RAILWAY_REDIRECT);
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: parsed.data.refreshToken ?? undefined,
    });
    if (parsed.data.refreshToken) {
      try { await oauth2Client.refreshAccessToken(); } catch {}
    }
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    try {
      const q = `(from:${contactEmail} OR to:${contactEmail}) in:anywhere has:attachment`;
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 200 });
      const ids = (list.data.messages ?? []).map(m => m.id!);

      const fullDetails: Array<unknown> = [];
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const results = await Promise.all(
          chunk.map(id => gmail.users.messages.get({ userId: "me", id, format: "full" })
            .then(r => r.data).catch(() => null))
        );
        fullDetails.push(...results);
      }

      const attachments: Array<{ id: string; messageId: string; name: string; mimeType: string; size: number; date: string }> = [];
      for (const msg of fullDetails as Array<Record<string, unknown> | null>) {
        if (!msg) continue;
        const h = ((msg.payload as Record<string, unknown>)?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;
        const date = getGmailHeader(h, "Date");
        const atts = extractGmailAttachments(msg.payload as Record<string, unknown> ?? {});
        for (const att of atts) {
          if (!att.mimeType.includes("pdf") && !att.mimeType.startsWith("image/")) continue;
          attachments.push({ ...att, messageId: msg.id as string, date });
        }
      }

      attachments.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      res.json({ attachments });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const status = (e?.response as Record<string, unknown>)?.status as number ?? 500;
      const msg = err instanceof Error ? err.message : "Failed";
      console.error("[gmail/contact-attachments]", msg);
      res.status(status).json({ error: msg });
    }
  });

  // ── Gmail: /api/gmail/thread alias ────────────────────────────────────────
  async function handleGmailThread(req: Request, res: Response) {
    const schema = z.object({ accessToken: z.string().min(1), contactEmail: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const { accessToken, contactEmail } = parsed.data;
    const gmail = makeGmailClient(accessToken);
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = profile.data.emailAddress?.toLowerCase() ?? "";
      const list = await gmail.users.messages.list({ userId: "me", q: `from:${contactEmail} OR to:${contactEmail}`, maxResults: 100 });
      const ids = (list.data.messages ?? []).map((m: { id?: string | null }) => m.id!);
      const details = await Promise.all(ids.map(id => gmail.users.messages.get({ userId: "me", id, format: "full" }).then((r: { data: unknown }) => r.data).catch(() => null)));
      const messages = (details as Array<Record<string, unknown> | null>).filter(Boolean).map(msg => {
        const h = ((msg!.payload as Record<string, unknown>)?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;
        const from = parseGmailEmail(getGmailHeader(h, "From"));
        const to = parseGmailEmail(getGmailHeader(h, "To"));
        const date = getGmailHeader(h, "Date");
        const subject = getGmailHeader(h, "Subject");
        const isSent = from.email === myEmail;
        const payload = (msg!.payload as Record<string, unknown>) ?? {};
        return { id: msg!.id as string, direction: isSent ? "sent" : "received", fromName: from.name, fromEmail: from.email, toEmail: to.email, date, subject, body: stripEmailQuotes(extractGmailBody(payload).replace(/\s*—\s*Sent via Docera\s*/gi, "").trim()), snippet: (msg!.snippet as string) ?? "", attachments: extractGmailAttachments(payload) };
      }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      res.json({ myEmail, messages });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const status = (e?.response as Record<string, unknown>)?.status as number ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Failed" });
    }
  }
  app.post("/api/gmail/thread", handleGmailThread);

  // ── Gmail: fetch attachment data ──────────────────────────────────────────
  app.post("/api/gmail/attachment", async (req, res) => {
    const schema = z.object({ accessToken: z.string().min(1), messageId: z.string().min(1), attachmentId: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const { accessToken, messageId, attachmentId } = parsed.data;
    const gmail = makeGmailClient(accessToken);
    try {
      const att = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
      const base64 = (att.data.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
      res.json({ base64 });
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const status = (e?.response as Record<string, unknown>)?.status as number ?? 500;
      const msg = err instanceof Error ? err.message : "Failed";
      console.error("[gmail/attachment]", msg);
      res.status(status).json({ error: msg });
    }
  });

  // ── Gmail: send message via Gmail API (so it lands in SENT and shows on reload) ──
  app.post("/api/gmail/send-message", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      to: z.string().min(1),
      senderEmail: z.string().optional().default(""),
      body: z.string().default(""),
      subject: z.string().optional(),
      attachmentBase64: z.string().optional(),
      attachmentName: z.string().optional(),
      attachmentMimeType: z.string().optional(),
      refreshToken: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });

    const { accessToken, to, senderEmail, body, attachmentBase64, attachmentName, attachmentMimeType } = parsed.data;
    const subject = parsed.data.subject ?? `New message from ${senderEmail}`;

    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET, GMAIL_RAILWAY_REDIRECT);
    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: parsed.data.refreshToken ?? undefined,
    });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      const myEmail = profile.data.emailAddress?.toLowerCase() ?? senderEmail;

      // Build raw MIME email so it appears in user's Gmail SENT folder
      let rawEmail: string;
      if (attachmentBase64 && attachmentName) {
        const mimeType = attachmentMimeType ?? "application/octet-stream";
        const boundary = `boundary_${Date.now()}`;
        const htmlBody = `<p><strong>${senderEmail}</strong> sent you a document.</p><p style="color:#888;font-size:12px">— Sent via Docera</p>`;
        const textBody = attachmentName ?? "Document";
        rawEmail = [
          `From: ${myEmail}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          ``,
          `--${boundary}`,
          `Content-Type: multipart/alternative; boundary="alt_${boundary}"`,
          ``,
          `--alt_${boundary}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          textBody,
          ``,
          `--alt_${boundary}`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          htmlBody,
          ``,
          `--alt_${boundary}--`,
          ``,
          `--${boundary}`,
          `Content-Type: ${mimeType}`,
          `Content-Disposition: attachment; filename="${attachmentName}"`,
          `Content-Transfer-Encoding: base64`,
          ``,
          attachmentBase64,
          ``,
          `--${boundary}--`,
        ].join('\r\n');
      } else {
        const textBoundary = `boundary_txt_${Date.now()}`;
        const htmlBody = `<p>${body.replace(/\n/g, "<br/>")}</p><p style="color:#888;font-size:12px">— Sent via Docera</p>`;
        rawEmail = [
          `From: ${myEmail}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: multipart/alternative; boundary="${textBoundary}"`,
          ``,
          `--${textBoundary}`,
          `Content-Type: text/plain; charset=utf-8`,
          ``,
          body,
          ``,
          `--${textBoundary}`,
          `Content-Type: text/html; charset=utf-8`,
          ``,
          htmlBody,
          ``,
          `--${textBoundary}--`,
        ].join('\r\n');
      }

      const encodedMessage = Buffer.from(rawEmail).toString('base64url');
      const sent = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
      });

      console.log(`[gmail/send-message] sent via Gmail API, msgId: ${sent.data.id}`);

      res.json({
        ok: true,
        sentMessage: {
          id: sent.data.id ?? `local_${Date.now()}`,
          direction: "sent",
          fromEmail: myEmail,
          fromName: "Me",
          toEmail: to,
          date: new Date().toISOString(),
          subject,
          body: attachmentBase64 && attachmentName ? attachmentName : body,
          snippet: attachmentBase64 && attachmentName ? attachmentName : body.slice(0, 100),
          attachments: attachmentBase64 && attachmentName
            ? [{ id: `att_${sent.data.id}`, name: attachmentName, mimeType: attachmentMimeType ?? "application/octet-stream", size: 0 }]
            : [],
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send";
      console.error("[gmail/send-message]", msg);
      res.status(500).json({ error: msg });
    }
  });

}
