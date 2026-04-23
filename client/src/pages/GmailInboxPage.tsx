import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft, Mail, RefreshCw, FileText, Send, X, AlertCircle,
  Plus, Paperclip, Share2, Loader2, WifiOff, Sun, Moon, ImageOff, Search,
  ChevronDown, ChevronRight, ChevronLeft, Inbox, Folder, PenLine,
} from "lucide-react";
import { Capacitor, registerPlugin } from "@capacitor/core";

const QuickLook = registerPlugin<{ openPDF: (options: { path: string }) => Promise<void> }>("QuickLook");
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";
import {
  format, isValid, isToday, isYesterday, isSameDay,
} from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { API_BASE } from "@/lib/queryClient";
import ClientProfilePage from "./ClientProfilePage";

// ─── Constants ────────────────────────────────────────────────────────────────

const WEB_CLIENT_ID = "787920130380-euura0so62q39iro5t4ukfqlsiu5tagd.apps.googleusercontent.com";
const RAILWAY_REDIRECT_URI = "https://docera-production.up.railway.app/api/gmail/callback";
const GMAIL_TOKEN_KEY = "gmail_access_token";
const GMAIL_REFRESH_TOKEN_KEY = "gmail_refresh_token";
const DARK_MODE_KEY = "docera_inbox_dark";
const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

// ─── Theme ────────────────────────────────────────────────────────────────────

interface Theme {
  bg: string;
  header: string;
  cardBg: string;
  receivedBg: string;
  receivedText: string;
  sentBg: string;
  sentText: string;
  subText: string;
  inputBg: string;
  border: string;
  pillBg: string;
  searchBg: string;
  avatarBg: string;
  avatarText: string;
}

function getTheme(dark: boolean): Theme {
  return dark
    ? {
        bg: "#041a15",
        header: "#00332a",
        cardBg: "rgba(255,255,255,0.07)",
        receivedBg: "rgba(255,255,255,0.08)",
        receivedText: "rgba(255,255,255,0.92)",
        sentBg: "#fef7ed",
        sentText: "#00332a",
        subText: "rgba(255,255,255,0.50)",
        inputBg: "rgba(255,255,255,0.10)",
        border: "rgba(255,255,255,0.10)",
        pillBg: "rgba(255,255,255,0.10)",
        searchBg: "rgba(255,255,255,0.10)",
        avatarBg: "#fef7ed",
        avatarText: "#00332a",
      }
    : {
        bg: "#fef7ed",
        header: "#fef7ed",
        cardBg: "#ffffff",
        receivedBg: "rgba(0,51,42,0.07)",
        receivedText: "rgba(41,38,27,0.92)",
        sentBg: "#00332a",
        sentText: "#fef7ed",
        subText: "rgba(41,38,27,0.55)",
        inputBg: "rgba(0,51,42,0.08)",
        border: "rgba(0,0,0,0.06)",
        pillBg: "rgba(0,51,42,0.08)",
        searchBg: "rgba(0,51,42,0.08)",
        avatarBg: "#00332a",
        avatarText: "#fef7ed",
      };
}

// ─── Types ────────────────────────────────────────────────────────────────────

type GmailAttachment = { id: string; name: string; mimeType: string; size: number };

type GmailMessage = {
  id: string;
  direction: "sent" | "received";
  fromName: string;
  fromEmail: string;
  toEmail: string;
  date: string;
  subject: string;
  body: string;
  snippet: string;
  attachments: GmailAttachment[];
};

type Contact = {
  email: string;
  name: string;
  lastSubject: string;
  lastDate: string;
  lastMessage: string;
  messageCount: number;
  lastDirection: "sent" | "received";
  hasUnread: boolean;
  hasAttachments: boolean;
  isImportant?: boolean;
  score?: number;
};

type DocItem = { id: string; name: string; type: string; dataUrl: string };

// ─── PDF thumbnail cache ──────────────────────────────────────────────────────

const thumbCache = new Map<string, string>();

// ─── PDF base64 cache (reused by viewer to avoid re-fetching) ─────────────────
const base64Cache = new Map<string, string>();

// ─── Thumbnail load semaphore (max 2 concurrent) ──────────────────────────────

let activeThumbnailLoads = 0;
const MAX_CONCURRENT_THUMBNAILS = 2;
const thumbnailQueue: Array<() => void> = [];
let mountedThumbnailCount = 0;

function acquireThumbnailSlot(): Promise<void> {
  return new Promise(resolve => {
    if (activeThumbnailLoads < MAX_CONCURRENT_THUMBNAILS) {
      activeThumbnailLoads++;
      resolve();
    } else {
      thumbnailQueue.push(() => { activeThumbnailLoads++; resolve(); });
    }
  });
}

function releaseThumbnailSlot() {
  activeThumbnailLoads--;
  const next = thumbnailQueue.shift();
  if (next) next();
}

async function generatePdfThumbnail(base64: string): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).href;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = Math.floor(viewport.width * 0.45);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return "";
  }
}

// ─── Open PDF via native Quick Look (iOS) ─────────────────────────────────────

