import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { Capacitor } from "@capacitor/core";
import { ArrowLeft, Search, X, FileText, Send, Check, AlertCircle } from "lucide-react";
import { isDarkMode } from "@/lib/theme";
import { useToast } from "@/hooks/use-toast";
import type { DocumentSummary, Folder, DocStatus, Client } from "@shared/schema";
import { dataUrlToBlob, docFilename, docMime } from "@/lib/docUtils";
import ClientEmailSuggest from "@/components/ClientEmailSuggest";
import { DocCard } from "./HomePage";

// ── Theme constants ────────────────────────────────────────────────────────

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

// ── Props ──────────────────────────────────────────────────────────────────

interface AllDocumentsPageProps {
  onBack: () => void;
  onOpenDoc: (docId: string) => void;
  onEditDoc: (docId: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function AllDocumentsPage({ onBack, onOpenDoc, onEditDoc }: AllDocumentsPageProps) {
  const { toast } = useToast();
  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const headerBg = dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)";
  const textPrimary = dark ? "#ececef" : "#1a1f2a";
  const textSecondary = dark ? "#a0a8b8" : "#4a5262";
  const borderColor = dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)";
  const surfaceBg = dark ? "rgba(28,28,32,0.55)" : "rgba(255,255,255,0.35)";

  const [search, setSearch] = useState("");

  const [sendingDoc, setSendingDoc] = useState<{ id: string; name: string; clientId: string | null } | null>(null);
  const [cardEmailTo, setCardEmailTo] = useState("");
  const [cardEmailMsg, setCardEmailMsg] = useState("");
  const [cardEmailError, setCardEmailError] = useState("");
  const [cardEmailSuccess, setCardEmailSuccess] = useState(false);

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  // ── Queries ──────────────────────────────────────────────────────────────

