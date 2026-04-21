import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Capacitor } from "@capacitor/core";

export type SubscriptionStatus = "active" | "trialing" | "expired" | "past_due" | "canceled" | "unpaid" | "incomplete" | "incomplete_expired" | "none";

export interface SubscriptionInfo {
  status: SubscriptionStatus;
  /** true when user can use the app normally (active subscription or active trial) */
  active: boolean;
  /** true when user has access to gated features (scan, export, send email) */
  canUseGatedFeatures: boolean;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  /** Days remaining in trial, or null if not trialing */
  trialDaysLeft: number | null;
  isTrialing: boolean;
  /** true only when user has a real Stripe customer — required for billing portal */
  hasStripeCustomer: boolean;
  loading: boolean;
}

export function useSubscription(): SubscriptionInfo {
  const isNative = Capacitor.isNativePlatform();

  const { data, isLoading } = useQuery<{
    status: SubscriptionStatus;
    active: boolean;
    currentPeriodEnd: number | null;
    trialEnd: number | null;
    hasStripeCustomer: boolean;
  }>({
    queryKey: ["/api/subscription"],
    retry: false,
    staleTime: 60_000,
    enabled: !isNative,
  });

  // Safety timeout: if subscription fetch takes > 4 s (offline / server slow),
  // stop blocking the app so the loading spinner never gets stuck.
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  useEffect(() => {
    if (!isLoading) { setLoadingTimedOut(false); return; }
    const t = setTimeout(() => setLoadingTimedOut(true), 2000);
    return () => clearTimeout(t);
  }, [isLoading]);

  const effectivelyLoading = isLoading && !loadingTimedOut;

  const status = data?.status ?? "none";
  const trialEnd = data?.trialEnd ?? null;
  const isTrialing = status === "trialing";
  const trialDaysLeft = isTrialing && trialEnd
    ? Math.max(0, Math.ceil((trialEnd * 1000 - Date.now()) / 86_400_000))
    : null;
  const active = data?.active ?? false;
  // FIX: guests (no subscription) can still use all features.
  // Only block when we have confirmed subscription data showing it's expired/canceled.
  const canUseGatedFeatures = active || status === "none";

  return {
    status,
    active,
    canUseGatedFeatures,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    trialEnd,
    trialDaysLeft,
    isTrialing,
    hasStripeCustomer: data?.hasStripeCustomer ?? false,
    loading: effectivelyLoading,
  };
}
