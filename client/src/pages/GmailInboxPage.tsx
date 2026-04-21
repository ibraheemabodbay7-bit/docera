import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft, Mail, RefreshCw, FileText, Send, X, AlertCircle,
  Plus, Paperclip, Share2, ChevronRight, Loader2, WifiOff,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { App as CapApp } from "@capacitor/app";
import { formatDistanceToNow, format, isValid, isToday, isYesterday } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { API_BASE } from "@/lib/queryClient";

// ─── Constants ───────────────────────────────────────────────────────────────

const WEB_CLIENT_ID = import.meta.env.VITE_GMAIL_WEB_CLIENT_ID as string ?? "";
const RAILWAY_REDIRECT_URI = "https://docera-production.up.railway.app/api/gmail/callback";
const GMAIL_TOKEN_KEY = "gmail_access_token";
const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

const PRIMARY = "#113e61";
const BG = "#fef7ed";

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
};

type DocItem = { id: string; name: string; type: string; dataUrl: string };

// ─── PDF thumbnail cache ──────────────────────────────────────────────────────

const thumbCache = new Map<string, string>();

async function generatePdfThumbnail(base64: string): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.6 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  // pdfjs v5 uses `canvas` key in RenderParameters; cast to any for compatibility
  await (page.render as (p: unknown) => { promise: Promise<void> })({ canvas, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.75);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function timeAgo(dateStr: string) {
  try {
    const d = new Date(dateStr);
    return isValid(d) ? formatDistanceToNow(d, { addSuffix: true }) : "";
  } catch { return ""; }
}

function initials(name: string) {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

async function gmailPost<T>(
  path: string,
  extra: Record<string, unknown>,
  token: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: token, ...extra }),
    credentials: Capacitor.isNativePlatform() ? "omit" : "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? "Request failed"), { status: res.status });
  }
  return res.json();
}

// ─── PDF Thumbnail component ──────────────────────────────────────────────────

