import { Capacitor } from "@capacitor/core";

// ── API keys ──────────────────────────────────────────────────────────────────
// Platform-specific public keys from RevenueCat dashboard.
// In production these must match the RevenueCat "App" configured for each store.
// The universal TEST key is used as fallback (works in browser / CI / test store).
const REVENUECAT_IOS_API_KEY     = import.meta.env.VITE_REVENUECAT_IOS_API_KEY     as string | undefined;
const REVENUECAT_ANDROID_API_KEY = import.meta.env.VITE_REVENUECAT_ANDROID_API_KEY as string | undefined;
const REVENUECAT_TEST_API_KEY    = import.meta.env.VITE_REVENUECAT_API_KEY          as string | undefined;

export const ENTITLEMENT_ID = "pro";

// ── Platform helpers ──────────────────────────────────────────────────────────

export type NativePlatform = "ios" | "android";

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

export function getNativePlatform(): NativePlatform | null {
  const p = Capacitor.getPlatform();
  if (p === "ios") return "ios";
  if (p === "android") return "android";
  return null;
}

/**
 * Returns the correct RevenueCat public API key for the current platform.
 *
 * iOS  → VITE_REVENUECAT_IOS_API_KEY     (Apple IAP)
 * Android → VITE_REVENUECAT_ANDROID_API_KEY (Google Play Billing)
 * Web / fallback → VITE_REVENUECAT_API_KEY  (test store / browser)
 */
function getPlatformApiKey(): string | null {
  const platform = getNativePlatform();
  if (platform === "ios")     return REVENUECAT_IOS_API_KEY     ?? REVENUECAT_TEST_API_KEY ?? null;
  if (platform === "android") return REVENUECAT_ANDROID_API_KEY ?? REVENUECAT_TEST_API_KEY ?? null;
  return REVENUECAT_TEST_API_KEY ?? null;
}

// ── Module singleton ──────────────────────────────────────────────────────────

let initialized = false;
let PurchasesModule: typeof import("@revenuecat/purchases-capacitor") | null = null;

async function ensureInitialized(): Promise<boolean> {
  if (!isNativePlatform()) return false;

  const apiKey = getPlatformApiKey();
  if (!apiKey) {
    console.warn(
      `[purchases] No RevenueCat API key for platform "${Capacitor.getPlatform()}". ` +
      "Set VITE_REVENUECAT_IOS_API_KEY / VITE_REVENUECAT_ANDROID_API_KEY / VITE_REVENUECAT_API_KEY."
    );
    return false;
  }

  if (initialized) return true;

  try {
    PurchasesModule = await import("@revenuecat/purchases-capacitor");
    await PurchasesModule.Purchases.configure({ apiKey });
    console.info(`[purchases] RevenueCat configured for ${Capacitor.getPlatform()}`);
    initialized = true;
    return true;
  } catch (err) {
    console.warn("[purchases] RevenueCat init failed:", err);
    return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function initPurchases(): Promise<void> {
  await ensureInitialized();
}

export type SubscriptionStatus = "free" | "pro";

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  const ready = await ensureInitialized();
  if (!ready || !PurchasesModule) return "free";

  try {
    const { customerInfo } = await PurchasesModule.Purchases.getCustomerInfo();
    return customerInfo.entitlements.active[ENTITLEMENT_ID] ? "pro" : "free";
  } catch {
    return "free";
  }
}

export interface MonthlyPackageInfo {
  priceString: string;
  identifier: string;
}

export async function getMonthlyPackage(): Promise<MonthlyPackageInfo | null> {
  const ready = await ensureInitialized();
  if (!ready || !PurchasesModule) return null;

  try {
    const offerings = await PurchasesModule.Purchases.getOfferings();
    const current = offerings.current;
    if (!current) return null;

    const pkg = current.monthly ?? current.availablePackages?.[0];
    if (!pkg) return null;

    return { priceString: pkg.product.priceString, identifier: pkg.identifier };
  } catch {
    return null;
  }
}

/**
 * Initiates the native subscription purchase sheet.
 *
 * iOS  → Apple App Store payment sheet (Apple IAP)
 * Android → Google Play billing dialog (Google Play Billing)
 *
 * Throws if the purchase fails; returns "free" silently if the user cancels.
 */
export async function purchaseMonthlyPlan(): Promise<SubscriptionStatus> {
  const ready = await ensureInitialized();
  if (!ready || !PurchasesModule) return "free";

  const offerings = await PurchasesModule.Purchases.getOfferings();
  const current = offerings.current;
  if (!current) throw new Error("No offerings available from the store.");

  const pkg = current.monthly ?? current.availablePackages?.[0];
  if (!pkg) throw new Error("No monthly package found in current offering.");

  try {
    const { customerInfo } = await PurchasesModule.Purchases.purchasePackage({ aPackage: pkg });
    return customerInfo.entitlements.active[ENTITLEMENT_ID] ? "pro" : "free";
  } catch (e: unknown) {
    // User cancelled — not an error, return silently
    if (typeof e === "object" && e !== null && "userCancelled" in e &&
        (e as Record<string, unknown>).userCancelled === true) {
      return "free";
    }
    throw e;
  }
}

/**
 * Restores previous purchases.
 *
 * Required by Apple App Store review guidelines.
 * Also supported on Google Play for account recovery.
 */
export async function restorePurchases(): Promise<{ status: SubscriptionStatus; error?: string }> {
  const ready = await ensureInitialized();
  if (!ready || !PurchasesModule) return { status: "free" };

  try {
    const { customerInfo } = await PurchasesModule.Purchases.restorePurchases();
    return { status: customerInfo.entitlements.active[ENTITLEMENT_ID] ? "pro" : "free" };
  } catch (e: unknown) {
    const message =
      typeof e === "object" && e !== null && "message" in e
        ? String((e as Record<string, unknown>).message)
        : "Restore failed";
    return { status: "free", error: message };
  }
}

/**
 * Returns the platform's subscription management URL for deep-linking.
 *
 * iOS → Apple subscriptions page
 * Android → Google Play subscriptions page
 */
export function getManageSubscriptionUrl(): string {
  const platform = getNativePlatform();
  if (platform === "ios")     return "https://apps.apple.com/account/subscriptions";
  if (platform === "android") return "https://play.google.com/store/account/subscriptions";
  return "";
}

export const FREE_TIER_LIMIT = 5;
