import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, ImageOff, Paperclip, Image, MessageCircle } from "lucide-react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { API_BASE } from "@/lib/queryClient";

const QuickLook = registerPlugin<{ openPDF: (options: { path: string }) => Promise<void> }>("QuickLook");

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

function fmtSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function initials(name: string) {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

function fmtDate(dateStr: string) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// ─── PDF thumbnail cache ───────────────────────────────────────────────────────

const profileThumbCache = new Map<string, string>();
const profileBase64Cache = new Map<string, string>();

let activeProfileThumbnailLoads = 0;
const MAX_CONCURRENT = 2;
const profileThumbnailQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise(resolve => {
    if (activeProfileThumbnailLoads < MAX_CONCURRENT) {
      activeProfileThumbnailLoads++;
      resolve();
    } else {
      profileThumbnailQueue.push(() => { activeProfileThumbnailLoads++; resolve(); });
    }
  });
}

function releaseSlot() {
  activeProfileThumbnailLoads--;
  const next = profileThumbnailQueue.shift();
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
    await (page.render as any)({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    return "";
  }
}

async function openPdfFromProfile(base64: string, name: string) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const safe = name.replace(/[^a-z0-9._-]/gi, "_");
    const fileName = safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
    await QuickLook.openPDF({ path: uri });
  } catch (err) {
    console.error("PDF open error:", err);
  }
}

// ─── Theme ────────────────────────────────────────────────────────────────────

const TONE_GRADIENTS_LIGHT = [
  "linear-gradient(135deg, #c8d8c0 0%, #9ab896 100%)",
  "linear-gradient(135deg, #f0e3c8 0%, #d8c393 100%)",
  "linear-gradient(135deg, #1f5c4d 0%, #00332a 100%)",
  "linear-gradient(135deg, #fef7ed 0%, #ecdfc3 100%)",
];
const TONE_GRADIENTS_DARK = [
  "linear-gradient(135deg, #1a4d3e 0%, #2a6855 100%)",
  "linear-gradient(135deg, #5c4a2e 0%, #7d6640 100%)",
  "linear-gradient(135deg, #00251e 0%, #0e5a4b 100%)",
  "linear-gradient(135deg, #d4c4a3 0%, #ad9d7a 100%)",
];

function getTheme(dark: boolean) {
  return dark
    ? {
        base: "#00332a",
        headerBg: "#001e19",
        headerInk: "#fef7ed",
        headerSubtle: "rgba(254,247,237,0.72)",
        headerFaint: "rgba(254,247,237,0.46)",
        ink: "#fef7ed",
        subtle: "rgba(254,247,237,0.72)",
        muted: "rgba(254,247,237,0.3)",
        hair: "rgba(254,247,237,0.14)",
        statsCard: "rgba(14,90,75,1)",
        statsCardShadow: "0 12px 32px -12px rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.06)",
        statsCardBorder: "0.5px solid rgba(254,247,237,0.14)",
        accentInk: "#00332a",
        accentBg: "linear-gradient(160deg, #fef7ed, #f0e3c8)",
        accentShadow: "0 10px 24px -8px rgba(254,247,237,0.4), inset 0 1px 0 rgba(255,255,255,0.6)",
        avatarBg: "radial-gradient(circle at 30% 25%, #fffaf0, #d9c9a5 80%)",
        frameDark: true,
        toneGradients: TONE_GRADIENTS_DARK,
      }
    : {
        base: "#fef7ed",
        headerBg: "#00332a",
        headerInk: "#fef7ed",
        headerSubtle: "rgba(254,247,237,0.72)",
        headerFaint: "rgba(254,247,237,0.46)",
        ink: "#00332a",
        subtle: "rgba(0,51,42,0.62)",
        muted: "rgba(0,51,42,0.28)",
        hair: "rgba(0,51,42,0.12)",
        statsCard: "#ffffff",
        statsCardShadow: "0 12px 32px -14px rgba(0,51,42,0.35), inset 0 0.5px 0 rgba(255,255,255,0.8)",
        statsCardBorder: "none",
        accentInk: "#fef7ed",
        accentBg: "linear-gradient(160deg, #0e5a4b, #00332a)",
        accentShadow: "0 10px 24px -8px rgba(0,51,42,0.5), inset 0 1px 0 rgba(255,255,255,0.12)",
        avatarBg: "radial-gradient(circle at 30% 25%, #ffffff, #ecdfc3 80%)",
        frameDark: false,
        toneGradients: TONE_GRADIENTS_LIGHT,
      };
}