function PdfThumbnail({
  messageId,
  attachment,
  token,
  onTap,
}: {
  messageId: string;
  attachment: GmailAttachment;
  token: string;
  onTap: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(thumbCache.get(attachment.id) ?? null);
  const [loading, setLoading] = useState(!thumb);

  useEffect(() => {
    if (thumb) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await gmailPost<{ base64: string }>(
          "/api/gmail/attachment",
          { messageId, attachmentId: attachment.id },
          token,
        );
        if (cancelled) return;
        const dataUrl = await generatePdfThumbnail(data.base64);
        if (!cancelled) {
          thumbCache.set(attachment.id, dataUrl);
          setThumb(dataUrl);
        }
      } catch {
        // thumbnail generation failed — show fallback icon
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment.id]);

  return (
    <button
      onClick={onTap}
      className="w-full rounded-xl overflow-hidden mb-1 active:opacity-70 relative"
      style={{ background: "rgba(255,255,255,0.15)" }}
    >
      {thumb ? (
        <img src={thumb} alt={attachment.name} className="w-full object-cover rounded-xl" style={{ maxHeight: 180 }} />
      ) : (
        <div className="w-full h-28 flex flex-col items-center justify-center gap-2 rounded-xl" style={{ background: "rgba(255,255,255,0.12)" }}>
          {loading
            ? <Loader2 className="w-6 h-6 animate-spin" style={{ color: "rgba(255,255,255,0.7)" }} />
            : <FileText className="w-8 h-8" style={{ color: "rgba(255,255,255,0.7)" }} />
          }
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 rounded-b-xl px-2 py-1.5" style={{ background: "rgba(0,0,0,0.4)" }}>
        <p className="text-white text-[11px] font-medium truncate">{attachment.name}</p>
        <p className="text-white/70 text-[10px]">{fmtSize(attachment.size)}</p>
      </div>
    </button>
  );
}

// ─── Forward sheet ────────────────────────────────────────────────────────────

function ForwardSheet({
  contacts,
  attachment,
  messageId,
  token,
  onClose,
}: {
  contacts: Contact[];
  attachment: GmailAttachment;
  messageId: string;
  token: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  const filtered = search
    ? contacts.filter(
        c =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.email.toLowerCase().includes(search.toLowerCase()),
      )
    : contacts;

  const forward = async (contact: Contact) => {
    setSending(contact.email);
    try {
      const attData = await gmailPost<{ base64: string }>(
        "/api/gmail/attachment",
        { messageId, attachmentId: attachment.id },
        token,
      );
      await gmailPost(
        "/api/gmail/send-message",
        {
          to: contact.email,
          subject: `Fwd: ${attachment.name}`,
          body: `Forwarding ${attachment.name}`,
          attachmentBase64: attData.base64,
          attachmentName: attachment.name,
          attachmentMimeType: attachment.mimeType || "application/pdf",
        },
        token,
      );
      toast({ title: "Forwarded!", description: `${attachment.name} → ${contact.name}` });
      onClose();
    } catch (err: unknown) {
      toast({ title: "Forward failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSending(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full rounded-t-3xl shadow-2xl max-h-[75vh] flex flex-col"
        style={{ background: BG, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="pt-3 pb-3 px-5 flex-shrink-0 border-b" style={{ borderColor: "rgba(17,62,97,0.12)" }}>
          <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "rgba(17,62,97,0.2)" }} />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-base font-bold" style={{ color: PRIMARY }}>Forward Attachment</p>
              <p className="text-xs mt-0.5" style={{ color: `${PRIMARY}88` }}>{attachment.name}</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center active:opacity-60" style={{ background: "rgba(17,62,97,0.1)" }}>
              <X className="w-4 h-4" style={{ color: PRIMARY }} />
            </button>
          </div>
          <input
            type="text"
            placeholder="Search contacts…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full mt-3 h-9 px-3 rounded-xl text-sm outline-none border"
            style={{ background: "white", color: PRIMARY, borderColor: "rgba(17,62,97,0.2)" }}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          {filtered.map(c => (
            <button
              key={c.email}
              onClick={() => forward(c)}
              disabled={!!sending}
              className="flex items-center gap-3 p-3 rounded-2xl active:opacity-70 disabled:opacity-50 text-left"
              style={{ background: "white" }}
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-white text-sm font-bold" style={{ background: PRIMARY }}>
                {initials(c.name)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: PRIMARY }}>{c.name}</p>
                <p className="text-xs truncate" style={{ color: `${PRIMARY}99` }}>{c.email}</p>
              </div>
              {sending === c.email && <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: PRIMARY }} />}
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-center text-sm py-8" style={{ color: `${PRIMARY}88` }}>No contacts found</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  token,
  contacts,
  onViewPdf,
}: {
  msg: GmailMessage;
  token: string;
  contacts: Contact[];
  onViewPdf: (url: string, name: string) => void;
}) {
  const { toast } = useToast();
  const isSent = msg.direction === "sent";
  const [forwardTarget, setForwardTarget] = useState<GmailAttachment | null>(null);
  const [loadingPdfId, setLoadingPdfId] = useState<string | null>(null);

  const openPdf = async (att: GmailAttachment) => {
    setLoadingPdfId(att.id);
    try {
      const data = await gmailPost<{ base64: string }>(
        "/api/gmail/attachment",
        { messageId: msg.id, attachmentId: att.id },
        token,
      );
      const blob = await fetch(`data:application/pdf;base64,${data.base64}`).then(r => r.blob());
      onViewPdf(URL.createObjectURL(blob), att.name);
    } catch {
      toast({ title: "Could not open attachment", variant: "destructive" });
    } finally {
      setLoadingPdfId(null);
    }
  };

  const isPdf = (att: GmailAttachment) =>
    att.mimeType === "application/pdf" || att.name.toLowerCase().endsWith(".pdf");

  const isImage = (att: GmailAttachment) => att.mimeType.startsWith("image/");

  const bubbleBg = isSent ? PRIMARY : "white";
  const bubbleText = isSent ? "white" : PRIMARY;
  const bubbleSubText = isSent ? "rgba(255,255,255,0.65)" : `${PRIMARY}88`;

  return (
    <>
      {forwardTarget && (
        <ForwardSheet
          contacts={contacts}
          attachment={forwardTarget}
          messageId={msg.id}
          token={token}
          onClose={() => setForwardTarget(null)}
        />
      )}

      <div className={`flex ${isSent ? "justify-end" : "justify-start"} mb-1`}>
        <div
          className="max-w-[82%] rounded-2xl px-3.5 py-2.5 shadow-sm"
          style={{
            background: bubbleBg,
            borderRadius: isSent ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          }}
        >
          {/* Attachments */}
          {msg.attachments.map(att => (
            <div key={att.id} className="mb-2">
              {isPdf(att) ? (
                <>
                  <PdfThumbnail
                    messageId={msg.id}
                    attachment={att}
                    token={token}
                    onTap={() => openPdf(att)}
                  />
                  {loadingPdfId === att.id && (
                    <div className="flex items-center gap-1 mt-1">
                      <Loader2 className="w-3 h-3 animate-spin" style={{ color: bubbleSubText }} />
                      <span className="text-[10px]" style={{ color: bubbleSubText }}>Opening…</span>
                    </div>
                  )}
                </>
              ) : isImage(att) ? (
                <button
                  onClick={() => openPdf(att)}
                  className="w-full rounded-xl overflow-hidden mb-1 active:opacity-70"
                >
                  <div className="w-full h-28 flex items-center justify-center rounded-xl" style={{ background: "rgba(255,255,255,0.15)" }}>
                    <Paperclip className="w-6 h-6" style={{ color: bubbleSubText }} />
                    <span className="ml-2 text-xs" style={{ color: bubbleSubText }}>{att.name}</span>
                  </div>
                </button>
              ) : (
                <div className="flex items-center gap-2 p-2 rounded-xl mb-1" style={{ background: isSent ? "rgba(255,255,255,0.12)" : "rgba(17,62,97,0.06)" }}>
                  <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-[8px] font-bold">FILE</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate" style={{ color: bubbleText }}>{att.name}</p>
                    <p className="text-[10px]" style={{ color: bubbleSubText }}>{fmtSize(att.size)}</p>
                  </div>
                </div>
              )}
              {/* Forward button */}
              <button
                onClick={() => setForwardTarget(att)}
                className="flex items-center gap-1 mt-0.5 mb-1 active:opacity-60"
              >
                <Share2 className="w-3 h-3" style={{ color: bubbleSubText }} />
                <span className="text-[10px]" style={{ color: bubbleSubText }}>Forward</span>
              </button>
            </div>
          ))}

          {/* Body text */}
          {msg.body && (
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ color: bubbleText }}>
              {msg.body}
            </p>
          )}

          {/* Fallback: show snippet if no body */}
          {!msg.body && !msg.attachments.length && msg.snippet && (
            <p className="text-sm leading-relaxed" style={{ color: bubbleText }}>{msg.snippet}</p>
          )}

          {/* Timestamp */}
          <p className="text-[10px] mt-1 text-right" style={{ color: bubbleSubText }}>
            {fmtBubbleTime(msg.date)}
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Chat input ───────────────────────────────────────────────────────────────

function ChatInput({
  contact,
  token,
  onSent,
  onTokenExpired,
}: {
  contact: Contact;
  token: string;
  onSent: () => void;
  onTokenExpired: () => void;
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

  // Keyboard avoidance
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handler = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardOffset(offset);
    };
    vv.addEventListener("resize", handler);
    vv.addEventListener("scroll", handler);
    return () => {
      vv.removeEventListener("resize", handler);
      vv.removeEventListener("scroll", handler);
    };
  }, []);

  const sendText = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await gmailPost(
        "/api/gmail/send-message",
        { to: contact.email, subject: "Message from Docera", body: text.trim() },
        token,
      );
      setText("");
      onSent();
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) { onTokenExpired(); return; }
      toast({ title: "Failed to send", description: e.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
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
        const all = await res.json();
        loaded = (all as DocItem[]).filter((d: DocItem) => d.dataUrl && d.dataUrl.length > 50);
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
      await gmailPost(
        "/api/gmail/send-message",
        {
          to: contact.email,
          subject: `Document from Docera – ${doc.name}`,
          body: `Please find the attached document: ${doc.name}`,
          attachmentBase64: pdfBase64,
          attachmentName: `${doc.name}.pdf`,
          attachmentMimeType: "application/pdf",
        },
        token,
      );
      setShowDocPicker(false);
      toast({ title: "Sent!", description: `${doc.name} → ${contact.name}` });
      onSent();
    } catch (err: unknown) {
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
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.includes(",") ? result.split(",")[1] : result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await gmailPost(
        "/api/gmail/send-message",
        {
          to: contact.email,
          subject: `File from Docera – ${file.name}`,
          body: `Please find the attached file: ${file.name}`,
          attachmentBase64: base64,
          attachmentName: file.name,
          attachmentMimeType: file.type || "application/octet-stream",
        },
        token,
      );
      toast({ title: "Sent!", description: `${file.name} → ${contact.name}` });
      onSent();
    } catch (err: unknown) {
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
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowActionSheet(false)} />
          <div
            className="relative w-full rounded-t-3xl shadow-2xl"
            style={{ background: BG, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-4" style={{ background: "rgba(17,62,97,0.2)" }} />
            <div className="px-4 pb-2 flex flex-col gap-2">
              <button
                onClick={openDocPicker}
                disabled={loadingDocs}
                className="flex items-center gap-3 p-4 rounded-2xl active:opacity-70"
                style={{ background: "white" }}
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: PRIMARY }}>
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <span className="font-semibold" style={{ color: PRIMARY }}>From Docera</span>
                {loadingDocs && <Loader2 className="w-4 h-4 animate-spin ml-auto" style={{ color: PRIMARY }} />}
              </button>
              <button
                onClick={() => { setShowActionSheet(false); fileInputRef.current?.click(); }}
                className="flex items-center gap-3 p-4 rounded-2xl active:opacity-70"
                style={{ background: "white" }}
              >
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: PRIMARY }}>
                  <Paperclip className="w-5 h-5 text-white" />
                </div>
                <span className="font-semibold" style={{ color: PRIMARY }}>Photo / File from iPhone</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Doc picker sheet */}
      {showDocPicker && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowDocPicker(false)} />
          <div
            className="relative w-full rounded-t-3xl shadow-2xl max-h-[70vh] flex flex-col"
            style={{ background: BG, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <div className="pt-3 pb-4 px-5 flex-shrink-0 border-b" style={{ borderColor: "rgba(17,62,97,0.12)" }}>
              <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "rgba(17,62,97,0.2)" }} />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-base font-bold" style={{ color: PRIMARY }}>Send a Document</p>
                  <p className="text-xs mt-0.5" style={{ color: `${PRIMARY}88` }}>Choose a doc to send to {contact.name}</p>
                </div>
                <button onClick={() => setShowDocPicker(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(17,62,97,0.1)" }}>
                  <X className="w-4 h-4" style={{ color: PRIMARY }} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-2">
              {docs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-28 text-center">
                  <p className="text-sm" style={{ color: `${PRIMARY}88` }}>No documents found</p>
                </div>
              ) : docs.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => sendDoc(doc)}
                  disabled={!!sendingDocId}
                  className="flex items-center gap-3 p-3 rounded-2xl active:opacity-70 disabled:opacity-50 text-left"
                  style={{ background: "white" }}
                >
                  <div className="w-10 h-10 rounded-xl bg-red-500 flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-[9px] font-bold">PDF</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: PRIMARY }}>{doc.name}</p>
                    <p className="text-xs uppercase" style={{ color: `${PRIMARY}88` }}>{doc.type}</p>
                  </div>
                  {sendingDocId === doc.id && <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: PRIMARY }} />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input */}
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
          background: "white",
          borderTop: `1.5px solid ${PRIMARY}22`,
        }}
      >
        <button
          onClick={() => setShowActionSheet(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 active:opacity-60 mb-1"
          style={{ background: `${PRIMARY}18` }}
        >
          <Plus className="w-5 h-5" style={{ color: PRIMARY }} />
        </button>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          rows={1}
          className="flex-1 resize-none rounded-2xl px-3 py-2 text-sm outline-none border"
          style={{
            background: "#fef7ed",
            color: PRIMARY,
            borderColor: `${PRIMARY}22`,
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
          style={{ background: PRIMARY }}
        >
          {sending
            ? <Loader2 className="w-4 h-4 animate-spin text-white" />
            : <Send className="w-4 h-4 text-white" />
          }
        </button>
      </div>
    </>
  );
}

// ─── Thread view ──────────────────────────────────────────────────────────────

function ThreadView({
  contact,
  token,
  contacts,
  onBack,
  onTokenExpired,
}: {
  contact: Contact;
  token: string;
  contacts: Contact[];
  onBack: () => void;
  onTokenExpired: () => void;
}) {
  const { toast } = useToast();
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdfModal, setPdfModal] = useState<{ url: string; name: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await gmailPost<{ messages: GmailMessage[] }>(
        "/api/gmail/thread-messages",
        { contactEmail: contact.email },
        token,
      );
      setMessages(data.messages);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) { onTokenExpired(); return; }
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [contact.email, token]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col h-full" style={{ background: BG }}>
      {/* PDF viewer modal */}
      {pdfModal && (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: BG }}>
          <div
            className="flex-shrink-0 flex items-center gap-3 px-4 pb-3 border-b"
            style={{ paddingTop: "max(3rem, env(safe-area-inset-top))", borderColor: `${PRIMARY}22`, background: "white" }}
          >
            <button
              onClick={() => { URL.revokeObjectURL(pdfModal.url); setPdfModal(null); }}
              className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60"
              style={{ color: PRIMARY }}
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="flex-1 text-sm font-semibold truncate" style={{ color: PRIMARY }}>{pdfModal.name}</p>
            <a
              href={pdfModal.url}
              download={pdfModal.name}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-lg active:opacity-60"
              style={{ color: PRIMARY }}
            >
              ⬇
            </a>
          </div>
          <div className="flex-1 overflow-hidden">
            <iframe src={pdfModal.url} title={pdfModal.name} className="w-full h-full border-0" />
          </div>
        </div>
      )}

      {/* Header */}
      <div
        className="flex-shrink-0 flex items-center gap-3 px-4 pb-3 border-b"
        style={{
          paddingTop: "max(3rem, env(safe-area-inset-top))",
          borderColor: `${PRIMARY}22`,
          background: "white",
        }}
      >
        <button onClick={onBack} className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60" style={{ color: PRIMARY }}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold"
          style={{ background: PRIMARY }}
        >
          {initials(contact.name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm truncate" style={{ color: PRIMARY }}>{contact.name}</p>
          <p className="text-xs truncate" style={{ color: `${PRIMARY}88` }}>{contact.email}</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60"
          style={{ color: `${PRIMARY}88` }}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: `${PRIMARY}60` }} />
            <p className="text-sm" style={{ color: `${PRIMARY}88` }}>Loading messages…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-4">
            <AlertCircle className="w-10 h-10 mb-3" style={{ color: `${PRIMARY}60` }} />
            <p className="font-medium" style={{ color: PRIMARY }}>Couldn't load messages</p>
            <p className="text-sm mt-1" style={{ color: `${PRIMARY}88` }}>{error}</p>
            <button onClick={load} className="mt-4 px-5 py-2 rounded-xl text-white text-sm font-semibold" style={{ background: PRIMARY }}>
              Try again
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Mail className="w-12 h-12 mb-3" style={{ color: `${PRIMARY}40` }} />
            <p style={{ color: `${PRIMARY}88` }}>No messages with this contact</p>
          </div>
        ) : (
          messages.map(msg => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              token={token}
              contacts={contacts}
              onViewPdf={(url, name) => setPdfModal({ url, name })}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Chat input */}
      <ChatInput
        contact={contact}
        token={token}
        onSent={load}
        onTokenExpired={onTokenExpired}
      />
    </div>
  );
}

