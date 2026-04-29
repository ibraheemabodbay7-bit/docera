import { useState, useEffect, useRef } from "react";
import { ChevronLeft, Loader2, ImageOff, Paperclip, Image, MessageCircle } from "lucide-react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { API_BASE } from "@/lib/queryClient";
import { isDarkMode } from "@/lib/theme";

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
const profilePageCountCache = new Map<string, number>();
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

async function generatePdfThumbnail(base64: string): Promise<{ thumb: string; pageCount: number }> {
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
    const pageCount = pdf.numPages;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = Math.floor(viewport.width * 0.45);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await (page.render as any)({ canvasContext: ctx, viewport }).promise;
    return { thumb: canvas.toDataURL("image/jpeg", 0.9), pageCount };
  } catch {
    return { thumb: "", pageCount: 0 };
  }
}

async function openImageFromProfile(base64: string, name: string, mimeType: string) {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("gif") ? "gif" : mimeType.includes("webp") ? "webp" : "jpg";
    const safe = name.replace(/[^a-z0-9._-]/gi, "_");
    const fileName = safe.includes(".") ? safe : `${safe}.${ext}`;
    await Filesystem.writeFile({ path: fileName, data: base64, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache });
    await QuickLook.openPDF({ path: uri });
  } catch (err) {
    console.error("Image open error:", err);
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

const TONE_GRADIENTS_LIGHT = [
  "linear-gradient(135deg, #d8d8dc 0%, #c0c0c8 100%)",
  "linear-gradient(135deg, #e8e8ec 0%, #d0d0d8 100%)",
  "linear-gradient(135deg, #2a2a30 0%, #1a1a1f 100%)",
  "linear-gradient(135deg, #ececef 0%, #dcdce0 100%)",
];
const TONE_GRADIENTS_DARK = [
  "linear-gradient(135deg, #2a2a30 0%, #3a3a42 100%)",
  "linear-gradient(135deg, #3a3a42 0%, #4a4a54 100%)",
  "linear-gradient(135deg, #0a0a0c 0%, #1c1c20 100%)",
  "linear-gradient(135deg, #d4d4dc 0%, #b0b0bc 100%)",
];

function getTheme(dark: boolean) {
  return dark
    ? {
        base: "transparent",
        headerBg: "rgba(14,14,18,0.88)",
        headerInk: "#e8e8ec",
        headerSubtle: "rgba(232,232,236,0.72)",
        headerFaint: "rgba(232,232,236,0.46)",
        ink: "#e8e8ec",
        subtle: "rgba(232,232,236,0.72)",
        muted: "#a0a0a8",
        hair: "rgba(255,255,255,0.08)",
        statsCard: "rgba(28,28,32,0.65)",
        statsCardShadow: "0 1px 0 rgba(255,255,255,0.05) inset, 0 4px 20px rgba(0,0,0,0.5)",
        statsCardBorder: "0.5px solid rgba(255,255,255,0.08)",
        accentInk: "#e8e8ec",
        accentBg: "linear-gradient(160deg, #3a3a42, #2a2a30)",
        accentShadow: "0 10px 24px -8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)",
        avatarBg: "radial-gradient(circle at 30% 25%, #3a3a42, #2a2a30 80%)",
        frameDark: true,
        toneGradients: TONE_GRADIENTS_DARK,
      }
    : {
        base: "transparent",
        headerBg: "rgba(232,236,242,0.82)",
        headerInk: "#1a1f2a",
        headerSubtle: "rgba(26,31,42,0.7)",
        headerFaint: "rgba(26,31,42,0.45)",
        ink: "#1a1a1f",
        subtle: "#6a6a72",
        muted: "rgba(26,26,31,0.28)",
        hair: "rgba(255,255,255,0.4)",
        statsCard: "rgba(255,255,255,0.55)",
        statsCardShadow: "0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.15)",
        statsCardBorder: "0.5px solid rgba(255,255,255,0.4)",
        accentInk: "#e8e8ec",
        accentBg: "linear-gradient(160deg, #3a3a42, #2a2a30)",
        accentShadow: "0 10px 24px -8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)",
        avatarBg: "radial-gradient(circle at 30% 25%, #ffffff, #e4e4e8 80%)",
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
        ? "linear-gradient(180deg, #2a2a30 0%, #1c1c20 100%)"
        : "linear-gradient(180deg, #f5f5f8 0%, #e8e8ec 100%)",
      padding: "12px 10px",
      display: "flex", flexDirection: "column", gap: 4,
      overflow: "hidden",
    }}>
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(0deg, rgba(26,26,31,0.04) 0 1px, transparent 1px 3px)", pointerEvents: "none" }} />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ height: 3, background: "rgba(26,26,31,0.18)", borderRadius: 1, width: i === 0 ? "50%" : i === 5 ? "30%" : `${68 + (i * 9) % 24}%`, marginTop: i === 1 ? 3 : 0, flexShrink: 0 }} />
      ))}
      <div style={{ position: "absolute", top: 6, right: 6, background: "#2a2a30", color: "#e8e8ec", fontSize: 7.5, fontWeight: 700, letterSpacing: "0.04em", padding: "2px 5px", borderRadius: 3 }}>
        PDF
      </div>
    </div>
  );
}

