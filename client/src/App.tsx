import { useState, useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { initPurchases } from "@/lib/purchases";
import { Capacitor } from "@capacitor/core";
import HomePage from "./pages/HomePage";
import ScannerPage from "./pages/ScannerPage";
import ViewerPage from "./pages/ViewerPage";
import FolderPage from "./pages/FolderPage";
import ProfilePage from "./pages/ProfilePage";
import PaywallPage from "./pages/PaywallPage";
import ClientsPage from "./pages/ClientsPage";
import GmailInboxPage from "./pages/GmailInboxPage";
import AllDocumentsPage from "./pages/AllDocumentsPage";
import { useSubscription } from "./hooks/use-subscription";
import { Loader2, Sparkles, X, Camera as CameraIcon, Image as ImageIcon } from "lucide-react";

export type ActiveView = "inbox" | "chat" | "contacts" | "files" | "camera";

type View =
  | { name: "home" }
  | { name: "scanner"; folderId?: string; clientId?: string; entryMode?: "camera" | "gallery"; preCapturedFileUris?: string[] }
  | { name: "editor"; docId: string }
  | { name: "viewer"; docId: string }
  | { name: "folder"; folderId: string; folderName: string }
  | { name: "profile" }
  | { name: "paywall"; returnTo: View; lockedFeature?: string }
  | { name: "clients" }
  | { name: "inbox" }
  | { name: "allDocs" };

interface AppUser {
  id: string;
  name: string;
  username: string;
  senderName: string | null;
}

/** Returns true when the signed-in account is a device-scoped guest. */
function isGuestUser(user: AppUser): boolean {
  return user.username.endsWith("@docera.guest");
}

/** Returns a stable device ID from localStorage, creating one on first call. */
function getOrCreateDeviceId(): string {
  const KEY = "docera_guest_device_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(KEY, id);
  }
  return id;
}

const USER_CACHE_KEY = "docera_cached_user";

function getCachedUser(): AppUser | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

function setCachedUser(user: AppUser) {
  try { localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user)); } catch {}
}

