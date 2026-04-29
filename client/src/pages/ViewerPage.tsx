import { useEffect, useState, useRef, useCallback } from "react";
import { isDarkMode } from "@/lib/theme";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch, API_BASE } from "@/lib/queryClient";
import {
  ArrowLeft, Download, Trash2, Sun, Pencil, Share2, Mail, Info,
  Edit2, Send, Check, Tag, Clock, FilePlus2, X, AlertCircle, FileText,
  User, UserMinus, UserPlus, ChevronRight, Search, Copy,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, isToday, isYesterday } from "date-fns";
import type { Document, DocumentEvent, DocStatus, Client } from "@shared/schema";
import { dataUrlToBlob, docFilename, docMime } from "@/lib/docUtils";
import ClientEmailSuggest from "@/components/ClientEmailSuggest";
import type { SubscriptionInfo } from "@/hooks/use-subscription";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";

interface ViewerPageProps {
  docId: string;
  onBack: () => void;
  onDeleted: () => void;
  onEdit: (docId: string) => void;
  onEditText: (docId: string) => void;
  subscription?: SubscriptionInfo;
  onPaywall?: (feature: string) => void;
}

/** Returns true if the document's pages field contains recognized text edit data (v1 or v2). */
function isTextDocument(pages: string | undefined): boolean {
  if (!pages || pages === "[]") return false;
  try {
    const p = JSON.parse(pages);
    return p?.type === "text" && (p?.v === 1 || p?.v === 2);
  } catch {
    return false;
  }
}

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_META: Record<DocStatus, { label: string; bg: string; text: string; dot: string }> = {
  draft:    { label: "Draft",    bg: "bg-gray-100 dark:bg-gray-800",   text: "text-gray-600 dark:text-gray-300",  dot: "bg-gray-400" },
  pending:  { label: "Waiting for Reply", bg: "bg-amber-50 dark:bg-amber-900/30", text: "text-amber-700 dark:text-amber-300", dot: "bg-amber-400" },
  sent:     { label: "Sent",     bg: "bg-blue-50 dark:bg-blue-900/30",   text: "text-blue-700 dark:text-blue-300",  dot: "bg-blue-400" },
  approved: { label: "Approved", bg: "bg-green-50 dark:bg-green-900/30", text: "text-green-700 dark:text-green-300", dot: "bg-green-400" },
  rejected: { label: "Rejected", bg: "bg-red-50 dark:bg-red-900/30",     text: "text-red-700 dark:text-red-300",   dot: "bg-red-400" },
};

const ALL_STATUSES: DocStatus[] = ["draft", "pending", "sent", "approved", "rejected"];

// ── Event type helpers ─────────────────────────────────────────────────────

function eventIcon(type: string) {
  switch (type) {
    case "created":         return <FilePlus2 className="w-3.5 h-3.5 text-green-500" />;
    case "edited":          return <Edit2 className="w-3.5 h-3.5 text-blue-500" />;
    case "exported":        return <Download className="w-3.5 h-3.5 text-primary" />;
    case "sent":            return <Send className="w-3.5 h-3.5 text-blue-500" />;
    case "renamed":         return <Pencil className="w-3.5 h-3.5 text-muted-foreground" />;
    case "status_changed":  return <Tag className="w-3.5 h-3.5 text-violet-500" />;
    case "client_assigned": return <User className="w-3.5 h-3.5 text-emerald-500" />;
    case "client_removed":  return <UserMinus className="w-3.5 h-3.5 text-muted-foreground" />;
    default:                return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
  }
}

function formatEventTime(ts: string | Date | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isToday(d)) return `Today ${format(d, "h:mm a")}`;
  if (isYesterday(d)) return `Yesterday ${format(d, "h:mm a")}`;
  return format(d, "MMM d, h:mm a");
}

// ── PDF/Image helpers ──────────────────────────────────────────────────────

function extractJpegFromPdf(dataUrl: string): string[] {
  const commaIdx = dataUrl.indexOf(",");
  const base64 = dataUrl.substring(commaIdx + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const images: string[] = [];
  let i = 0;
  while (i < bytes.length - 1) {
    if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) {
      const start = i;
      let j = i + 2;
      while (j < bytes.length - 1) {
        if (bytes[j] === 0xFF && bytes[j + 1] === 0xD9) {
          const end = j + 2;
          const jpegBytes = bytes.slice(start, end);
          let binaryStr = "";
          for (let k = 0; k < jpegBytes.length; k++) binaryStr += String.fromCharCode(jpegBytes[k]);
          images.push(`data:image/jpeg;base64,${btoa(binaryStr)}`);
          i = end;
          break;
        }
        j++;
      }
      if (j >= bytes.length - 1) break;
    } else {
      i++;
    }
  }
  return images;
}

interface PageDims { src: string; naturalWidth: number; naturalHeight: number; }

function loadImageDims(src: string): Promise<PageDims> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ src, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    img.onerror = () => resolve({ src, naturalWidth: 1, naturalHeight: 1 });
    img.src = src;
  });
}