// ─── Paper skeleton (shown while thumbnail loads) ─────────────────────────────

function PdfPaperSkeleton({ dark }: { dark: boolean }) {
  return (
    <div style={{
      position: "absolute", inset: 0,
      background: dark
        ? "linear-gradient(180deg, #f7ecd6 0%, #ecdfc3 100%)"
        : "linear-gradient(180deg, #fffdf6 0%, #f4e7cf 100%)",
      padding: "12px 10px",
      display: "flex", flexDirection: "column", gap: 4,
      overflow: "hidden",
    }}>
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, rgba(0,51,42,0.025) 0 1px, transparent 1px 3px)", pointerEvents: "none" }} />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ height: 3, background: "rgba(0,51,42,0.18)", borderRadius: 1, width: i === 0 ? "50%" : i === 5 ? "30%" : `${68 + (i * 9) % 24}%`, marginTop: i === 1 ? 3 : 0, flexShrink: 0 }} />
      ))}
      <div style={{ position: "absolute", top: 6, right: 6, background: "#00332a", color: "#fef7ed", fontSize: 7.5, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 5px", borderRadius: 3 }}>
        PDF
      </div>
    </div>
  );
}

// ─── PDF thumbnail card ───────────────────────────────────────────────────────

function PdfThumbnailCard({
  att, msgId, token, dark, dateStr,
}: {
  att: GmailAttachment & { msgId: string };
  msgId: string;
  token: string;
  dark: boolean;
  dateStr: string;
}) {
  const theme = getTheme(dark);
  const cached = profileThumbCache.get(att.id) ?? null;
  const [thumb, setThumb] = useState<string | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      await acquireSlot();
      try {
        if (cancelled) return;
        let b64 = profileBase64Cache.get(att.id);
        if (!b64) {
          const res = await fetch(`${API_BASE}/api/gmail/attachment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: token, messageId: msgId, attachmentId: att.id }),
            credentials: "omit",
          });
          if (!res.ok) return;
          const data = await res.json() as { base64?: string };
          if (!data.base64 || cancelled) return;
          b64 = data.base64;
          profileBase64Cache.set(att.id, b64);
        }
        const url = await generatePdfThumbnail(b64);
        if (!cancelled && url) { profileThumbCache.set(att.id, url); setThumb(url); }
      } catch { } finally {
        releaseSlot();
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [att.id, msgId, token]);

  const handleTap = async () => {
    if (opening) return;
    setOpening(true);
    try {
      let b64 = profileBase64Cache.get(att.id);
      if (!b64) {
        const res = await fetch(`${API_BASE}/api/gmail/attachment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: token, messageId: msgId, attachmentId: att.id }),
          credentials: "omit",
        });
        if (res.ok) {
          const data = await res.json() as { base64?: string };
          if (data.base64) { b64 = data.base64; profileBase64Cache.set(att.id, b64); }
        }
      }
      if (b64) await openPdfFromProfile(b64, att.name);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div onClick={handleTap} style={{ display: "flex", flexDirection: "column", cursor: "pointer" }}>
      {/* Thumbnail area */}
      <div style={{
        position: "relative",
        height: 110,
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: dark
          ? "0 8px 18px -10px rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.04)"
          : "0 6px 14px -8px rgba(0,51,42,0.22), inset 0 0.5px 0 rgba(255,255,255,0.6)",
      }}>
        {/* Paper skeleton always mounted as base layer */}
        <PdfPaperSkeleton dark={dark} />
        {/* Real thumbnail rendered on top once loaded */}
        {thumb && (
          <img
            src={thumb}
            alt=""
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }}
          />
        )}
        {/* Loading spinner overlay */}
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader2 style={{ width: 16, height: 16, color: "rgba(0,51,42,0.35)" }} className="animate-spin" />
          </div>
        )}
        {opening && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,51,42,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Loader2 style={{ width: 18, height: 18, color: "#00332a" }} className="animate-spin" />
          </div>
        )}
      </div>
      {/* Metadata below */}
      <div style={{ paddingTop: 8, paddingLeft: 2, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.ink, letterSpacing: "-0.01em", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {att.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: theme.subtle, letterSpacing: "-0.01em" }}>
          <span>{fmtSize(att.size)}</span>
          {dateStr && <>
            <span style={{ width: 2.5, height: 2.5, borderRadius: "50%", background: theme.muted, flexShrink: 0, display: "inline-block" }} />
            <span>{dateStr}</span>
          </>}
        </div>
      </div>
    </div>
  );
}

