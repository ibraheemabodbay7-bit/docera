import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { ArrowLeft, FileText, FolderOpen, LogOut, ChevronRight, Check, X, Crown, Loader2, User, Mail, AtSign, SlidersHorizontal, Tag, Download, Sparkles } from "lucide-react";
import { getSetting, setSetting, getBoolSetting, setBoolSetting } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import type { Document, Folder } from "@shared/schema";
import type { SubscriptionInfo } from "@/hooks/use-subscription";

interface ProfilePageProps {
  user: { id: string; name: string; username: string; senderName: string | null };
  onBack: () => void;
  onLogout: () => void;
  subscription: SubscriptionInfo;
  onUpgrade?: () => void;
  isGuest?: boolean;
}

export default function ProfilePage({ user, onBack, onLogout, subscription, onUpgrade, isGuest = false }: ProfilePageProps) {
  const { toast } = useToast();
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(user.name);
  const [editingSenderName, setEditingSenderName] = useState(false);
  const [newSenderName, setNewSenderName] = useState(user.senderName ?? "");
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // App preferences (localStorage)
  const [filenamePrefix, setFilenamePrefix] = useState(() => getSetting("filenamePrefix", "Scan"));
  const [prefixEditing, setPrefixEditing] = useState(false);
  const [prefixDraft, setPrefixDraft] = useState(filenamePrefix);
  const [defaultFilter, setDefaultFilter] = useState(() => getSetting("defaultFilter", "all"));
  const [autoExport, setAutoExport] = useState(() => getBoolSetting("autoExport", false));

  const { data: docs = [] } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => {
      const res = await apiFetch("/api/documents");
      return res.json();
    },
  });

  const { data: folders = [] } = useQuery<Folder[]>({
    queryKey: ["/api/folders"],
    queryFn: async () => {
      const res = await apiFetch("/api/folders");
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

  const updateSenderName = useMutation({
    mutationFn: async (senderName: string | null) => {
      const res = await apiRequest("PUT", "/api/auth/profile", { senderName: senderName || null });
      return res.json() as Promise<{ senderName: string | null }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      user.senderName = data.senderName;
      setEditingSenderName(false);
      toast({ title: "Sender name updated" });
    },
    onError: () => toast({ title: "Failed to update sender name", variant: "destructive" }),
  });



  const totalSizeMB = docs.reduce((acc, d) => acc + d.size, 0) / 1024 / 1024;
  const initials = user.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
  const periodEnd = subscription.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd * 1000).toLocaleDateString()
    : null;

  const effectiveSenderName = user.senderName?.trim() || user.name?.trim() || "Docera";

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-shrink-0 bg-card border-b border-border flex items-center gap-3 px-4 pt-12 pb-4">
        <button data-testid="button-back" onClick={onBack}
          className="w-11 h-11 rounded-xl flex items-center justify-center text-foreground -ml-1">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-base font-bold text-foreground">Profile & Settings</h1>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col items-center py-8 px-4">
          <div className="w-20 h-20 rounded-full bg-primary flex items-center justify-center shadow-md mb-3">
            <span className="text-primary-foreground text-2xl font-bold">{initials}</span>
          </div>
          {editingName ? (
            <div className="flex items-center gap-2 mt-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) updateName.mutate(newName.trim());
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="px-3 py-1.5 rounded-xl bg-muted text-sm text-foreground border-0 outline-none text-center min-w-0 w-40"
              />
              <button onClick={() => { if (newName.trim()) updateName.mutate(newName.trim()); }}
                className="w-7 h-7 rounded-full bg-primary flex items-center justify-center">
                <Check className="w-3.5 h-3.5 text-primary-foreground" />
              </button>
              <button onClick={() => { setEditingName(false); setNewName(user.name); }}
                className="w-7 h-7 rounded-full bg-muted flex items-center justify-center">
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          ) : (
            <button onClick={() => setEditingName(true)} className="mt-1 group flex items-center gap-1.5">
              <span className="text-lg font-bold text-foreground">{user.name}</span>
              <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">Edit</span>
            </button>
          )}
          {!isGuest && (
            <p className="text-sm text-muted-foreground mt-0.5">{user.username}</p>
          )}
          {subscription.status === "active" && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-gradient-to-r from-amber-100 to-orange-100 text-amber-700"
              data-testid="badge-subscription">
              <Crown className="w-3 h-3" />
              Pro
            </div>
          )}
          {subscription.status === "trialing" && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-primary/10 text-primary"
              data-testid="badge-subscription">
              <Sparkles className="w-3 h-3" />
              Free Trial
            </div>
          )}
          {(subscription.status === "expired" || subscription.status === "canceled" || subscription.status === "past_due" || subscription.status === "unpaid" || subscription.status === "none") && (
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-muted text-muted-foreground"
              data-testid="badge-subscription">
              No active plan
            </div>
          )}
        </div>

        {/* Subscription */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Subscription</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center">
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
            {!subscription.active && onUpgrade && (
            <button
              data-testid="button-upgrade-plan"
              onClick={onUpgrade}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-foreground"
            >
              <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                <Crown className="w-4 h-4 text-primary" />
              </div>
              <span className="text-sm font-medium flex-1 text-left text-primary">Upgrade to Pro</span>
              <ChevronRight className="w-4 h-4 opacity-40" />
            </button>
            )}
          </div>
        </div>

        {/* Storage */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Storage</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
                <FileText className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Documents</p>
                <p className="text-xs text-muted-foreground">{docs.length} file{docs.length !== 1 ? "s" : ""}</p>
              </div>
              <span className="text-sm font-semibold text-foreground">{docs.length}</span>
            </div>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center">
                <FolderOpen className="w-4 h-4 text-amber-500" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Folders</p>
                <p className="text-xs text-muted-foreground">{folders.length} folder{folders.length !== 1 ? "s" : ""}</p>
              </div>
              <span className="text-sm font-semibold text-foreground">{folders.length}</span>
            </div>
          </div>
          {totalSizeMB > 0 && (
            <p className="text-xs text-muted-foreground mt-2 px-1">
              Total storage used: {totalSizeMB < 1 ? `${(totalSizeMB * 1024).toFixed(0)} KB` : `${totalSizeMB.toFixed(1)} MB`}
            </p>
          )}
        </div>

        {/* Account */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Account</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
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
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center">
                <Mail className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Email</p>
                <p className="text-xs text-muted-foreground truncate">{user.username}</p>
              </div>
            </div>
          </div>
        </div>

        {/* App Preferences */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">App Preferences</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">

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

            {/* Default filter */}
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
                <Tag className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Default View</p>
                <p className="text-xs text-muted-foreground">Filter shown when you open the app</p>
              </div>
              <select
                data-testid="select-default-filter"
                value={defaultFilter}
                onChange={(e) => {
                  setDefaultFilter(e.target.value);
                  setSetting("defaultFilter", e.target.value);
                }}
                className="text-xs font-medium text-foreground bg-muted border-0 rounded-lg px-2 py-1.5 outline-none"
              >
                <option value="all">All</option>
                <option value="draft">Draft</option>
                <option value="pending">Waiting for Reply</option>
                <option value="sent">Sent</option>
                <option value="approved">Approved</option>
              </select>
            </div>

            {/* Auto-export */}
            <div className="flex items-center gap-3 px-4 py-3.5">
              <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
                <Download className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">Auto-Download After Scan</p>
                <p className="text-xs text-muted-foreground">Automatically download the PDF when you save a scan</p>
              </div>
              <button
                data-testid="toggle-auto-export"
                role="switch"
                aria-checked={autoExport}
                onClick={() => {
                  const next = !autoExport;
                  setAutoExport(next);
                  setBoolSetting("autoExport", next);
                }}
                className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${autoExport ? "bg-primary" : "bg-muted-foreground/30"}`}
              >
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${autoExport ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Email sender name */}
        <div className="px-4 mb-5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Email Sending</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="px-4 py-4">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                  <AtSign className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">Preferred Sender Name</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Shown to recipients as the sender of your documents
                  </p>
                </div>
              </div>

              {editingSenderName ? (
                <div className="flex flex-col gap-2 ml-11">
                  <input
                    autoFocus
                    data-testid="input-sender-name"
                    value={newSenderName}
                    onChange={(e) => setNewSenderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") updateSenderName.mutate(newSenderName.trim() || null);
                      if (e.key === "Escape") { setEditingSenderName(false); setNewSenderName(user.senderName ?? ""); }
                    }}
                    placeholder="e.g. Ibrahim Abu Dbay or Dbay Accounting"
                    maxLength={100}
                    className="w-full px-3 py-2 rounded-xl bg-muted text-sm text-foreground border border-border outline-none placeholder:text-muted-foreground/50"
                  />
                  <div className="flex gap-2">
                    <button
                      data-testid="button-save-sender-name"
                      onClick={() => updateSenderName.mutate(newSenderName.trim() || null)}
                      disabled={updateSenderName.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-60"
                    >
                      {updateSenderName.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Save
                    </button>
                    <button
                      onClick={() => { setEditingSenderName(false); setNewSenderName(user.senderName ?? ""); }}
                      className="px-3 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-semibold"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ml-11 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-foreground font-medium truncate">
                      {user.senderName?.trim() || (
                        <span className="text-muted-foreground italic">Not set — using account name</span>
                      )}
                    </p>
                  </div>
                  <button
                    data-testid="button-edit-sender-name"
                    onClick={() => setEditingSenderName(true)}
                    className="text-xs text-primary font-medium flex-shrink-0"
                  >
                    {user.senderName ? "Edit" : "Set"}
                  </button>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* App */}
        <div className="px-4 mb-8">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">App</p>
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">Version</p>
              </div>
              <span className="text-sm text-muted-foreground">1.0.0</span>
            </div>
            {!isGuest && (
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
            )}
          </div>
        </div>

        {/* ── TEMPORARY: Paywall screenshot helper — remove before release ── */}
        {onUpgrade && (
          <div className="px-4 mb-6">
            <button
              data-testid="button-preview-paywall"
              onClick={onUpgrade}
              className="w-full py-3 rounded-2xl border border-dashed border-primary/30 text-primary/60 text-xs font-medium active:opacity-60"
            >
              Preview Paywall Screen
            </button>
          </div>
        )}
      </div>

      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowLogoutConfirm(false)}>
          <div className="w-full bg-card rounded-t-3xl shadow-2xl p-4 pb-10" onClick={(e) => e.stopPropagation()}>
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
  );
}