async function openPdfNative(base64: string, name: string) {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const safe = name.replace(/[^a-z0-9._-]/gi, "_");
      const fileName = safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
      await Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory: Directory.Cache,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({
        path: fileName,
        directory: Directory.Cache,
      });
      await QuickLook.openPDF({ path: uri });
    } catch (err) {
      console.error("PDF open error:", err);
    }
  } else {
    const blob = await fetch(`data:application/pdf;base64,${base64}`).then(r => r.blob());
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decodeHtml(html: string): string {
  return (html ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function fmtMsgTime(dateStr: string) {
  try {
    const d = new Date(dateStr);
    if (!isValid(d)) return "";
    if (isToday(d)) return format(d, "h:mm a");
    if (isYesterday(d)) return "Yesterday";
    return format(d, "MMM d");
  } catch { return ""; }
}

function fmtBubbleTime(dateStr: string) {
  try {
    const d = new Date(dateStr);
    return isValid(d) ? format(d, "h:mm a") : "";
  } catch { return ""; }
}

function fmtDateSep(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (!isValid(d)) return "";
    if (isToday(d)) return "Today";
    if (isYesterday(d)) return "Yesterday";
    return format(d, "MMMM d");
  } catch { return ""; }
}

function initials(name: string) {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}


async function gmailPost<T>(
  path: string,
  extra: Record<string, unknown>,
  token: string,
  refreshToken?: string | null,
): Promise<T> {
  const makeRequest = async (accessToken: string) => {
    return fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, ...extra }),
      credentials: Capacitor.isNativePlatform() ? "omit" : "include",
    });
  };

  let res = await makeRequest(token);

  if (res.status === 401) {
    const storedRefresh = localStorage.getItem("gmail_refresh_token");
    if (storedRefresh) {
      try {
        const refreshRes = await fetch(`${API_BASE}/api/gmail/refresh-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: storedRefresh }),
          credentials: "omit",
        });
        if (refreshRes.ok) {
          const refreshData = await refreshRes.json();
          if (refreshData.accessToken) {
            localStorage.setItem("gmail_access_token", refreshData.accessToken);
            res = await makeRequest(refreshData.accessToken);
          }
        }
      } catch {}
    }
    if (res.status === 401) {
      localStorage.removeItem("gmail_access_token");
      localStorage.removeItem("gmail_refresh_token");
      throw Object.assign(new Error("token_expired"), { status: 401 });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? "Request failed"), { status: res.status });
  }
  return res.json();
}

// ─── Date separator ───────────────────────────────────────────────────────────

function DateSeparator({ dateStr, theme }: { dateStr: string; theme: Theme }) {
  const label = fmtDateSep(dateStr);
  if (!label) return null;
  return (
    <div className="flex items-center justify-center my-3">
      <span
        className="px-3 py-1 rounded-full text-[11px] font-medium"
        style={{ background: theme.pillBg, color: theme.subText }}
      >
        {label}
      </span>
    </div>
  );
}

// ─── PDF thumbnail component ──────────────────────────────────────────────────

function PdfThumbnail({
  messageId, attachment, token, refreshToken, theme, onTap, bodyText, isLastAtt,
}: {
  messageId: string; attachment: GmailAttachment; token: string; refreshToken?: string | null;
  theme: Theme; onTap: () => void; bodyText?: string; isLastAtt?: boolean;
}) {
  const cached = thumbCache.get(attachment.id) ?? null;
  const [thumb, setThumb] = useState<string | null>(cached);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(!!cached);
  const containerRef = useRef<HTMLDivElement>(null);
  const largeFile = attachment.size > 3 * 1024 * 1024;

  useEffect(() => {
    mountedThumbnailCount++;
    return () => { mountedThumbnailCount--; };
  }, []);

  useEffect(() => {
    if (cached || largeFile) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cached, largeFile]);

  useEffect(() => {
    if (!visible || thumb || largeFile) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      await acquireThumbnailSlot();
      try {
        if (cancelled) return;
        const data = await gmailPost<{ base64: string }>(
          "/api/gmail/attachment", { messageId, attachmentId: attachment.id }, token, refreshToken,
        );
        if (cancelled) return;
        base64Cache.set(attachment.id, data.base64);
        const url = await generatePdfThumbnail(data.base64);
        if (!cancelled && url) { thumbCache.set(attachment.id, url); setThumb(url); }
      } catch { } finally {
        releaseThumbnailSlot();
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, attachment.id]);

  const fileCardArea = (
    <div
      style={{
        width: 260, height: 160,
        background: theme.cardBg,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
        border: `1px solid ${theme.border}`,
      }}
    >
      <div className="w-12 h-12 rounded-xl bg-red-500 flex items-center justify-center">
        <span className="text-white text-xs font-bold">PDF</span>
      </div>
      <p className="text-xs font-semibold px-4 text-center" style={{ color: theme.receivedText, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {attachment.name}
      </p>
      <p className="text-[11px]" style={{ color: theme.subText }}>{fmtSize(attachment.size)}</p>
      {loading && <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.subText }} />}
    </div>
  );

  return (
    <div ref={containerRef} style={{ width: 260, borderRadius: 14, overflow: "hidden", marginBottom: 6 }}>
      <button onClick={onTap} className="block active:opacity-80" style={{ width: 260 }}>
        {thumb ? (
          <>
            <div style={{ width: 260, height: 160, overflow: "hidden" }}>
              <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }} />
            </div>
            <div style={{ width: 260, height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", background: "rgba(0,0,0,0.6)" }}>
              <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center flex-shrink-0">
                <span className="text-white text-[7px] font-bold">PDF</span>
              </div>
              <div className="flex-1 min-w-0 text-left">
                <p className="text-white text-[11px] font-semibold truncate">{attachment.name}</p>
                <p className="text-white/55 text-[10px]">{fmtSize(attachment.size)}</p>
              </div>
            </div>
          </>
        ) : (
          fileCardArea
        )}
      </button>
      {isLastAtt && bodyText && (
        <div style={{ padding: "8px 12px", fontSize: 13, color: thumb ? "white" : theme.receivedText, background: thumb ? "rgba(0,0,0,0.6)" : theme.cardBg }}>
          {bodyText}
        </div>
      )}
    </div>
  );
}

// ─── Image attachment ─────────────────────────────────────────────────────────

function ImageAttachment({
  messageId, attachment, token, refreshToken, theme, bodyText, isLastAtt,
}: {
  messageId: string; attachment: GmailAttachment; token: string; refreshToken?: string | null;
  theme: Theme; bodyText?: string; isLastAtt?: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    gmailPost<{ base64: string }>(
      "/api/gmail/attachment", { messageId, attachmentId: attachment.id }, token, refreshToken,
    )
      .then(data => { if (!cancelled) setSrc(`data:${attachment.mimeType};base64,${data.base64}`); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, attachment.id]);

  return (
    <>
      {fullscreen && src && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.96)" }}
          onClick={() => setFullscreen(false)}
        >
          <img src={src} alt="" className="max-w-full max-h-full object-contain" />
          <button
            className="absolute top-12 right-4 w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.15)" }}
            onClick={() => setFullscreen(false)}
          >
            <X className="w-5 h-5 text-white" />
          </button>
        </div>
      )}
      <div ref={containerRef} style={{ width: 260, borderRadius: 14, overflow: "hidden", marginBottom: 6 }}>
        <button onClick={() => src && setFullscreen(true)} className="block active:opacity-80" style={{ width: 260 }}>
          <div style={{ width: 260, height: 160, overflow: "hidden", background: "#f0f0f0" }}>
            {!visible || loading ? (
              <div className="w-full h-full flex items-center justify-center" style={{ background: theme.pillBg }}>
                {loading && <Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.subText }} />}
              </div>
            ) : src ? (
              <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }} />
            ) : (
              <div className="w-full h-full flex items-center justify-center" style={{ background: "rgba(128,128,128,0.18)" }}>
                <ImageOff className="w-8 h-8" style={{ color: theme.subText }} />
              </div>
            )}
          </div>
          <div style={{ width: 260, height: 52, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", background: "rgba(0,0,0,0.6)" }}>
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.15)" }}>
              <ImageOff className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-white text-[11px] font-semibold truncate">{attachment.name}</p>
              <p className="text-white/55 text-[10px]">{fmtSize(attachment.size)}</p>
            </div>
          </div>
        </button>
        {isLastAtt && bodyText && (
          <div style={{ padding: "8px 12px", fontSize: 13, color: "white", background: "rgba(0,0,0,0.6)" }}>
            {bodyText}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Forward sheet ────────────────────────────────────────────────────────────

function ForwardSheet({
  contacts, attachment, messageId, token, refreshToken, onClose, theme,
}: {
  contacts: Contact[]; attachment: GmailAttachment; messageId: string;
  token: string; refreshToken?: string | null; onClose: () => void; theme: Theme;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  const filtered = search
    ? contacts.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.email.toLowerCase().includes(search.toLowerCase()),
      )
    : contacts;

  const forward = async (contact: Contact) => {
    setSending(contact.email);
    try {
      const attData = await gmailPost<{ base64: string }>(
        "/api/gmail/attachment", { messageId, attachmentId: attachment.id }, token, refreshToken,
      );
      await gmailPost("/api/gmail/send-message", {
        to: contact.email,
        subject: `Fwd: ${attachment.name}`,
        body: `Forwarding ${attachment.name}`,
        attachmentBase64: attData.base64,
        attachmentName: attachment.name,
        attachmentMimeType: attachment.mimeType || "application/octet-stream",
      }, token, refreshToken);
      toast({ title: "Forwarded!", description: `→ ${contact.name}` });
      onClose();
    } catch (err) {
      toast({ title: "Forward failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className="relative w-full rounded-t-3xl shadow-2xl max-h-[75vh] flex flex-col"
        style={{ background: theme.header, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="pt-3 pb-3 px-5 flex-shrink-0 border-b" style={{ borderColor: theme.border }}>
          <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: theme.subText }} />
          <div className="flex items-center justify-between mb-3">
            <p className="font-bold text-base" style={{ color: theme.receivedText }}>Forward</p>
            <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: theme.pillBg }}>
              <X className="w-4 h-4" style={{ color: theme.subText }} />
            </button>
          </div>
          <input
            type="text"
            placeholder="Search contacts…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-9 px-3 rounded-xl text-sm outline-none"
            style={{ background: theme.searchBg, color: theme.receivedText, border: `1px solid ${theme.border}` }}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          {filtered.map(c => (
            <button
              key={c.email}
              onClick={() => forward(c)}
              disabled={!!sending}
              className="flex items-center gap-3 p-3 rounded-2xl active:opacity-70 disabled:opacity-50 text-left"
              style={{ background: theme.cardBg }}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
                style={{ background: theme.avatarBg, color: theme.avatarText }}
              >
                {initials(c.name)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: theme.receivedText }}>{c.name}</p>
                <p className="text-xs truncate" style={{ color: theme.subText }}>{c.email}</p>
              </div>
              {sending === c.email && <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.subText }} />}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-center text-sm py-8" style={{ color: theme.subText }}>No contacts found</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "yellow", color: "black" }}>{text.slice(idx, idx + query.length)}</mark>
      {highlightText(text.slice(idx + query.length), query)}
    </>
  );
}

function MessageBubble({
  msg, token, refreshToken, contacts, theme, searchQuery, onOpenPdf,
}: {
  msg: GmailMessage; token: string; refreshToken?: string | null; contacts: Contact[]; theme: Theme; searchQuery?: string;
  onOpenPdf?: (att: GmailAttachment, msgId: string) => void;
}) {
  const { toast } = useToast();
  const isSent = msg.direction === "sent";
  const [forwardTarget, setForwardTarget] = useState<GmailAttachment | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBodyTouchStart = (text: string) => {
    longPressTimer.current = setTimeout(() => {
      navigator.clipboard.writeText(text).then(() => toast({ title: "Copied" })).catch(() => {});
    }, 500);
  };
  const handleBodyTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const isPdf = (att: GmailAttachment) =>
    att.mimeType === "application/pdf" || att.name.toLowerCase().endsWith(".pdf");
  const isImage = (att: GmailAttachment) => att.mimeType.startsWith("image/");

  const bubbleBg = isSent ? theme.sentBg : theme.receivedBg;
  const bubbleText = isSent ? theme.sentText : theme.receivedText;
  const bubbleSub = isSent ? "rgba(255,255,255,0.55)" : theme.subText;
  const hasAtts = msg.attachments.length > 0;

  return (
    <>
      {forwardTarget && (
        <ForwardSheet
          contacts={contacts}
          attachment={forwardTarget}
          messageId={msg.id}
          token={token}
          refreshToken={refreshToken}
          onClose={() => setForwardTarget(null)}
          theme={theme}
        />
      )}

      <div className={`flex items-end gap-1.5 mb-1.5 ${isSent ? "justify-end" : "justify-start"}`}>

        {/* Forward icon — left of bubble for received */}
        {!isSent && hasAtts && (
          <button
            onClick={() => setForwardTarget(msg.attachments[0])}
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 active:opacity-60 mb-0.5"
            style={{ background: theme.pillBg }}
          >
            <Share2 className="w-3.5 h-3.5" style={{ color: theme.subText }} />
          </button>
        )}

        {/* Bubble */}
        <div
          style={{
            background: hasAtts ? "transparent" : bubbleBg,
            borderRadius: isSent ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
            overflow: "hidden",
            ...(hasAtts ? { width: 260 } : { maxWidth: "78%" }),
          }}
        >
          {/* Attachments — 260px uniform cards */}
          {(() => {
            const rawBody = msg.body || (!hasAtts ? msg.snippet : "");
            const isAutoGenerated = !rawBody ||
              rawBody.startsWith("Please find the attached") ||
              rawBody.startsWith("Forwarding ") ||
              rawBody.trim() === "";
            const displayBody = isAutoGenerated ? undefined : rawBody;

            return msg.attachments.map((att, idx) => {
              const isLastAtt = idx === msg.attachments.length - 1;
              if (isPdf(att)) {
                return (
                  <div key={att.id}>
                    <PdfThumbnail
                      messageId={msg.id}
                      attachment={att}
                      token={token}
                      refreshToken={refreshToken}
                      theme={theme}
                      onTap={() => onOpenPdf?.(att, msg.id)}
                      bodyText={displayBody}
                      isLastAtt={isLastAtt}
                    />
                  </div>
                );
              }
              if (isImage(att)) {
                return (
                  <ImageAttachment
                    key={att.id}
                    messageId={msg.id}
                    attachment={att}
                    token={token}
                    refreshToken={refreshToken}
                    theme={theme}
                    bodyText={displayBody}
                    isLastAtt={isLastAtt}
                  />
                );
              }
              return (
                <div key={att.id} style={{ width: 260, borderRadius: 14, overflow: "hidden", marginBottom: 6 }}>
                  <button onClick={() => { if (isPdf(att)) onOpenPdf?.(att, msg.id); }} className="block active:opacity-80" style={{ width: 260 }}>
                    <div style={{ width: 260, height: 160, background: theme.cardBg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, border: `1px solid ${theme.border}` }}>
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.15)" }}>
                        <FileText className="w-6 h-6 text-white" />
                      </div>
                      <p className="text-sm font-semibold px-4 text-center" style={{ color: theme.receivedText, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</p>
                      <p className="text-xs" style={{ color: theme.subText }}>{fmtSize(att.size)}</p>
                    </div>
                  </button>
                  {isLastAtt && displayBody && (
                    <div style={{ padding: "8px 12px", fontSize: 13, color: theme.receivedText, background: theme.cardBg }}>
                      {displayBody}
                    </div>
                  )}
                </div>
              );
            });
          })()}

          {/* Body text for text-only messages */}
          {!hasAtts && (() => {
            const bodyText = msg.body || msg.snippet || "";
            const isAutoGenerated = !bodyText ||
              bodyText.startsWith("Please find the attached") ||
              bodyText.startsWith("Forwarding ") ||
              bodyText.trim() === "";
            if (isAutoGenerated) return null;
            return (
              <p
                className="text-sm leading-relaxed whitespace-pre-wrap break-words"
                style={{ color: bubbleText, padding: "10px 14px 4px" }}
                onTouchStart={() => handleBodyTouchStart(bodyText)}
                onTouchEnd={handleBodyTouchEnd}
              >
                {searchQuery ? highlightText(bodyText, searchQuery) : bodyText}
              </p>
            );
          })()}

          {/* Timestamp */}
          <p
            className="text-[10px] text-right"
            style={{
              color: hasAtts ? "rgba(255,255,255,0.55)" : bubbleSub,
              padding: hasAtts ? "0 10px 8px" : "0 12px 8px",
              background: hasAtts ? "rgba(0,0,0,0.6)" : "transparent",
            }}
          >
            {fmtBubbleTime(msg.date)}
          </p>
        </div>

        {/* Forward icon — right of bubble for sent */}
        {isSent && hasAtts && (
          <button
            onClick={() => setForwardTarget(msg.attachments[0])}
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 active:opacity-60 mb-0.5"
            style={{ background: theme.pillBg }}
          >
            <Share2 className="w-3.5 h-3.5" style={{ color: theme.subText }} />
          </button>
        )}
      </div>
    </>
  );
}

// ─── Chat input ───────────────────────────────────────────────────────────────

function ChatInput({
  contact, token, refreshToken, onSent, onTokenExpired, theme,
}: {
  contact: Contact; token: string; refreshToken?: string | null; onSent: () => void; onTokenExpired: () => void; theme: Theme;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showDocPicker, setShowDocPicker] = useState(false);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [sendingDocId, setSendingDocId] = useState<string | null>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => setKeyboardOffset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", handler);
    vv.addEventListener("scroll", handler);
    return () => { vv.removeEventListener("resize", handler); vv.removeEventListener("scroll", handler); };
  }, []);

  const defaultSubject = () =>
    contact.lastSubject ? `Re: ${contact.lastSubject}` : "Message from Docera";

  const sendText = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const body = text.trim() || " ";
      const subject = contact.lastSubject ? `Re: ${contact.lastSubject}` : "Message from Docera";
      console.log("[sendText] to:", contact.email, "subject:", subject);
      const res = await fetch(`${API_BASE}/api/gmail/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, to: contact.email, subject, body }),
        credentials: Capacitor.isNativePlatform() ? "omit" : "include",
        signal: controller.signal,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }));
        console.error("[sendText] server error:", res.status, errData);
        throw Object.assign(new Error(errData.error ?? "Send failed"), { status: res.status });
      }
      setText("");
      onSent();
    } catch (err) {
      const e = err as Error & { status?: number };
      console.error("[sendText] caught:", e.name, e.message);
      if (e.name === "AbortError") {
        toast({ title: "Send timed out, please try again", variant: "destructive" });
      } else if (e.status === 401 || e.status === 403) {
        onTokenExpired();
        return;
      } else {
        toast({ title: "Failed to send", description: e.message, variant: "destructive" });
      }
    } finally {
      clearTimeout(timeoutId);
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); }
  };

  const openDocPicker = async () => {
    setShowActionSheet(false);
    setLoadingDocs(true);
    try {
      let loaded: DocItem[] = [];
      if (Capacitor.isNativePlatform()) {
        const { listLocalDocs } = await import("@/lib/localDocs");
        const local = await listLocalDocs();
        loaded = (local as DocItem[]).filter(d => d.dataUrl && d.dataUrl.length > 50);
      } else {
        const res = await fetch(`${API_BASE}/api/documents`, { credentials: "include" });
        loaded = ((await res.json()) as DocItem[]).filter(d => d.dataUrl && d.dataUrl.length > 50);
      }
      setDocs(loaded);
      setShowDocPicker(true);
    } catch {
      toast({ title: "Couldn't load documents", variant: "destructive" });
    } finally {
      setLoadingDocs(false);
    }
  };

  const sendDoc = async (doc: DocItem) => {
    setSendingDocId(doc.id);
    try {
      const pdfBase64 = doc.dataUrl.includes(",") ? doc.dataUrl.split(",")[1] : doc.dataUrl;
      await gmailPost("/api/gmail/send-message", {
        to: contact.email,
        subject: defaultSubject(),
        body: `Please find the attached document: ${doc.name}`,
        attachmentBase64: pdfBase64,
        attachmentName: `${doc.name}.pdf`,
        attachmentMimeType: "application/pdf",
      }, token, refreshToken);
      setShowDocPicker(false);
      toast({ title: "Sent!", description: `${doc.name} → ${contact.name}` });
      onSent();
    } catch (err) {
      toast({ title: "Failed to send", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSendingDocId(null);
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowActionSheet(false);
    setSending(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.includes(",") ? r.split(",")[1] : r);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await gmailPost("/api/gmail/send-message", {
        to: contact.email,
        subject: defaultSubject(),
        body: `Please find the attached file: ${file.name}`,
        attachmentBase64: base64,
        attachmentName: file.name,
        attachmentMimeType: file.type || "application/octet-stream",
      }, token, refreshToken);
      toast({ title: "Sent!", description: `${file.name} → ${contact.name}` });
      onSent();
    } catch (err) {
      toast({ title: "Failed to send file", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      {/* Action sheet */}
      {showActionSheet && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowActionSheet(false)} />
          <div
            className="relative w-full rounded-t-3xl shadow-2xl"
            style={{ background: theme.header, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-4" style={{ background: theme.subText }} />
            <div className="px-4 pb-2 flex flex-col gap-2">
              <button
                onClick={openDocPicker}
                disabled={loadingDocs}
                className="flex items-center gap-3 p-4 rounded-2xl active:opacity-70"
                style={{ background: theme.cardBg }}
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: theme.avatarBg }}>
                  <FileText className="w-5 h-5" style={{ color: theme.avatarText }} />
                </div>
                <span className="font-semibold" style={{ color: theme.receivedText }}>From Docera</span>
                {loadingDocs && <Loader2 className="w-4 h-4 animate-spin ml-auto" style={{ color: theme.subText }} />}
              </button>
              <button
                onClick={() => { setShowActionSheet(false); fileInputRef.current?.click(); }}
                className="flex items-center gap-3 p-4 rounded-2xl active:opacity-70"
                style={{ background: theme.cardBg }}
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: theme.avatarBg }}>
                  <Paperclip className="w-5 h-5" style={{ color: theme.avatarText }} />
                </div>
                <span className="font-semibold" style={{ color: theme.receivedText }}>Photo / File from iPhone</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Doc picker */}
      {showDocPicker && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDocPicker(false)} />
          <div
            className="relative w-full rounded-t-3xl shadow-2xl max-h-[70vh] flex flex-col"
            style={{ background: theme.header, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="pt-3 pb-4 px-5 flex-shrink-0 border-b" style={{ borderColor: theme.border }}>
              <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: theme.subText }} />
              <div className="flex items-center justify-between">
                <p className="font-bold" style={{ color: theme.receivedText }}>Send a Document</p>
                <button onClick={() => setShowDocPicker(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: theme.pillBg }}>
                  <X className="w-4 h-4" style={{ color: theme.subText }} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-2">
              {docs.length === 0
                ? <p className="text-center text-sm py-8" style={{ color: theme.subText }}>No documents found</p>
                : docs.map(doc => (
                  <button
                    key={doc.id}
                    onClick={() => sendDoc(doc)}
                    disabled={!!sendingDocId}
                    className="flex items-center gap-3 p-3 rounded-2xl active:opacity-70 disabled:opacity-50 text-left"
                    style={{ background: theme.cardBg }}
                  >
                    <div className="w-10 h-10 rounded-xl bg-red-500 flex items-center justify-center flex-shrink-0">
                      <span className="text-white text-[9px] font-bold">PDF</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: theme.receivedText }}>{doc.name}</p>
                      <p className="text-xs uppercase" style={{ color: theme.subText }}>{doc.type}</p>
                    </div>
                    {sendingDocId === doc.id && <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.subText }} />}
                  </button>
                ))
              }
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.doc,.docx"
        className="hidden"
        onChange={handleFileInput}
      />

      {/* Input bar */}
      <div
        className="flex-shrink-0 flex items-end gap-2 px-3 pt-2"
        style={{
          paddingBottom: `max(${keyboardOffset + 8}px, calc(env(safe-area-inset-bottom) + 8px))`,
          background: theme.header,
          borderTop: `1px solid ${theme.border}`,
        }}
      >
        <button
          onClick={() => setShowActionSheet(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 active:opacity-60 mb-1"
          style={{ background: theme.pillBg }}
        >
          <Plus className="w-5 h-5" style={{ color: theme.subText }} />
        </button>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          rows={1}
          className="flex-1 resize-none rounded-2xl px-3 py-2 text-sm outline-none"
          style={{
            background: theme.inputBg,
            color: theme.receivedText,
            border: `1px solid ${theme.border}`,
            minHeight: 36,
            maxHeight: 120,
          }}
          onInput={e => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
          }}
        />

        <button
          onClick={sendText}
          disabled={!text.trim() || sending}
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 active:opacity-60 mb-1 disabled:opacity-40"
          style={{ background: theme.avatarBg }}
        >
          {sending
            ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.avatarText }} />
            : <Send className="w-4 h-4 text-white" />
          }
        </button>
      </div>
    </>
  );
}