// ─── PDF thumbnail card ───────────────────────────────────────────────────────

function PdfThumbnailCard({
  att, msgId, token, dark, dateStr, variant = "card",
}: {
  att: GmailAttachment & { msgId: string };
  msgId: string;
  token: string;
  dark: boolean;
  dateStr: string;
  variant?: "card" | "row" | "large";
}) {
  const theme = getTheme(dark);
  const cached = profileThumbCache.get(att.id) ?? null;
  const [thumb, setThumb] = useState<string | null>(cached);
  const [pageCount, setPageCount] = useState<number | null>(profilePageCountCache.get(att.id) ?? null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(!!cached);
  const [opening, setOpening] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cached) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } },
      { threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cached]);

  useEffect(() => {
    if (!visible || thumb) return;
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
        const { thumb: url, pageCount: count } = await generatePdfThumbnail(b64);
        if (!cancelled && url) {
          profileThumbCache.set(att.id, url);
          profilePageCountCache.set(att.id, count);
          setThumb(url);
          setPageCount(count);
        }
      } catch { } finally {
        releaseSlot();
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, att.id]);

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

  const thumbArea = (w: number | string, h: number) => (
    <div style={{
      position: "relative",
      width: w,
      height: h,
      borderRadius: 10,
      overflow: "hidden",
      flexShrink: 0,
      boxShadow: dark
        ? "0 6px 14px -8px rgba(0,0,0,0.5), inset 0 0.5px 0 rgba(255,255,255,0.04)"
        : "0 4px 10px -6px rgba(0,0,0,0.12), inset 0 0.5px 0 rgba(255,255,255,0.6)",
    }}>
      <PdfPaperSkeleton dark={dark} />
      {thumb && <img src={thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }} />}
      {loading && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 style={{ width: 14, height: 14, color: "rgba(26,26,31,0.35)" }} className="animate-spin" /></div>}
      {opening && <div style={{ position: "absolute", inset: 0, background: "rgba(26,26,31,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 style={{ width: 16, height: 16, color: "#1a1a1f" }} className="animate-spin" /></div>}
    </div>
  );

  if (variant === "large") {
    const cardBg = dark ? "rgba(232,232,236,0.06)" : "#ffffff";
    const nameColor = dark ? "#e8e8ec" : "#1a1a1f";
    const metaColor = dark ? "#a0a0a8" : "#6a6a72";
    return (
      <div ref={containerRef} onClick={handleTap} style={{ background: cardBg, borderRadius: 12, overflow: "hidden", cursor: "pointer" }}>
        <div style={{ position: "relative", width: "100%", height: 150, overflow: "hidden" }}>
          <PdfPaperSkeleton dark={dark} />
          {thumb && <img src={thumb} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" }} />}
          {loading && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 style={{ width: 18, height: 18, color: "rgba(26,26,31,0.35)" }} className="animate-spin" /></div>}
          {opening && <div style={{ position: "absolute", inset: 0, background: "rgba(26,26,31,0.18)", display: "flex", alignItems: "center", justifyContent: "center" }}><Loader2 style={{ width: 20, height: 20, color: "#1a1a1f" }} className="animate-spin" /></div>}
        </div>
        <div style={{ padding: "8px 12px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: nameColor, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</div>
          <div style={{ fontSize: 10, color: metaColor, marginTop: 2 }}>{pageCount !== null && pageCount > 0 ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'} · ` : ''}{fmtSize(att.size)}{dateStr ? ` · ${dateStr}` : ""}</div>
        </div>
      </div>
    );
  }

  if (variant === "row") {
    return (
      <div ref={containerRef} onClick={handleTap} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", cursor: "pointer", borderBottom: `0.5px solid ${theme.hair}` }}>
        {thumbArea(60, 80)}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink, letterSpacing: "-0.01em", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: theme.subtle }}>
            {pageCount !== null && pageCount > 0 && <span>{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>}
            {pageCount !== null && pageCount > 0 && <span style={{ width: 2.5, height: 2.5, borderRadius: "50%", background: theme.muted, flexShrink: 0, display: "inline-block" }} />}
            <span>{fmtSize(att.size)}</span>
            {dateStr && <><span style={{ width: 2.5, height: 2.5, borderRadius: "50%", background: theme.muted, flexShrink: 0, display: "inline-block" }} /><span>{dateStr}</span></>}
          </div>
        </div>
        <ChevronLeft style={{ width: 16, height: 16, color: theme.muted, transform: "rotate(180deg)", flexShrink: 0 }} />
      </div>
    );
  }

  // card variant
  return (
    <div ref={containerRef} onClick={handleTap} style={{ display: "flex", flexDirection: "column", cursor: "pointer", width: 130, flexShrink: 0 }}>
      {thumbArea("100%", 100)}
      {/* Metadata below */}
      <div style={{ paddingTop: 8, paddingLeft: 2, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: theme.ink, letterSpacing: "-0.01em", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {att.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: theme.subtle, letterSpacing: "-0.01em" }}>
          {pageCount !== null && pageCount > 0 && <span>{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>}
          {pageCount !== null && pageCount > 0 && <span style={{ width: 2.5, height: 2.5, borderRadius: "50%", background: theme.muted, flexShrink: 0, display: "inline-block" }} />}
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
  const [b64, setB64] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
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
        if (!cancelled && data.base64) {
          setB64(data.base64);
          setSrc(`data:${att.mimeType};base64,${data.base64}`);
        } else if (!cancelled) setError(true);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [att.id, msgId, token]);

  const handleTap = async () => {
    if (opening || !b64) return;
    setOpening(true);
    try {
      await openImageFromProfile(b64, att.name, att.mimeType);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div onClick={handleTap} style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: 10, overflow: "hidden", background: placeholder, cursor: "pointer" }}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(255,255,255,0.12), transparent 50%)", pointerEvents: "none", zIndex: 1 }} />
      {loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
          <Loader2 style={{ width: 18, height: 18, color: "rgba(26,26,31,0.3)" }} className="animate-spin" />
        </div>
      )}
      {opening && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 4 }}>
          <Loader2 style={{ width: 20, height: 20, color: "#ffffff" }} className="animate-spin" />
        </div>
      )}
      {error && !loading && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2 }}>
          <ImageOff style={{ width: 18, height: 18, color: "rgba(26,26,31,0.25)" }} />
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

type ContactAtt = { id: string; messageId: string; name: string; mimeType: string; size: number; date: string };

export default function ClientProfilePage({
  contact, messages, token, refreshToken, onBack, onOpenConversation,
}: ClientProfilePageProps) {
  const darkMode = isDarkMode();
  const theme = getTheme(darkMode);
  const orbBg = darkMode ? ORB_DARK : ORB_LIGHT;

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  const [allAtts, setAllAtts] = useState<ContactAtt[]>([]);
  const [attsLoading, setAttsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setAttsLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/gmail/contact-attachments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: token, contactEmail: contact.email, refreshToken: refreshToken ?? null }),
          credentials: "omit",
        });
        if (!res.ok) return;
        const data = await res.json() as { attachments: ContactAtt[] };
        if (!cancelled) setAllAtts(data.attachments ?? []);
      } catch { } finally {
        if (!cancelled) setAttsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contact.email, token]);

  const [showAllDocs, setShowAllDocs] = useState(false);
  const [docSearch, setDocSearch] = useState("");

  const pdfs = allAtts.filter(a => a.mimeType.includes("pdf") || a.name.toLowerCase().endsWith(".pdf"));
  const images = allAtts.filter(a => a.mimeType.startsWith("image/"));

  const stats = [
    { label: "Messages", value: messages.length },
    { label: "PDFs",     value: attsLoading ? "…" : pdfs.length },
    { label: "Photos",   value: attsLoading ? "…" : images.length },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: "transparent", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap');`}</style>

      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative", zIndex: 1 }}>

        {/* Header */}
        <div style={{ background: theme.headerBg, backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", color: theme.headerInk, paddingTop: "max(3rem, env(safe-area-inset-top))", paddingBottom: 26, paddingLeft: 20, paddingRight: 20, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative", zIndex: 1 }}>
            <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 10, background: "transparent", border: "none", padding: 0, color: theme.headerInk, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: -6 }}>
              <ChevronLeft style={{ width: 22, height: 22 }} />
            </button>
            <div style={{ fontSize: 10, letterSpacing: "0.26em", textTransform: "uppercase", color: theme.headerFaint, fontWeight: 600 }}>Contact</div>
            <div style={{ width: 36 }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 20, gap: 14, position: "relative", zIndex: 1 }}>
            <div style={{ width: 88, height: 88, borderRadius: "50%", background: theme.avatarBg, display: "flex", alignItems: "center", justifyContent: "center", color: theme.headerInk, fontSize: 37, fontWeight: 500, fontFamily: '"Cormorant Garamond", Georgia, serif', letterSpacing: "0.01em", boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.15), 0 8px 24px -8px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.4)", border: `1px solid ${theme.hair}`, flexShrink: 0 }}>
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
                <div style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontSize: 30, fontWeight: 500, color: (typeof s.value === "number" ? s.value > 0 : true) ? theme.ink : theme.muted, lineHeight: 1, letterSpacing: "-0.02em" }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 11, fontWeight: 500, color: theme.subtle, letterSpacing: "0.02em" }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Documents — horizontal scroll row */}
        {attsLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: "28px 20px" }}>
            <Loader2 style={{ width: 22, height: 22, color: theme.muted }} className="animate-spin" />
          </div>
        ) : pdfs.length > 0 ? (
          <>
            <div style={{ padding: "28px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: theme.subtle, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                <Paperclip style={{ width: 13, height: 13, strokeWidth: 1.8 }} />
                Documents
              </div>
              <button onClick={() => setShowAllDocs(true)} style={{ background: "transparent", border: "none", padding: 0, color: theme.ink, fontSize: 14, fontWeight: 500, fontFamily: "inherit", cursor: "pointer", letterSpacing: "-0.01em" }}>
                See All
              </button>
            </div>
            <div style={{ paddingLeft: 20, paddingRight: 20, overflowX: "auto", display: "flex", flexDirection: "row", gap: 12, paddingBottom: 4 }}>
              {pdfs.slice(0, 10).map((att, i) => (
                <PdfThumbnailCard
                  key={`${att.id}-${i}`}
                  att={{ id: att.id, name: att.name, mimeType: att.mimeType, size: att.size, msgId: att.messageId }}
                  msgId={att.messageId}
                  token={token}
                  dark={theme.frameDark}
                  dateStr={fmtDate(att.date)}
                  variant="card"
                />
              ))}
            </div>
          </>
        ) : null}

        {/* Photos */}
        {!attsLoading && images.length > 0 && (
          <>
            <div style={{ padding: "28px 20px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: theme.subtle, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                <Image style={{ width: 13, height: 13, strokeWidth: 1.8 }} />
                Photos
              </div>
            </div>
            <div style={{ padding: "0 20px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
              {images.map((att, i) => (
                <ImageCard
                  key={`${att.id}-${i}`}
                  att={{ id: att.id, name: att.name, mimeType: att.mimeType, size: att.size, msgId: att.messageId }}
                  msgId={att.messageId}
                  token={token}
                  placeholder={theme.toneGradients[i % 4]}
                />
              ))}
            </div>
          </>
        )}

        {/* Empty state */}
        {!attsLoading && pdfs.length === 0 && images.length === 0 && (
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

      {/* See All Documents — full screen overlay */}
      {showAllDocs && (() => {
        const q = docSearch.trim().toLowerCase();
        const filtered = q
          ? pdfs.filter(a => a.name.toLowerCase().includes(q) || fmtDate(a.date).toLowerCase().includes(q))
          : pdfs;
        const searchBg = theme.frameDark ? "rgba(232,232,236,0.08)" : "rgba(26,26,31,0.06)";
        return (
          <div style={{ position: "absolute", inset: 0, zIndex: 10, background: darkMode ? "rgba(5,5,7,0.97)" : "rgba(232,236,242,0.97)", backdropFilter: "blur(30px)", WebkitBackdropFilter: "blur(30px)", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <div style={{ background: theme.headerBg, backdropFilter: "blur(30px) saturate(160%)", WebkitBackdropFilter: "blur(30px) saturate(160%)", paddingTop: "max(3rem, env(safe-area-inset-top))", paddingBottom: 10, paddingLeft: 20, paddingRight: 20, flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <button onClick={() => { setShowAllDocs(false); setDocSearch(""); }} style={{ width: 36, height: 36, borderRadius: 10, background: "transparent", border: "none", padding: 0, color: theme.headerInk, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", marginLeft: -6 }}>
                  <ChevronLeft style={{ width: 22, height: 22 }} />
                </button>
                <div style={{ fontSize: 15, fontWeight: 600, color: theme.headerInk, letterSpacing: "-0.01em" }}>All Documents</div>
                <div style={{ width: 36 }} />
              </div>
              {/* Search bar */}
              <div style={{ marginTop: 10 }}>
                <input
                  type="text"
                  placeholder="Search by name or date..."
                  value={docSearch}
                  onChange={e => setDocSearch(e.target.value)}
                  style={{ width: "100%", height: 36, borderRadius: 10, border: "none", outline: "none", background: searchBg, color: theme.headerInk, padding: "0 12px", fontSize: 14, boxSizing: "border-box" as const, fontFamily: "inherit" }}
                />
              </div>
            </div>
            {/* Large card list */}
            <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 0" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {filtered.length === 0 ? (
                  <p style={{ color: theme.muted, fontSize: 14, textAlign: "center", paddingTop: 32 }}>No documents found</p>
                ) : filtered.map((att, i) => (
                  <PdfThumbnailCard
                    key={`all-${att.id}-${i}`}
                    att={{ id: att.id, name: att.name, mimeType: att.mimeType, size: att.size, msgId: att.messageId }}
                    msgId={att.messageId}
                    token={token}
                    dark={theme.frameDark}
                    dateStr={fmtDate(att.date)}
                    variant="large"
                  />
                ))}
              </div>
              <div style={{ height: 40 }} />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
