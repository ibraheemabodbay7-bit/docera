import { useState, useMemo } from "react";
import { ArrowLeft, MessageCircle, FileText, Image, Loader2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { format, isValid } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { API_BASE } from "@/lib/queryClient";

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
}

interface ClientProfilePageProps {
  contact: Contact;
  messages: GmailMessage[];
  token: string;
  refreshToken?: string | null;
  onBack: () => void;
  theme: Theme;
  onOpenThread: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIMARY = "#1a3a5c";

function initials(name: string) {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

function fmtDate(dateStr: string) {
  try {
    const d = new Date(dateStr);
    return isValid(d) ? format(d, "MMM d, yyyy") : "";
  } catch { return ""; }
}

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function gmailPost<T>(
  path: string,
  extra: Record<string, unknown>,
  token: string,
  refreshToken?: string | null,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: token, ...(refreshToken ? { refreshToken } : {}), ...extra }),
    credentials: Capacitor.isNativePlatform() ? "omit" : "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(body.error ?? "Request failed"), { status: res.status });
  }
  return res.json();
}

async function openPdfNative(
  base64: string,
  filename: string,
  toastFn?: (opts: { title: string; description?: string; variant?: string }) => void,
) {
  if (Capacitor.isNativePlatform()) {
    try {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      await Filesystem.writeFile({ path: safeName, data: base64, directory: Directory.Cache, recursive: true });
      const fileResult = await Filesystem.getUri({ path: safeName, directory: Directory.Cache });
      await Share.share({ title: filename, url: fileResult.uri });
    } catch (err) {
      toastFn?.({ title: "Could not open PDF", description: (err as Error).message, variant: "destructive" });
    }
  } else {
    const blob = await fetch(`data:application/pdf;base64,${base64}`).then(r => r.blob());
    window.open(URL.createObjectURL(blob), "_blank");
  }
}

// ─── PDF card ─────────────────────────────────────────────────────────────────