/** Creates or restores the device-scoped guest session. */
async function ensureGuestSession(): Promise<AppUser | null> {
  try {
    const deviceId = getOrCreateDeviceId();
    const res = await fetch("/api/auth/guest-device", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
    if (res.ok) return res.json();
  } catch {
    // network error
  }
  return null;
}

/** Top banner shown while the user is on a free trial. */
function TrialBanner({ daysLeft, onDismiss, onUpgrade }: {
  daysLeft: number; onDismiss: () => void; onUpgrade: () => void;
}) {
  const label = daysLeft <= 1
    ? "Last day of your free trial"
    : `${daysLeft} day${daysLeft !== 1 ? "s" : ""} left in your free trial`;
  return (
    <div
      data-testid="trial-banner"
      className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-between px-4 py-2.5 text-white text-[12px] font-semibold"
      style={{ backgroundColor: "#113e61", paddingTop: "max(0.625rem, env(safe-area-inset-top))" }}
    >
      <button onClick={onUpgrade} className="flex items-center gap-1.5 flex-1 min-w-0 text-left active:opacity-70">
        <Sparkles className="w-3.5 h-3.5 text-amber-300 flex-shrink-0" />
        <span className="truncate">{label} · Subscribe — ₪19.90/mo</span>
      </button>
      <button onClick={onDismiss} className="opacity-60 active:opacity-100 ml-3 flex-shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function AppWithAuth() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscriptionTimedOut, setSubscriptionTimedOut] = useState(false);
  const [view, setView] = useState<View>({ name: "home" });
  const [trialBannerDismissed, setTrialBannerDismissed] = useState(false);
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  const [scanSheetOpen, setScanSheetOpen] = useState(false);
  const subscription = useSubscription();

  useEffect(() => {
    initPurchases().catch(() => {});
  }, []);

  // Safety net: if subscription query hangs for more than 5 seconds, stop blocking the UI
  useEffect(() => {
    if (!subscription.loading) return;
    const tid = setTimeout(() => setSubscriptionTimedOut(true), 2000);
    return () => clearTimeout(tid);
  }, [subscription.loading]);

  useEffect(() => {
    async function initAuth() {
      // On native Capacitor: always resolve instantly from localStorage, no fetch.
      if (Capacitor.isNativePlatform()) {
        const cached = getCachedUser();
        if (cached) {
          setUser(cached);
        } else {
          const deviceId = getOrCreateDeviceId();
          const localGuest: AppUser = {
            id: deviceId,
            name: "Guest",
            username: `${deviceId}@docera.guest`,
            senderName: null,
          };
          setCachedUser(localGuest);
          setUser(localGuest);
        }
        setLoading(false);
        return;
      }

      // Hard timeout: if auth takes more than 3 s bail out to guest flow.
      const authTimeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 3000)
      );

      // 1. Try to resume an existing server session (with timeout)
      try {
        const meRes = await Promise.race([
          fetch("/api/auth/me", { credentials: "include" }),
          authTimeout.then(() => null),
        ]);
        if (meRes && meRes.ok) {
          const u = await meRes.json();
          setCachedUser(u);
          setUser(u);
          setLoading(false);
          return;
        }
      } catch {
        // network error — fall through to guest
      }

      // 2. No session → silently create/restore device-scoped guest account
      const guestTimeout = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 3000)
      );
      const guest = await Promise.race([ensureGuestSession(), guestTimeout]);
      if (guest) {
        setCachedUser(guest);
        setUser(guest);
      }
      setLoading(false);
    }
    initAuth();
  }, []);

  // Handle Stripe redirect back from subscription checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      window.history.replaceState({}, "", "/");
      fetch("/api/stripe/sync", { method: "POST", credentials: "include" })
        .then(() => queryClient.invalidateQueries({ queryKey: ["/api/subscription"] }))
        .catch(() => queryClient.invalidateQueries({ queryKey: ["/api/subscription"] }));
    }
  }, []);

  // Handle Stripe redirect back from credit top-up checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("topup") === "success") {
      window.history.replaceState({}, "", "/");
      // Refresh credits count so the Handwriting tab immediately reflects the new balance
      queryClient.invalidateQueries({ queryKey: ["/api/credits/hw"] });
    }
  }, []);

  if (loading || (subscription.loading && !subscriptionTimedOut)) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Edge case: guest creation failed (offline on first launch)
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 px-8 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Connecting…</p>
        <button
          className="text-xs text-primary underline"
          onClick={async () => {
            setLoading(true);
            const guest = await ensureGuestSession();
            if (guest) setUser(guest);
            setLoading(false);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const isGuest = isGuestUser(user);

  const goHome = () => setView({ name: "home" });

  const goScanner = (folderId?: string, clientId?: string) => {
    if (!subscription.canUseGatedFeatures) {
      setView({ name: "paywall", returnTo: { name: "home" }, lockedFeature: "Scanning" });
      return;
    }
    setScanSheetOpen(false);
    setView({ name: "scanner", folderId, clientId });
  };

  const goScannerGallery = () => {
    if (!subscription.canUseGatedFeatures) {
      setView({ name: "paywall", returnTo: { name: "home" }, lockedFeature: "Scanning" });
      return;
    }
    setScanSheetOpen(false);
    setView({ name: "scanner", entryMode: "gallery" });
  };

  const goScannerNative = async () => {
    if (!subscription.canUseGatedFeatures) {
      setView({ name: "paywall", returnTo: { name: "home" }, lockedFeature: "Scanning" });
      return;
    }
    setScanSheetOpen(false);
    try {
      const { DocumentScanner } = await import("@capgo/capacitor-document-scanner");
      const result = await DocumentScanner.scanDocument();
      if (!result.scannedImages?.length) return;
      setView({ name: "scanner", preCapturedFileUris: result.scannedImages });
    } catch {
      // user cancelled or scanner unavailable — do nothing
    }
  };

  const goEditor = (docId: string) => {
    if (!subscription.canUseGatedFeatures) {
      setView({ name: "paywall", returnTo: { name: "home" }, lockedFeature: "Editing" });
      return;
    }
    setView({ name: "editor", docId });
  };

  const goViewer = (docId: string) => {
    setView({ name: "viewer", docId });
  };

  const goFolder = (folderId: string, folderName: string) => {
    setView({ name: "folder", folderId, folderName });
  };

  const goProfile = () => setView({ name: "profile" });

  const goClients = () => setView({ name: "clients" });
  const goInbox = () => setView({ name: "inbox" });
  const goAllDocs = () => setView({ name: "allDocs" });

  // Logout clears the server session then immediately restores the same
  // device-scoped guest account — so documents stay accessible.
  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    queryClient.clear();
    const guest = await ensureGuestSession();
    if (guest) {
      setCachedUser(guest);
      setUser(guest);
      queryClient.invalidateQueries({ queryKey: ["/api/subscription"] });
    } else {
      setUser(null);
    }
  };

  // ── Paywall view ──
  if (view.name === "paywall") {
    const returnView = view.returnTo;
    const lockedFeature = view.lockedFeature;
    return (
      <PaywallPage
        lockedFeature={lockedFeature}
        onBack={() => setView(returnView)}
      />
    );
  }

  if (view.name === "clients") {
    return (
      <ClientsPage onBack={goHome} onOpenDoc={goViewer} onScan={(clientId) => goScanner(undefined, clientId)} />
    );
  }

  if (view.name === "inbox") {
    return <GmailInboxPage onBack={goHome} onUnreadCount={setInboxUnreadCount} />;
  }

  if (view.name === "allDocs") {
    return <AllDocumentsPage onBack={goHome} onOpenDoc={goViewer} onEditDoc={goEditor} />;
  }

  if (view.name === "scanner") {
    return (
      <ScannerPage
        folderId={view.folderId}
        clientId={view.clientId}
        entryMode={view.entryMode}
        preCapturedFileUris={view.preCapturedFileUris}
        onSaved={goHome}
        onCancel={goHome}
      />
    );
  }
  if (view.name === "editor") {
    return (
      <ScannerPage
        editDocId={view.docId}
        onSaved={goHome}
        onCancel={() => goViewer(view.docId)}
      />
    );
  }
  if (view.name === "viewer") {
    return (
      <ViewerPage
        docId={view.docId}
        onBack={goHome}
        onDeleted={goHome}
        onEdit={goEditor}
        onEditText={() => {}}
        subscription={subscription}
        onPaywall={(feature) => setView({ name: "paywall", returnTo: { name: "viewer", docId: view.docId }, lockedFeature: feature })}
      />
    );
  }

  // Trial banner — shown on main nav views when user is trialing
  const showTrialBanner =
    subscription.isTrialing &&
    !trialBannerDismissed &&
    (view.name === "home" || view.name === "folder" || view.name === "profile");

  const trialBannerEl = showTrialBanner && subscription.trialDaysLeft !== null ? (
    <TrialBanner
      daysLeft={subscription.trialDaysLeft}
      onDismiss={() => setTrialBannerDismissed(true)}
      onUpgrade={() => setView({ name: "paywall", returnTo: view })}
    />
  ) : null;

  if (view.name === "folder") {
    return (
      <>
        {trialBannerEl}
        <FolderPage
          folderId={view.folderId}
          folderName={view.folderName}
          onBack={goHome}
          onScan={() => goScanner(view.folderId)}
          onOpenDoc={goViewer}
          onEditDoc={goEditor}
          onProfile={goProfile}
        />
      </>
    );
  }
  if (view.name === "profile") {
    return (
      <>
        {trialBannerEl}
        <ProfilePage
          user={user}
          onBack={goHome}
          onLogout={handleLogout}
          subscription={subscription}
          onUpgrade={() => setView({ name: "paywall", returnTo: { name: "profile" } })}
          isGuest={isGuest}
        />
      </>
    );
  }

  return (
    <>
      {trialBannerEl}
      <HomePage
        user={user}
        onScan={() => setScanSheetOpen(true)}
        onOpenDoc={goViewer}
        onEditDoc={goEditor}
        onOpenFolder={goFolder}
        onProfile={goProfile}
        onOpenClients={goClients}
        onOpenInbox={goInbox}
        inboxUnreadCount={inboxUnreadCount}
        onLogout={handleLogout}
        onOpenAllDocs={goAllDocs}
      />
      {/* Scan action sheet — appears when user taps the Scan button on the home tab bar */}
      {scanSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setScanSheetOpen(false)}
        >
          <div
            className="w-full rounded-t-3xl"
            style={{
              background: "#1c1c1e",
              padding: "8px 16px",
              paddingBottom: "max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem))",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2 pb-4">
              <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.2)" }} />
            </div>

            {/* Take Photo */}
            <button
              onClick={() => goScannerNative()}
              className="w-full flex items-center gap-4 rounded-2xl active:opacity-70"
              style={{ padding: "14px 16px", marginBottom: 2, background: "rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-center justify-center rounded-full"
                style={{ width: 44, height: 44, background: "rgba(59,130,246,0.18)", flexShrink: 0 }}>
                <CameraIcon style={{ width: 22, height: 22, color: "#3b82f6" }} />
              </div>
              <div className="text-left">
                <p style={{ color: "#ececef", fontSize: 16, fontWeight: 600, margin: 0 }}>Take Photo</p>
                <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0, marginTop: 1 }}>Use camera to scan a document</p>
              </div>
            </button>

            {/* Choose from Gallery */}
            <button
              onClick={() => goScannerGallery()}
              className="w-full flex items-center gap-4 rounded-2xl active:opacity-70"
              style={{ padding: "14px 16px", marginBottom: 12, background: "rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-center justify-center rounded-full"
                style={{ width: 44, height: 44, background: "rgba(59,130,246,0.18)", flexShrink: 0 }}>
                <ImageIcon style={{ width: 22, height: 22, color: "#3b82f6" }} />
              </div>
              <div className="text-left">
                <p style={{ color: "#ececef", fontSize: 16, fontWeight: 600, margin: 0 }}>Choose from Gallery</p>
                <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0, marginTop: 1 }}>Import existing photos</p>
              </div>
            </button>

            {/* Cancel */}
            <button
              onClick={() => setScanSheetOpen(false)}
              className="w-full py-3.5 rounded-2xl active:opacity-70"
              style={{ background: "rgba(255,255,255,0.1)", color: "#ececef", fontSize: 16, fontWeight: 600 }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppWithAuth />
      <Toaster />
    </QueryClientProvider>
  );
}
