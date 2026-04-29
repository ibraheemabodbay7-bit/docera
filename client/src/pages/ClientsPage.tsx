import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import ClientEmailSuggest from "@/components/ClientEmailSuggest";
import {
  ArrowLeft, Plus, Search, X, Mail, Phone, FileText, Edit2, Trash2,
  User, Users, Check, ChevronRight, Building2, AlignLeft, Camera, Send, AlertCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import type { Client, DocumentSummary, DocStatus } from "@shared/schema";
import { isDarkMode } from "@/lib/theme";

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

interface ClientsPageProps {
  onBack: () => void;
  onOpenDoc: (docId: string) => void;
  onScan: (clientId: string) => void;
}

const STATUS_META: Record<DocStatus, { label: string; dot: string; text: string; bg: string }> = {
  draft:    { label: "Draft",              dot: "bg-gray-400",   text: "text-gray-600",   bg: "bg-gray-100" },
  pending:  { label: "Waiting for Reply",  dot: "bg-amber-400",  text: "text-amber-700",  bg: "bg-amber-50" },
  sent:     { label: "Sent",              dot: "bg-blue-400",   text: "text-blue-700",   bg: "bg-blue-50" },
  approved: { label: "Approved",          dot: "bg-green-400",  text: "text-green-700",  bg: "bg-green-50" },
  rejected: { label: "Rejected",          dot: "bg-red-400",    text: "text-red-700",    bg: "bg-red-50" },
};

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

function ClientAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const sz = size === "lg" ? "w-16 h-16 text-xl" : size === "md" ? "w-10 h-10 text-sm" : "w-8 h-8 text-xs";
  return (
    <div className={`${sz} rounded-full flex items-center justify-center flex-shrink-0 font-bold bg-primary text-primary-foreground`}>
      {initials(name)}
    </div>
  );
}

interface ClientFormValues {
  name: string;
  email: string;
  phone: string;
  notes: string;
}

function ClientForm({
  initial,
  onSave,
  onCancel,
  isPending,
}: {
  initial?: Partial<ClientFormValues>;
  onSave: (v: ClientFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  function handleSave() {
    const errs: { name?: string; email?: string } = {};
    if (!name.trim()) errs.name = "Name is required";
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "Enter a valid email";
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSave({ name: name.trim(), email: email.trim(), phone: phone.trim(), notes: notes.trim() });
  }

  return (
    <div className="flex flex-col gap-4 px-5 pt-4 pb-2">
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
          Client Name <span className="text-red-400">*</span>
        </label>
        <input
          data-testid="input-client-name"
          autoFocus
          value={name}
          onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: undefined })); }}
          placeholder="e.g. John Smith"
          className={`w-full px-3 py-3 rounded-xl bg-muted text-sm text-foreground border-0 outline-none ${errors.name ? "ring-2 ring-red-400" : ""}`}
        />
        {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Email</label>
        <input
          data-testid="input-client-email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: undefined })); }}
          placeholder="client@example.com"
          className={`w-full px-3 py-3 rounded-xl bg-muted text-sm text-foreground border-0 outline-none ${errors.email ? "ring-2 ring-red-400" : ""}`}
        />
        {errors.email && <p className="text-xs text-red-500 mt-1">{errors.email}</p>}
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Phone (optional)</label>
        <input
          data-testid="input-client-phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 555 000 0000"
          className="w-full px-3 py-3 rounded-xl bg-muted text-sm text-foreground border-0 outline-none"
        />
      </div>

      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Notes (optional)</label>
        <textarea
          data-testid="input-client-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any relevant notes about this client…"
          rows={3}
          className="w-full px-3 py-3 rounded-xl bg-muted text-sm text-foreground border-0 outline-none resize-none"
        />
      </div>

      <div className="flex gap-3 pb-2">
        <button
          data-testid="button-client-cancel"
          onClick={onCancel}
          disabled={isPending}
          className="flex-1 py-3 rounded-2xl bg-muted text-sm font-semibold text-muted-foreground active:opacity-70 disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          data-testid="button-client-save"
          onClick={handleSave}
          disabled={isPending}
          className="flex-1 py-3 rounded-2xl bg-primary text-sm font-bold text-primary-foreground active:opacity-80 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {isPending ? (
            <div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Save
        </button>
      </div>
    </div>
  );
}

