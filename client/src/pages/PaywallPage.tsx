import { useState, useEffect, useRef } from "react";
import ProUnlockCelebration from "@/components/ProUnlockCelebration";
import {
  ScanLine, Send, Folder, Star, Inbox, Check, Lock, X, Sparkles, Loader2, ExternalLink,
} from "lucide-react";
import { Browser } from "@capacitor/browser";
import { useToast } from "@/hooks/use-toast";
import {
  purchaseMonthlyPlan,
  getMonthlyPackage,
  getSubscriptionStatus,
  isNativePlatform,
  addCustomerInfoUpdateListener,
  ENTITLEMENT_ID,
} from "@/lib/purchases";
import { queryClient } from "@/lib/queryClient";
import { setTheme } from "@/lib/theme";

const TRIAL_DAYS = 7;

const EULA_URL    = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";
const PRIVACY_URL = "https://docera-production.up.railway.app/privacy";

function openUrl(url: string) {
  Browser.open({ url, windowName: "_blank" });
}

// ── Feature list ──────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: ScanLine,   text: "Scan and edit any document" },
  { icon: Send,       text: "Send via Gmail directly in the app" },
  { icon: Folder,     text: "Client and folder organization" },
  { icon: Star,       text: "Important contact auto-detection" },
  { icon: Inbox,      text: "Browse Gmail attachments by client" },
  { icon: Sparkles,   text: "Unlimited scans, no watermarks" },
];

// ── Fallback strings (shown before RevenueCat price loads) ────────────────────
const FALLBACK_PRICE = "₪29.90/month";

// Paywall always shows the Pro navy background — it's selling Pro.
const ORB_PRO = [
  "radial-gradient(ellipse at 20% 15%, #1a2444 0%, #0d1530 30%, transparent 60%)",
  "radial-gradient(ellipse at 80% 85%, #15203c 0%, #0a0f1e 35%, transparent 65%)",
  "radial-gradient(ellipse at 50% 50%, #0a0f1e 0%, transparent 50%)",
  "#0a0f1e",
].join(", ");

function glassStyle(dark: boolean): React.CSSProperties {
  return {
    backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`,
    WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`,
    border: dark ? "0.5px solid rgba(255,255,255,0.08)" : "0.5px solid rgba(255,255,255,0.4)",
    boxShadow: dark
      ? "0 1px 0 rgba(255,255,255,0.05) inset, 0 4px 20px rgba(0,0,0,0.5)"
      : "0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.15)",
  };
}

interface PaywallPageProps {
  onBack?: () => void;
  lockedFeature?: string;
}

