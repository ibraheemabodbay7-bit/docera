import { useState, useEffect } from "react";
import {
  AlignRight, ScanLine, FileText, Check, Lock, X, Sparkles, RotateCcw, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  purchaseMonthlyPlan,
  restorePurchases,
  getMonthlyPackage,
  isNativePlatform,
} from "@/lib/purchases";
import { queryClient } from "@/lib/queryClient";
import { isDarkMode } from "@/lib/theme";

// ── Feature list ──────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: AlignRight, text: "10 handwriting scans per month" },
  { icon: ScanLine,   text: "Scan and edit documents" },
  { icon: FileText,   text: "Export files" },
];

// ── Fallback strings (shown before RevenueCat price loads) ────────────────────
const FALLBACK_PRICE      = "₪19.90/month";
const FALLBACK_SUBTITLE   = "7 days free, then ₪19.90/month. Cancel anytime.";

const ORB_LIGHT = [
  "radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%)",
  "radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%)",
  "radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%)",
  "#b8c0cc",
].join(", ");

const ORB_DARK = [
  "radial-gradient(ellipse at 20% 15%, #1a1a1f 0%, #0e0e12 30%, transparent 60%)",
  "radial-gradient(ellipse at 80% 85%, #16161a 0%, #0a0a0c 35%, transparent 65%)",
  "radial-gradient(ellipse at 50% 50%, #000000 0%, transparent 50%)",
  "#050507",
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
  const [restoring,  setRestoring]  = useState(false);
  const [priceString, setPriceString] = useState<string | null>(null);

  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const cardBg = dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)";
  const heroBg = dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)";
  const textPrimary = dark ? "#ececef" : "#1a1f2a";
  const textSecondary = dark ? "#a0a8b8" : "#4a5262";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  useEffect(() => {
    getMonthlyPackage().then((pkg) => {
      if (pkg?.priceString) setPriceString(pkg.priceString);
    });
  }, []);

  const displayPrice    = priceString ? `${priceString}/month` : FALLBACK_PRICE;
  const displaySubtitle = priceString
    ? `7 days free, then ${priceString}/month. Cancel anytime.`
    : FALLBACK_SUBTITLE;

  // ── Sync purchase to backend after RevenueCat confirms it ─────────────────
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
    queryClient.invalidateQueries({ queryKey: ["/api/credits/hw"] });
  };

  // ── Subscribe ─────────────────────────────────────────────────────────────
  const handleSubscribe = async () => {
    if (!isNativePlatform()) {
      toast({ title: "Available on the mobile app" });
      return;
    }
    setPurchasing(true);
    try {
      const status = await purchaseMonthlyPlan();
      if (status === "pro") {
        await activateOnServer();
        toast({ title: "Welcome to Docera Pro!" });
        onBack?.();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Purchase failed. Please try again.";
      toast({ title: "Purchase failed", description: msg, variant: "destructive" });
    } finally {
      setPurchasing(false);
    }
  };

  // ── Restore ───────────────────────────────────────────────────────────────
  const handleRestore = async () => {
    if (!isNativePlatform()) {
      toast({ title: "Available on the mobile app" });
      return;
    }
    setRestoring(true);
    try {
      const { status, error } = await restorePurchases();
      if (status === "pro") {
        await activateOnServer();
        toast({ title: "Purchases restored!", description: "Your subscription is active again." });
        onBack?.();
      } else if (error) {
        toast({ title: "Restore failed", description: error, variant: "destructive" });
      } else {
        toast({ title: "No purchases found", description: "No previous subscription was found for your account." });
      }
    } finally {
      setRestoring(false);
    }
  };

  const busy = purchasing || restoring;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="min-h-screen flex flex-col" style={{ position: "relative", zIndex: 1, background: "transparent" }}>

        {/* ── Hero ── */}
        <div
          className="flex-shrink-0 relative px-5 pb-10 text-center"
          style={{
            background: heroBg,
            ...glassStyle(dark),
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
              style={{ background: dark ? "rgba(255,255,255,0.12)" : "rgba(26,31,42,0.1)", top: "max(1rem, env(safe-area-inset-top))" }}
            >
              <X className="w-4 h-4" style={{ color: textPrimary }} />
            </button>
          )}

          {lockedFeature && (
            <div
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 mb-5"
              style={{ background: dark ? "rgba(255,255,255,0.12)" : "rgba(26,31,42,0.08)", border: dark ? "1px solid rgba(255,255,255,0.15)" : "1px solid rgba(26,31,42,0.12)" }}
            >
              <Lock className="w-3 h-3 text-amber-400" />
              <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                {lockedFeature} requires a subscription
              </span>
            </div>
          )}

          <h1 className="text-[30px] font-extrabold leading-tight mb-3" style={{ color: textPrimary }}>
            Start your free trial
          </h1>
          <p className="text-base font-medium" style={{ color: textSecondary }}>
            {displaySubtitle}
          </p>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto px-5 pt-6 pb-10">
          <div className="max-w-sm mx-auto flex flex-col gap-5">

            {/* Feature list */}
            <div
              className="rounded-3xl p-5 flex flex-col gap-4"
              style={{ background: cardBg, ...glassStyle(dark) }}
            >
              {FEATURES.map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: dark ? "rgba(255,255,255,0.08)" : "rgba(26,31,42,0.06)" }}>
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <span className="text-sm font-medium flex-1" style={{ color: textPrimary }}>{text}</span>
                  <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                </div>
              ))}
            </div>

            {/* Pricing summary */}
            <div
              className="rounded-2xl px-5 py-4 flex items-center justify-between"
              style={{ background: cardBg, ...glassStyle(dark) }}
            >
              <div>
                <p className="text-sm font-semibold" style={{ color: textPrimary }}>Monthly plan</p>
                <p className="text-xs mt-0.5" style={{ color: textSecondary }}>Cancel anytime · no hidden fees</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-primary font-semibold">Free for 7 days</p>
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
            ...glassStyle(dark),
            borderRadius: 0,
            paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
            boxShadow: dark ? "0 -1px 0 rgba(255,255,255,0.06)" : "0 -1px 0 rgba(255,255,255,0.6)",
          }}
        >
          <div className="max-w-sm mx-auto w-full flex flex-col gap-2">

            {/* Primary CTA */}
            <button
              data-testid="button-subscribe"
              onClick={handleSubscribe}
              disabled={busy}
              className="w-full h-14 rounded-2xl font-bold text-base flex items-center justify-center gap-2 active:scale-[0.98] transition-all bg-primary text-primary-foreground disabled:opacity-60"
              style={{ boxShadow: "0 4px 20px rgba(17,62,97,0.35)" }}
            >
              {purchasing
                ? <Loader2 className="w-5 h-5 animate-spin" />
                : <Sparkles className="w-4 h-4" />}
              {purchasing ? "Processing…" : "Start Free Trial"}
            </button>

            {/* Restore Purchases — required by Apple App Store */}
            <button
              data-testid="button-restore-purchases"
              onClick={handleRestore}
              disabled={busy}
              className="w-full h-12 rounded-2xl text-sm font-semibold active:opacity-60 flex items-center justify-center gap-2 disabled:opacity-40"
              style={{ background: dark ? "rgba(255,255,255,0.06)" : "rgba(26,31,42,0.06)", color: textPrimary, border: dark ? "0.5px solid rgba(255,255,255,0.08)" : "0.5px solid rgba(26,31,42,0.12)" }}
            >
              {restoring
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <RotateCcw className="w-3.5 h-3.5" style={{ color: textSecondary }} />}
              {restoring ? "Restoring…" : "Restore Purchases"}
            </button>

            {/* Legal */}
            <p className="text-center text-[11px] pt-1 pb-1" style={{ color: textSecondary }}>
              Subscription renews automatically. Cancel anytime.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
