import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { ArrowLeft, FileText, LogOut, ChevronRight, Check, X, Crown, User, Mail, Sparkles, Palette } from "lucide-react";
import { getSetting, setSetting } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import type { Document } from "@shared/schema";
import type { SubscriptionInfo } from "@/hooks/use-subscription";
import { isDarkMode, getThemeMode, getAppliedTheme } from "@/lib/theme";

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

interface ProfilePageProps {
  user: { id: string; name: string; username: string };
  onBack: () => void;
  onLogout: () => void;
  subscription: SubscriptionInfo;
  onUpgrade?: () => void;
  isGuest?: boolean;
  onOpenThemePicker: () => void;
}

export default function ProfilePage({ user, onBack, onLogout, subscription, onUpgrade, isGuest = false, onOpenThemePicker }: ProfilePageProps) {
  const { toast } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(user.name);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // App preferences (localStorage)
  const [filenamePrefix, setFilenamePrefix] = useState(() => getSetting("filenamePrefix", "Scan"));
  const [prefixEditing, setPrefixEditing] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState(filenamePrefix);

  const { data: docs = [] } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => {
      const res = await apiFetch("/api/documents");
      return res.json();
    },
  });


  const updateName = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("PUT", "/api/auth/profile", { name });
      return res.json() as Promise<{ name: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      user.name = data.name;
      setEditingName(false);
      toast({ title: "Name updated" });
    },
    onError: () => toast({ title: "Failed to update name", variant: "destructive" }),
  });


  const dark = isDarkMode();
  const orbBg = getAppliedTheme() === "pro" ? ORB_PRO : (dark ? ORB_DARK : ORB_LIGHT);
  const isPro = getAppliedTheme() === "pro";
  const cardBg = isPro ? "rgba(17,25,53,0.65)" : (dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)");
  const headerBg = isPro ? "rgba(13,27,62,0.5)" : (dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)");
  const textPrimary = isPro ? "#f4ead0" : (dark ? "#ececef" : "#1a1f2a");
  const textSecondary = isPro ? "#a89970" : (dark ? "#a0a8b8" : "#4a5262");
  const borderColor = isPro ? "rgba(201,168,76,0.18)" : (dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)");

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  const totalSizeMB = docs.reduce((acc, d) => acc + d.size, 0) / 1024 / 1024;
  const initials = user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  const periodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd * 1000).toLocaleDateString()
    : null;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="min-h-screen flex flex-col" style={{ position: "relative", zIndex: 1, background: "transparent" }}>
      <div className="flex-shrink-0 flex items-center gap-3 px-4 pb-4" style={{ paddingTop: "max(3rem, env(safe-area-inset-top))", background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, borderBottom: `0.5px solid ${borderColor}` }}>
        <button data-testid="button-back" onClick={onBack}
          className="w-11 h-11 rounded-xl flex items-center justify-center -ml-1" style={{ color: textPrimary }}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-base font-bold" style={{ color: textPrimary }}>Profile & Settings</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 px-4" style={{ paddingTop: 14, paddingBottom: 8 }}>
          <div className="w-11 h-11 rounded-full bg-primary flex items-center justify-center shadow-md flex-shrink-0">
            <span className="text-primary-foreground text-base font-bold">{initials}</span>
          </div>
          <div className="flex-1 min-w-0">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) updateName.mutate(newName.trim());
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  className="px-3 py-1.5 rounded-xl bg-muted text-sm text-foreground border-0 outline-none min-w-0 flex-1"
                />
                <button onClick={() => { if (newName.trim()) updateName.mutate(newName.trim()); }}
                  className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
                  <Check className="w-3.5 h-3.5 text-primary-foreground" />
                </button>
                <button onClick={() => { setEditingName(false); setNewName(user.name); }}
                  className="w-7 h-7 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                  <X className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <button onClick={() => setEditingName(true)} className="group flex items-center gap-1.5">
                <span className="text-base font-bold" style={{ color: textPrimary }}>{user.name}</span>
                <span className="text-xs opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: textSecondary }}>Edit</span>
              </button>
            )}
            {!isGuest && (
              <p className="text-xs mt-0.5" style={{ color: textSecondary }}>{user.username}</p>
            )}
            {subscription.status === "active" && (
              <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-gradient-to-r from-amber-100 to-orange-100 text-amber-700"
                data-testid="badge-subscription">
                <Crown className="w-2.5 h-2.5" />
                Pro
              </div>
            )}
            {subscription.status === "trialing" && (
              <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-primary/10 text-primary"
                data-testid="badge-subscription">
                <Sparkles className="w-2.5 h-2.5" />
                Free Trial
              </div>
            )}
            {(subscription.status === "expired" || subscription.status === "canceled" || subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "none") && (
              <div className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-muted-foreground"
                data-testid="badge-subscription">
                No active plan
              </div>
            )}
          </div>
        </div>

        {/* Subscription */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Subscription</p>
          <div className="rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center" style={isPro ? { background: "rgba(244,234,208,0.15)", backgroundImage: "none" } : undefined}>
                <Crown className="w-4 h-4 text-amber-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Docera Pro</p>
                <p className="text-xs text-muted-foreground">
                  {subscription.status === "active"
                    ? "Active" + (periodEnd ? ` · Renews ${periodEnd}` : "")
                    : subscription.status === "trialing"
                      ? `Free trial · ${subscription.trialDaysLeft ?? "?"} day${subscription.trialDaysLeft !== 1 ? "s" : ""} left`
                      : subscription.status === "expired"
                        ? "Trial ended · Subscribe to continue"
                        : subscription.status === "canceled"
                          ? "Subscription canceled"
                          : subscription.status === "past_due"
                            ? "Payment past due · Update billing"
                            : subscription.status === "unpaid"
                              ? "Payment failed · Update billing"
                              : subscription.status === "none"
                                ? "No active plan"
                                : subscription.status}
                </p>
              </div>
              {!subscription.active && onUpgrade && (
                <button
                  data-testid="button-upgrade-profile"
                  onClick={onUpgrade}
                  className="text-xs font-bold text-primary active:opacity-60 whitespace-nowrap"
                >
                  Upgrade
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Storage */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Storage</p>
          <div className="rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                <FileText className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Documents</p>
                <p className="text-xs text-muted-foreground">{docs.length} file{docs.length !== 1 ? "s" : ""}{totalSizeMB > 0 ? ` · ${totalSizeMB < 1 ? `${(totalSizeMB * 1024).toFixed(0)} KB` : `${totalSizeMB.toFixed(1)} MB`} used` : ""}</p>
              </div>
              <span className="text-sm font-semibold text-foreground">{docs.length}</span>
            </div>
          </div>
        </div>

        {/* Account */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Account</p>
          <div className="rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Name</p>
                <p className="text-xs text-muted-foreground truncate">{user.name}</p>
              </div>
              <button
                data-testid="button-edit-name"
                onClick={() => setEditingName(true)}
                className="text-xs text-primary font-medium"
              >
                Edit
              </button>
            </div>
            {!isGuest && (
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center">
                <Mail className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Email</p>
                <p className="text-xs text-muted-foreground truncate">{user.username}</p>
              </div>
            </div>
            )}
          </div>
        </div>

        {/* Preferences */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Preferences</p>
          <div className="rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>

            {/* Theme */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
                <Palette className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Theme</p>
                <p className="text-xs text-muted-foreground">Light, Dark, System, Pro</p>
              </div>
              <button
                onClick={onOpenThemePicker}
                className="flex items-center gap-1 text-xs font-medium text-foreground flex-shrink-0"
              >
                <span className="capitalize">{getThemeMode()}</span>
                <ChevronRight className="w-4 h-4 opacity-40" />
              </button>
            </div>

            {/* Filename prefix */}
            <div className="px-4 py-3.5 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Filename Prefix</p>
                  <p className="text-xs text-muted-foreground">New scans are named "{filenamePrefix} {new Date().toLocaleDateString()}"</p>
                </div>
                {!prefixEditing && (
                  <button
                    data-testid="button-edit-prefix"
                    onClick={() => { setPrefixDraft(filenamePrefix); setPrefixEditing(true); }}
                    className="text-xs text-primary font-medium flex-shrink-0"
                  >
                    Edit
                  </button>
                )}
              </div>
              {prefixEditing && (
                <div className="mt-3 flex gap-2">
                  <input
                    autoFocus
                    data-testid="input-filename-prefix"
                    value={prefixDraft}
                    onChange={(e) => setPrefixDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && prefixDraft.trim()) {
                        const v = prefixDraft.trim();
                        setSetting("filenamePrefix", v);
                        setFilenamePrefix(v);
                        setPrefixEditing(false);
                        toast({ title: "Filename prefix saved" });
                      }
                      if (e.key === "Escape") { setPrefixEditing(false); }
                    }}
                    maxLength={40}
                    placeholder="e.g. Scan, Invoice, Doc"
                    className="flex-1 px-3 py-2 rounded-xl bg-muted text-sm text-foreground border border-border outline-none"
                  />
                  <button
                    data-testid="button-save-prefix"
                    onClick={() => {
                      const v = prefixDraft.trim() || "Scan";
                      setSetting("filenamePrefix", v);
                      setFilenamePrefix(v);
                      setPrefixEditing(false);
                      toast({ title: "Filename prefix saved" });
                    }}
                    className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setPrefixEditing(false)}
                    className="px-3 py-2 rounded-xl bg-muted text-muted-foreground text-xs"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>


        {!isGuest && (
        <div className="px-4 mb-8">
          <div className="rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>
            <button
              data-testid="button-logout"
              onClick={() => setShowLogoutConfirm(true)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-red-500"
            >
              <div className="w-8 h-8 rounded-xl bg-red-50 flex items-center justify-center">
                <LogOut className="w-4 h-4 text-red-500" />
              </div>
              <span className="text-sm font-medium flex-1 text-left">Sign Out</span>
              <ChevronRight className="w-4 h-4 opacity-40" />
            </button>
          </div>
        </div>
        )}
        <p className="text-center text-[10px] mt-4 mb-2" style={{ color: textSecondary }}>
          Docera v1.0.0
        </p>
      </div>

      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowLogoutConfirm(false)}>
          <div className="w-full rounded-t-3xl p-4 pb-10" style={{ background: cardBg, ...glassStyle(dark), borderRadius: "24px 24px 0 0" }} onClick={(e) => e.stopPropagation()}>
            <div className="w-10 h-1 bg-muted rounded-full mx-auto mb-4" />
            <p className="text-base font-bold text-foreground text-center mb-1">Sign Out</p>
            <p className="text-sm text-muted-foreground text-center mb-6">Are you sure you want to sign out?</p>
            <div className="flex gap-3">
              <button onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 rounded-2xl bg-muted text-foreground font-semibold text-sm">
                Cancel
              </button>
              <button onClick={onLogout}
                className="flex-1 py-3 rounded-2xl bg-red-500 text-white font-semibold text-sm">
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