// ─── PDF Viewer ───────────────────────────────────────────────────────────────

function PdfViewer({ attachment, messageId, token, refreshToken, onClose }: {
  attachment: GmailAttachment;
  messageId: string;
  token: string;
  refreshToken?: string | null;
  onClose: () => void;
}) {
  const [pages, setPages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let b64 = base64Cache.get(attachment.id);
        if (!b64) {
          const data = await gmailPost<{ base64: string }>(
            "/api/gmail/attachment",
            { messageId, attachmentId: attachment.id },
            token,
            refreshToken,
          );
          b64 = data.base64;
          base64Cache.set(attachment.id, b64);
        }
        if (cancelled) return;
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).href;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const pageDataUrls: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          pageDataUrls.push(canvas.toDataURL("image/jpeg", 0.85));
        }
        if (!cancelled) setPages(pageDataUrls);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment.id]);

  const share = async () => {
    try {
      const { Filesystem, Directory } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");
      const b64 = base64Cache.get(attachment.id) ?? "";
      const safe = attachment.name.replace(/[^a-z0-9._-]/gi, "_");
      const fileName = safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
      await Filesystem.writeFile({ path: fileName, data: b64, directory: Directory.Cache, recursive: true });
      const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
      await Share.share({ url: uri, title: attachment.name });
    } catch (err) { console.error(err); }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      zIndex: 99999,
      background: '#000',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        flexShrink: 0,
        paddingTop: 'max(3rem, env(safe-area-inset-top))',
        paddingBottom: 12,
        paddingLeft: 16,
        paddingRight: 16,
        background: '#111',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <button onClick={onClose} style={{
          color: 'white', background: 'none', border: 'none',
          fontSize: 17, fontWeight: 600, cursor: 'pointer', padding: '4px 8px'
        }}>
          Done
        </button>
        <span style={{
          color: 'white', fontSize: 14, fontWeight: 600,
          flex: 1, textAlign: 'center', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: '0 12px'
        }}>
          {attachment.name}
        </span>
        <div style={{ width: 60 }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', background: '#1a1a1a' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
            <Loader2 style={{ color: 'rgba(255,255,255,0.4)', width: 32, height: 32 }} className="animate-spin" />
          </div>
        ) : error ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 300 }}>
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>Could not load PDF</p>
          </div>
        ) : (
          pages.map((dataUrl, i) => (
            <img key={i} src={dataUrl} style={{ width: '100%', display: 'block', marginBottom: 4 }} alt={`Page ${i + 1}`} />
          ))
        )}
      </div>

      <div style={{
        flexShrink: 0,
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
        paddingTop: 12,
        background: '#111',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
      }}>
        <button onClick={share} style={{
          background: 'none', border: 'none', color: 'white',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 4, cursor: 'pointer'
        }}>
          <Share2 style={{ width: 24, height: 24 }} />
          <span style={{ fontSize: 11 }}>Share</span>
        </button>
      </div>
    </div>
  );
}