  const { data: docs = [] } = useQuery<DocumentSummary[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) {
        const { listLocalDocs } = await import("@/lib/localDocs");
        return (await listLocalDocs()) as unknown as DocumentSummary[];
      }
      const res = await apiFetch("/api/documents");
      return res.json();
    },
  });

  const { data: foldersData = [] } = useQuery<Folder[]>({
    queryKey: ["/api/folders"],
    initialData: [],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) return [];
      const res = await apiFetch("/api/folders");
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const { data: clientsData = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    initialData: [],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) return [];
      const res = await apiFetch("/api/clients");
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const clientMap = useMemo(() => new Map(clientsData.map((c) => [c.id, c])), [clientsData]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      if (Capacitor.isNativePlatform()) {
        const { deleteLocalDoc } = await import("@/lib/localDocs");
        await deleteLocalDoc(id); return;
      }
      return apiRequest("DELETE", `/api/documents/${id}`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const renameDoc = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { name }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { name });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
  });

  const setDocStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: DocStatus }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { status }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { status });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const duplicateDoc = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/documents/${id}/duplicate`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Document duplicated" }); },
    onError: () => toast({ title: "Failed to duplicate", variant: "destructive" }),
  });

  const moveToFolder = useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      apiRequest("PUT", `/api/documents/${id}`, { folderId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Moved" }); },
    onError: () => toast({ title: "Failed to move", variant: "destructive" }),
  });

  const setDocClient = useMutation({
    mutationFn: ({ id, clientId }: { id: string; clientId: string | null }) =>
      apiRequest("PUT", `/api/documents/${id}`, { clientId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to assign client", variant: "destructive" }),
  });

  const toggleFavorite = useMutation({
    mutationFn: async ({ id, isFavorite }: { id: string; isFavorite: boolean }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { isFavorite }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { isFavorite });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to update favorite", variant: "destructive" }),
  });

  const sendEmailCard = useMutation({
    mutationFn: ({ id, to, message }: { id: string; to: string; message?: string }) =>
      apiRequest("POST", `/api/documents/${id}/send-email`, { to, message }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setCardEmailSuccess(true);
      toast({ title: "Email sent", description: `Document sent to ${vars.to}` });
      setTimeout(() => {
        setSendingDoc(null);
        setCardEmailTo("");
        setCardEmailMsg("");
        setCardEmailError("");
        setCardEmailSuccess(false);
      }, 1800);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setCardEmailError(msg);
    },
  });

  // ── Share / Download helpers ──────────────────────────────────────────────

  const handleCardShare = async (docId: string) => {
    try {
      const res = await apiFetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error("fetch failed");
      const fullDoc: { dataUrl: string; name: string; type: string } = await res.json();
      if (!fullDoc.dataUrl || fullDoc.dataUrl.length < 50) {
        toast({ title: "No file available", description: "This document has no exported file yet.", variant: "destructive" });
        return;
      }
      const filename = docFilename(fullDoc.name, fullDoc.type);
      const mimeType = docMime(fullDoc.type);
      const blob = dataUrlToBlob(fullDoc.dataUrl);
      const file = new File([blob], filename, { type: mimeType });
      if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fullDoc.name, text: "Shared from Docera" });
        return;
      }
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: fullDoc.name, text: `Check out: ${fullDoc.name}`, url: window.location.href });
          return;
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
        }
      }
      toast({ title: "Open the document to share", description: "Your browser doesn't support direct file sharing.", variant: "destructive" });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast({ title: "Could not share", description: "Please try again.", variant: "destructive" });
    }
  };

  const handleCardDownload = async (docId: string) => {
    try {
      const res = await apiFetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error("fetch failed");
      const fullDoc: { dataUrl: string; name: string; type: string } = await res.json();
      if (!fullDoc.dataUrl || fullDoc.dataUrl.length < 50) {
        toast({ title: "No file available", description: "This document has no exported file yet.", variant: "destructive" });
        return;
      }
      const blob = dataUrlToBlob(fullDoc.dataUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = docFilename(fullDoc.name, fullDoc.type);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", description: "Please try again.", variant: "destructive" });
    }
  };

  // ── Filtered docs ─────────────────────────────────────────────────────────

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = docs
      .slice()
      .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
    if (!q) return base;
    return base.filter((d) => {
      const client = d.clientId ? clientMap.get(d.clientId) : undefined;
      return (
        d.name.toLowerCase().includes(q) ||
        (d.status ?? "").toLowerCase().includes(q) ||
        (client?.name ?? "").toLowerCase().includes(q) ||
        (client?.email ?? "").toLowerCase().includes(q)
      );
    });
  }, [docs, search, clientMap]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="fixed inset-0 flex flex-col z-50" style={{ background: "transparent" }}>

        {/* ── Glass header ── */}
        <div style={{ background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, borderBottom: `0.5px solid ${borderColor}`, paddingTop: "max(3rem, env(safe-area-inset-top))", paddingBottom: 12, paddingLeft: 16, paddingRight: 16, flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <button
              onClick={onBack}
              style={{ width: 40, height: 40, borderRadius: 12, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: textPrimary, flexShrink: 0 }}
            >
              <ArrowLeft style={{ width: 20, height: 20 }} />
            </button>
            <h1 style={{ flex: 1, fontSize: 20, fontWeight: 700, color: textPrimary, margin: 0 }}>
              All Documents
            </h1>
            <span style={{ fontSize: 13, color: textSecondary, fontWeight: 500 }}>
              {docs.length}
            </span>
          </div>

          {/* Search */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: surfaceBg, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 12, padding: "10px 14px", border: `0.5px solid ${borderColor}` }}>
            <Search style={{ width: 16, height: 16, color: textSecondary, flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 15, color: textPrimary }}
            />
            {search && (
              <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <X style={{ width: 14, height: 14, color: textSecondary }} />
              </button>
            )}
          </div>
        </div>

        {/* ── Scrollable grid ── */}
        <div className="flex-1 overflow-y-auto" style={{ padding: "16px 20px 32px", background: "transparent" }}>
          {filteredDocs.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 20px", textAlign: "center" }}>
              {search ? (
                <>
                  <Search style={{ width: 36, height: 36, color: textSecondary, marginBottom: 12 }} />
                  <p style={{ fontSize: 15, color: textSecondary, margin: 0 }}>No documents match</p>
                </>
              ) : (
                <>
                  <FileText style={{ width: 36, height: 36, color: textSecondary, marginBottom: 12 }} />
                  <p style={{ fontSize: 15, color: textSecondary, margin: 0 }}>No documents yet</p>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {filteredDocs.map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  variant="grid"
                  folders={foldersData}
                  clients={clientsData}
                  clientName={doc.clientId ? clientMap.get(doc.clientId)?.name : undefined}
                  onOpen={() => onOpenDoc(doc.id)}
                  onEdit={() => onEditDoc(doc.id)}
                  onDelete={() => deleteDoc.mutate(doc.id)}
                  onRename={(name) => renameDoc.mutate({ id: doc.id, name })}
                  onDuplicate={() => duplicateDoc.mutate(doc.id)}
                  onMoveToFolder={(folderId) => moveToFolder.mutate({ id: doc.id, folderId })}
                  onSetStatus={(status) => setDocStatus.mutate({ id: doc.id, status })}
                  onSetClient={(clientId) => setDocClient.mutate({ id: doc.id, clientId })}
                  onToggleFavorite={() => toggleFavorite.mutate({ id: doc.id, isFavorite: !doc.isFavorite })}
                  onShare={() => handleCardShare(doc.id)}
                  onDownload={() => handleCardDownload(doc.id)}
                  onSendEmail={(clientEmail) => {
                    setCardEmailError("");
                    setCardEmailTo(clientEmail || "");
                    setSendingDoc({ id: doc.id, name: doc.name, clientId: doc.clientId ?? null });
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Send-by-email modal ── */}
        {sendingDoc && (
          <div
            className="fixed inset-0 z-[60] flex items-end"
            onClick={() => { if (!sendEmailCard.isPending) { setSendingDoc(null); setCardEmailTo(""); setCardEmailMsg(""); setCardEmailError(""); setCardEmailSuccess(false); } }}
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
                    <p className="text-xs mt-0.5 truncate max-w-[240px]" style={{ color: textSecondary }}>{sendingDoc.name}</p>
                  </div>
                  <button
                    onClick={() => { setSendingDoc(null); setCardEmailTo(""); setCardEmailMsg(""); setCardEmailError(""); setCardEmailSuccess(false); }}
                    disabled={sendEmailCard.isPending}
                    className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground active:opacity-60 disabled:opacity-40"
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
                    <p className="text-sm font-semibold text-foreground truncate">{sendingDoc.name}</p>
                  </div>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Recipient email</label>
                  <ClientEmailSuggest
                    value={cardEmailTo}
                    onChange={(v) => { setCardEmailTo(v); setCardEmailError(""); }}
                    linkedClientId={sendingDoc?.clientId}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const t = cardEmailTo.trim();
                        if (t && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) sendEmailCard.mutate({ id: sendingDoc!.id, to: t, message: cardEmailMsg.trim() || undefined });
                        else setCardEmailError("Please enter a valid email address.");
                      }
                    }}
                    disabled={sendEmailCard.isPending || cardEmailSuccess}
                    inputClassName="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                    Message <span className="text-muted-foreground/50 font-normal normal-case">(optional)</span>
                  </label>
                  <textarea
                    placeholder="Add a personal note to the recipient…"
                    value={cardEmailMsg}
                    onChange={(e) => setCardEmailMsg(e.target.value)}
                    rows={3}
                    disabled={sendEmailCard.isPending || cardEmailSuccess}
                    className="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none resize-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                  />
                </div>
                {cardEmailError && (
                  <div className="flex items-start gap-2.5 px-4 py-3 rounded-2xl bg-red-50 border border-red-200/60">
                    <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                    <span className="text-red-600 text-sm leading-snug">{cardEmailError}</span>
                  </div>
                )}
                {cardEmailSuccess ? (
                  <div className="w-full py-3.5 rounded-2xl bg-green-500/10 border border-green-500/20 text-green-600 text-sm font-bold flex items-center justify-center gap-2">
                    <Check className="w-4 h-4" /> Document sent successfully
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      const t = cardEmailTo.trim();
                      if (!t || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { setCardEmailError("Please enter a valid email address."); return; }
                      setCardEmailError("");
                      sendEmailCard.mutate({ id: sendingDoc.id, to: t, message: cardEmailMsg.trim() || undefined });
                    }}
                    disabled={sendEmailCard.isPending || !cardEmailTo.trim()}
                    className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50 transition-opacity"
                  >
                    {sendEmailCard.isPending
                      ? <><div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" /> Sending…</>
                      : <><Send className="w-4 h-4" /> Send Document</>}
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
