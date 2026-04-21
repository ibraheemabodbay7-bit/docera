import puppeteer from "puppeteer-core";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT       = path.join(__dirname, "..", "paywall-screenshot.png");
const CHROMIUM  = "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

// iPhone 14 Pro Max logical canvas — @3x → 1290 × 2796 physical
const W = 430;
const H = 932;

const HTML = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=${W}, initial-scale=1"/>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  width: ${W}px;
  height: ${H}px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
               "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  background: #fef7ed;
  color: #1a1a1a;
}

/* ── Full-screen column ── */
.screen {
  width: ${W}px;
  height: ${H}px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── HERO ── */
.hero {
  background: linear-gradient(160deg, #113e61 0%, #1a5a8a 100%);
  flex-shrink: 0;
  position: relative;
  text-align: center;
  padding-bottom: 44px;
}

/* iOS status bar */
.status-bar {
  height: 59px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 28px 8px;
  position: relative;
  z-index: 10;
}
.status-time {
  font-size: 15.5px;
  font-weight: 600;
  color: #fff;
  letter-spacing: -0.3px;
}
.status-icons { display: flex; align-items: center; gap: 6px; }

/* Dynamic Island */
.dynamic-island {
  position: absolute;
  top: 11px;
  left: 50%;
  transform: translateX(-50%);
  width: 126px;
  height: 37px;
  background: #000;
  border-radius: 20px;
  z-index: 20;
}

/* Hero copy */
.hero-copy {
  padding: 4px 32px 0;
}
.hero-copy h1 {
  font-size: 33px;
  font-weight: 800;
  color: #fff;
  line-height: 1.17;
  margin-bottom: 12px;
  letter-spacing: -0.7px;
}
.hero-copy p {
  font-size: 16px;
  color: rgba(255,255,255,0.72);
  font-weight: 500;
  line-height: 1.45;
}

/* ── CONTENT (fills all remaining space) ── */
.content {
  flex: 1;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
  justify-content: space-evenly;   /* spreads cards + trust evenly */
}

/* Feature card */
.feature-card {
  background: #f5efe6;
  border: 1px solid rgba(0,0,0,0.07);
  border-radius: 24px;
  padding: 20px 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.feature-row { display: flex; align-items: center; gap: 12px; }
.f-icon {
  width: 40px; height: 40px;
  border-radius: 12px;
  background: rgba(17,62,97,0.1);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.f-icon svg { width: 18px; height: 18px; stroke: #113e61; fill: none; stroke-width: 2; }
.f-text { font-size: 14.5px; font-weight: 500; color: #1a1a1a; flex: 1; }
.check svg { width: 17px; height: 17px; stroke: #22c55e; fill: none; stroke-width: 2.5; }

/* Pricing card */
.pricing-card {
  background: rgba(17,62,97,0.06);
  border: 1px solid rgba(17,62,97,0.18);
  border-radius: 18px;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pl p:first-child { font-size: 14px; font-weight: 600; color: #1a1a1a; }
.pl p:last-child  { font-size: 11.5px; color: #6b7280; margin-top: 3px; }
.pr { text-align: right; }
.pr p:first-child { font-size: 11.5px; font-weight: 700; color: #113e61; }
.pr p:last-child  { font-size: 14px; font-weight: 700; color: #1a1a1a; margin-top: 3px; }

/* Trust row */
.trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-size: 11.5px;
  color: #9ca3af;
}
.trust-dot { color: rgba(156,163,175,0.35); font-size: 14px; line-height: 1; }
.trust-item { display: flex; align-items: center; gap: 4px; }
.trust-item svg { width: 11px; height: 11px; stroke: #9ca3af; fill: none; stroke-width: 2; }

/* ── CTA FOOTER ── */
.cta-footer {
  flex-shrink: 0;
  background: #f5efe6;
  border-top: 1px solid rgba(0,0,0,0.07);
  padding: 16px 20px 0;
}
.cta-inner { display: flex; flex-direction: column; gap: 9px; }

.btn-primary {
  width: 100%;
  height: 56px;
  background: #113e61;
  color: #fff;
  border: none;
  border-radius: 18px;
  font-size: 16.5px;
  font-weight: 700;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  box-shadow: 0 4px 22px rgba(17,62,97,0.35);
  letter-spacing: -0.2px;
}
.btn-primary svg { width: 15px; height: 15px; stroke: #fff; fill: none; stroke-width: 2; }

.btn-restore {
  width: 100%;
  height: 48px;
  background: transparent;
  border: 1.5px solid rgba(0,0,0,0.12);
  border-radius: 18px;
  font-size: 14.5px;
  font-weight: 600;
  color: #1a1a1a;
  display: flex; align-items: center; justify-content: center; gap: 7px;
}
.btn-restore svg { width: 13px; height: 13px; stroke: #6b7280; fill: none; stroke-width: 2; }

.legal {
  text-align: center;
  font-size: 11px;
  color: #9ca3af;
  padding: 2px 0 6px;
}

/* ── HOME INDICATOR ── */
.home-indicator {
  flex-shrink: 0;
  height: 34px;
  background: #f5efe6;
  display: flex; align-items: center; justify-content: center;
}
.home-pill {
  width: 134px; height: 5px;
  background: rgba(0,0,0,0.22);
  border-radius: 3px;
}
</style>
</head>
<body>
<div class="screen">

  <!-- HERO -->
  <div class="hero">
    <div class="dynamic-island"></div>

    <div class="status-bar">
      <span class="status-time">9:41</span>
      <div class="status-icons">
        <!-- Signal bars -->
        <svg width="18" height="13" viewBox="0 0 18 13" fill="none">
          <rect x="0"    y="8"   width="3.2" height="5"   rx="0.9" fill="white"/>
          <rect x="4.7"  y="5.5" width="3.2" height="7.5" rx="0.9" fill="white"/>
          <rect x="9.4"  y="3"   width="3.2" height="10"  rx="0.9" fill="white"/>
          <rect x="14.1" y="0"   width="3.2" height="13"  rx="0.9" fill="white"/>
        </svg>
        <!-- Wi-Fi -->
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <circle cx="8" cy="11" r="1.4" fill="white"/>
          <path d="M4.2 7.2a5.4 5.4 0 0 1 7.6 0"  stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M1.3 4.3a9.5 9.5 0 0 1 13.4 0" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <!-- Battery -->
        <svg width="26" height="13" viewBox="0 0 26 13" fill="none">
          <rect x="0.6" y="0.6" width="21.8" height="11.8" rx="3.2" stroke="white" stroke-opacity="0.4" stroke-width="1.2"/>
          <rect x="2.2" y="2.2" width="16.4" height="8.6" rx="1.8" fill="white"/>
          <path d="M24 4.5v4a2.2 2.2 0 0 0 0-4z" fill="white" opacity="0.4"/>
        </svg>
      </div>
    </div>

    <div class="hero-copy">
      <h1>Start your<br/>free trial</h1>
      <p>7 days free, then ₪19.90/month.<br/>Cancel anytime.</p>
    </div>
  </div>

  <!-- CONTENT -->
  <div class="content">

    <!-- Features -->
    <div class="feature-card">
      <div class="feature-row">
        <div class="f-icon">
          <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/></svg>
        </div>
        <span class="f-text">10 handwriting scans per month</span>
        <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
      </div>
      <div class="feature-row">
        <div class="f-icon">
          <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <span class="f-text">Scan and edit documents</span>
        <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
      </div>
      <div class="feature-row">
        <div class="f-icon">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <span class="f-text">Export files</span>
        <div class="check"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
      </div>
    </div>

    <!-- Pricing -->
    <div class="pricing-card">
      <div class="pl">
        <p>Monthly plan</p>
        <p>Cancel anytime · no hidden fees</p>
      </div>
      <div class="pr">
        <p>Free for 7 days</p>
        <p>then ₪19.90/month</p>
      </div>
    </div>

    <!-- Trust -->
    <div class="trust">
      <div class="trust-item">
        <svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Secure payment
      </div>
      <span class="trust-dot">·</span>
      <span>Cancel anytime</span>
      <span class="trust-dot">·</span>
      <span>Instant access</span>
    </div>

  </div>

  <!-- CTA FOOTER -->
  <div class="cta-footer">
    <div class="cta-inner">
      <button class="btn-primary">
        <svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" stroke-linejoin="round"/></svg>
        Start Free Trial
      </button>
      <button class="btn-restore">
        <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.95"/></svg>
        Restore Purchases
      </button>
      <p class="legal">Subscription renews automatically. Cancel anytime.</p>
    </div>
  </div>

  <!-- HOME INDICATOR -->
  <div class="home-indicator">
    <div class="home-pill"></div>
  </div>

</div>
</body>
</html>`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 3 });
  await page.setContent(HTML, { waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 400));

  await page.screenshot({ path: OUT, fullPage: false, type: "png" });
  await browser.close();
  console.log("Saved:", OUT);
})();
