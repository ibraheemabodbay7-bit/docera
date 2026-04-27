import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, ImageOff, Paperclip, Image, MessageCircle } from "lucide-react";
import { API_BASE } from "@/lib/queryClient";

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

function PdfThumb({ dark }: { dark: boolean }) {
  return (
    <div style={{
      position: "absolute", inset: 0,
      background: dark
        ? "linear-gradient(180deg, #f7ecd6 0%, #ecdfc3 100%)"
        : "linear-gradient(180deg, #fffdf6 0%, #f4e7cf 100%)",
      padding: "16px 12px",
      display: "flex", flexDirection: "column", gap: 5,
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", inset: 0,
        background: "repeating-linear-gradient(0deg, rgba(0,51,42,0.025) 0 1px, transparent 1px 3px)",
        pointerEvents: "none",
      }} />
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{
          height: 3,
          background: "rgba(0,51,42,0.22)",
          borderRadius: 1,
          width: i === 0 ? "50%" : i === 7 ? "30%" : `${72 + (i * 9) % 22}%`,
          marginTop: i === 1 ? 4 : 0,
          flexShrink: 0,
        }} />
      ))}
      <div style={{
        position: "absolute", top: 8, right: 8,
        background: "#00332a", color: "#fef7ed",
        fontSize: 8.5, fontWeight: 700, letterSpacing: "0.04em",
        padding: "2.5px 6px",
        borderRadius: 4,
      }}>
        PDF
      </div>
    </div>
  );
}

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

interface ClientProfilePageProps {
  contact: Contact;
  messages: GmailMessage[];
  token: string;
  refreshToken?: string | null;
  onBack: () => void;
  onOpenPdf: (att: GmailAttachment, msgId: string) => void;
  onOpenConversation: () => void;
}

export default function ClientProfilePage({
  contact, messages, token, onBack, onOpenPdf, onOpenConversation,
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
        <div style={{
          background: theme.headerBg,
          color: theme.headerInk,
          paddingTop: "max(3rem, env(safe-area-inset-top))",
          paddingBottom: 26,
          paddingLeft: 20,
          paddingRight: 20,
          position: "relative",
        }}>
          {/* Top bar */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", zIndex: 1 }}>
            <button
              onClick={onBack}
              style={{ width: 36, height: 36, borderRadius: 10, background: "transparent", border: "none", padding: 0, color: theme.headerInk, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: -6 }}
            >
              <ChevronLeft style={{ width: 22, height: 22 }} />
            </button>
            <div style={{ fontSize: 10, letterSpacing: "0.26em", textTransform: "uppercase", color: theme.headerFaint, fontWeight: 600 }}>
              Contact
            </div>
            <div style={{ width: 36 }} />
          </div>

          {/* Avatar + name */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 20, gap: 14, position: "relative", zIndex: 1 }}>
            <div style={{
              width: 88, height: 88, borderRadius: "50%",
              background: theme.avatarBg,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#00332a",
              fontSize: 37, fontWeight: 500,
              fontFamily: '"Cormorant Garamond", Georgia, serif',
              letterSpacing: "0.01em",
              boxShadow: "inset 0 -1px 0 rgba(0,51,42,0.15), 0 8px 24px -8px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.4)",
              border: "1px solid rgba(254,247,237,0.6)",
              flexShrink: 0,
            }}>
              {initials(contact.name)}
            </div>
            <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 8, alignItems: "center", maxWidth: 320 }}>
              <div style={{
                fontFamily: '"Cormorant Garamond", Georgia, serif',
                fontSize: 24, fontWeight: 500,
                color: theme.headerInk,
                letterSpacing: "-0.005em",
                lineHeight: 1.2,
                margin: 0,
              }}>
                {contact.name}
              </div>
              <div style={{ fontSize: 13.5, color: theme.headerSubtle, letterSpacing: "-0.01em", fontWeight: 400 }}>
                {contact.email}
              </div>
            </div>
          </div>
        </div>

        {/* Stats card — overlaps header */}
        <div style={{ padding: "0 20px", marginTop: -20, position: "relative", zIndex: 2 }}>
          <div style={{
            background: theme.statsCard,
            borderRadius: 16,
            padding: "18px 12px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            boxShadow: theme.statsCardShadow,
            border: theme.statsCardBorder,
          }}>
            {stats.map((s, i) => (
              <div key={s.label} style={{
                padding: "4px 0",
                borderLeft: i === 0 ? "none" : `0.5px solid ${theme.hair}`,
                display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              }}>
                <div style={{
                  fontFamily: '"Cormorant Garamond", Georgia, serif',
                  fontSize: 30, fontWeight: 500,
                  color: s.value > 0 ? theme.ink : theme.muted,
                  lineHeight: 1,
                  letterSpacing: "-0.02em",
                }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 11, fontWeight: 500, color: theme.subtle, letterSpacing: "0.02em" }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Documents section */}
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
                <div
                  key={`${att.id}-${i}`}
                  onClick={() => onOpenPdf(att, att.msgId)}
                  style={{ display: "flex", flexDirection: "column", cursor: "pointer" }}
                >
                  <div style={{
                    position: "relative",
                    aspectRatio: "0.78 / 1",
                    borderRadius: 12,
                    overflow: "hidden",
                    boxShadow: theme.frameDark
                      ? "0 8px 18px -10px rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.04)"
                      : "0 6px 14px -8px rgba(0,51,42,0.22), inset 0 0.5px 0 rgba(255,255,255,0.6)",
                  }}>
                    <PdfThumb dark={theme.frameDark} />
                  </div>
                  <div style={{ paddingTop: 10, paddingLeft: 2, display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink, letterSpacing: "-0.01em", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {att.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: theme.subtle, letterSpacing: "-0.01em" }}>
                      <span>{fmtSize(att.size)}</span>
                      <span style={{ width: 2.5, height: 2.5, borderRadius: "50%", background: theme.muted, flexShrink: 0, display: "inline-block" }} />
                      <span>{fmtDate(messages.find(m => m.id === att.msgId)?.date ?? "")}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Photos section */}
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
                <ImageCard
                  key={`${att.id}-${i}`}
                  att={att}
                  msgId={att.msgId}
                  token={token}
                  placeholder={theme.toneGradients[i % 4]}
                />
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

        {/* Open Conversation CTA */}
        <div style={{ padding: "28px 20px 0" }}>
          <button
            onClick={onOpenConversation}
            style={{
              width: "100%",
              background: theme.accentBg,
              border: "none",
              borderRadius: 14,
              padding: "15px 20px",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
              color: theme.accentInk,
              fontFamily: "inherit",
              fontSize: 16, fontWeight: 600,
              letterSpacing: "-0.01em",
              cursor: "pointer",
              boxShadow: theme.accentShadow,
            }}
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