// ─── Image card ───────────────────────────────────────────────────────────────

function ImageCard({ att, msgId, token, placeholder }: {
  att: GmailAttachment & { msgId: string };
  msgId: string;
  token: string;
  placeholder: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/gmail/attachment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: token, messageId: msgId, attachmentId: att.id }),
          credentials: "omit",
        });
        if (!res.ok) throw new Error("fetch failed");
        const data = await res.json() as { base64?: string };
        if (!cancelled && data.base64) setSrc(`data:${att.mimeType};base64,${data.base64}`);
        else if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [att.id, msgId, token]);

  return (
    <div style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 10, overflow: "hidden", background: placeholder, cursor: "pointer" }}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(255,255,255,0.12), transparent 50%)", pointerEvents: "none", zIndex: 1 }} />
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
          <Loader2 style={{ width: 18, height: 18, color: "rgba(0,51,42,0.3)" }} className="animate-spin" />
        </div>
      )}
      {error && !loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
          <ImageOff style={{ width: 18, height: 18, color: "rgba(0,51,42,0.25)" }} />
        </div>
      )}
      {src && (
        <img src={src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block", zIndex: 2 }} />
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ClientProfilePageProps {
  contact: Contact;
  messages: GmailMessage[];
  token: string;
  refreshToken?: string | null;
  onBack: () => void;
  onOpenPdf: (att: GmailAttachment, msgId: string) => void;
  onOpenConversation: () => void;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ClientProfilePage({
  contact, messages, token, onBack, onOpenConversation,
}: ClientProfilePageProps) {
  const darkMode = localStorage.getItem("docera_inbox_dark") === "true";
  const theme = getTheme(darkMode);

  const allAttachments = messages.flatMap(m => m.attachments.map(att => ({ ...att, msgId: m.id })));
  const pdfs = allAttachments.filter(a => a.mimeType === "application/pdf" || a.name.toLowerCase().endsWith(".pdf"));
  const images = allAttachments.filter(a => a.mimeType.startsWith("image/"));

  const stats = [
    { label: "Messages", value: messages.length },
    { label: "PDFs",     value: pdfs.length },
    { label: "Photos",   value: images.length },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: theme.base, overflow: "hidden" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap');`}</style>

      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>

        {/* Header */}
        <div style={{ background: theme.headerBg, color: theme.headerInk, paddingTop: "max(3rem, env(safe-area-inset-top))", paddingBottom: 26, paddingLeft: 20, paddingRight: 20, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", zIndex: 1 }}>
            <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 10, background: "transparent", border: "none", padding: 0, color: theme.headerInk, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: -6 }}>
              <ChevronLeft style={{ width: 22, height: 22 }} />
            </button>
            <div style={{ fontSize: 10, letterSpacing: "0.26em", textTransform: "uppercase", color: theme.headerFaint, fontWeight: 600 }}>Contact</div>
            <div style={{ width: 36 }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 20, gap: 14, position: "relative", zIndex: 1 }}>
            <div style={{ width: 88, height: 88, borderRadius: "50%", background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: "#00332a", fontSize: 37, fontWeight: 500, fontFamily: '"Cormorant Garamond", Georgia, serif', letterSpacing: "0.01em", boxShadow: "inset 0 -1px 0 rgba(0,51,42,0.15), 0 8px 24px -8px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.4)", border: "1px solid rgba(254,247,237,0.6)", flexShrink: 0 }}>
              {initials(contact.name)}
            </div>
            <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 8, alignItems: "center", maxWidth: 320 }}>
              <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 24, fontWeight: 500, color: theme.headerInk, letterSpacing: "-0.005em", lineHeight: 1.2, margin: 0 }}>
                {contact.name}
              </div>
              <div style={{ fontSize: 13.5, color: theme.headerSubtle, letterSpacing: "-0.01em", fontWeight: 400 }}>
                {contact.email}
              </div>
            </div>
          </div>
        </div>

        {/* Stats card */}
        <div style={{ padding: "0 20px", marginTop: -20, position: "relative", zIndex: 2 }}>
          <div style={{ background: theme.statsCard, borderRadius: 16, padding: "18px 12px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", boxShadow: theme.statsCardShadow, border: theme.statsCardBorder }}>
            {stats.map((s, i) => (
              <div key={s.label} style={{ padding: "4px 0", borderLeft: i === 0 ? "none" : `0.5px solid ${theme.hair}`, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 30, fontWeight: 500, color: s.value > 0 ? theme.ink : theme.muted, lineHeight: 1, letterSpacing: "-0.02em" }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 11, fontWeight: 500, color: theme.subtle, letterSpacing: "0.02em" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Documents */}
        {pdfs.length > 0 && (
          <>
            <div style={{ padding: "28px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: theme.subtle, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                <Paperclip style={{ width: 13, height: 13, strokeWidth: 1.8 }} />
                Documents
              </div>
              <button style={{ background: "transparent", border: "none", padding: 0, color: theme.ink, fontSize: 14, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", letterSpacing: "-0.01em" }}>
                See All
              </button>
            </div>
            <div style={{ padding: "0 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {pdfs.map((att, i) => (
                <PdfThumbnailCard
                  key={`${att.id}-${i}`}
                  att={att}
                  msgId={att.msgId}
                  token={token}
                  dark={theme.frameDark}
                  dateStr={fmtDate(messages.find(m => m.id === att.msgId)?.date ?? "")}
                />
              ))}
            </div>
          </>
        )}

        {/* Photos */}
        {images.length > 0 && (
          <>
            <div style={{ padding: "28px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: theme.subtle, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                <Image style={{ width: 13, height: 13, strokeWidth: 1.8 }} />
                Photos
              </div>
              <button style={{ background: "transparent", border: "none", padding: 0, color: theme.ink, fontSize: 14, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", letterSpacing: "-0.01em" }}>
                See All
              </button>
            </div>
            <div style={{ padding: "0 20px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              {images.map((att, i) => (
                <ImageCard key={`${att.id}-${i}`} att={att} msgId={att.msgId} token={token} placeholder={theme.toneGradients[i % 4]} />
              ))}
            </div>
          </>
        )}

        {/* Empty state */}
        {pdfs.length === 0 && images.length === 0 && (
          <p style={{ color: theme.muted, fontSize: 14, textAlign: "center", padding: "28px 20px" }}>
            No attachments in this conversation
          </p>
        )}

        {/* CTA */}
        <div style={{ padding: "28px 20px 0" }}>
          <button
            onClick={onOpenConversation}
            style={{ width: "100%", background: theme.accentBg, border: "none", borderRadius: 14, padding: "15px 20px", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, color: theme.accentInk, fontFamily: "inherit", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", cursor: "pointer", boxShadow: theme.accentShadow }}
          >
            <MessageCircle style={{ width: 18, height: 18, strokeWidth: 2 }} />
            Open Conversation
          </button>
        </div>

        <div style={{ height: 60 }} />
      </div>
    </div>
  );
}