function PdfCard({
  messageId, attachment, token, refreshToken, theme,
}: {
  messageId: string; attachment: GmailAttachment; token: string; refreshToken?: string | null; theme: Theme;
}) {
  const { toast } = useToast();
  const [opening, setOpening] = useState(false);

  const open = async () => {
    setOpening(true);
    try {
      const data = await gmailPost<{ base64: string }>(
        "/api/gmail/attachment", { messageId, attachmentId: attachment.id }, token, refreshToken,
      );
      await openPdfNative(data.base64, attachment.name, toast);
    } catch (err) {
      toast({ title: "Could not open PDF", description: (err as Error).message, variant: "destructive" });
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      onClick={open}
      disabled={opening}
      className="flex-shrink-0 active:opacity-70 disabled:opacity-50"
      style={{ width: 160 }}
    >
      <div
        style={{
          width: 160, height: 120, borderRadius: 12, overflow: "hidden",
          background: theme.cardBg, border: `1px solid ${theme.border}`,
          display: "flex", flexDirection: "column",
        }}
      >
        <div
          className="flex-1 flex items-center justify-center"
          style={{ background: "rgba(220,53,69,0.08)" }}
        >
          {opening
            ? <Loader2 className="w-8 h-8 animate-spin" style={{ color: theme.subText }} />
            : <FileText className="w-10 h-10 text-red-500" />
          }
        </div>
        <div className="px-2 py-1.5 text-left" style={{ borderTop: `1px solid ${theme.border}` }}>
          <p className="text-[11px] font-semibold truncate" style={{ color: theme.receivedText }}>{attachment.name}</p>
          <p className="text-[10px]" style={{ color: theme.subText }}>{fmtSize(attachment.size)}</p>
        </div>
      </div>
    </button>
  );
}

// ─── Image card ───────────────────────────────────────────────────────────────

function ImageCard({
  messageId, attachment, token, refreshToken, theme,
}: {
  messageId: string; attachment: GmailAttachment; token: string; refreshToken?: string | null; theme: Theme;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const load = async () => {
    if (src || loading) return;
    setLoading(true);
    try {
      const data = await gmailPost<{ base64: string }>(
        "/api/gmail/attachment", { messageId, attachmentId: attachment.id }, token, refreshToken,
      );
      const mimeType = attachment.mimeType?.startsWith("image/") ? attachment.mimeType : "image/jpeg";
      setSrc(`data:${mimeType};base64,${data.base64}`);
    } catch {} finally {
      setLoading(false);
    }
  };

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
            <span className="text-white text-lg">✕</span>
          </button>
        </div>
      )}
      <button
        onClick={() => { load(); if (src) setFullscreen(true); }}
        className="active:opacity-70"
        style={{ aspectRatio: "1", background: theme.cardBg, borderRadius: 8, overflow: "hidden", display: "block" }}
      >
        {src ? (
          <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} onClick={() => setFullscreen(true)} />
        ) : loading ? (
          <div className="w-full h-full flex items-center justify-center" style={{ background: theme.pillBg }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: theme.subText }} />
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ background: theme.pillBg }} onClick={load}>
            <Image className="w-5 h-5" style={{ color: theme.subText }} />
          </div>
        )}
      </button>
    </>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ClientProfilePage({
  contact, messages, token, refreshToken, onBack, theme, onOpenThread,
}: ClientProfilePageProps) {
  const pdfs = useMemo(() =>
    messages.flatMap(m =>
      m.attachments
        .filter(a => a.mimeType === "application/pdf" || a.name.toLowerCase().endsWith(".pdf"))
        .map(a => ({ messageId: m.id, attachment: a, date: m.date }))
    ), [messages]);

  const images = useMemo(() =>
    messages.flatMap(m =>
      m.attachments
        .filter(a => a.mimeType.startsWith("image/"))
        .map(a => ({ messageId: m.id, attachment: a }))
    ), [messages]);

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: theme.bg }}>
      {/* Header */}
      <div
        className="flex-shrink-0 px-4 pb-4"
        style={{ paddingTop: "max(3rem, env(safe-area-inset-top))", background: theme.header, borderBottom: `1px solid ${theme.border}` }}
      >
        <button
          onClick={onBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center active:opacity-60 mb-4"
          style={{ color: theme.receivedText }}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Avatar + name */}
        <div className="flex flex-col items-center gap-3 pb-2">
          <div
            className="w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl font-bold"
            style={{ background: PRIMARY }}
          >
            {initials(contact.name)}
          </div>
          <div className="text-center">
            <h2 className="text-lg font-bold" style={{ color: theme.receivedText }}>{contact.name}</h2>
            <p className="text-sm" style={{ color: theme.subText }}>{contact.email}</p>
            {contact.lastDate && (
              <p className="text-xs mt-0.5" style={{ color: theme.subText }}>Last message {fmtDate(contact.lastDate)}</p>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mt-4">
          {[
            { label: "Messages", value: contact.messageCount },
            { label: "PDFs", value: pdfs.length },
            { label: "Images", value: images.length },
          ].map(s => (
            <div
              key={s.label}
              className="flex-1 flex flex-col items-center py-2 rounded-2xl"
              style={{ background: theme.cardBg }}
            >
              <span className="text-lg font-bold" style={{ color: theme.receivedText }}>{s.value}</span>
              <span className="text-[11px]" style={{ color: theme.subText }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 px-4 py-4 flex flex-col gap-6">
        {/* PDFs */}
        {pdfs.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <FileText className="w-4 h-4" style={{ color: theme.subText }} />
              <span className="text-sm font-semibold" style={{ color: theme.receivedText }}>PDFs</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
              {pdfs.map(({ messageId, attachment }) => (
                <PdfCard
                  key={attachment.id}
                  messageId={messageId}
                  attachment={attachment}
                  token={token}
                  refreshToken={refreshToken}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        )}

        {/* Images */}
        {images.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Image className="w-4 h-4" style={{ color: theme.subText }} />
              <span className="text-sm font-semibold" style={{ color: theme.receivedText }}>Images</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {images.map(({ messageId, attachment }) => (
                <ImageCard
                  key={attachment.id}
                  messageId={messageId}
                  attachment={attachment}
                  token={token}
                  refreshToken={refreshToken}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        )}

        {/* Open conversation */}
        <button
          onClick={onOpenThread}
          className="w-full py-3.5 rounded-2xl text-white font-semibold text-base flex items-center justify-center gap-2 active:opacity-80"
          style={{ background: PRIMARY }}
        >
          <MessageCircle className="w-5 h-5" />
          Open Conversation
        </button>
      </div>
    </div>
  );
}
