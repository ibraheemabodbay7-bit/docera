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

// ── Feature list ──────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: AlignRight, text: "10 handwriting scans per month" },
  { icon: ScanLine,   text: "Scan and edit documents" },
  { icon: FileText,   text: "Export files" },
];

// ── Fallback strings (shown before RevenueCat price loads) ────────────────────
const FALLBACK_PRICE      = "₪19.90/month";
const FALLBACK_SUBTITLE   = "7 days free, then ₪19.90/month. Cancel anytime.";

interface PaywallPageProps {
  onBack?: () => void;
  lockedFeature?: string;
}

export default function PaywallPage({ onBack, lockedFeature }: PaywallPageProps) {
  const { toast } = useToast();
  const [purchasing, setPurchasing] = useState(false);
  const [restoring,  setRestoring]  = useState(false);
  const [priceString, setPriceString] = useState<string | null>(null);

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
    <div className="min-h-screen flex flex-col bg-background">

      {/* ── Hero ── */}
      <div
        className="flex-shrink-0 relative px-5 pb-10 text-center"
        style={{
          background: "linear-gradient(160deg, #113e61 0%, #1a5a8a 100%)",
          paddingTop: "max(3.5rem, env(safe-area-inset-top))",
        }}
      >
        {onBack && (
          <button
            data-testid="button-paywall-back"
            onClick={onBack}
            disabled={busy}
            className="absolute right-4 w-9 h-9 rounded-full bg-white/15 flex items-center justify-center active:opacity-60 disabled:opacity-40"
            style={{ top: "max(1rem, env(safe-area-inset-top))" }}
          >
            <X className="w-4 h-4 text-white" />
          </button>
        )}

        {lockedFeature && (
          <div className="inline-flex items-center gap-1.5 bg-white/15 border border-white/20 rounded-full px-3 py-1 mb-5">
            <Lock className="w-3 h-3 text-amber-300" />
            <span className="text-xs font-semibold text-white">
              {lockedFeature} requires a subscription
            </span>
          </div>
        )}

        <h1 className="text-[30px] font-extrabold text-white leading-tight mb-3">
          Start your free trial
        </h1>
        <p className="text-base text-white/70 font-medium">
          {displaySubtitle}
        </p>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto px-5 pt-6 pb-10">
        <div className="max-w-sm mx-auto flex flex-col gap-5">

          {/* Feature list */}
          <div className="bg-card rounded-3xl border border-border p-5 flex flex-col gap-4">
            {FEATURES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <span className="text-sm font-medium text-foreground flex-1">{text}</span>
                <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
              </div>
            ))}
          </div>

          {/* Pricing summary */}
          <div className="bg-primary/5 border border-primary/20 rounded-2xl px-5 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-foreground">Monthly plan</p>
              <p className="text-xs text-muted-foreground mt-0.5">Cancel anytime · no hidden fees</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-primary font-semibold">Free for 7 days</p>
              <p className="text-sm font-bold text-foreground">then {displayPrice}</p>
            </div>
          </div>

          {/* Trust row */}
          <div className="flex items-center justify-center gap-3 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1">
              <Lock className="w-3 h-3" />
              Secure payment
            </div>
            <span className="text-muted-foreground/30">·</span>
            <span>Cancel anytime</span>
            <span className="text-muted-foreground/30">·</span>
            <span>Instant access</span>
          </div>
        </div>
      </div>

      {/* ── Sticky CTA ── */}
      <div
        className="flex-shrink-0 bg-card border-t border-border px-5 pt-4"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
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
            className="w-full h-12 rounded-2xl border border-border text-sm font-semibold text-foreground active:opacity-60 flex items-center justify-center gap-2 disabled:opacity-40"
          >
            {restoring
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />}
            {restoring ? "Restoring…" : "Restore Purchases"}
          </button>

          {/* Legal */}
          <p className="text-center text-[11px] text-muted-foreground pt-1 pb-1">
            Subscription renews automatically. Cancel anytime.
          </p>
        </div>
      </div>
    </div>
  );
}
