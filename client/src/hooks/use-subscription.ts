import { useQuery } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import { FREE_TIER_LIMIT } from "@/lib/purchases";

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
  loading: boolean;
  /** Number of documents the user currently has */
  scanCount: number;
  /** true when a free user is at or over FREE_TIER_LIMIT; false while count is still loading */
  scanLimitReached: boolean;
}

export function useSubscription(): SubscriptionInfo {
  const isNative = Capacitor.isNativePlatform();

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
  // Unchanged — governs the Gmail send gate in ViewerPage (Gmail is free under Model B).
  const canUseGatedFeatures = active || status === "none";

  // Share the ["/api/documents"] cache that ScannerPage already invalidates on every save,
  // so no ScannerPage edits are needed. On native, override queryFn to read IndexedDB.
  const { data: allDocs, isLoading: docsLoading } = useQuery<Array<unknown>>({
    queryKey: ["/api/documents"],
    ...(isNative ? {
      queryFn: async () => {
        const { listLocalDocs } = await import("@/lib/localDocs");
        return listLocalDocs();
      },
    } : {}),
    retry: false,
  });

  const isPro = active;
  const scanCount = allDocs?.length ?? 0;
  // While docs are loading, treat count as 0 — never block during the loading race.
  const scanLimitReached = !isPro && !docsLoading && scanCount >= FREE_TIER_LIMIT;

  return {
    status,
    active,
    canUseGatedFeatures,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    trialEnd,
    trialDaysLeft,
    isTrialing,
    loading: effectivelyLoading,
    scanCount,
    scanLimitReached,
  };
}