// ── LazyPageImage ─────────────────────────────────────────────────────────────
// Only renders the <img> when the placeholder div enters the viewport (+ 300px
// buffer), preventing off-screen pages from decoding all at once.
function LazyPageImage({
  src, renderW, renderH, pageIndex, brightnessFilter,
}: {
  src: string; renderW: number; renderH: number; pageIndex: number; brightnessFilter?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(pageIndex === 0); // first page is always eager

  useEffect(() => {
    if (visible) return; // already revealed
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  return (
    <div ref={ref} style={{ display: "block", width: renderW, height: renderH }}>
      {visible ? (
        <img
          src={src}
          alt={`Page ${pageIndex + 1}`}
          data-testid={`pdf-page-${pageIndex}`}
          width={renderW}
          height={renderH}
          style={{ display: "block", width: renderW, height: renderH, filter: brightnessFilter }}
          decoding="async"
        />
      ) : (
        <div style={{ width: renderW, height: renderH, background: "var(--muted)" }} />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function PdfImageViewer({ dataUrl, brightnessFilter }: { dataUrl: string; brightnessFilter?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageDims[]>([]);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function extract() {
      setLoading(true);
      setPages([]);
      const srcs = extractJpegFromPdf(dataUrl);
      if (!srcs.length) { if (!cancelled) setLoading(false); return; }
      // Load pages progressively — show each page as soon as its dims are known.
      // This lets users see the first page immediately without waiting for the whole doc.
      for (const src of srcs) {
        if (cancelled) return;
        const dim = await loadImageDims(src);
        if (!cancelled) setPages((prev) => [...prev, dim]);
      }
      if (!cancelled) setLoading(false);
    }
    extract();
    return () => { cancelled = true; };
  }, [dataUrl]);

  const measure = useCallback(() => {
    if (!containerRef.current) return;
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth > 0 && clientHeight > 0) {
      setContainerSize((prev) => {
        if (prev && prev.w === clientWidth && prev.h === clientHeight) return prev;
        return { w: clientWidth, h: clientHeight };
      });
    }
  }, []);

  useEffect(() => {
    measure();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const pad = 16;
  const availW = containerSize ? containerSize.w - pad * 2 : 0;
  const availH = containerSize ? containerSize.h - pad * 2 : 0;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-x-hidden overflow-y-auto"
      style={{ WebkitOverflowScrolling: "touch" }}>
      {pages.length === 0 && loading ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        </div>
      ) : pages.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-foreground/50 text-sm">Could not display PDF</p>
        </div>
      ) : (
        pages.map((page, i) => {
          let renderW = 0; let renderH = 0;
          if (availW > 0 && availH > 0 && page.naturalWidth > 1 && page.naturalHeight > 1) {
            const scale = Math.min(availW / page.naturalWidth, availH / page.naturalHeight);
            renderW = Math.round(page.naturalWidth * scale);
            renderH = Math.round(page.naturalHeight * scale);
          }
          return (
            <div key={i} style={{ width: "100%", height: containerSize ? containerSize.h : "100%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              {renderW > 0 && renderH > 0 ? (
                <LazyPageImage
                  src={page.src} renderW={renderW} renderH={renderH}
                  pageIndex={i} brightnessFilter={brightnessFilter}
                />
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function FittedImage({ src, alt, brightnessFilter, testId }: { src: string; alt: string; brightnessFilter?: string; testId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [dims, setDims] = useState<{ nw: number; nh: number } | null>(null);

  useEffect(() => { loadImageDims(src).then((d) => setDims({ nw: d.naturalWidth, nh: d.naturalHeight })); }, [src]);

  const measure = useCallback(() => {
    if (!containerRef.current) return;
    const { clientWidth, clientHeight } = containerRef.current;
    if (clientWidth > 0 && clientHeight > 0) {
      setSize((prev) => {
        if (prev && prev.w === clientWidth && prev.h === clientHeight) return prev;
        return { w: clientWidth, h: clientHeight };
      });
    }
  }, []);

  useEffect(() => {
    measure();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const pad = 16;
  let renderW = 0; let renderH = 0;
  if (size && dims && dims.nw > 0 && dims.nh > 0) {
    const scale = Math.min((size.w - pad * 2) / dims.nw, (size.h - pad * 2) / dims.nh);
    renderW = Math.round(dims.nw * scale);
    renderH = Math.round(dims.nh * scale);
  }

  return (
    <div ref={containerRef} className="absolute inset-0 flex items-center justify-center" style={{ padding: pad }}>
      <img src={src} alt={alt} data-testid={testId}
        style={renderW > 0 ? { display: "block", width: renderW, height: renderH, filter: brightnessFilter }
          : { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", filter: brightnessFilter }} />
    </div>
  );
}

// ── Native share helper ───────────────────────────────────────────────────────
// Writes the document dataUrl to the Capacitor cache directory, then opens
// the iOS native share sheet via @capacitor/share.
async function nativeShareDoc(doc: { name: string; type: string; dataUrl: string }) {
  const { docFilename, docMime } = await import("@/lib/docUtils");
  // Sanitize: no slashes, no spaces — just a flat filename in the cache dir
  const rawFilename = docFilename(doc.name, doc.type);
  const filename = rawFilename.replace(/[/\\]/g, "_").replace(/\s+/g, "_");
  const mimeType = docMime(doc.type);
  // dataUrl format: "data:<mime>;base64,<data>"
  const base64 = doc.dataUrl.includes(",") ? doc.dataUrl.split(",")[1] : doc.dataUrl;
  const result = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
    recursive: true,
  });
  await Share.share({
    title: doc.name,
    url: result.uri,
    dialogTitle: "Send document",
  });
}

// ── Theme helpers ──────────────────────────────────────────────────────────

const ORB_LIGHT = "radial-gradient(ellipse 80% 50% at 20% 20%, rgba(180,195,220,0.55) 0%, transparent 60%), radial-gradient(ellipse 60% 70% at 80% 80%, rgba(160,180,210,0.45) 0%, transparent 55%), radial-gradient(ellipse 100% 100% at 50% 50%, rgba(200,210,230,0.25) 0%, transparent 70%), linear-gradient(135deg, #d8e2ef 0%, #c8d4e6 50%, #b8c8e0 100%)";
const ORB_DARK  = "radial-gradient(ellipse 80% 50% at 20% 20%, rgba(40,55,90,0.7) 0%, transparent 60%), radial-gradient(ellipse 60% 70% at 80% 80%, rgba(30,45,80,0.6) 0%, transparent 55%), radial-gradient(ellipse 100% 100% at 50% 50%, rgba(20,30,60,0.4) 0%, transparent 70%), linear-gradient(135deg, #0e0e14 0%, #121620 50%, #0a0e18 100%)";

function glassStyle(dark: boolean): React.CSSProperties {
  return {
    backdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`,
    WebkitBackdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`,
    background: dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)",
    borderBottom: `0.5px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)"}`,
    boxShadow: dark ? "0 1px 0 rgba(255,255,255,0.04)" : "0 1px 0 rgba(255,255,255,0.6)",
  };
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ViewerPage({ docId, onBack, onDeleted, onEdit, onEditText, subscription, onPaywall }: ViewerPageProps) {
  const { toast } = useToast();
  const [blobUrl, setBlobUrl] = useState<string>("");
  const [brightness, setBrightness] = useState(1);
  const [showBrightness, setShowBrightness] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [showInfoSheet, setShowInfoSheet] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailSentSuccess, setEmailSentSuccess] = useState(false);
  const [gmailAccessToken, setGmailAccessToken] = useState<string | null>(null);
  const [gmailConnecting, setGmailConnecting] = useState(false);

  // Inline rename state (inside info sheet)
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");

  // Client picker state
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [clientSearch, setClientSearch] = useState("");

  // Notes state
  const [notesValue, setNotesValue] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);

  const isNative = Capacitor.isNativePlatform();

  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const headerBg = dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)";
  const actionBarBg = dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)";
  const textPrimary = dark ? "#ececef" : "#1a1f2a";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["/api/documents", docId],
    queryFn: async () => {
      if (isNative) {
        const { getLocalDoc } = await import("@/lib/localDocs");
        const local = await getLocalDoc(docId);
        if (!local) throw new Error("Not found");
        return local as unknown as Document;
      }
      const res = await apiFetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
  });

  const { data: events = [] } = useQuery<DocumentEvent[]>({
    queryKey: ["/api/documents", docId, "events"],
    queryFn: async () => {
      const res = await apiFetch(`/api/documents/${docId}/events`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: showInfoSheet && !isNative,
  });

  useEffect(() => {
    if (!doc) return;
    const blob = dataUrlToBlob(doc.dataUrl);
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [doc]);

  // Sync rename field when doc loads
  useEffect(() => {
    if (doc) setNewName(doc.name);
  }, [doc]);

  // Sync notes when doc loads (don't overwrite mid-edit if sheet is already open)
  useEffect(() => {
    if (doc) setNotesValue(doc.notes ?? "");
  }, [doc?.id]);

  // Gmail OAuth: load stored token and listen for deep-link callback
  useEffect(() => {
    const stored = localStorage.getItem("gmail_access_token");
    if (stored) setGmailAccessToken(stored);

    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | null = null;
    CapApp.addListener("appUrlOpen", ({ url }: { url: string }) => {
      if (!url.includes("oauth2callback")) return;
      const codeMatch = url.match(/[?&]code=([^&]+)/);
      const code = codeMatch ? decodeURIComponent(codeMatch[1]) : null;
      if (!code) return;
      setGmailConnecting(true);
      apiRequest("POST", `${API_BASE}/api/gmail/exchange-token`, {
        code,
        redirectUri: "com.docera.app:/oauth2callback",
      })
        .then((r) => r.json())
        .then((data: { access_token?: string; error?: string }) => {
          if (data.access_token) {
            localStorage.setItem("gmail_access_token", data.access_token);
            setGmailAccessToken(data.access_token);
            toast({ title: "Gmail connected", description: "You can now send emails via your Gmail account." });
          } else {
            toast({ title: "Gmail connection failed", description: data.error ?? "Unknown error", variant: "destructive" });
          }
        })
        .catch((err: unknown) => {
          console.error("[gmail oauth] exchange error:", err);
          toast({ title: "Gmail connection failed", variant: "destructive" });
        })
        .finally(() => setGmailConnecting(false));
    }).then((h) => { handle = h; });

    return () => { handle?.remove(); };
  }, []);

  const deleteDoc = useMutation({
    mutationFn: async () => {
      if (isNative) {
        const { deleteLocalDoc } = await import("@/lib/localDocs");
        await deleteLocalDoc(docId);
        return;
      }
      return apiRequest("DELETE", `/api/documents/${docId}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      onDeleted();
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const renameDoc = useMutation({
    mutationFn: async (name: string) => {
      if (isNative) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(docId, { name });
        return;
      }
      return apiRequest("PUT", `/api/documents/${docId}`, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
      setRenaming(false);
      toast({ title: "Renamed" });
    },
    onError: () => toast({ title: "Failed to rename", variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: async (status: DocStatus) => {
      if (isNative) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(docId, { status });
        return;
      }
      return apiRequest("PUT", `/api/documents/${docId}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
    },
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const { data: clientsAll = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    enabled: !isNative,
  });

  const setClientId = useMutation({
    mutationFn: async (clientId: string | null) => {
      if (isNative) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(docId, { clientId });
        return;
      }
      return apiRequest("PUT", `/api/documents/${docId}`, { clientId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
      setShowClientPicker(false);
      setClientSearch("");
    },
    onError: () => toast({ title: "Failed to update client", variant: "destructive" }),
  });

  const duplicateDoc = useMutation({
    mutationFn: async () => {
      if (isNative) {
        const { getLocalDoc, createLocalDoc } = await import("@/lib/localDocs");
        const orig = await getLocalDoc(docId);
        if (!orig) return;
        await createLocalDoc({ ...orig, name: `${orig.name} (copy)` });
        return;
      }
      return apiRequest("POST", `/api/documents/${docId}/duplicate`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Document duplicated", description: "A copy has been added to your documents." });
    },
    onError: () => toast({ title: "Failed to duplicate", variant: "destructive" }),
  });

  const saveNotes = useMutation({
    mutationFn: async (notes: string) => {
      if (isNative) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(docId, { name: doc?.name ?? "" });
        return;
      }
      return apiRequest("PUT", `/api/documents/${docId}`, { notes: notes || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    },
    onError: () => toast({ title: "Failed to save notes", variant: "destructive" }),
  });

  const logEvent = useMutation({
    mutationFn: ({ type, label }: { type: string; label: string }) =>
      apiRequest("POST", `/api/documents/${docId}/events`, { type, label }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents", docId, "events"] }),
  });

  const sendEmail = useMutation({
    mutationFn: async ({ to, message }: { to: string; message?: string }) => {
      console.log('[email] Starting send, to:', to, 'type:', typeof to);
      try {
        if (Capacitor.isNativePlatform()) {
          console.log('[email] Native platform path');
          console.log('[email] doc?.dataUrl length:', doc?.dataUrl?.length, 'prefix:', doc?.dataUrl?.slice(0, 50));
          if (!doc?.dataUrl || doc.dataUrl.length < 50) {
            throw new Error("No file available to send. Please export the document first.");
          }
          const hasComma = doc.dataUrl.includes(",");
          console.log('[email] dataUrl has comma:', hasComma);
          const pdfBase64 = hasComma ? doc.dataUrl.split(",")[1] : doc.dataUrl;
          console.log('[email] pdfBase64 length:', pdfBase64?.length, 'type:', typeof pdfBase64);
          const targetUrl = `${API_BASE}/api/send-email-direct`;
          console.log('[email] Fetching URL:', targetUrl);
          const payload = { to, message, documentName: doc.name, pdfBase64, docType: doc.type };
          console.log('[email] Payload keys:', Object.keys(payload), 'doc.name:', doc.name, 'doc.type:', doc.type);
          const res = await apiRequest("POST", targetUrl, payload);
          console.log('[email] Response status:', res.status);
          return res.json() as Promise<{ ok?: boolean; error?: string }>;
        }
        console.log('[email] Web platform path, docId:', docId);
        const res = await apiRequest("POST", `/api/documents/${docId}/send-email`, { to, message });
        console.log('[email] Web response status:', res.status);
        return res.json() as Promise<{ ok?: boolean; error?: string }>;
      } catch (err: unknown) {
        const e = err as Error & { code?: number; name?: string };
        console.log('[email] Full error:', JSON.stringify(err), e?.message, e?.name, e?.code, e?.stack);
        throw err;
      }
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId, "events"] });
      setEmailSentSuccess(true);
      toast({ title: "Email sent!", description: `Document sent to ${vars.to}` });
      setTimeout(() => {
        setShowEmailModal(false);
        setEmailTo("");
        setEmailMessage("");
        setEmailError("");
        setEmailSentSuccess(false);
      }, 1800);
    },
    onError: (err: unknown) => {
      console.error("[sendEmail] Error:", err instanceof Error ? err.message : String(err));
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setEmailError(msg);
      toast({ title: "Failed to send email", variant: "destructive" });
    },
  });

  const sendViaGmail = useMutation({
    mutationFn: async ({ to, message }: { to: string; message?: string }) => {
      if (!gmailAccessToken) throw new Error("Gmail not connected");
      if (!doc?.dataUrl || doc.dataUrl.length < 50) throw new Error("No file available to send.");
      const pdfBase64 = doc.dataUrl.includes(",") ? doc.dataUrl.split(",")[1] : doc.dataUrl;
      const res = await apiRequest("POST", `${API_BASE}/api/gmail/send`, {
        accessToken: gmailAccessToken,
        to,
        subject: `Document from Docera – ${doc.name}`,
        message,
        pdfBase64,
        documentName: doc.name,
      });
      return res.json() as Promise<{ ok?: boolean; error?: string }>;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId] });
      setEmailSentSuccess(true);
      toast({ title: "Email sent!", description: `Document sent to ${vars.to}` });
      setTimeout(() => {
        setShowEmailModal(false);
        setEmailTo("");
        setEmailMessage("");
        setEmailError("");
        setEmailSentSuccess(false);
      }, 1800);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setEmailError(msg);
      if (msg.includes("401") || msg.includes("invalid_grant") || msg.includes("expired")) {
        localStorage.removeItem("gmail_access_token");
        setGmailAccessToken(null);
      }
      toast({ title: "Failed to send email", variant: "destructive" });
    },
  });

  const handleConnectGmail = async () => {
    const clientId = Capacitor.isNativePlatform()
      ? "787920130380-25us11cn9ekfe14fbkoj4dntqf6i7hlk.apps.googleusercontent.com"
      : "787920130380-euura0so62q39iro5t4ukfqlsiu5tagd.apps.googleusercontent.com";
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      `?client_id=${clientId}` +
      "&redirect_uri=com.docera.app:/oauth2callback" +
      "&response_type=code" +
      "&scope=https://www.googleapis.com/auth/gmail.send" +
      "&access_type=offline" +
      "&prompt=consent";
    await Browser.open({ url: authUrl });
  };

  const handleDisconnectGmail = () => {
    localStorage.removeItem("gmail_access_token");
    setGmailAccessToken(null);
  };

  const handleSendEmail = () => {
    setEmailError("");
    const trimmed = emailTo.trim();
    if (!trimmed) {
      toast({ title: "Please enter an email address", variant: "destructive" });
      return;
    }
    if (gmailAccessToken && Capacitor.isNativePlatform()) {
      sendViaGmail.mutate({ to: trimmed, message: emailMessage.trim() || undefined });
    } else {
      sendEmail.mutate({ to: trimmed, message: emailMessage.trim() || undefined });
    }
  };

  const handleDownload = () => {
    if (!doc || !blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = docFilename(doc.name, doc.type);
    a.click();
    logEvent.mutate({ type: "exported", label: "Exported as " + doc.type.toUpperCase() });
  };

  const handleDelete = () => {
    if (confirm("Delete this document? This cannot be undone.")) deleteDoc.mutate();
  };

  const handleShare = async () => {
    if (!doc) return;
    if (!doc.dataUrl || doc.dataUrl.length < 50) {
      toast({ title: "No file available", description: "This document has no exported file yet.", variant: "destructive" });
      return;
    }
    setIsSharing(true);
    try {
      if (isNative) {
        await nativeShareDoc(doc as { name: string; type: string; dataUrl: string });
        return;
      }
      const filename = docFilename(doc.name, doc.type);
      const mimeType = docMime(doc.type);
      const blob = dataUrlToBlob(doc.dataUrl);
      const file = new File([blob], filename, { type: mimeType });

      if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: doc.name, text: "Shared from Docera" });
        logEvent.mutate({ type: "sent", label: "Shared via system share sheet" });
        return;
      }
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: doc.name, text: `Check out: ${doc.name}`, url: window.location.href });
          logEvent.mutate({ type: "sent", label: "Shared via system share sheet" });
          return;
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
        }
      }
      setShowShareSheet(true);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast({ title: "Could not share", description: "Use Download instead.", variant: "destructive" });
    } finally {
      setIsSharing(false);
    }
  };

  const handleEmailShare = async () => {
    if (!doc) return;
    setShowShareSheet(false);
    setShowEmailModal(true);
  };

  const isImg = doc?.type === "jpeg" || doc?.type === "png";
  const isPdf = doc?.type === "pdf" || doc?.type === "text-he";
  const isTextDoc = isTextDocument(doc?.pages);
  const hasScanPages = !isTextDoc && doc?.pages && doc.pages !== "[]";
  const brightnessFilter = brightness !== 1 ? `brightness(${brightness}) contrast(${1 + (brightness - 1) * 0.4})` : undefined;

  const docStatus = (doc?.status as DocStatus | undefined) ?? "draft";
  const statusMeta = STATUS_META[docStatus] ?? STATUS_META.draft;
  const linkedClient = doc?.clientId ? clientsAll.find((c) => c.id === doc.clientId) : undefined;
  const filteredClients = clientsAll.filter((c) =>
    !clientSearch.trim() || c.name.toLowerCase().includes(clientSearch.toLowerCase())
  );

  return (
    <div className="fixed inset-0 flex flex-col z-50" style={{ background: "transparent" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 pt-12 pb-3"
        style={{ ...glassStyle(dark), background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})` }}>
        <button data-testid="button-back" onClick={onBack}
          className="w-11 h-11 rounded-xl flex items-center justify-center -ml-1 flex-shrink-0"
          style={{ color: textPrimary }}>
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate leading-tight" style={{ color: textPrimary }}>
            {isLoading ? "Loading…" : doc?.name ?? "Document"}
          </p>
          {doc && (
            <span className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${statusMeta.bg} ${statusMeta.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
              {statusMeta.label}
            </span>
          )}
        </div>

        <button data-testid="button-brightness"
          onClick={() => setShowBrightness((v) => !v)}
          className={`flex items-center gap-1.5 px-3 h-11 rounded-xl flex-shrink-0 transition-colors ${showBrightness ? "bg-amber-100 text-amber-600" : "bg-muted text-foreground"}`}>
          <Sun className="w-4 h-4" />
          <span className="text-xs font-semibold">Whiten</span>
        </button>
      </div>

      {showBrightness && (
        <div className="flex-shrink-0 flex items-center gap-3 px-4 py-3"
          style={{ background: actionBarBg, backdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, borderBottom: `0.5px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)"}` }}>
          <Sun className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input type="range" min="1" max="2" step="0.05" value={brightness}
            onChange={(e) => setBrightness(parseFloat(e.target.value))}
            className="flex-1 accent-amber-500 h-2" data-testid="slider-brightness" />
          <Sun className="w-5 h-5 text-amber-500 flex-shrink-0" />
          <button onClick={() => setBrightness(1)}
            className="text-xs text-muted-foreground font-semibold px-3 py-1.5 rounded-lg bg-muted active:opacity-60 flex-shrink-0">
            Reset
          </button>
        </div>
      )}

      {/* ── Document preview ── */}
      <div className="flex-1 overflow-hidden relative" style={{ background: "transparent" }}>
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : !doc ? (
          <p className="absolute inset-0 flex items-center justify-center text-foreground/50 text-sm">Document not found</p>
        ) : isImg ? (
          <FittedImage src={blobUrl} alt={doc.name} brightnessFilter={brightnessFilter} testId="doc-image" />
        ) : isPdf ? (
          <PdfImageViewer dataUrl={doc.dataUrl} brightnessFilter={brightnessFilter} />
        ) : null}
      </div>

      {/* ── Bottom action bar ── */}
      <div className="flex-shrink-0 flex items-center"
        style={{ background: actionBarBg, backdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? "140%" : "160%"})`, borderTop: `0.5px solid ${dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)"}`, paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>

        <button data-testid="button-download" onClick={handleDownload} disabled={!blobUrl}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 disabled:opacity-40 active:opacity-60"
          style={{ color: textPrimary }}>
          <Download className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Download</span>
        </button>

        <button data-testid="button-share" onClick={handleShare} disabled={!doc || isSharing || !blobUrl}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 text-primary disabled:opacity-40 active:opacity-60">
          {isSharing
            ? <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            : <Share2 className="w-5 h-5" />}
          <span className="text-[10px] font-semibold">Share</span>
        </button>

        <button data-testid="button-send-email"
          onClick={() => {
            if (subscription && !subscription.canUseGatedFeatures) {
              onPaywall?.("Sending emails");
              return;
            }
            if (!doc?.dataUrl || doc.dataUrl.length < 50) {
              toast({ title: "No file to send", description: "Please export or save the document first.", variant: "destructive" });
              return;
            }
            setEmailError("");
            if (linkedClient?.email && !emailTo) setEmailTo(linkedClient.email);
            setShowEmailModal(true);
          }}
          disabled={!doc}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 disabled:opacity-40 active:opacity-60"
          style={{ color: textPrimary }}>
          <Mail className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Send</span>
        </button>

        <button data-testid="button-duplicate" onClick={() => duplicateDoc.mutate()} disabled={!doc || duplicateDoc.isPending}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 disabled:opacity-40 active:opacity-60"
          style={{ color: textPrimary }}>
          {duplicateDoc.isPending
            ? <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            : <Copy className="w-5 h-5" />}
          <span className="text-[10px] font-semibold">Duplicate</span>
        </button>

        <button data-testid="button-info" onClick={() => setShowInfoSheet(true)} disabled={!doc}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 disabled:opacity-40 active:opacity-60"
          style={{ color: textPrimary }}>
          <div className="relative">
            <Info className="w-5 h-5" />
            {doc?.notes && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary" />
            )}
          </div>
          <span className="text-[10px] font-semibold">Details</span>
        </button>

        {isTextDoc && (
          <button data-testid="button-edit-text" onClick={() => onEditText(docId)}
            className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 active:opacity-60"
            style={{ color: textPrimary }}>
            <Pencil className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Edit</span>
          </button>
        )}
        {hasScanPages && (
          <button data-testid="button-edit-doc" onClick={() => onEdit(docId)}
            className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 active:opacity-60"
            style={{ color: textPrimary }}>
            <Pencil className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Edit</span>
          </button>
        )}

        <button data-testid="button-delete" onClick={handleDelete} disabled={deleteDoc.isPending}
          className="flex-1 flex flex-col items-center gap-1 pt-3 pb-1 text-red-500 disabled:opacity-40 active:opacity-60">
          <Trash2 className="w-5 h-5" />
          <span className="text-[10px] font-semibold">Delete</span>
        </button>
      </div>

      {/* ── Share sheet ── */}
      {showShareSheet && (
        <div className="fixed inset-0 z-[60] flex items-end" onClick={() => setShowShareSheet(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="relative w-full bg-card rounded-t-3xl px-5 pt-4 shadow-2xl"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}>
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-5" />
            <p className="text-sm font-bold text-foreground mb-1">Share document</p>
            <p className="text-xs text-muted-foreground mb-5 truncate">{doc?.name}</p>
            <div className="flex flex-col gap-3">
              <button data-testid="button-share-download"
                onClick={() => { handleDownload(); setShowShareSheet(false); }}
                className="flex items-center gap-4 p-4 rounded-2xl bg-muted active:opacity-70 text-left">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Download className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Download file</p>
                  <p className="text-xs text-muted-foreground">Save PDF to your device</p>
                </div>
              </button>
              <button data-testid="button-share-email" onClick={handleEmailShare}
                className="flex items-center gap-4 p-4 rounded-2xl bg-muted active:opacity-70 text-left">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Mail className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Send by email</p>
                  <p className="text-xs text-muted-foreground">Open your email app</p>
                </div>
              </button>
            </div>
            <button data-testid="button-share-cancel" onClick={() => setShowShareSheet(false)}
              className="w-full mt-4 py-3 rounded-2xl text-sm font-semibold text-muted-foreground bg-muted active:opacity-70">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Email modal ── */}
      {showEmailModal && (
        <div className="fixed inset-0 z-[60] flex items-end" onClick={() => { if (!sendEmail.isPending && !sendViaGmail.isPending) { setShowEmailModal(false); setEmailError(""); } }}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full bg-card rounded-t-3xl shadow-2xl"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle + header */}
            <div className="pt-3 pb-4 px-5 border-b border-border">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-base font-bold text-foreground">Send by Email</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[240px]">{doc?.name}</p>
                </div>
                <button
                  data-testid="button-email-close"
                  onClick={() => { setShowEmailModal(false); setEmailError(""); }}
                  disabled={sendEmail.isPending || sendViaGmail.isPending}
                  className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground active:opacity-60 disabled:opacity-40"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Form */}
            <div className="px-5 pt-5 pb-2 flex flex-col gap-4">

              {/* Document chip */}
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-primary/8 border border-primary/15">
                <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Sending</p>
                  <p className="text-sm font-semibold text-foreground truncate">{doc?.name}</p>
                </div>
              </div>

              {/* Gmail connection status (native only) */}
              {Capacitor.isNativePlatform() && (
                gmailAccessToken ? (
                  <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-green-50 dark:bg-green-950/30 border border-green-200/60 dark:border-green-800/30">
                    <div className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <span className="text-green-700 dark:text-green-400 text-sm font-medium">Gmail connected</span>
                    </div>
                    <button
                      onClick={handleDisconnectGmail}
                      className="text-xs text-muted-foreground underline active:opacity-60"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleConnectGmail}
                    disabled={gmailConnecting}
                    className="w-full py-3 rounded-2xl bg-blue-600 text-white text-sm font-bold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50"
                  >
                    {gmailConnecting ? (
                      <>
                        <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                        Connecting…
                      </>
                    ) : (
                      <>
                        <Mail className="w-4 h-4" />
                        Connect Gmail to Send
                      </>
                    )}
                  </button>
                )
              )}

              {/* Recipient email */}
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                  Recipient email
                </label>
                <ClientEmailSuggest
                  data-testid="input-email-to"
                  value={emailTo}
                  onChange={(v) => { setEmailTo(v); setEmailError(""); }}
                  linkedClientId={doc?.clientId ?? null}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSendEmail(); }}
                  disabled={sendEmail.isPending || sendViaGmail.isPending}
                  inputClassName="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </div>

              {/* Message */}
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                  Message <span className="text-muted-foreground/50 font-normal normal-case">(optional)</span>
                </label>
                <textarea
                  data-testid="input-email-message"
                  placeholder="Add a personal note to the recipient…"
                  value={emailMessage}
                  onChange={(e) => setEmailMessage(e.target.value)}
                  rows={3}
                  disabled={sendEmail.isPending || sendViaGmail.isPending}
                  className="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none resize-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </div>

              {/* Error */}
              {emailError && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/30">
                  <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <span className="text-red-600 dark:text-red-400 text-sm leading-snug">{emailError}</span>
                </div>
              )}

              {/* Send button / success */}
              {emailSentSuccess ? (
                <div className="w-full py-3.5 rounded-2xl bg-green-500/10 border border-green-500/20 text-green-600 text-sm font-bold flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" />
                  Document sent successfully
                </div>
              ) : (
                <button
                  data-testid="button-email-send"
                  onClick={handleSendEmail}
                  disabled={sendEmail.isPending || sendViaGmail.isPending || !emailTo.trim() || (Capacitor.isNativePlatform() && !gmailAccessToken)}
                  className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50 transition-opacity"
                >
                  {(sendEmail.isPending || sendViaGmail.isPending) ? (
                    <>
                      <div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      {gmailAccessToken && Capacitor.isNativePlatform() ? "Send via Gmail" : "Send Document"}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Info / Details sheet ── */}
      {showInfoSheet && (
        <div className="fixed inset-0 z-[60] flex items-end" onClick={() => { setShowInfoSheet(false); setRenaming(false); }}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full bg-card rounded-t-3xl shadow-2xl flex flex-col max-h-[85vh]"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Handle */}
            <div className="flex-shrink-0 pt-3 pb-2 px-5">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-3" />
              <div className="flex items-center justify-between">
                <p className="text-base font-bold text-foreground">Document Details</p>
                <button onClick={() => { setShowInfoSheet(false); setRenaming(false); }}
                  className="text-xs text-primary font-semibold px-3 py-1.5 rounded-lg bg-primary/10 active:opacity-60">
                  Done
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-2">
              {/* ── Rename ── */}
              <div className="mb-5">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Name</p>
                {renaming ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      data-testid="input-rename-doc"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newName.trim()) renameDoc.mutate(newName.trim());
                        if (e.key === "Escape") setRenaming(false);
                      }}
                      className="flex-1 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground border-0 outline-none"
                    />
                    <button
                      onClick={() => { if (newName.trim()) renameDoc.mutate(newName.trim()); }}
                      disabled={renameDoc.isPending || !newName.trim()}
                      className="px-3 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 active:opacity-70 flex items-center gap-1"
                    >
                      {renameDoc.isPending
                        ? <div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                        : <Check className="w-4 h-4" />}
                    </button>
                    <button onClick={() => setRenaming(false)}
                      className="px-3 py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-semibold active:opacity-70">
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    data-testid="button-doc-rename"
                    onClick={() => { setNewName(doc?.name ?? ""); setRenaming(true); }}
                    className="w-full flex items-center justify-between px-3 py-3 rounded-xl bg-muted text-sm text-foreground text-left active:opacity-70"
                  >
                    <span className="truncate font-medium">{doc?.name ?? "—"}</span>
                    <Edit2 className="w-4 h-4 text-muted-foreground flex-shrink-0 ml-2" />
                  </button>
                )}
              </div>

              {/* ── Status ── */}
              <div className="mb-5">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Status</p>
                <div className="flex flex-wrap gap-2">
                  {ALL_STATUSES.map((s) => {
                    const m = STATUS_META[s];
                    const active = docStatus === s;
                    return (
                      <button
                        key={s}
                        data-testid={`status-chip-${s}`}
                        onClick={() => { if (!active) setStatus.mutate(s); }}
                        disabled={setStatus.isPending}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all active:scale-95 border-2 ${
                          active
                            ? `${m.bg} ${m.text} border-current`
                            : "bg-muted text-muted-foreground border-transparent"
                        }`}
                      >
                        <span className={`w-2 h-2 rounded-full ${m.dot}`} />
                        {m.label}
                        {active && <Check className="w-3 h-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ── Client ── */}
              <div className="mb-5">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Client</p>
                {linkedClient ? (
                  <div className="flex items-center gap-3 p-3 bg-muted rounded-2xl">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold bg-primary text-primary-foreground">
                      {linkedClient.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">{linkedClient.name}</p>
                      {linkedClient.email && <p className="text-xs text-muted-foreground truncate">{linkedClient.email}</p>}
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button
                        data-testid="button-change-client"
                        onClick={() => { setClientSearch(""); setShowClientPicker(true); }}
                        className="p-1.5 rounded-lg bg-background text-muted-foreground active:opacity-60"
                        title="Change client"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                      <button
                        data-testid="button-unlink-client"
                        onClick={() => setClientId.mutate(null)}
                        disabled={setClientId.isPending}
                        className="p-1.5 rounded-lg bg-background text-red-400 active:opacity-60 disabled:opacity-40"
                        title="Unlink client"
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    data-testid="button-assign-client"
                    onClick={() => { setClientSearch(""); setShowClientPicker(true); }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl bg-muted text-sm text-muted-foreground active:opacity-70 border-2 border-dashed border-border"
                  >
                    <UserPlus className="w-4 h-4 flex-shrink-0" />
                    <span>Assign to a client</span>
                  </button>
                )}
              </div>

              {/* ── Notes ── */}
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Notes</p>
                  <div className="flex items-center gap-1.5">
                    {saveNotes.isPending && (
                      <div className="w-3 h-3 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                    )}
                    {notesSaved && !saveNotes.isPending && (
                      <span className="text-[10px] text-green-600 dark:text-green-400 font-semibold">Saved</span>
                    )}
                  </div>
                </div>
                <textarea
                  data-testid="textarea-doc-notes"
                  value={notesValue}
                  onChange={(e) => setNotesValue(e.target.value)}
                  onBlur={() => {
                    const trimmed = notesValue.trim();
                    const saved = (doc?.notes ?? "").trim();
                    if (trimmed !== saved) saveNotes.mutate(trimmed);
                  }}
                  placeholder="Add notes, context, or reminders…"
                  rows={4}
                  className="w-full px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground border-0 outline-none resize-none placeholder:text-muted-foreground/50 leading-relaxed"
                />
              </div>

              {/* ── File info ── */}
              {doc && (
                <div className="mb-5 grid grid-cols-2 gap-2">
                  <div className="bg-muted rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Type</p>
                    <p className="text-sm font-semibold text-foreground uppercase">{doc.type}</p>
                  </div>
                  <div className="bg-muted rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Size</p>
                    <p className="text-sm font-semibold text-foreground">
                      {doc.size > 1024 * 1024 ? `${(doc.size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(doc.size / 1024)} KB`}
                    </p>
                  </div>
                  <div className="bg-muted rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Created</p>
                    <p className="text-sm font-semibold text-foreground">
                      {doc.createdAt ? format(new Date(doc.createdAt), "MMM d, yyyy") : "—"}
                    </p>
                  </div>
                  <div className="bg-muted rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-muted-foreground font-medium mb-0.5">Modified</p>
                    <p className="text-sm font-semibold text-foreground">
                      {doc.updatedAt ? format(new Date(doc.updatedAt), "MMM d, yyyy") : "—"}
                    </p>
                  </div>
                </div>
              )}

              {/* ── Timeline ── */}
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">Timeline</p>
                {events.length === 0 ? (
                  <div className="flex items-center gap-2 py-4 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    <span className="text-sm">No activity recorded yet</span>
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {events.map((evt, i) => (
                      <div key={evt.id} className="flex gap-3 pb-4 relative">
                        {/* Vertical line connecting events */}
                        {i < events.length - 1 && (
                          <div className="absolute left-[13px] top-6 bottom-0 w-px bg-border" />
                        )}
                        {/* Icon bubble */}
                        <div className="w-7 h-7 rounded-full bg-muted border border-border flex items-center justify-center flex-shrink-0 mt-0.5 z-10">
                          {eventIcon(evt.type)}
                        </div>
                        {/* Content */}
                        <div className="flex-1 min-w-0 pt-0.5">
                          <p className="text-sm text-foreground font-medium leading-tight">{evt.label}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{formatEventTime(evt.createdAt)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Client picker ── */}
      {showClientPicker && (
        <div className="fixed inset-0 z-[70] flex items-end" onClick={() => setShowClientPicker(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full bg-card rounded-t-3xl shadow-2xl max-h-[80vh] flex flex-col"
            style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-shrink-0 pt-3 pb-4 px-5 border-b border-border">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between mb-3">
                <p className="text-base font-bold text-foreground">Assign to Client</p>
                <button onClick={() => setShowClientPicker(false)} className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2 bg-muted rounded-xl px-3 py-2">
                <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  data-testid="input-client-picker-search"
                  autoFocus
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Search clients…"
                  className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-2">
              {clientsAll.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No clients yet. Create one from the Clients tab.</p>
              ) : filteredClients.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No clients match your search.</p>
              ) : (
                filteredClients.map((c) => (
                  <button
                    key={c.id}
                    data-testid={`picker-client-${c.id}`}
                    onClick={() => setClientId.mutate(c.id)}
                    disabled={setClientId.isPending}
                    className={`flex items-center gap-3 px-3 py-3 rounded-2xl border text-left active:opacity-70 disabled:opacity-50 transition-colors ${
                      doc?.clientId === c.id
                        ? "bg-primary/10 border-primary/30"
                        : "bg-muted border-transparent"
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold bg-primary text-primary-foreground">
                      {c.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
                      {c.email && <p className="text-xs text-muted-foreground truncate">{c.email}</p>}
                    </div>
                    {doc?.clientId === c.id && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