// ─── Contact list ─────────────────────────────────────────────────────────────

function ContactList({
  token,
  onBack,
  onSelect,
  onTokenExpired,
  onDisconnect,
  onContactsLoaded,
}: {
  token: string;
  onBack: () => void;
  onSelect: (c: Contact) => void;
  onTokenExpired: () => void;
  onDisconnect: () => void;
  onContactsLoaded: (contacts: Contact[]) => void;
}) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showMenu, setShowMenu] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await gmailPost<{ contacts: Contact[] }>("/api/gmail/messages", {}, token);
      setContacts(data.contacts);
      onContactsLoaded(data.contacts);

    } catch (err: unknown) {
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
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const filtered = search
    ? contacts.filter(
        c =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.email.toLowerCase().includes(search.toLowerCase()) ||
          c.lastMessage.toLowerCase().includes(search.toLowerCase()),
      )
    : contacts;

  return (
    <div className="flex flex-col h-full" style={{ background: BG }}>
      {/* Header */}
      <div
        className="flex-shrink-0 px-4 pb-3"
        style={{ paddingTop: "max(3rem, env(safe-area-inset-top))", background: BG }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60" style={{ color: PRIMARY }}>
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold" style={{ color: PRIMARY }}>Inbox</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={load}
              disabled={loading}
              className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60"
              style={{ color: `${PRIMARY}88` }}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <div className="relative">
              <button
                onClick={() => setShowMenu(v => !v)}
                className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60"
                style={{ color: `${PRIMARY}88` }}
              >
                <ChevronRight className="w-4 h-4 rotate-90" />
              </button>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                  <div
                    className="absolute right-0 top-10 z-20 rounded-2xl shadow-xl py-2 min-w-[160px]"
                    style={{ background: "white", border: `1px solid ${PRIMARY}18` }}
                  >
                    <button
                      onClick={() => { setShowMenu(false); onDisconnect(); }}
                      className="w-full flex items-center gap-2 px-4 py-3 text-left active:opacity-60"
                    >
                      <X className="w-4 h-4 text-red-500" />
                      <span className="text-sm font-medium text-red-500">Disconnect Gmail</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search contacts…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full h-10 px-4 rounded-xl text-sm outline-none"
          style={{
            background: "white",
            color: PRIMARY,
            border: `1px solid ${PRIMARY}22`,
          }}
        />
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {loading && contacts.length === 0 ? (
          <div className="flex flex-col gap-2 mt-1">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-2xl animate-pulse" style={{ background: "white" }}>
                <div className="w-12 h-12 rounded-full flex-shrink-0" style={{ background: `${PRIMARY}18` }} />
                <div className="flex-1 space-y-2">
                  <div className="h-4 rounded w-32" style={{ background: `${PRIMARY}18` }} />
                  <div className="h-3 rounded w-48" style={{ background: `${PRIMARY}10` }} />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-6">
            <AlertCircle className="w-10 h-10 mb-3" style={{ color: `${PRIMARY}60` }} />
            <p className="font-medium" style={{ color: PRIMARY }}>Couldn't load inbox</p>
            <p className="text-sm mt-1" style={{ color: `${PRIMARY}88` }}>{error}</p>
            <button onClick={load} className="mt-4 px-5 py-2 rounded-xl text-white text-sm font-semibold" style={{ background: PRIMARY }}>
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Mail className="w-12 h-12 mb-3" style={{ color: `${PRIMARY}40` }} />
            <p className="font-medium" style={{ color: `${PRIMARY}88` }}>
              {search ? "No contacts match" : "No emails found"}
            </p>
            <p className="text-sm mt-1" style={{ color: `${PRIMARY}60` }}>
              {search ? "Try a different search" : "Send or receive an email to see it here"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 mt-1">
            {filtered.map(c => (
              <button
                key={c.email}
                onClick={() => onSelect(c)}
                className="w-full flex items-center gap-3 p-3 rounded-2xl active:opacity-70 text-left"
                style={{ background: "white" }}
              >
                <div className="relative flex-shrink-0">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                    style={{ background: PRIMARY }}
                  >
                    {initials(c.name)}
                  </div>
                  {c.hasUnread && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white"
                      style={{ background: PRIMARY }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="text-sm truncate"
                      style={{ color: PRIMARY, fontWeight: c.hasUnread ? 700 : 600 }}
                    >
                      {c.name}
                    </span>
                    <span className="text-[11px] flex-shrink-0" style={{ color: `${PRIMARY}88` }}>
                      {fmtMsgTime(c.lastDate)}
                    </span>
                  </div>
                  <p className="text-xs truncate mt-0.5" style={{ color: `${PRIMARY}88` }}>{c.email}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    {c.lastDirection === "sent" && <Send className="w-3 h-3 flex-shrink-0" style={{ color: `${PRIMARY}60` }} />}
                    <p
                      className="text-[11px] truncate"
                      style={{ color: c.hasUnread ? PRIMARY : `${PRIMARY}70`, fontWeight: c.hasUnread ? 600 : 400 }}
                    >
                      {c.lastMessage || c.lastSubject}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Connect prompt ───────────────────────────────────────────────────────────

function ConnectPrompt({
  onBack,
  onConnect,
  connecting,
}: {
  onBack: () => void;
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <div className="flex flex-col h-full" style={{ background: BG }}>
      <div
        className="flex-shrink-0 px-4 pb-3"
        style={{ paddingTop: "max(3rem, env(safe-area-inset-top))" }}
      >
        <button onClick={onBack} className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60" style={{ color: PRIMARY }}>
          <ArrowLeft className="w-5 h-5" />
        </button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <div
          className="w-24 h-24 rounded-3xl flex items-center justify-center mb-6 shadow-lg"
          style={{ background: `${PRIMARY}12` }}
        >
          <Mail className="w-12 h-12" style={{ color: PRIMARY }} />
        </div>
        <h2 className="text-2xl font-bold mb-2" style={{ color: PRIMARY }}>Connect Gmail</h2>
        <p className="leading-relaxed mb-10 text-sm" style={{ color: `${PRIMARY}99` }}>
          See all your emails organized as conversations. Tap any contact to read and reply.
        </p>
        <button
          onClick={onConnect}
          disabled={connecting}
          className="w-full max-w-xs py-4 rounded-2xl text-white text-base font-bold active:opacity-80 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg"
          style={{ background: PRIMARY }}
        >
          {connecting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Connecting…
            </>
          ) : (
            <>
              <Mail className="w-5 h-5" />
              Connect Gmail
            </>
          )}
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
      <WifiOff className="w-3.5 h-3.5" />
      You're offline — showing cached data
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface GmailInboxPageProps {
  onBack: () => void;
}

export default function GmailInboxPage({ onBack }: GmailInboxPageProps) {
  const { toast } = useToast();
  const [gmailToken, setGmailToken] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(GMAIL_TOKEN_KEY);
    if (stored) setGmailToken(stored);

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
        .then((data: { accessToken?: string; error?: string }) => {
          if (data.accessToken) {
            localStorage.setItem(GMAIL_TOKEN_KEY, data.accessToken);
            setGmailToken(data.accessToken);
            toast({ title: "Gmail connected", description: "Your inbox is ready." });
          } else {
            toast({ title: "Connection failed", description: data.error ?? "Unknown error", variant: "destructive" });
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
      `&access_type=offline` +
      `&prompt=consent`;
    if (Capacitor.isNativePlatform()) {
      setConnecting(true);
      await Browser.open({ url: authUrl });
    } else {
      window.open(authUrl, "_blank");
    }
  };

  const handleTokenExpired = () => {
    localStorage.removeItem(GMAIL_TOKEN_KEY);
    setGmailToken(null);
    setSelectedContact(null);
  };

  const handleDisconnect = () => {
    localStorage.removeItem(GMAIL_TOKEN_KEY);
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
        <div className="flex flex-col" style={{ height: "100dvh", background: BG }}>
          <ThreadView
            contact={selectedContact}
            token={gmailToken}
            contacts={contacts}
            onBack={() => setSelectedContact(null)}
            onTokenExpired={handleTokenExpired}
          />
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ background: BG }}>
      <OfflineBanner />
      <ContactList
        token={gmailToken}
        onBack={onBack}
        onSelect={setSelectedContact}
        onTokenExpired={handleTokenExpired}
        onDisconnect={handleDisconnect}
        onContactsLoaded={setContacts}
      />
    </div>
  );
}
