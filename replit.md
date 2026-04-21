# Docera — PDF Scanner & Organizer

## Overview
A mobile-first document scanning and PDF organizer app. Users can scan documents with their device camera, apply image enhancements and cropping, save as PDF/JPEG/PNG, and organize them into folders. Capacitor is configured to package the app for iOS and Android.

## Architecture
- **Frontend**: React + Vite, TypeScript, TailwindCSS, shadcn/ui, TanStack Query
- **Backend**: Express.js, Drizzle ORM, PostgreSQL
- **Auth**: Email + Password (bcrypt) with express-session stored in PostgreSQL
- **PDF Generation**: jsPDF (converts captured images to PDF)
- **Camera**: Browser getUserMedia API (works in Capacitor WebView)
- **Mobile**: Capacitor (`@capacitor/core`, `@capacitor/ios`, `@capacitor/android`)

## Key Features
1. **Email/Password Auth** — sign up and sign in, no OAuth required
2. **Document Scanner** — live camera preview, capture, free-form quad crop with 4 independent draggable corner handles, perspective correction (homography warp), document enhancement filters (Original, Auto, No Shadow, Color, Document), format selector (PDF/JPEG/PNG)
3. **Multi-page Scanning** — capture multiple pages, reorder them, combine into one PDF or save separately
4. **PDF Import** — pick existing PDF files from device storage
4b. **Import Organizer** — import multiple photos and PDFs at once, group them into separate named documents, reorder items, split/merge groups, save each group as its own PDF
5. **Document Organizer** — grid view of all documents, folder creation/rename/delete, document rename/delete
6. **Document Viewer** — full-screen PDF iframe or image viewer, download button
7. **Folders** — organize documents into named folders, scan directly into a folder
8. **Handwriting Converter** — dedicated Convert tab; photograph or upload a handwritten page, run client-side OCR via Tesseract.js (v7), review/edit the extracted text, save as a named PDF into the Docera library

## Pages
- `AuthPage` — sign in / sign up form
- `HomePage` — document grid + folders list, bottom tab bar (Docs | Scan FAB | Convert | Clients)
- `ConvertPage` — handwriting-to-text: image upload/capture → Tesseract.js OCR → editable text review → save as PDF
- `ScannerPage` — camera → capture → crop + enhance → format → save (or multi-page mode)
- `ViewerPage` — full-screen document viewer with download/delete
- `FolderPage` — documents within a specific folder
- `ProfilePage` — user profile, storage stats, Pro badge, Manage Billing button, sign out
- `PaywallPage` — Stripe subscription paywall (monthly / yearly plans, Stripe Checkout)
- `ImportPage` — multi-file import organizer: group photos/PDFs into separate documents, reorder, split/merge, save all

## Key Features
8. **Re-editable Documents** — every saved PDF stores per-page edit data (crop quad, filter, rotation) as a JSON `pages` column. The "Edit" button in the viewer or document card menu reloads all pages into the full scanner editor, allowing re-cropping, re-filtering, and re-exporting.

## Database Schema
- `users` — id, username (email), password (hashed), name, sender_name, stripe_customer_id, stripe_subscription_id, created_at
- `folders` — id, user_id, name, created_at
- `clients` — id, user_id, name, email (nullable), phone (nullable), notes (nullable), created_at
- `documents` — id, user_id, folder_id (nullable), client_id (nullable FK → clients), name, type, data_url, pages (JSON), size, thumb_url, status, created_at, updated_at
  - `pages` column: JSON array of `SerializablePage` (id, originalDataUrl JPEG 0.92, quad, filterMode, filterStrength, rotation). Empty `"[]"` for imported PDFs or legacy documents.
  - List endpoint (`GET /api/documents`) returns `DocumentSummary` — omits `dataUrl` and `pages` for payload performance
  - Detail endpoint (`GET /api/documents/:id`) returns full `Document` including both heavy fields
- `document_events` — id, document_id, user_id, type, label, created_at (append-only audit log)

## API Routes
- `POST /api/auth/signup` — create account
- `POST /api/auth/login` — sign in
- `POST /api/auth/logout` — sign out
- `GET /api/auth/me` — current user
- `PUT /api/auth/profile` — update name
- `GET/POST /api/folders` — list/create folders
- `PUT/DELETE /api/folders/:id` — rename/delete folder
- `GET/POST /api/documents` — list/create documents (supports ?folderId= filter); list returns DocumentSummary (no dataUrl/pages)
- `GET /api/documents/:id` — get full document (includes dataUrl and pages)
- `PUT /api/documents/:id` — rename document / move to folder / set status
- `PATCH /api/documents/:id` — update content (dataUrl, size, pages, name) — used by re-edit save
- `DELETE /api/documents/:id` — delete document
- `POST /api/documents/:id/send-email` — send document as email attachment `{ to, message? }` (requires SMTP env vars)
- `GET /api/documents/:id/events` — fetch document activity timeline
- `POST /api/documents/:id/events` — log a manual event `{ type, label }`
- `GET /api/subscription` — current subscription status (active, status, currentPeriodEnd)
- `GET /api/stripe/plans` — list available Stripe plans (monthly/yearly)
- `POST /api/stripe/checkout` — create Stripe Checkout session → returns {url}
- `POST /api/stripe/portal` — create Stripe Billing Portal session → returns {url}
- `POST /api/stripe/webhook` — Stripe webhook handler (raw body, before express.json)