export default function PaywallPage({ onBack, lockedFeature }: PaywallPageProps) {
  const { toast } = useToast();
  const [purchasing, setPurchasing] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [alreadyPro, setAlreadyPro] = useState(false);
  const [checkingPro, setCheckingPro] = useState(true);
  const [priceString, setPriceString] = useState<string | null>(null);

  // Paywall is always navy/gold regardless of system theme.
  const orbBg         = ORB_PRO;
  const cardBg        = "rgba(13,20,45,0.65)";
  const heroBg        = "rgba(10,15,30,0.88)";
  const textPrimary   = "#e8dfc8";
  const textSecondary = "#8a96b0";
  const gold          = "#c9a84c";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  useEffect(() => {
    if (!isNativePlatform()) { setCheckingPro(false); return; }
    (async () => {
      try {
        const status = await getSubscriptionStatus();
        if (status === "pro") setAlreadyPro(true);
      } catch {}
      finally { setCheckingPro(false); }
    })();
  }, []);

  useEffect(() => {
    getMonthlyPackage().then((pkg) => {
      if (pkg?.priceString) setPriceString(pkg.priceString);
    });
  }, []);

  const displayPrice = priceString ? `${priceString}/month` : FALLBACK_PRICE;

  // Guards against: double-fire, and listener triggering on launch (not during a purchase).
  const purchaseAttemptedRef  = useRef(false);
  const celebratedRef         = useRef(false);
  const triggerCelebrationRef = useRef<() => void>(() => {});

  // RevenueCat listener — catches the delayed entitlement update that purchasePackage can miss.
  // purchaseAttemptedRef guards against replaying the celebration on launch for existing Pro users.
  useEffect(() => {
    let removeFn: (() => Promise<void>) | null = null;
    addCustomerInfoUpdateListener((info) => {
      if (!purchaseAttemptedRef.current) return;
      if (info.entitlements.active[ENTITLEMENT_ID]) {
        triggerCelebrationRef.current();
      }
    }).then((fn) => { removeFn = fn; });
    return () => { removeFn?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync purchase to backend — fire-and-forget, never blocks animation ────
  const activateOnServer = async () => {
    try {
      await fetch("/api/subscription/native-activate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // Non-fatal
    }
    queryClient.invalidateQueries({ queryKey: ["/api/subscription"] });
  };

  // Called from both the purchase promise and the listener — whichever fires first.
  const triggerCelebration = () => {
    if (celebratedRef.current) return;
    celebratedRef.current = true;
    activateOnServer(); // intentionally not awaited — server sync must not gate the animation
    setCelebrating(true);
  };

  // Keep the ref pointing at the latest render's closure (safe to call from the stable listener).
  triggerCelebrationRef.current = triggerCelebration;

  // ── Subscribe ─────────────────────────────────────────────────────────────
  const handleSubscribe = async () => {
    if (!isNativePlatform()) {
      toast({ title: "Available on the mobile app" });
      return;
    }
    purchaseAttemptedRef.current = true;
    setPurchasing(true);
    try {
      const status = await purchaseMonthlyPlan();
      if (status === "pro") {
        triggerCelebration();
        // If status is still "free" here (RC delay), the listener will catch the
        // entitlement update and call triggerCelebration when it arrives.
      }
    } catch (e: unknown) {
      purchaseAttemptedRef.current = false; // don't let the listener misfire on next open
      const msg = e instanceof Error ? e.message : "Purchase failed. Please try again.";
      toast({ title: "Purchase failed", description: msg, variant: "destructive" });
    } finally {
      setPurchasing(false);
    }
  };

  const busy = purchasing || celebrating;

  if (checkingPro) {
    return (
      <>
        <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
        <div className="min-h-screen flex items-center justify-center" style={{ position: "relative", zIndex: 1 }}>
          <Loader2 className="w-6 h-6 animate-spin" style={{ color: textSecondary }} />
        </div>
      </>
    );
  }

  if (alreadyPro) {
    return (
      <>
        <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
        <div className="min-h-screen flex flex-col items-center justify-center px-5" style={{ position: "relative", zIndex: 1 }}>
          {onBack && (
            <button
              onClick={onBack}
              className="absolute right-4 w-9 h-9 rounded-full flex items-center justify-center active:opacity-60"
              style={{ background: "rgba(255,255,255,0.12)", top: "max(1rem, env(safe-area-inset-top))" }}
            >
              <X className="w-4 h-4" style={{ color: textPrimary }} />
            </button>
          )}
          <div className="max-w-sm w-full flex flex-col items-center gap-5 text-center rounded-3xl p-8"
               style={{ background: cardBg, ...glassStyle(true) }}>
            <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: "rgba(201,168,76,0.15)", border: "1px solid rgba(201,168,76,0.35)" }}>
              <Sparkles className="w-6 h-6" style={{ color: gold }} />
            </div>
            <div>
              <h1 className="text-2xl font-bold mb-2" style={{ color: textPrimary }}>You're on Docera Pro</h1>
              <p className="text-sm" style={{ color: textSecondary }}>Your subscription is active. Enjoy full access to all Pro features.</p>
            </div>
            <button
              onClick={onBack}
              className="w-full h-12 rounded-2xl font-semibold text-sm active:scale-[0.98] transition-all bg-primary text-primary-foreground"
            >
              Close
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="min-h-screen flex flex-col" style={{ position: "relative", zIndex: 1, background: "transparent" }}>

        {/* ── Hero ── */}
        <div
          className="flex-shrink-0 relative px-5 pb-10 text-center"
          style={{
            background: heroBg,
            ...glassStyle(true),
            borderRadius: 0,
            boxShadow: "none",
            paddingTop: "max(3.5rem, env(safe-area-inset-top))",
          }}
        >
          {onBack && (
            <button
              data-testid="button-paywall-back"
              onClick={onBack}
              disabled={busy}
              className="absolute right-4 w-9 h-9 rounded-full flex items-center justify-center active:opacity-60 disabled:opacity-40"
              style={{ background: "rgba(255,255,255,0.12)", top: "max(1rem, env(safe-area-inset-top))" }}
            >
              <X className="w-4 h-4" style={{ color: textPrimary }} />
            </button>
          )}

          {lockedFeature && (
            <div
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 mb-5"
              style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              <Lock className="w-3 h-3" style={{ color: gold }} />
              <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                {lockedFeature} requires a subscription
              </span>
            </div>
          )}

          {/* Subscription identity */}
          <p className="text-xs font-bold tracking-widest uppercase mb-3" style={{ color: gold }}>
            Docera Pro · Monthly
          </p>

          {/* Billed price — most prominent element per Apple 3.1.2(c) */}
          <h1 className="text-[46px] font-extrabold leading-none mb-3" style={{ color: textPrimary }}>
            {displayPrice}
          </h1>

          {/* Trial — visually subordinate: smaller, lighter, below price */}
          <p className="text-sm font-medium" style={{ color: textSecondary }}>
            {TRIAL_DAYS}-day free trial, then {displayPrice}. Cancel anytime.
          </p>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto px-5 pt-6 pb-10">
          <div className="max-w-sm mx-auto flex flex-col gap-5">

            {/* Feature list */}
            <div
              className="rounded-3xl p-5 flex flex-col gap-4"
              style={{ background: cardBg, ...glassStyle(true) }}
            >
              {FEATURES.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.08)" }}>
                    <Icon className="w-4 h-4" style={{ color: gold }} />
                  </div>
                  <span className="text-sm font-medium flex-1" style={{ color: textPrimary }}>{text}</span>
                  <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
                </div>
              ))}
            </div>

            {/* Pricing summary */}
            <div
              className="rounded-2xl px-5 py-4 flex items-center justify-between"
              style={{ background: cardBg, ...glassStyle(true) }}
            >
              <div>
                <p className="text-sm font-semibold" style={{ color: textPrimary }}>Docera Pro · Monthly</p>
                <p className="text-xs mt-0.5" style={{ color: textSecondary }}>Cancel anytime · no hidden fees</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium" style={{ color: textSecondary }}>{TRIAL_DAYS}-day free trial</p>
                <p className="text-sm font-bold" style={{ color: textPrimary }}>then {displayPrice}</p>
              </div>
            </div>

            {/* Trust row */}
            <div className="flex items-center justify-center gap-3 text-[11px]" style={{ color: textSecondary }}>
              <div className="flex items-center gap-1">
                <Lock className="w-3 h-3" />
                Secure payment
              </div>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>Cancel anytime</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>Instant access</span>
            </div>
          </div>
        </div>

        {/* ── Sticky CTA ── */}
        <div
          className="flex-shrink-0 px-5 pt-4"
          style={{
            background: heroBg,
            ...glassStyle(true),
            borderRadius: 0,
            paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
            boxShadow: "0 -1px 0 rgba(255,255,255,0.06)",
          }}
        >
          <div className="max-w-sm mx-auto w-full flex flex-col gap-2">

            {/* Primary CTA */}
            <button
              data-testid="button-subscribe"
              onClick={handleSubscribe}
              disabled={busy}
              className="w-full h-14 rounded-2xl font-bold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-60"
              style={{ background: "linear-gradient(180deg, #c9a84c, #b08a30)", color: "#0a0f1e", boxShadow: "0 4px 20px rgba(201,168,76,0.35)" }}
            >
              {purchasing
                ? <Loader2 className="w-5 h-5 animate-spin" />
                : <Sparkles className="w-4 h-4" />}
              {purchasing ? "Processing…" : "Start Free Trial"}
            </button>

            {/* Renewal notice — explicit price per Apple guidelines */}
            <p className="text-center text-[11px] pt-1" style={{ color: textSecondary }}>
              Subscription renews automatically at {displayPrice}. Cancel anytime.
            </p>

            {/* Legal links — tappable, required by Apple 3.1.2(c) */}
            <div className="flex items-center justify-center gap-4 pb-1">
              <button
                onClick={() => openUrl(EULA_URL)}
                className="flex items-center gap-1 text-[12px] font-medium active:opacity-60"
                style={{ color: gold }}
              >
                <ExternalLink className="w-3 h-3" />
                Terms of Use
              </button>
              <span style={{ color: textSecondary, opacity: 0.4 }}>·</span>
              <button
                onClick={() => openUrl(PRIVACY_URL)}
                className="flex items-center gap-1 text-[12px] font-medium active:opacity-60"
                style={{ color: gold }}
              >
                <ExternalLink className="w-3 h-3" />
                Privacy Policy
              </button>
            </div>
          </div>
        </div>
      </div>

      <ProUnlockCelebration
        playing={celebrating}
        onComplete={() => { setTheme("pro"); onBack?.(); }}
      />
    </>
  );
}
