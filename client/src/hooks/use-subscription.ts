import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { getSubscriptionStatus, ENTITLEMENT_ID } from "@/lib/purchases";

export type SubscriptionStatus = "active" | "trialing" | "expired" | "past_due" | "canceled" | "unpaid" | "incomplete" | "incomplete_expired" | "none";

export interface SubscriptionInfo {
  status: SubscriptionStatus;
  /** true when user has a real active subscription */
  active: boolean;
  /** true when user can access gated features — strictly requires active === true */
  canUseGatedFeatures: boolean;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  /** Days remaining in trial, or null if not trialing */
  trialDaysLeft: number | null;
  isTrialing: boolean;
  loading: boolean;
}

interface NativeState {
  active: boolean;
  status: SubscriptionStatus;
  loading: boolean;
}

export function useSubscription(): SubscriptionInfo {
  const isNative = Capacitor.isNativePlatform();

  // ── Web branch ───────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery<{
    status: SubscriptionStatus;
    active: boolean;
    currentPeriodEnd: number | null;
    trialEnd: number | null;
  }>({
    queryKey: ["/api/subscription"],
    retry: false,
    staleTime: 60_000,
    enabled: !isNative,
  });

  // Safety timeout: if fetch takes > 2 s, unblock the app.
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    if (isNative) return;
    if (!isLoading) { setLoadingTimedOut(false); return; }
    const t = setTimeout(() => setLoadingTimedOut(true), 2000);
    return () => clearTimeout(t);
  }, [isLoading, isNative]);

  // ── Native branch ────────────────────────────────────────────────────────────
  const [nativeState, setNativeState] = useState<NativeState>({
    active: false,
    status: "none",
    loading: true,
  });

  useEffect(() => {
    if (!isNative) return;

    let listenerId: string | null = null;
    let cancelled = false;

    const refreshFromRevenueCat = async () => {
      try {
        const result = await getSubscriptionStatus();
        if (!cancelled) {
          const isPro = result === "pro";
          setNativeState({ active: isPro, status: isPro ? "active" : "none", loading: false });
        }
      } catch {
        if (!cancelled) {
          setNativeState({ active: false, status: "none", loading: false });
        }
      }
    };

    (async () => {
      await refreshFromRevenueCat();

      try {
        const { Purchases } = await import("@revenuecat/purchases-capacitor");
        const id = await Purchases.addCustomerInfoUpdateListener((info) => {
          if (cancelled) return;
          const isPro = !!info?.entitlements?.active?.[ENTITLEMENT_ID];
          setNativeState({ active: isPro, status: isPro ? "active" : "none", loading: false });
        });

        if (cancelled) {
          // Unmounted before listener registered — remove immediately
          Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: id }).catch(() => {});
        } else {
          listenerId = id;
        }
      } catch {
        // Listener registration failed — initial fetch result still valid
      }
    })();

    return () => {
      cancelled = true;
      if (listenerId) {
        import("@revenuecat/purchases-capacitor").then(({ Purchases }) => {
          Purchases.removeCustomerInfoUpdateListener({ listenerToRemove: listenerId! }).catch(() => {});
        });
      }
    };
  }, [isNative]);

  // ── Native return ────────────────────────────────────────────────────────────
  if (isNative) {
    return {
      status: nativeState.status,
      active: nativeState.active,
      canUseGatedFeatures: nativeState.active,
      currentPeriodEnd: null,
      trialEnd: null,
      trialDaysLeft: null,
      isTrialing: false,
      loading: nativeState.loading,
    };
  }

  // ── Web return ───────────────────────────────────────────────────────────────
  const effectivelyLoading = isLoading && !loadingTimedOut;
  const status = data?.status ?? "none";
  const trialEnd = data?.trialEnd ?? null;
  const isTrialing = status === "trialing";
  const trialDaysLeft = isTrialing && trialEnd
    ? Math.max(0, Math.ceil((trialEnd * 1000 - Date.now()) / 86_400_000))
    : null;
  const active = data?.active ?? false;

  return {
    status,
    active,
    canUseGatedFeatures: active,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    trialEnd,
    trialDaysLeft,
    isTrialing,
    loading: effectivelyLoading,
  };
}