## Session Config
- PgSession store, 90-day expiry, rolling sessions
- Secure cookies in production, lax in development

## Mobile Build — Capacitor Setup

### Prerequisites (on your local machine)
- Node.js 22+ installed (Capacitor v8 CLI requires Node ≥ 22)
- For iOS: macOS with Xcode 14+ installed
- For Android: Android Studio installed (any OS)
- Apple Developer account ($99/year) for App Store
- Google Play Console account ($25 one-time) for Play Store

### Step 1: Deploy the backend on Replit
1. Click **Deploy** in the Replit workspace to get your live backend URL (e.g. `https://docera.replit.app`)
2. Note this URL — you'll need it as `VITE_API_BASE_URL`

### Step 2: Clone and build locally
```bash
git clone <your-replit-repo-url>
cd docera

# Install dependencies
npm install

# Create a .env file for mobile builds
echo "VITE_API_BASE_URL=https://your-deployed-replit-url.replit.app" > .env.local

# Build the React app
npm run build
```

### Step 3: Add mobile platforms (first time only)
```bash
# Add iOS (Mac only)
npx cap add ios

# Add Android
npx cap add android

# Copy built web assets into native projects
npx cap sync
```

### Step 4: Run on iOS (Mac only)
```bash
npx cap open ios
# This opens Xcode — select your device/simulator and press Run
```

### Step 5: Run on Android
```bash
npx cap open android
# This opens Android Studio — select your device/emulator and press Run
```

### Subsequent builds (after code changes)
```bash
npm run build && npx cap sync
```

### Subscriptions (Stripe)

Docera uses a **subscription-only model** via Stripe. All users must subscribe before accessing any features. There is no free tier.

#### Architecture
- `server/stripeClient.ts` — Stripe SDK initialisation (reads key from Replit connection)
- `server/webhookHandlers.ts` — Stripe webhook event handlers (checkout.session.completed, customer.subscription.*)
- `server/routes.ts` — `/api/stripe/*` endpoints + `/api/subscription`
- `client/src/hooks/use-subscription.ts` — React hook, fetches `/api/subscription`
- `client/src/pages/PaywallPage.tsx` — Paywall shown to all unsubscribed users
- `client/src/pages/ProfilePage.tsx` — "Manage Billing" button → Stripe Billing Portal
- `scripts/seed-products.ts` — creates Stripe Products/Prices ($9.99/mo, $79.99/yr)

#### Stripe Setup (already configured)
- Replit Stripe integration connected: credentials read automatically via `listConnections("stripe")`
- Run seed script once to create products: `npx tsx scripts/seed-products.ts`
- Set `STRIPE_WEBHOOK_SECRET` environment variable from Stripe Dashboard → Webhooks

#### Subscription Flow
1. Unauthenticated → `AuthPage`
2. Authenticated but no active subscription → `PaywallPage`
3. User picks monthly/yearly plan → Stripe Checkout (hosted page)
4. On success, redirect to `/?checkout=success` → app invalidates subscription cache
5. Webhook confirms payment server-side and stores `stripeCustomerId` / `stripeSubscriptionId`
6. `ProfilePage` → "Manage Billing" → Stripe Billing Portal for cancellation/plan changes

## Sender Display Name

Each user can set a **Preferred Sender Name** in Profile → Email Sending. This is stored in the `sender_name` column on the `users` table.

- If set, outgoing emails show: `Ibrahim via Docera <no-reply@docera.app>`
- If not set, falls back to account name, then `"Docera"`
- The real sending address is always the system email — users cannot customize it
- `PUT /api/auth/profile` accepts `{ senderName?: string | null }` to update it
- `GET /api/auth/me` returns `senderName` alongside `name` and `username`

## Email Configuration (Send by Email feature)

The "Send" button in the document viewer sends the document as an email attachment via **Resend** (`resend` npm package). Set these environment variables in Replit Secrets to enable it:

| Variable | Required | Description |
|---|---|---|
| `RESEND_API_KEY` | ✅ | API key from resend.com dashboard |
| `EMAIL_FROM` | optional | Sending address (default: `no-reply@docera.app`). Must be verified in Resend. |

**Setup:** Sign up at [resend.com](https://resend.com), create an API key, and add it as `RESEND_API_KEY` in Replit Secrets. The free tier allows 3,000 emails/month.

**Domain verification:** To send from `no-reply@docera.app`, verify the domain in the Resend dashboard. Until then, Resend's shared domain can be used for testing.

If `RESEND_API_KEY` is not set, the Send button will show a clear error message.

## Capacitor Config (`capacitor.config.ts`)
- **App ID**: `com.docera.app`
- **App Name**: `Docera`
- **Web dir**: `dist/public` (Vite build output — must run `npm run build` first)
- **API base URL**: Baked in at build time via `VITE_API_BASE_URL` env var (set in `.env.local`)
- **Live-reload dev builds**: Set `CAPACITOR_SERVER_URL=http://<LAN-IP>:5000` before `npx cap run` — skips bundled files and loads the running dev server instead
- **Production**: Leave `CAPACITOR_SERVER_URL` unset — app is fully self-contained (required for App Store / Play Store)
- **Camera plugin**: `presentationStyle: "fullscreen"` configured under `plugins.Camera`
- **Android**: `allowMixedContent: true`, scheme `https`
- **iOS**: `contentInset: "automatic"` (respects safe-area insets)

See the **Mobile Build — Capacitor Setup** section above for the full step-by-step build guide.