// ─── Thread view ──────────────────────────────────────────────────────────────

function ThreadView({
  contact, token, refreshToken, contacts, onBack, onTokenExpired, theme,
}: {
  contact: Contact; token: string; refreshToken?: string | null; contacts: Contact[];
  onBack: () => void; onTokenExpired: () => void; theme: Theme;
}) {
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [oldestDate, setOldestDate] = useState<string | null>(null);
  const [tooManyFiles, setTooManyFiles] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState("");
  const [showLoadPill, setShowLoadPill] = useState(false);
  const [viewerAtt, setViewerAtt] = useState<GmailAttachment | null>(null);
  const [viewerMsgId, setViewerMsgId] = useState<string>("");
  const [showProfile, setShowProfile] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const loadFailCountRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (olderThan?: string) => {
    if (loading && olderThan) return;
    if (!olderThan) { setLoading(true); setError(null); }
    else setLoadingOlder(true);
    let cancelled = false;
    try {
      const data = await gmailPost<{ messages: GmailMessage[]; hasMore: boolean }>(
        "/api/gmail/thread-messages",
        { contactEmail: contact.email, ...(olderThan ? { olderThan } : {}) },
        token,
        refreshToken,
      );
      let msgs = data.messages;
      if (msgs.length > 15) msgs = msgs.slice(-15);
      console.log("[load] received:", msgs.length, "msgs, hasMore:", data.hasMore, "olderThan:", olderThan ?? "none");
      if (!olderThan) {
        requestAnimationFrame(() => { if (!cancelled) setMessages(msgs); });
        loadFailCountRef.current = 0;
        console.log("[load] setting oldestDate to:", msgs[0]?.date ?? null);
        setOldestDate(msgs[0]?.date ?? null);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 280);
      } else {
        setMessages(prev => [...msgs, ...prev]);
        if (msgs[0]) setOldestDate(msgs[0].date);
      }
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) { onTokenExpired(); return; }
      if (!olderThan) {
        loadFailCountRef.current += 1;
        if (loadFailCountRef.current >= 3) setTooManyFiles(true);
        setError(e.message);
      }
    } finally {
      if (!olderThan) setLoading(false);
      else setLoadingOlder(false);
    }
    return () => { cancelled = true; };
  }, [contact.email, token, refreshToken]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const handler = () => setShowLoadPill(el.scrollTop < 80 && hasMore);
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, [hasMore]);

  const loadOlder = useCallback(async () => {
    if (!oldestDate || loadingOlder) return;
    setLoadingOlder(true);
    const el = messagesContainerRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    try {
      console.log("[loadOlder] sending olderThan:", oldestDate);
      const data = await gmailPost<{ messages: GmailMessage[]; hasMore: boolean; total?: number }>(
        "/api/gmail/thread-messages",
        { contactEmail: contact.email, olderThan: oldestDate },
        token,
        refreshToken,
      );
      console.log("[loadOlder] received:", data.messages.length, "msgs, hasMore:", data.hasMore, "total:", data.total);
      setMessages(prev => [...data.messages, ...prev]);
      if (data.messages[0]) setOldestDate(data.messages[0].date);
      setHasMore(data.hasMore ?? false);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevScrollHeight;
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) onTokenExpired();
    } finally {
      setLoadingOlder(false);
    }
  }, [oldestDate, loadingOlder, contact.email, token, refreshToken]);

  const q = search.toLowerCase();
  const visibleMessages = search
    ? messages.filter(m =>
        (m.body || "").toLowerCase().includes(q) ||
        (m.subject || "").toLowerCase().includes(q) ||
        (m.snippet || "").toLowerCase().includes(q) ||
        (m.fromName || "").toLowerCase().includes(q),
      )
    : messages;

  const allAttachments = messages.flatMap(m => m.attachments.map(att => ({ ...att, msgId: m.id })));

  const renderMessages = () => {
    const nodes: React.ReactNode[] = [];
    let lastDate: Date | null = null;
    for (const msg of visibleMessages) {
      const d = new Date(msg.date);
      if (!lastDate || (isValid(d) && !isSameDay(lastDate, d))) {
        nodes.push(<DateSeparator key={`sep-${msg.id}`} dateStr={msg.date} theme={theme} />);
        lastDate = isValid(d) ? d : lastDate;
      }
      nodes.push(
        <MessageBubble key={msg.id} msg={msg} token={token} refreshToken={refreshToken} contacts={contacts} theme={theme} searchQuery={search}
          onOpenPdf={(att, msgId) => { setViewerAtt(att); setViewerMsgId(msgId); }} />,
      );
    }
    return nodes;
  };

  return (
    <>
    {showProfile && (
      <ClientProfilePage
        contact={contact}
        messages={messages}
        token={token}
        refreshToken={refreshToken}
        onBack={() => setShowProfile(false)}
        onOpenPdf={(att, msgId) => { setViewerAtt(att); setViewerMsgId(msgId); setShowProfile(false); }}
        onOpenConversation={() => setShowProfile(false)}
      />
    )}
    {viewerAtt && (
      <PdfViewer
        attachment={viewerAtt}
        messageId={viewerMsgId}
        token={token}
        refreshToken={refreshToken}
        onClose={() => setViewerAtt(null)}
      />
    )}
    <div className="flex flex-col h-full" style={{ background: theme.bg }}>
      {/* Header — compact iOS style */}
      <div style={{ flexShrink: 0, background: "#000000", borderBottom: "1px solid rgba(255,255,255,0.1)", paddingTop: "max(3rem, env(safe-area-inset-top))" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px 8px" }}>
          <button
            onClick={onBack}
            style={{ background: "none", border: "none", cursor: "pointer", color: "#007AFF", padding: "4px 6px", display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            <ChevronLeft style={{ width: 22, height: 22 }} />
          </button>
          <button
            onClick={() => setShowProfile(true)}
            style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            <div style={{ width: 36, height: 36, borderRadius: 18, background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: theme.avatarText, fontSize: 14, fontWeight: 600, flexShrink: 0 }}>
              {initials(contact.name)}
            </div>
            <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <p style={{ color: "white", fontSize: 17, fontWeight: 600, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact.name}</p>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact.email}</p>
            </div>
          </button>
          <button
            onClick={() => { setShowSearch(v => !v); setSearch(""); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: showSearch ? "white" : "rgba(255,255,255,0.6)", padding: 8, flexShrink: 0 }}
          >
            <Search style={{ width: 16, height: 16 }} />
          </button>
          <button
            onClick={() => load()}
            disabled={loading}
            style={{ background: "none", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.6)", padding: 8, flexShrink: 0 }}
          >
            <RefreshCw style={{ width: 16, height: 16 }} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {showSearch && (
          <div style={{ padding: "0 12px 10px" }}>
            <input
              autoFocus
              type="text"
              placeholder="Search messages…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: "100%", height: 34, borderRadius: 10, border: "none", outline: "none", background: "rgba(255,255,255,0.1)", color: "white", padding: "0 12px", fontSize: 14, boxSizing: "border-box" }}
            />
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-4 py-4" style={{ position: "relative" }}>
        {showLoadPill && (
          <div
            style={{
              position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
              zIndex: 10, background: "rgba(0,0,0,0.7)", borderRadius: 20,
              padding: "6px 16px", cursor: "pointer", color: "white", fontSize: 12,
              display: "flex", alignItems: "center", gap: 6,
            }}
            onClick={loadOlder}
          >
            {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : "↑"}
            {" "}Load older messages
          </div>
        )}
        {loading && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.subText }} />
            <p className="text-sm" style={{ color: theme.subText }}>Loading messages…</p>
          </div>
        ) : tooManyFiles ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <AlertCircle className="w-10 h-10 mb-3" style={{ color: theme.subText }} />
            <p className="font-medium" style={{ color: theme.receivedText }}>This conversation has too many files to load</p>
            <p className="text-sm mt-1" style={{ color: theme.subText }}>Try again later</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <AlertCircle className="w-10 h-10 mb-3" style={{ color: theme.subText }} />
            <p className="font-medium" style={{ color: theme.receivedText }}>Couldn't load messages</p>
            <p className="text-sm mt-1 mb-4" style={{ color: theme.subText }}>{error}</p>
            <button
              onClick={() => load()}
              className="px-5 py-2 rounded-xl text-sm font-semibold"
              style={{ background: theme.avatarBg, color: theme.avatarText }}
            >
              Retry
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Mail className="w-12 h-12 mb-3" style={{ color: theme.subText }} />
            <p style={{ color: theme.subText }}>No messages with this contact</p>
          </div>
        ) : search && visibleMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Search className="w-12 h-12 mb-3" style={{ color: theme.subText }} />
            <p style={{ color: theme.subText }}>No results for "{search}"</p>
          </div>
        ) : (
          <>
            {/* Collapsible Files section */}
            {allAttachments.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <button
                  onClick={() => setFilesExpanded(v => !v)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl w-full text-left"
                  style={{ background: theme.pillBg }}
                >
                  <Paperclip className="w-4 h-4 flex-shrink-0" style={{ color: theme.subText }} />
                  <span className="text-sm font-medium flex-1" style={{ color: theme.subText }}>
                    📎 {allAttachments.length} {allAttachments.length === 1 ? "File" : "Files"}
                  </span>
                  {filesExpanded
                    ? <ChevronDown className="w-4 h-4" style={{ color: theme.subText }} />
                    : <ChevronRight className="w-4 h-4" style={{ color: theme.subText }} />
                  }
                </button>
                {filesExpanded && (
                  <div className="mt-2 flex flex-col gap-1.5">
                    {allAttachments.map((att, i) => {
                      const isPdf = att.mimeType === "application/pdf" || att.name.toLowerCase().endsWith(".pdf");
                      return (
                        <button
                          key={`${att.id}-${i}`}
                          onClick={() => { if (isPdf) { setViewerAtt(att); setViewerMsgId(att.msgId); } }}
                          disabled={!isPdf}
                          className="flex items-center gap-3 p-3 rounded-xl active:opacity-70 disabled:opacity-60 text-left"
                          style={{ background: theme.cardBg }}
                        >
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isPdf ? "bg-red-500" : "bg-blue-500"}`}>
                            <span className="text-white text-[8px] font-bold">{isPdf ? "PDF" : "IMG"}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold truncate" style={{ color: theme.receivedText }}>{att.name}</p>
                            <p className="text-[11px]" style={{ color: theme.subText }}>{fmtSize(att.size)}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {renderMessages()}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <ChatInput
        contact={contact}
        token={token}
        refreshToken={refreshToken}
        onSent={() => load()}
        onTokenExpired={onTokenExpired}
        theme={theme}
      />
    </div>
    </>
  );
}

// ─── Contact list ─────────────────────────────────────────────────────────────

function ContactList({
  token, refreshToken, onBack, onSelect, onTokenExpired, onDisconnect, onContactsLoaded,
  darkMode, onToggleDark, theme,
}: {
  token: string;
  refreshToken?: string | null;
  onBack: () => void;
  onSelect: (c: Contact) => void;
  onTokenExpired: () => void;
  onDisconnect: () => void;
  onContactsLoaded: (c: Contact[]) => void;
  darkMode: boolean;
  onToggleDark: () => void;
  theme: Theme;
}) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const [smartMode, setSmartMode] = useState(false);
  const [inboxTab, setInboxTab] = useState<"important" | "other">("important");
  const [overrides, setOverrides] = useState<Record<string, 'important' | 'other'>>(() => {
    try { return JSON.parse(localStorage.getItem("docera_contact_overrides") ?? "{}"); } catch { return {}; }
  });
  const [longPressTarget, setLongPressTarget] = useState<Contact | null>(null);
  const [blockTaps, setBlockTaps] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await gmailPost<{ contacts: Contact[] }>("/api/gmail/messages", {}, token, refreshToken);
      setContacts(data.contacts);
      onContactsLoaded(data.contacts);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) {
        toast({ title: "Gmail session expired — please reconnect", variant: "destructive" });
        onTokenExpired();
        return;
      }
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [token, refreshToken]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => load(), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const contactsWithOverrides = contacts.map(c =>
    overrides[c.email] ? { ...c, isImportant: overrides[c.email] === 'important' } : c
  );
  const importantContacts = contactsWithOverrides.filter(c => c.isImportant !== false);
  const otherContacts = contactsWithOverrides.filter(c => c.isImportant === false);
  const tabContacts = inboxTab === "important" ? importantContacts : otherContacts;

  const sortedImportant = [...importantContacts].sort((a, b) => {
    if (a.hasAttachments !== b.hasAttachments) return a.hasAttachments ? -1 : 1;
    if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
    return new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime();
  });
  const sortedOther = [...otherContacts].sort((a, b) =>
    new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime()
  );

  const autoSuggest = [...importantContacts]
    .filter(c => c.hasAttachments || c.messageCount > 3)
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 5);

  const smartContacts = [...tabContacts]
    .filter(c => c.hasAttachments || c.messageCount >= 3)
    .sort((a, b) => {
      if (a.hasAttachments !== b.hasAttachments) return a.hasAttachments ? -1 : 1;
      return b.messageCount - a.messageCount;
    });

  const base = smartMode ? smartContacts : (inboxTab === "important" ? sortedImportant : sortedOther);

  const startLongPress = (c: Contact) => {
    longPressTimer.current = setTimeout(() => setLongPressTarget(c), 500);
  };
  const endLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const moveContact = (email: string, to: 'important' | 'other') => {
    const next = { ...overrides, [email]: to };
    setOverrides(next);
    localStorage.setItem("docera_contact_overrides", JSON.stringify(next));
    setLongPressTarget(null);
    setBlockTaps(true);
    setTimeout(() => setBlockTaps(false), 400);
  };

  const filtered = search
    ? base.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.email.toLowerCase().includes(search.toLowerCase()) ||
        (c.lastMessage || "").toLowerCase().includes(search.toLowerCase()),
      )
    : base;

  return (
    <div className="flex flex-col h-full" style={{ background: theme.bg }}>
      {/* Long-press action sheet */}
      {longPressTarget && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => { setLongPressTarget(null); setBlockTaps(true); setTimeout(() => setBlockTaps(false), 400); }} />
          <div
            className="relative w-full rounded-t-3xl shadow-2xl"
            style={{ background: theme.header, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-4" style={{ background: theme.subText }} />
            <div className="px-4 pb-2">
              <p className="text-sm font-semibold px-2 mb-3" style={{ color: theme.subText }}>{longPressTarget.name}</p>
              {inboxTab === "other" ? (
                <button
                  onClick={() => moveContact(longPressTarget.email, 'important')}
                  className="w-full flex items-center gap-3 p-4 rounded-2xl active:opacity-70 mb-2"
                  style={{ background: theme.cardBg }}
                >
                  <span className="font-semibold" style={{ color: theme.receivedText }}>Move to Important</span>
                </button>
              ) : (
                <button
                  onClick={() => moveContact(longPressTarget.email, 'other')}
                  className="w-full flex items-center gap-3 p-4 rounded-2xl active:opacity-70 mb-2"
                  style={{ background: theme.cardBg }}
                >
                  <span className="font-semibold" style={{ color: theme.receivedText }}>Move to Other</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Header */}
      <div style={{ background: theme.header, paddingTop: "max(3rem, env(safe-area-inset-top))", borderBottom: `1px solid ${theme.border}`, flexShrink: 0 }}>
        {/* Top row */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "0 16px 4px" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", color: theme.subText, padding: "4px 4px 4px 0", display: "flex", alignItems: "center" }}>
                <ArrowLeft style={{ width: 20, height: 20 }} />
              </button>
              <h1 style={{ color: theme.receivedText, fontSize: 34, fontWeight: 700, letterSpacing: -0.5, margin: 0, lineHeight: 1.1 }}>Inbox</h1>
            </div>
            <p style={{ color: theme.subText, fontSize: 11, fontWeight: 600, letterSpacing: 0.8, margin: "2px 0 0 4px", textTransform: "uppercase" }}>
              {filtered.filter(c => c.hasUnread).length} Unread · {filtered.length} Threads
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 2, paddingTop: 4 }}>
            <button onClick={onToggleDark} style={{ background: "none", border: "none", cursor: "pointer", color: theme.subText, padding: 8 }}>
              {darkMode ? <Sun style={{ width: 16, height: 16 }} /> : <Moon style={{ width: 16, height: 16 }} />}
            </button>
            <button onClick={load} disabled={loading} style={{ background: "none", border: "none", cursor: "pointer", color: theme.subText, padding: 8 }}>
              <RefreshCw style={{ width: 16, height: 16 }} className={loading ? "animate-spin" : ""} />
            </button>
            <button onClick={() => setSmartMode(v => !v)} style={{ background: smartMode ? theme.avatarBg : theme.pillBg, border: "none", cursor: "pointer", color: smartMode ? theme.avatarText : theme.subText, padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 600 }}>
              ✦
            </button>
            <div style={{ position: "relative" }}>
              <button onClick={() => setShowMenu(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: theme.subText, padding: 8, fontSize: 18, lineHeight: 1 }}>⋯</button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                  <div style={{ position: "absolute", right: 0, top: 40, zIndex: 20, background: theme.cardBg, borderRadius: 14, boxShadow: "0 4px 24px rgba(0,0,0,0.18)", minWidth: 180, overflow: "hidden", border: `1px solid ${theme.border}` }}>
                    <button onClick={() => { setShowMenu(false); onDisconnect(); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "none", border: "none", cursor: "pointer", color: "#ff453a" }}>
                      <X style={{ width: 16, height: 16 }} />
                      <span style={{ fontSize: 14, fontWeight: 500 }}>Disconnect Gmail</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Search bar */}
        <div style={{ padding: "8px 16px 10px", position: "relative" }}>
          <div style={{ position: "absolute", left: 28, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", display: "flex", alignItems: "center" }}>
            <Search style={{ width: 14, height: 14, color: theme.subText }} />
          </div>
          <input
            type="text"
            placeholder="Search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: "100%", height: 36, borderRadius: 10, border: "none", outline: "none",
              background: theme.searchBg, color: theme.receivedText,
              paddingLeft: 32, paddingRight: 12, fontSize: 15,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Segmented tabs */}
        <div style={{ padding: "0 16px 12px" }}>
          <div style={{ display: "flex", background: darkMode ? "rgba(255,255,255,0.1)" : "rgba(0,51,42,0.10)", borderRadius: 9, padding: 2 }}>
            <button
              onClick={() => setInboxTab("important")}
              style={{
                flex: 1, borderRadius: 7, padding: "6px 0", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 600, transition: "all 0.15s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                background: inboxTab === "important" ? "white" : "transparent",
                color: inboxTab === "important" ? "#00332a" : theme.subText,
                boxShadow: inboxTab === "important" ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              }}
            >
              <Inbox size={13} />Important
            </button>
            <button
              onClick={() => setInboxTab("other")}
              style={{
                flex: 1, borderRadius: 7, padding: "6px 0", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 600, transition: "all 0.15s",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                background: inboxTab === "other" ? "white" : "transparent",
                color: inboxTab === "other" ? "#00332a" : theme.subText,
                boxShadow: inboxTab === "other" ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              }}
            >
              <Folder size={13} />Other
            </button>
          </div>
        </div>
      </div>

      {/* Contact list */}
      <div style={{ flex: 1, overflowY: "auto", background: theme.bg, paddingBottom: 80 }}>
        {loading && contacts.length === 0 ? (
          <div style={{ padding: "8px 16px" }}>
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
                <div style={{ width: 20, flexShrink: 0 }} />
                <div style={{ width: 44, height: 44, borderRadius: 22, background: theme.pillBg, flexShrink: 0 }} className="animate-pulse" />
                <div style={{ flex: 1 }}>
                  <div style={{ height: 14, borderRadius: 7, background: theme.pillBg, width: "55%", marginBottom: 6 }} className="animate-pulse" />
                  <div style={{ height: 12, borderRadius: 6, background: theme.border, width: "75%" }} className="animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 200, textAlign: "center", padding: "0 24px" }}>
            <AlertCircle style={{ width: 40, height: 40, marginBottom: 12, color: theme.subText }} />
            <p style={{ color: theme.receivedText, fontWeight: 600, margin: "0 0 4px" }}>Couldn't load inbox</p>
            <p style={{ color: theme.subText, fontSize: 14, margin: "0 0 16px" }}>{error}</p>
            <button onClick={load} style={{ background: theme.avatarBg, color: theme.avatarText, border: "none", borderRadius: 12, padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 200, textAlign: "center" }}>
            <Mail style={{ width: 48, height: 48, marginBottom: 12, color: theme.subText }} />
            <p style={{ color: theme.subText }}>{search ? "No contacts match" : smartMode ? "No important conversations yet" : "No emails found"}</p>
          </div>
        ) : (
          <div>
            {/* FREQUENT auto-suggest row */}
            {inboxTab === "important" && !smartMode && !search && autoSuggest.length > 0 && (
              <div style={{ padding: "16px 16px 8px" }}>
                <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, letterSpacing: 1, marginBottom: 10, fontWeight: 600, margin: "0 0 10px" }}>FREQUENT</p>
                <div style={{ overflowX: "auto", display: "flex", gap: 16, paddingBottom: 8 }}>
                  {autoSuggest.map(c => (
                    <button
                      key={c.email}
                      onClick={() => { if (blockTaps) return; onSelect(c); }}
                      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0, background: "none", border: "none", cursor: "pointer" }}
                    >
                      <div style={{ width: 52, height: 52, borderRadius: 26, background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: theme.avatarText, fontSize: 18, fontWeight: 600 }}>
                        {initials(c.name)}
                      </div>
                      <span style={{ fontSize: 11, color: theme.subText, maxWidth: 56, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.name.split(" ")[0]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Contact rows with TODAY / EARLIER section headers */}
            {(() => {
              const todayRows = filtered.filter(c => { try { return isToday(new Date(c.lastDate)); } catch { return false; } });
              const earlierRows = filtered.filter(c => { try { return !isToday(new Date(c.lastDate)); } catch { return true; } });
              const renderRow = (c: typeof filtered[0]) => inboxTab === "other" ? (
                <div key={c.email} style={{ position: "relative" }}>
                  <button
                    onClick={() => { if (blockTaps) return; onSelect(c); }}
                    onTouchStart={() => startLongPress(c)}
                    onTouchEnd={endLongPress}
                    onTouchMove={endLongPress}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "none", border: "none", cursor: "pointer" }}
                  >
                    <div style={{ width: 12, flexShrink: 0 }} />
                    <div style={{ width: 36, height: 36, borderRadius: 18, background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: theme.avatarText, fontSize: 13, fontWeight: 600, flexShrink: 0, opacity: 0.7 }}>
                      {initials(c.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <p style={{ color: theme.subText, fontSize: 15, fontWeight: 400, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</p>
                      <p style={{ color: theme.subText, fontSize: 12, margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.6 }}>{c.email}</p>
                    </div>
                  </button>
                  <div style={{ position: "absolute", bottom: 0, left: 76, right: 0, height: 1, background: theme.border }} />
                </div>
              ) : (
                <div key={c.email} style={{ position: "relative" }}>
                  <button
                    onClick={() => { if (blockTaps) return; onSelect(c); }}
                    onTouchStart={() => startLongPress(c)}
                    onTouchEnd={endLongPress}
                    onTouchMove={endLongPress}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "none", border: "none", cursor: "pointer" }}
                  >
                    <div style={{ width: 12, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                      {c.hasUnread && <div style={{ width: 8, height: 8, borderRadius: 4, background: theme.avatarBg }} />}
                    </div>
                    <div style={{ width: 44, height: 44, borderRadius: 22, background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: theme.avatarText, fontSize: 17, fontWeight: 600, flexShrink: 0 }}>
                      {initials(c.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
                        <span style={{ color: theme.receivedText, fontSize: 16, fontWeight: c.hasUnread ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {c.name}
                        </span>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                          <span style={{ color: theme.subText, fontSize: 12 }}>{fmtMsgTime(c.lastDate)}</span>
                          <ChevronRight style={{ width: 12, height: 12, color: theme.subText, opacity: 0.5 }} />
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {c.hasAttachments && <Paperclip style={{ width: 12, height: 12, color: theme.subText, flexShrink: 0 }} />}
                        <p style={{ color: theme.subText, fontSize: 14, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {decodeHtml(c.lastMessage || c.lastSubject)}
                        </p>
                      </div>
                    </div>
                  </button>
                  <div style={{ position: "absolute", bottom: 0, left: 76, right: 0, height: 1, background: theme.border }} />
                </div>
              );
              return (
                <>
                  {todayRows.length > 0 && (
                    <div style={{ padding: "8px 16px 4px", fontSize: 11, fontWeight: 600, letterSpacing: 0.8, color: theme.subText, textTransform: "uppercase" }}>
                      Today · Recent
                    </div>
                  )}
                  {todayRows.map(renderRow)}
                  {earlierRows.length > 0 && todayRows.length > 0 && (
                    <div style={{ padding: "12px 16px 4px", fontSize: 11, fontWeight: 600, letterSpacing: 0.8, color: theme.subText, textTransform: "uppercase" }}>
                      Earlier
                    </div>
                  )}
                  {earlierRows.map(renderRow)}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* FAB compose button */}
      <button
        style={{
          position: "fixed",
          bottom: "max(24px, env(safe-area-inset-bottom))",
          right: 20, width: 56, height: 56, borderRadius: 16,
          background: theme.avatarBg, border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(0,0,0,0.18)", zIndex: 50,
        }}
      >
        <PenLine style={{ width: 22, height: 22, color: theme.avatarText }} />
      </button>
    </div>
  );
}

// ─── Connect prompt ───────────────────────────────────────────────────────────

function ConnectPrompt({
  onBack, onConnect, connecting,
}: {
  onBack: () => void; onConnect: () => void; connecting: boolean;
}) {
  return (
    <div className="flex flex-col h-full" style={{ background: "#0a0a0a" }}>
      <div
        className="flex-shrink-0 px-4 pb-3"
        style={{ paddingTop: "max(3rem, env(safe-area-inset-top))" }}
      >
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60 text-white"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <div
          className="w-24 h-24 rounded-3xl flex items-center justify-center mb-6"
          style={{ background: "rgba(26,58,92,0.35)" }}
        >
          <Mail className="w-12 h-12 text-white" />
        </div>
        <h2 className="text-2xl font-bold mb-2 text-white">Connect Gmail</h2>
        <p className="leading-relaxed mb-10 text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
          See all your emails as conversations. Tap any contact to read and reply.
        </p>
        <button
          onClick={onConnect}
          disabled={connecting}
          className="w-full max-w-xs py-4 rounded-2xl text-white text-base font-bold active:opacity-80 disabled:opacity-50 flex items-center justify-center gap-2"
          style={{ background: "#007AFF" }}
        >
          {connecting
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Connecting…</>
            : <><Mail className="w-5 h-5" /> Connect Gmail</>
          }
        </button>
      </div>
    </div>
  );
}

// ─── Offline banner ───────────────────────────────────────────────────────────

function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  if (!offline) return null;
  return (
    <div className="flex items-center justify-center gap-2 py-1.5 text-xs font-medium text-white" style={{ background: "#e85d04" }}>
      <WifiOff className="w-3.5 h-3.5" /> You're offline — showing cached data
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface GmailInboxPageProps { onBack: () => void; onUnreadCount?: (count: number) => void; }

export default function GmailInboxPage({ onBack, onUnreadCount }: GmailInboxPageProps) {
  const { toast } = useToast();
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [gmailRefreshToken] = useState<string | null>(() => localStorage.getItem("gmail_refresh_token"));
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [connecting, setConnecting] = useState(false);

  // Dark mode — default true, persisted to localStorage
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(DARK_MODE_KEY);
    return saved !== null ? saved === "true" : true;
  });
  const theme = getTheme(darkMode);

  const toggleDark = () =>
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem(DARK_MODE_KEY, String(next));
      return next;
    });

  useEffect(() => {
    const stored = localStorage.getItem(GMAIL_TOKEN_KEY);
    const storedRefresh = localStorage.getItem(GMAIL_REFRESH_TOKEN_KEY);
    if (stored) { setGmailToken(stored); }
    if (!Capacitor.isNativePlatform()) return;

    let handle: { remove: () => void } | null = null;
    CapApp.addListener("appUrlOpen", ({ url }: { url: string }) => {
      if (!url.includes("gmail-success")) return;
      const keyMatch = url.match(/[?&]token=([^&]+)/);
      const key = keyMatch ? decodeURIComponent(keyMatch[1]) : null;
      if (!key) return;
      Browser.close().catch(() => {});
      setConnecting(true);
      fetch(`${API_BASE}/api/gmail/get-token?key=${encodeURIComponent(key)}`, { credentials: "omit" })
        .then(r => r.json())
        .then((data: { accessToken?: string; refreshToken?: string; error?: string }) => {
          if (data.accessToken) {
            localStorage.setItem("gmail_access_token", data.accessToken);
            if (data.refreshToken) localStorage.setItem("gmail_refresh_token", data.refreshToken);
            setGmailToken(data.accessToken);
          }
        })
        .catch(() => toast({ title: "Gmail connection failed", variant: "destructive" }))
        .finally(() => setConnecting(false));
    }).then(h => { handle = h; });
    return () => { handle?.remove(); };
  }, []);

  const handleConnect = async () => {
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${encodeURIComponent(WEB_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(RAILWAY_REDIRECT_URI)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(GMAIL_SCOPE)}` +
      `&access_type=offline&prompt=consent`;
    if (Capacitor.isNativePlatform()) {
      setConnecting(true);
      await Browser.open({ url: authUrl });
    } else {
      window.open(authUrl, "_blank");
    }
  };

  const handleTokenExpired = () => {
    localStorage.removeItem(GMAIL_TOKEN_KEY);
    localStorage.removeItem(GMAIL_REFRESH_TOKEN_KEY);
    setGmailToken(null);
    setSelectedContact(null);
  };

  const handleDisconnect = () => {
    localStorage.removeItem(GMAIL_TOKEN_KEY);
    localStorage.removeItem(GMAIL_REFRESH_TOKEN_KEY);
    setGmailToken(null);
    setSelectedContact(null);
    setContacts([]);
    toast({ title: "Gmail disconnected" });
  };

  if (!gmailToken) {
    return <ConnectPrompt onBack={onBack} onConnect={handleConnect} connecting={connecting} />;
  }

  if (selectedContact) {
    return (
      <>
        <OfflineBanner />
        <div className="flex flex-col" style={{ height: "100dvh", background: theme.bg }}>
          <ThreadView
            contact={selectedContact}
            token={gmailToken}
            refreshToken={gmailRefreshToken}
            contacts={contacts}
            onBack={() => setSelectedContact(null)}
            onTokenExpired={handleTokenExpired}
            theme={theme}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <OfflineBanner />
      <div className="flex flex-col" style={{ height: "100dvh", background: theme.bg }}>
        <ContactList
          token={gmailToken}
          refreshToken={gmailRefreshToken}
          onBack={onBack}
          onSelect={setSelectedContact}
          onTokenExpired={handleTokenExpired}
          onDisconnect={handleDisconnect}
          onContactsLoaded={loaded => { setContacts(loaded); onUnreadCount?.(loaded.filter(c => c.hasUnread).length); }}
          darkMode={darkMode}
          onToggleDark={toggleDark}
          theme={theme}
        />
      </div>
    </>
  );
}
