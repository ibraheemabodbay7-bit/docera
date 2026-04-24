import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { z } from "zod";
import bcrypt from "bcrypt";
import { getUncachableStripeClient } from "./stripeClient";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { sendDocumentEmail } from "./email";
import { Resend } from "resend";
import { google } from "googleapis";

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

// Coerce express param (string | string[]) to string
const sp = (v: string | string[]): string => Array.isArray(v) ? (v[0] ?? "") : v;

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
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
      background: #ffffff;
      color: #1a1a1a;
      line-height: 1.7;
      font-size: 16px;
    }
    header {
      background: #113e61;
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header .logo {
      font-size: 22px;
      font-weight: 700;
      color: #ffffff;
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
      color: #113e61;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }
    .updated {
      font-size: 13px;
      color: #888;
      margin-bottom: 40px;
    }
    h2 {
      font-size: 18px;
      font-weight: 600;
      color: #113e61;
      margin-top: 36px;
      margin-bottom: 10px;
    }
    p { margin-bottom: 14px; color: #333; }
    ul {
      margin: 0 0 14px 20px;
      color: #333;
    }
    ul li { margin-bottom: 6px; }
    a { color: #113e61; }
    hr {
      border: none;
      border-top: 1px solid #e8e8e8;
      margin: 40px 0;
    }
    .contact-box {
      background: #f5f8fb;
      border: 1px solid #d6e4ef;
      border-radius: 10px;
      padding: 20px 24px;
      margin-top: 12px;
    }
    .contact-box p { margin: 0; }
  </style>
</head>
<body>
  <header>
    <span class="logo">Docera</span>
  </header>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: April 2026</p>

    <p>Docera ("we", "our", or "us") is committed to protecting your privacy. This policy explains what information we collect, how we use it, and your rights regarding your data.</p>

    <h2>1. Data We Collect</h2>
    <p>When you use Docera, we may access or process the following types of data:</p>
    <ul>
      <li><strong>Email messages</strong> — subject lines, sender/recipient addresses, and body content from your Gmail inbox, used to organise your communications.</li>
      <li><strong>PDF files and documents</strong> — files you scan, import, or send through the app.</li>
      <li><strong>Photos</strong> — images captured via your device camera for document scanning, or retrieved from Gmail attachments.</li>
      <li><strong>Account information</strong> — your name and email address when you create a Docera account.</li>
    </ul>

    <h2>2. How We Use Your Data</h2>
    <ul>
      <li>Organising and displaying your Gmail emails and threads in the app.</li>
      <li>Sending documents and files to your clients on your behalf.</li>
      <li>Classifying emails using AI to surface relevant messages.</li>
      <li>Storing documents locally on your device for offline access.</li>
    </ul>

    <h2>3. Gmail Data Usage</h2>
    <p>Docera uses the Google Gmail API to:</p>
    <ul>
      <li><strong>Read emails</strong> — to display your inbox and conversation threads inside the app.</li>
      <li><strong>Send emails on your behalf</strong> — when you compose or forward documents to clients.</li>
    </ul>
    <p>Docera's use of Gmail data complies with the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements. We do not use Gmail data to serve advertising, and we do not share Gmail data with third parties except as described in this policy.</p>

    <h2>4. Data Storage</h2>
    <p>Docera is designed with a <strong>local-first</strong> architecture:</p>
    <ul>
      <li>Your emails and documents are stored <strong>locally on your device</strong> using IndexedDB.</li>
      <li>We do <strong>not</strong> store your email content or documents on our servers.</li>
      <li>Authentication tokens required to access Gmail are stored securely on your device and used only to communicate with Google's APIs on your behalf.</li>
    </ul>

    <h2>5. Third-Party Services</h2>
    <ul>
      <li><strong>Google Gmail API</strong> — used to read and send emails. Subject to <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google's Privacy Policy</a>.</li>
      <li><strong>OpenAI</strong> — used for AI-powered email classification and organisation. Only minimal, non-identifying metadata may be sent. Subject to <a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener">OpenAI's Privacy Policy</a>.</li>
      <li><strong>RevenueCat</strong> — used to manage in-app subscriptions. Subject to <a href="https://www.revenuecat.com/privacy" target="_blank" rel="noopener">RevenueCat's Privacy Policy</a>.</li>
    </ul>

    <h2>6. Data Sharing</h2>
    <p>We do not sell, rent, or share your personal data with third parties for marketing purposes. Data is only shared with the third-party services listed above, and only to the extent necessary to provide the app's functionality.</p>

    <h2>7. Data Retention & Deletion</h2>
    <p>Because email and document data is stored locally on your device, you can delete it at any time by removing the app. If you delete your Docera account, any server-side account data (name, email address) is permanently deleted.</p>

    <h2>8. Security</h2>
    <p>We use industry-standard practices to protect your data, including secure HTTPS connections and OAuth 2.0 for Gmail authentication. We never store your Google account password.</p>

    <h2>9. Children's Privacy</h2>
    <p>Docera is not directed at children under 13. We do not knowingly collect personal information from children under 13.</p>

    <h2>10. Changes to This Policy</h2>
    <p>We may update this privacy policy from time to time. We will notify you of significant changes by updating the "Last updated" date at the top of this page.</p>

    <hr/>

    <h2>Contact Us</h2>
    <div class="contact-box">
      <p>If you have any questions or concerns about this privacy policy, please contact us at:<br/>
      <strong><a href="mailto:privacy@docera.app">privacy@docera.app</a></strong></p>
    </div>
  </div>
</body>
</html>`);
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  app.post("/api/auth/signup", async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      name: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const { email, password, name } = parsed.data;
    const existing = await storage.getUserByEmail(email);
    if (existing) return res.status(409).json({ error: "Email already registered" });
    const user = await storage.createUser({ username: email, password, name });
    (req.session as any).userId = user.id;
    req.session.save(() => res.json({ id: user.id, name: user.name, username: user.username }));
  });

  app.post("/api/auth/login", async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });
    const { email, password } = parsed.data;
    const user = await storage.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    const valid = await bcrypt.compare(password, user.password!);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    (req.session as any).userId = user.id;
    req.session.save(() => res.json({ id: user.id, name: user.name, username: user.username }));
  });

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
        password: "guest-dev-only-not-a-real-password",
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
        password: `guest-device-${deviceId}-no-real-password`,
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

    // Auto-recovery: if user has a Stripe customer but no subscription ID stored,
    // look one up live. This handles missed webhooks and interrupted sync calls.
    if (userBeforeCheck?.stripeCustomerId && !userBeforeCheck.stripeSubscriptionId) {
      try {
        const stripe = await getUncachableStripeClient();
        const subs = await stripe.subscriptions.list({
          customer: userBeforeCheck.stripeCustomerId,
          status: "all",
          limit: 5,
        });
        const activeSub = subs.data.find((s) => s.status === "active" || s.status === "trialing");
        if (activeSub) {
          await storage.updateUserStripeInfo(userId, { stripeSubscriptionId: activeSub.id });
          await storage.setSubscribed(userId, false);
        }
      } catch {
        // Non-fatal — fall through with existing data
      }
    }

    const user = await storage.getUser(userId);
    const { status, currentPeriodEnd } = await storage.getUserSubscriptionStatus(userId);
    const active = status === "active" || status === "trialing";
    const isTrialing = status === "trialing";
    const trialEnd = (isTrialing || status === "expired") ? currentPeriodEnd : null;
    const hasStripeCustomer = !!(user?.stripeCustomerId);
    res.json({ status, active, currentPeriodEnd, trialEnd, hasStripeCustomer });
  });

  // ── Native IAP activation (called from client after RevenueCat confirms purchase) ──
  app.post("/api/subscription/native-activate", requireAuth, async (req, res) => {
    const userId = (req.session as any).userId!;
    await storage.setSubscribed(userId, true);
    res.json({ status: "active", active: true });
  });

  app.get("/api/stripe/plans", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring
        FROM stripe.products p
        JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        WHERE p.active = true
        ORDER BY pr.unit_amount ASC
      `);
      res.json({ plans: result.rows });
    } catch {
      res.json({ plans: [] });
    }
  });

  app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
    // Accept optional priceId override; default to env var
    const schema = z.object({ priceId: z.string().optional() });
    const parsed = schema.safeParse(req.body);
    const priceId = parsed.data?.priceId ?? process.env.STRIPE_PRICE_ID;
    if (!priceId) return res.status(500).json({ error: "No price configured. Set STRIPE_PRICE_ID." });

    const user = await storage.getUser((req.session as any).userId!);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    try {
      const stripe = await getUncachableStripeClient();
      const base = getBaseUrl(req);

      let customerId = user.stripeCustomerId ?? undefined;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.username,
          name: user.name,
          metadata: { userId: user.id },
        });
        await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customer.id });
        customerId = customer.id;
      }

      // Check whether this user has already had a trial to avoid re-granting
      const existingSub = await storage.getUserSubscriptionStatus(user.id);
      const hasHadTrial = existingSub.status !== "none";

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: "subscription",
        success_url: `${base}/?checkout=success`,
        cancel_url: `${base}/?checkout=cancel`,
        subscription_data: {
          metadata: { userId: user.id },
          // Grant a 7-day free trial only to brand-new subscribers
          ...(hasHadTrial ? {} : { trial_period_days: 7 }),
        },
      });

      res.json({ url: session.url });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[stripe] checkout error:", message);
      res.status(500).json({ error: "checkout_failed", message: `Could not start checkout: ${message}` });
    }
  });

  // Called after Stripe checkout success — syncs subscription ID from Stripe to user record
  app.post("/api/stripe/sync", requireAuth, async (req, res) => {
    const user = await storage.getUser((req.session as any).userId!);
    if (!user?.stripeCustomerId) return res.json({ synced: false, reason: "no_customer" });

    try {
      const stripe = await getUncachableStripeClient();
      const subs = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: "all",
        limit: 5,
      });

      // Find the most recent active/trialing subscription
      const activeSub = subs.data.find((s) => s.status === "active" || s.status === "trialing");
      if (activeSub && activeSub.id !== user.stripeSubscriptionId) {
        await storage.updateUserStripeInfo(user.id, { stripeSubscriptionId: activeSub.id });
        // Clear the simulated subscription flag if set
        await storage.setSubscribed(user.id, false);
        return res.json({ synced: true, subscriptionId: activeSub.id, status: activeSub.status });
      }

      res.json({ synced: false, reason: "no_active_subscription" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[stripe] sync error:", message);
      res.status(500).json({ synced: false, error: message });
    }
  });

  app.post("/api/stripe/portal", requireAuth, async (req, res) => {
    const user = await storage.getUser((req.session as any).userId!);
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: "no_stripe_customer", message: "No billing account found. Start a paid subscription to access billing management." });
    }

    try {
      const stripe = await getUncachableStripeClient();
      const base = getBaseUrl(req);

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${base}/`,
      });

      res.json({ url: portalSession.url });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[stripe] billing portal error:", message);
      // Stripe throws a specific error when the customer portal is not configured
      const isPortalNotConfigured = message.includes("customer portal") || message.includes("configuration") || message.includes("No such customer");
      res.status(500).json({
        error: "portal_failed",
        message: isPortalNotConfigured
          ? "Billing portal is not configured in Stripe. Please set up your customer portal in the Stripe Dashboard."
          : `Could not open billing portal: ${message}`,
      });
    }
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

  // ── Send document by email ─────────────────────────────────────────────────

  app.post("/api/documents/:id/send-email", async (req, res) => {
    const schema = z.object({
      to: z.string().min(1),
      message: z.string().max(1000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const doc = await storage.getDocument(sp(req.params.id));
    if (!doc || doc.userId !== (req.session as any).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    if (!doc.dataUrl || doc.dataUrl.length < 50) {
      return res.status(422).json({
        error: "This document has no exported file yet — please save or re-export it first.",
      });
    }
    const sender = await storage.getUser((req.session as any).userId!);
    const senderDisplayName = sender?.senderName?.trim() || sender?.name?.trim() || null;
    const emailSubject = `Document from Docera – ${doc.name}`;
    try { await sendDocumentEmail({
        to: parsed.data.to,
        subject: emailSubject,
        message: parsed.data.message,
        docName: doc.name,
        docType: doc.type,
        dataUrl: doc.dataUrl,
        senderDisplayName,
      });
      const eventLabel = senderDisplayName
        ? `Sent to ${parsed.data.to} · ${senderDisplayName}`
        : `Sent to ${parsed.data.to}`;
      await Promise.all([
        storage.updateDocument(doc.id, { status: "sent" }),
        storage.createDocumentEvent({
          documentId: doc.id,
          userId: (req.session as any).userId!,
          type: "sent",
          label: eventLabel,
        }),
      ]);
      res.json({ ok: true });
    } catch (err: unknown) {
      console.error("Email send error:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
      const message = err instanceof Error ? err.message : "Failed to send email";
      res.status(500).json({ error: message });
    }
  });

  // ── Direct email route — no DB, used by native iOS ───────────────────────
  app.post("/api/send-email-direct", async (req, res) => {
    const schema = z.object({
      to: z.string().min(1),
      message: z.string().max(1000).optional(),
      documentName: z.string().min(1),
      pdfBase64: z.string().min(50),
      docType: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }
    const { to, message, documentName, pdfBase64, docType = "pdf" } = parsed.data;
    try {
      await sendDocumentEmail({
        to,
        message,
        docName: documentName,
        docType,
        dataUrl: `data:application/pdf;base64,${pdfBase64}`,
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      res.status(500).json({ error: msg });
    }
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
      `Subject: ${subject}`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
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
        hasUnread: boolean; hasAttachments: boolean;
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
          });
        } else {
          existing.messageCount++;
          if (isUnread) existing.hasUnread = true;
          if (hasAtt) existing.hasAttachments = true;
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
      const list = await gmail.users.messages.list({
        userId: "me",
        q: `from:${contactEmail} OR to:${contactEmail}`,
        maxResults: 100,
      });
      const ids = (list.data.messages ?? []).map(m => m.id!);
      console.log(`[thread-messages] pool size: ${ids.length}, olderThan: ${parsed.data.olderThan ?? "none"}`);

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
        const body = extractGmailBody(msg!.payload as Record<string, unknown> ?? {});
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
        return { id: msg!.id as string, direction: isSent ? "sent" : "received", fromName: from.name, fromEmail: from.email, toEmail: to.email, date, subject, body: extractGmailBody(payload), snippet: (msg!.snippet as string) ?? "", attachments: extractGmailAttachments(payload) };
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

  // ── Gmail: send message (text only or with attachment) ────────────────────
  app.post("/api/gmail/send-message", async (req, res) => {
    const schema = z.object({
      accessToken: z.string().min(1),
      to: z.string().min(1),
      subject: z.string().min(1),
      body: z.string().default(""),
      attachmentBase64: z.string().optional(),
      attachmentName: z.string().optional(),
      attachmentMimeType: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });

    const { accessToken, to, subject, body, attachmentBase64, attachmentName, attachmentMimeType } = parsed.data;
    const oauth2Client = new google.auth.OAuth2(GMAIL_WEB_CLIENT_ID, GMAIL_WEB_CLIENT_SECRET);
    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    let mime: string;
    if (attachmentBase64 && attachmentName) {
      const boundary = `docera_${Date.now()}`;
      const mimeType = attachmentMimeType ?? "application/octet-stream";
      mime = [
        `MIME-Version: 1.0`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body || " ",
        ``,
        `--${boundary}`,
        `Content-Type: ${mimeType}`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${attachmentName}"`,
        ``,
        attachmentBase64,
        `--${boundary}--`,
      ].join("\r\n");
    } else {
      mime = [
        `MIME-Version: 1.0`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body || " ",
      ].join("\r\n");
    }

    try {
      await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: Buffer.from(mime).toString("base64url") },
      });
      res.json({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to send";
      console.error("[gmail/send-message]", msg);
      res.status(500).json({ error: msg });
    }
  });

  // ── Test email endpoint (Resend, no attachment) ────────────────────────────
  app.post("/api/send-email", requireAuth, async (req, res) => {
    const schema = z.object({
      to: z.string().email("Invalid recipient email address"),
      subject: z.string().min(1, "Subject is required"),
      message: z.string().min(1, "Message is required"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "RESEND_API_KEY is not configured. Add it in Replit Secrets." });
    }

    try {
      const resend = new Resend(apiKey);
      const fromAddress = process.env.EMAIL_FROM ?? "no-reply@docera.app";
      const from = `Docera <${fromAddress}>`;
      const result = await resend.emails.send({
        from,
        to: [parsed.data.to],
        subject: "Email setup check · Docera",
        text: parsed.data.message,
      });

      if (result.error) {
        return res.status(500).json({ error: result.error.message ?? "Resend rejected the request" });
      }

      res.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unexpected error sending email";
      res.status(500).json({ error: message });
    }
  });

  // ── Handwriting credits ────────────────────────────────────────────────────

  app.get("/api/credits/hw", requireAuth, async (req, res) => {
    try {
      const { credits, resetAt } = await storage.getHwCredits((req.session as any).userId!);
      res.json({ credits, resetAt });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to get credits";
      res.status(500).json({ error: message });
    }
  });

  // Creates a Stripe one-time payment for +10 handwriting credits (₪9.90)
  app.post("/api/credits/hw/checkout", requireAuth, async (req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const user = await storage.getUser((req.session as any).userId!);
      if (!user) return res.status(404).json({ error: "User not found" });

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: user.username, name: user.name || undefined });
        await storage.updateUserStripeInfo(user.id, { stripeCustomerId: customer.id });
        customerId = customer.id;
      }

      const base = getBaseUrl(req);
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "ils",
            unit_amount: 990, // ₪9.90 in agorot
            product_data: {
              name: "+10 Handwriting Scans",
              description: "Add 10 handwriting recognition scans to your account",
            },
          },
          quantity: 1,
        }],
        mode: "payment",
        success_url: `${base}/?topup=success`,
        cancel_url: `${base}/?topup=cancel`,
        metadata: { purpose: "hw_credit_topup", userId: user.id },
      });

      res.json({ url: session.url });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Checkout failed";
      res.status(500).json({ error: message });
    }
  });

  // ── Hebrew OCR via OpenAI Vision ─────────────────────────────────────────
  app.post("/api/ocr/hebrew", requireAuth, async (req, res) => {
    try {
      const parsed = z.object({
        imageDataUrl: z.string().min(10),
      }).safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({ error: "imageDataUrl is required" });
      }

      // ── Credit gate ──────────────────────────────────────────────────────
      const credit = await storage.consumeHwCredit((req.session as any).userId!);
      if (!credit.ok) {
        return res.status(402).json({ error: "no_credits", remaining: 0 });
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        // Refund the credit — this is a server config issue, not user error
        await storage.addHwCredits((req.session as any).userId!, 1);
        return res.status(503).json({ error: "Hebrew OCR is not configured — OPENAI_API_KEY is missing." });
      }

      const { imageDataUrl } = parsed.data;

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 2048,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: imageDataUrl, detail: "high" },
                },
                {
                  type: "text",
                  text: `You are a precise document scanner. Your job is to read handwritten text and return each word with its horizontal position on the page. You do NOT interpret, translate, reorder, or correct anything.

═══ RULE 1 — CHARACTER ACCURACY ═══
Copy exactly what you see in the ink strokes.
  • Clearly visible letter → write it.
  • Unclear or ambiguous letter → write [?] instead.
Use [?] freely. "של[?]ם" is better than a guessed full word.
Do NOT auto-correct. Do NOT complete words from context.

═══ RULE 2 — WORD POSITIONS ═══
For each line, identify every individual word and estimate its X position as a fraction of the page width:
  • x = 0.0 means the far LEFT edge of the page
  • x = 1.0 means the far RIGHT edge of the page
  • Estimate the center of each word's ink horizontally.

Do NOT pre-sort the words. Output each word with its raw measured x value.
The system will sort them after receiving your output.

═══ RULE 3 — LINE DETECTION ═══
Find every handwritten row, strictly top to bottom.
  Each physical handwritten line = ONE block entry.
  Output entries in top-to-bottom page order.
  Do NOT merge separate lines. Do NOT split one line into two entries.

Return ONLY a valid JSON object — no markdown, no backticks, no extra text.

Output format:
{
  "blocks": [
    {
      "side": "left",
      "y": 0.05,
      "words": [
        { "w": "Hello", "x": 0.08 },
        { "w": "my",    "x": 0.22 },
        { "w": "name",  "x": 0.34 },
        { "w": "is",    "x": 0.44 }
      ]
    },
    {
      "side": "right",
      "y": 0.18,
      "words": [
        { "w": "מה",      "x": 0.55 },
        { "w": "התשובה",  "x": 0.68 },
        { "w": "פה?",     "x": 0.82 }
      ]
    }
  ]
}

Fields:
  • "side": "left" if the ink block is on the left half of the page, "right" if on the right half.
  • "y": vertical center of the line as a fraction of page height (0.0=top, 1.0=bottom).
  • "words": array of every word on that line, each with:
      "w" — the exact characters of the word (use [?] for unclear letters)
      "x" — horizontal center of the word as a fraction of page width (0.0=left, 1.0=right)

If no readable text: {"blocks": []}

Begin JSON:`,
                },
              ],
            },
          ],
        }),
      });

      if (!response.ok) {
        // Refund credit — OpenAI errors are not the user's fault
        await storage.addHwCredits((req.session as any).userId!, 1);
        if (response.status === 429) {
          return res.status(503).json({ error: "Recognition is temporarily unavailable. Please try again later." });
        }
        return res.status(502).json({ error: "Recognition failed. Please try again." });
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const raw = (data.choices?.[0]?.message?.content ?? "").trim();

      if (!raw || raw === '{"blocks":[]}' || raw.includes('"blocks":[]')) {
        return res.json({
          blocks: [],
          warning: "No text was detected in this image. Try a clearer photo with good lighting.",
        });
      }

      // Detect whether text contains Hebrew characters (used for sort direction)
      const lineIsRTL = (words: Array<{ w: string; x: number }>): boolean => {
        const combined = words.map(w => w.w).join("");
        return /[\u05D0-\u05EA\uFB1D-\uFB4F]/.test(combined);
      }

      type RawWord  = { w: string; x: number };
      type RawBlock = { text: string; side: string; y: number };
      type ModelBlock = { words?: RawWord[]; text?: string; side?: string; y?: number };

      let blocks: RawBlock[] = [];
      let parseOk = false;

      try {
        // Extract JSON — model might wrap it in backticks or add prose
        const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
        const parsed = JSON.parse(jsonStr) as { blocks?: ModelBlock[] };

        if (Array.isArray(parsed?.blocks)) {
          blocks = parsed.blocks
            .filter((b) => Array.isArray(b.words) ? b.words.length > 0 : (typeof b.text === "string" && b.text.trim()))
            .map((b): RawBlock => {
              const side = (b.side === "left" || b.side === "right") ? b.side : "left";
              const y    = typeof b.y === "number" ? Math.max(0, Math.min(1, b.y)) : 0.04;

              // ── New format: words with x positions ──────────────────────
              if (Array.isArray(b.words) && b.words.length > 0) {
                const words: RawWord[] = b.words
                  .filter(w => typeof w.w === "string" && w.w.trim())
                  .map(w => ({ w: w.w.trim(), x: typeof w.x === "number" ? w.x : 0.5 }));

                // Sort by x coordinate:
                //   RTL (Hebrew) → DESC (rightmost word = highest x → comes first)
                //   LTR (English) → ASC (leftmost word = lowest x → comes first)
                const rtl = lineIsRTL(words);
                const sorted = rtl
                  ? [...words].sort((a, b) => b.x - a.x)
                  : [...words].sort((a, b) => a.x - b.x);

                return { text: sorted.map(w => w.w).join(" "), side, y };
              }

              // ── Legacy / fallback: pre-joined text string ─────────────
              return { text: (b.text ?? "").trim(), side, y };
            })
            .filter(b => b.text.length > 0);

          parseOk = true;
        }
      } catch {
        // JSON parse failed — fall through to plain-text fallback
      }

      // Fallback: treat entire response as a single left-side block
      if (!parseOk || blocks.length === 0) {
        blocks = [{ text: raw, side: "left", y: 0.04 }];
      }

      const totalWords = blocks.reduce(
        (acc, b) => acc + b.text.trim().split(/\s+/).filter(Boolean).length,
        0
      );
      const warning = totalWords < 3
        ? "Very little text was detected — the handwriting may be unclear. Try a better-lit, sharper photo."
        : undefined;

      return res.json({ blocks, warning, remaining: credit.remaining });
    } catch (err: unknown) {
      // Refund the credit — unexpected server errors shouldn't cost the user a scan
      try { await storage.addHwCredits((req.session as any).userId!, 1); } catch { /* best-effort */ }
      const message = err instanceof Error ? err.message : "Unexpected error during OCR";
      res.status(500).json({ error: message });
    }
  });
}