function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dark = isDarkMode();
  const sheetBg = dark ? "rgba(18,18,22,0.95)" : "rgba(240,243,248,0.95)";
  const textP = dark ? "#ececef" : "#1a1f2a";
  const borderC = dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)";
  return (
    <div className="fixed inset-0 z-[70] flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative w-full max-h-[90vh] overflow-y-auto"
        style={{ background: sheetBg, backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", borderRadius: "24px 24px 0 0", border: `0.5px solid ${borderC}`, paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pt-3 pb-4 px-5 flex-shrink-0" style={{ borderBottom: `0.5px solid ${borderC}` }}>
          <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />
          <div className="flex items-center justify-between">
            <p className="text-base font-bold" style={{ color: textP }}>{title}</p>
            <button onClick={onClose} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ClientsPage({ onBack, onOpenDoc, onScan }: ClientsPageProps) {
  const { toast } = useToast();
  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const cardBg = dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)";
  const headerBg = dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)";
  const textPrimary = dark ? "#ececef" : "#1a1f2a";
  const textSecondary = dark ? "#a0a8b8" : "#4a5262";
  const borderColor = dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);
  const [search, setSearch] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Send email modal state
  const [sendDoc, setSendDoc] = useState<DocumentSummary | null>(null);
  const [sendEmailTo, setSendEmailTo] = useState("");
  const [sendEmailMsg, setSendEmailMsg] = useState("");
  const [sendEmailError, setSendEmailError] = useState("");
  const [sendEmailSuccess, setSendEmailSuccess] = useState(false);

  const { data: clients = [], isLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const { data: clientDocs = [], isLoading: docsLoading } = useQuery<DocumentSummary[]>({
    queryKey: ["/api/clients", selectedClient?.id, "documents"],
    enabled: !!selectedClient,
  });

  const createClient = useMutation({
    mutationFn: async (v: ClientFormValues) => {
      const res = await apiRequest("POST", "/api/clients", {
        name: v.name,
        email: v.email || null,
        phone: v.phone || null,
        notes: v.notes || null,
      });
      return res.json() as Promise<Client>;
    },
    onSuccess: (client: Client) => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      setShowCreate(false);
      setSelectedClient(client);
      toast({ title: "Client created" });
    },
    onError: () => toast({ title: "Failed to create client", variant: "destructive" }),
  });

  const updateClient = useMutation({
    mutationFn: async (v: ClientFormValues) => {
      const res = await apiRequest("PUT", `/api/clients/${selectedClient!.id}`, {
        name: v.name,
        email: v.email || null,
        phone: v.phone || null,
        notes: v.notes || null,
      });
      return res.json() as Promise<Client>;
    },
    onSuccess: (updated: Client) => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      setSelectedClient(updated);
      setShowEdit(false);
      toast({ title: "Client updated" });
    },
    onError: () => toast({ title: "Failed to update client", variant: "destructive" }),
  });

  const deleteClient = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/clients/${selectedClient!.id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setSelectedClient(null);
      setShowDeleteConfirm(false);
      toast({ title: "Client deleted" });
    },
    onError: () => toast({ title: "Failed to delete client", variant: "destructive" }),
  });

  const sendEmail = useMutation({
    mutationFn: ({ docId, to, message }: { docId: string; to: string; message?: string }) =>
      apiRequest("POST", `/api/documents/${docId}/send-email`, { to, message }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setSendEmailSuccess(true);
      toast({ title: "Email sent", description: `Sent to ${vars.to}` });
      setTimeout(() => {
        setSendDoc(null);
        setSendEmailTo("");
        setSendEmailMsg("");
        setSendEmailError("");
        setSendEmailSuccess(false);
      }, 1800);
    },
    onError: (err: unknown) => {
      setSendEmailError(err instanceof Error ? err.message : "Failed to send email");
    },
  });

  function openSendModal(doc: DocumentSummary) {
    setSendDoc(doc);
    setSendEmailTo(selectedClient?.email ?? "");
    setSendEmailMsg("");
    setSendEmailError("");
    setSendEmailSuccess(false);
  }

  const filtered = clients.filter((c) =>
    !search.trim() || c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase())
  );

  // ── Detail view ─────────────────────────────────────────────────────────────
  if (selectedClient) {
    return (
      <>
        <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
        <div className="min-h-screen flex flex-col" style={{ position: "relative", zIndex: 1, background: "transparent" }}>
        {/* Header */}
        <div
          className="flex-shrink-0 flex items-center gap-3 px-4 pb-4"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, borderBottom: `0.5px solid ${borderColor}` }}
        >
          <button
            data-testid="button-client-back"
            onClick={() => setSelectedClient(null)}
            className="w-9 h-9 rounded-full flex items-center justify-center active:opacity-60"
          style={{ background: dark ? "rgba(255,255,255,0.08)" : "rgba(26,31,42,0.08)", color: textPrimary }}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <p className="flex-1 text-base font-bold truncate" style={{ color: textPrimary }}>{selectedClient.name}</p>
          <button
            data-testid="button-client-edit"
            onClick={() => setShowEdit(true)}
            className="text-xs font-semibold text-primary px-3 py-1.5 rounded-lg bg-primary/10 active:opacity-70"
          >
            Edit
          </button>
        </div>

        <div className="flex-1 overflow-y-auto pb-8">
          {/* Client info card */}
          <div className="mx-4 mt-5 rounded-2xl overflow-hidden" style={{ background: cardBg, ...glassStyle(dark) }}>
            <div className="flex items-center gap-4 px-4 py-4 border-b border-border">
              <ClientAvatar name={selectedClient.name} size="lg" />
              <div className="min-w-0">
                <p className="text-lg font-bold text-foreground truncate">{selectedClient.name}</p>
                {selectedClient.email && (
                  <p className="text-sm text-muted-foreground truncate">{selectedClient.email}</p>
                )}
              </div>
            </div>

            {selectedClient.email && (
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
                <Mail className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Email</p>
                  <p className="text-sm text-foreground truncate">{selectedClient.email}</p>
                </div>
              </div>
            )}

            {selectedClient.phone && (
              <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border">
                <Phone className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Phone</p>
                  <p className="text-sm text-foreground">{selectedClient.phone}</p>
                </div>
              </div>
            )}

            {selectedClient.notes && (
              <div className="flex items-start gap-3 px-4 py-3.5">
                <AlignLeft className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{selectedClient.notes}</p>
                </div>
              </div>
            )}

            {!selectedClient.email && !selectedClient.phone && !selectedClient.notes && (
              <div className="px-4 py-3.5 text-sm text-muted-foreground italic">No additional details</div>
            )}
          </div>

          {/* Quick actions */}
          <div className="mx-4 mt-5 flex gap-3">
            <button
              data-testid="button-client-new-doc"
              onClick={() => onScan(selectedClient.id)}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-primary text-primary-foreground text-sm font-bold active:opacity-80"
            >
              <Camera className="w-4 h-4" />
              New Document
            </button>
            {selectedClient.email && (
              <button
                data-testid="button-client-send-email"
                onClick={() => {
                  if (clientDocs.length > 0) {
                    openSendModal(clientDocs[0]);
                  } else {
                    toast({ title: "No documents linked to this client yet" });
                  }
                }}
                className="flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl bg-muted text-foreground text-sm font-semibold active:opacity-70"
              >
                <Mail className="w-4 h-4" />
                Send Email
              </button>
            )}
          </div>

          {/* Documents section */}
          <div className="mx-4 mt-5">
            <p className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              Documents
              {clientDocs.length > 0 && (
                <span className="ml-1 text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{clientDocs.length}</span>
              )}
            </p>

            {docsLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              </div>
            ) : clientDocs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <FileText className="w-10 h-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm font-medium text-muted-foreground">No documents linked yet</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Tap "New Document" or assign this client from within any document</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {clientDocs.map((doc) => {
                  const status = (doc.status as DocStatus | undefined) ?? "draft";
                  const meta = STATUS_META[status] ?? STATUS_META.draft;
                  const ts = doc.updatedAt ?? doc.createdAt;
                  return (
                    <div key={doc.id} className="flex items-center gap-2">
                      <button
                        data-testid={`client-doc-${doc.id}`}
                        onClick={() => onOpenDoc(doc.id)}
                        className="flex-1 flex items-center gap-3 px-4 py-3.5 rounded-2xl active:opacity-70 text-left min-w-0"
                        style={{ background: cardBg, ...glassStyle(dark) }}
                      >
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-primary">
                          <FileText className="w-4 h-4 text-primary-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{doc.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${meta.dot}`} />
                            <span className="text-xs text-muted-foreground">{meta.label}</span>
                            {ts && <span className="text-xs text-muted-foreground">· {format(new Date(ts), "MMM d")}</span>}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      </button>
                      {selectedClient.email && (
                        <button
                          data-testid={`button-send-doc-${doc.id}`}
                          onClick={() => openSendModal(doc)}
                          className="w-10 h-10 flex-shrink-0 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground active:opacity-70"
                          title="Send by email"
                        >
                          <Mail className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Danger zone */}
          <div className="mx-4 mt-8 mb-4">
            <button
              data-testid="button-delete-client"
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full py-3.5 rounded-2xl bg-red-50 dark:bg-red-950/30 text-sm font-semibold text-red-500 flex items-center justify-center gap-2 active:opacity-70"
            >
              <Trash2 className="w-4 h-4" />
              Delete Client
            </button>
          </div>
        </div>

        {/* Edit sheet */}
        {showEdit && (
          <BottomSheet title="Edit Client" onClose={() => setShowEdit(false)}>
            <ClientForm
              initial={{
                name: selectedClient.name,
                email: selectedClient.email ?? "",
                phone: selectedClient.phone ?? "",
                notes: selectedClient.notes ?? "",
              }}
              onSave={(v) => updateClient.mutate(v)}
              onCancel={() => setShowEdit(false)}
              isPending={updateClient.isPending}
            />
          </BottomSheet>
        )}

        {/* Delete confirm sheet */}
        {showDeleteConfirm && (
          <BottomSheet title="Delete Client" onClose={() => setShowDeleteConfirm(false)}>
            <div className="px-5 pt-4 pb-6 flex flex-col gap-5">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Are you sure you want to delete <span className="font-semibold text-foreground">{selectedClient.name}</span>?
                Their documents will not be deleted — they'll just be unlinked from this client.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 py-3 rounded-2xl bg-muted text-sm font-semibold text-muted-foreground active:opacity-70"
                >
                  Cancel
                </button>
                <button
                  data-testid="button-confirm-delete-client"
                  onClick={() => deleteClient.mutate()}
                  disabled={deleteClient.isPending}
                  className="flex-1 py-3 rounded-2xl bg-red-500 text-sm font-bold text-white active:opacity-80 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {deleteClient.isPending ? (
                    <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Delete
                </button>
              </div>
            </div>
          </BottomSheet>
        )}

        {/* Send email modal */}
        {sendDoc && (
          <div
            className="fixed inset-0 z-[80] flex items-end"
            onClick={() => { if (!sendEmail.isPending) { setSendDoc(null); setSendEmailSuccess(false); } }}
          >
            <div className="absolute inset-0 bg-black/50" />
            <div
              className="relative w-full"
              style={{ background: dark ? "rgba(18,18,22,0.95)" : "rgba(240,243,248,0.95)", backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", borderRadius: "24px 24px 0 0", border: `0.5px solid ${borderColor}`, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pt-3 pb-4 px-5" style={{ borderBottom: `0.5px solid ${borderColor}` }}>
                <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-base font-bold" style={{ color: textPrimary }}>Send by Email</p>
                    <p className="text-xs mt-0.5 truncate max-w-[240px]" style={{ color: textSecondary }}>{sendDoc.name}</p>
                  </div>
                  <button
                    onClick={() => { setSendDoc(null); setSendEmailSuccess(false); }}
                    disabled={sendEmail.isPending}
                    className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground disabled:opacity-40"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="px-5 pt-5 pb-2 flex flex-col gap-4">
                <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-primary/8 border border-primary/15">
                  <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Sending</p>
                    <p className="text-sm font-semibold text-foreground truncate">{sendDoc.name}</p>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Recipient email</label>
                  <ClientEmailSuggest
                    data-testid="input-client-send-email-to"
                    value={sendEmailTo}
                    onChange={(v) => { setSendEmailTo(v); setSendEmailError(""); }}
                    linkedClientId={selectedClient?.id ?? null}
                    disabled={sendEmail.isPending || sendEmailSuccess}
                    inputClassName="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                    Message <span className="text-muted-foreground/50 font-normal normal-case">(optional)</span>
                  </label>
                  <textarea
                    data-testid="input-client-send-email-message"
                    placeholder="Add a personal note…"
                    value={sendEmailMsg}
                    onChange={(e) => setSendEmailMsg(e.target.value)}
                    rows={3}
                    disabled={sendEmail.isPending || sendEmailSuccess}
                    className="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none resize-none disabled:opacity-50"
                  />
                </div>

                {sendEmailError && (
                  <div className="flex items-start gap-2.5 px-4 py-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200/60">
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                    <span className="text-red-600 text-sm">{sendEmailError}</span>
                  </div>
                )}

                {sendEmailSuccess ? (
                  <div className="w-full py-3.5 rounded-2xl bg-green-500/10 border border-green-500/20 text-green-600 text-sm font-bold flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" />
                    Sent successfully
                  </div>
                ) : (
                  <button
                    data-testid="button-client-send-email-submit"
                    onClick={() => {
                      const t = sendEmailTo.trim();
                      if (!t || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { setSendEmailError("Please enter a valid email address."); return; }
                      setSendEmailError("");
                      sendEmail.mutate({ docId: sendDoc.id, to: t, message: sendEmailMsg.trim() || undefined });
                    }}
                    disabled={sendEmail.isPending || !sendEmailTo.trim()}
                    className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50"
                  >
                    {sendEmail.isPending ? (
                      <><div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />Sending…</>
                    ) : (
                      <><Send className="w-4 h-4" />Send Document</>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      </>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="min-h-screen flex flex-col" style={{ position: "relative", zIndex: 1, background: "transparent" }}>
      {/* Header */}
      <div
        className="flex-shrink-0 px-4 pb-3"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, borderBottom: `0.5px solid ${borderColor}` }}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <button
              data-testid="button-clients-back"
              onClick={onBack}
              className="w-9 h-9 rounded-full flex items-center justify-center active:opacity-60"
              style={{ background: dark ? "rgba(255,255,255,0.08)" : "rgba(26,31,42,0.08)", color: textPrimary }}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2">
              <Building2 className="w-5 h-5 text-primary" />
              <h1 className="text-lg font-bold" style={{ color: textPrimary }}>Clients</h1>
              {clients.length > 0 && (
                <span className="text-xs font-medium bg-muted px-2 py-0.5 rounded-full" style={{ color: textSecondary }}>{clients.length}</span>
              )}
            </div>
          </div>
          <button
            data-testid="button-add-client"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 bg-primary text-primary-foreground text-xs font-bold px-3.5 py-2 rounded-xl active:opacity-80"
          >
            <Plus className="w-3.5 h-3.5" />
            New Client
          </button>
        </div>

        <div className="flex items-center gap-2 bg-muted rounded-xl px-3 py-2.5">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            data-testid="input-client-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-muted-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : clients.length === 0 ? (
          <div className="flex flex-col items-center px-6 pt-8 pb-8 text-center">
            <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center mb-5">
              <Users className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-xl font-bold text-foreground mb-2">No clients yet</h2>
            <p className="text-sm text-muted-foreground leading-relaxed mb-7 max-w-xs">
              Add your first client to link documents directly to people or businesses — making it easy to track, organize, and send.
            </p>
            <div className="w-full rounded-2xl px-4 pt-4 pb-4 mb-6 text-left" style={{ background: cardBg, ...glassStyle(dark) }}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3 text-center">Why add clients?</p>
              {[
                { icon: FileText, text: "Link documents to a specific person or company" },
                { icon: Send, text: "Send documents directly to their email" },
                { icon: ChevronRight, text: "Access all their files in one tap" },
              ].map((item) => (
                <div key={item.text} className="flex items-start gap-3 py-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <item.icon className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <p className="text-sm text-foreground leading-snug">{item.text}</p>
                </div>
              ))}
            </div>
            <button
              data-testid="button-add-first-client"
              onClick={() => setShowCreate(true)}
              className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl active:opacity-80 text-[15px]"
            >
              Add your first client
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
              <Search className="w-7 h-7 text-muted-foreground/50" />
            </div>
            <p className="text-sm font-semibold text-foreground">No clients found</p>
            <p className="text-sm text-muted-foreground">No clients match your search.</p>
          </div>
        ) : (
          <div className="px-4 py-4 flex flex-col gap-3">
            {filtered.map((client) => (
              <button
                key={client.id}
                data-testid={`client-card-${client.id}`}
                onClick={() => setSelectedClient(client)}
                className="flex items-center gap-3 px-4 py-3.5 rounded-2xl active:opacity-70 text-left w-full"
                style={{ background: cardBg, ...glassStyle(dark) }}
              >
                <ClientAvatar name={client.name} size="md" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{client.name}</p>
                  {client.email ? (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{client.email}</p>
                  ) : client.phone ? (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{client.phone}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground/50 mt-0.5 italic">No contact info</p>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Create client sheet */}
      {showCreate && (
        <BottomSheet title="New Client" onClose={() => setShowCreate(false)}>
          <ClientForm
            onSave={(v) => createClient.mutate(v)}
            onCancel={() => setShowCreate(false)}
            isPending={createClient.isPending}
          />
        </BottomSheet>
      )}
    </div>
  </>
  );
}
