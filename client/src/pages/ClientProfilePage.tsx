import { ArrowLeft } from "lucide-react";

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

interface ClientProfilePageProps {
  contact: Contact;
  messages: GmailMessage[];
  onBack: () => void;
  onOpenPdf: (att: GmailAttachment, msgId: string) => void;
  onOpenConversation: () => void;
}

export default function ClientProfilePage({
  contact, messages, onBack, onOpenPdf, onOpenConversation,
}: ClientProfilePageProps) {
  const allAttachments = messages.flatMap(m => m.attachments.map(att => ({ ...att, msgId: m.id })));
  const pdfs = allAttachments.filter(a => a.mimeType === "application/pdf" || a.name.toLowerCase().endsWith(".pdf"));
  const images = allAttachments.filter(a => a.mimeType.startsWith("image/"));

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column", background: "#f5f5f5" }}>
      {/* Dark blue header */}
      <div style={{
        background: "#1a3a5c",
        paddingTop: "max(3rem, env(safe-area-inset-top))",
        paddingBottom: 24,
        paddingLeft: 16,
        paddingRight: 16,
      }}>
        <button
          onClick={onBack}
          style={{ background: "none", border: "none", color: "white", cursor: "pointer", display: "flex", alignItems: "center", marginBottom: 16 }}
        >
          <ArrowLeft width={20} height={20} />
        </button>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 72, height: 72, borderRadius: "50%",
            background: "rgba(255,255,255,0.2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "white", fontSize: 26, fontWeight: 700,
          }}>
            {initials(contact.name)}
          </div>
          <p style={{ color: "white", fontSize: 20, fontWeight: 700, margin: 0 }}>{contact.name}</p>
          <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, margin: 0 }}>{contact.email}</p>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "center" }}>
          {[
            { label: "Messages", value: messages.length },
            { label: "PDFs", value: pdfs.length },
            { label: "Photos", value: images.length },
          ].map(stat => (
            <div
              key={stat.label}
              style={{
                background: "rgba(255,255,255,0.15)",
                borderRadius: 12,
                padding: "10px 0",
                textAlign: "center",
                flex: 1,
              }}
            >
              <p style={{ color: "white", fontSize: 20, fontWeight: 700, margin: 0 }}>{stat.value}</p>
              <p style={{ color: "rgba(255,255,255,0.65)", fontSize: 11, margin: 0 }}>{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px 40px" }}>
        {/* Documents section */}
        {pdfs.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: "#111" }}>📎 Documents</p>
            <div style={{ overflowX: "auto", display: "flex", gap: 12, paddingBottom: 4 }}>
              {pdfs.map((att, i) => (
                <button
                  key={`${att.id}-${i}`}
                  onClick={() => onOpenPdf(att, att.msgId)}
                  style={{
                    flexShrink: 0, width: 120,
                    background: "white", borderRadius: 12,
                    overflow: "hidden",
                    border: "1px solid rgba(0,0,0,0.08)",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <div style={{
                    width: "100%", height: 80,
                    background: "#fee2e2",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <div style={{ background: "#ef4444", borderRadius: 8, width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ color: "white", fontSize: 9, fontWeight: 700 }}>PDF</span>
                    </div>
                  </div>
                  <div style={{ padding: "8px 8px 10px" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#111", margin: 0 }}>{att.name}</p>
                    <p style={{ fontSize: 10, color: "#888", margin: "2px 0 0" }}>{fmtSize(att.size)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Photos section */}
        {images.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 12, color: "#111" }}>🖼 Photos</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              {images.map((att, i) => (
                <div
                  key={`${att.id}-${i}`}
                  style={{
                    aspectRatio: "1",
                    background: "#e5e5ea",
                    borderRadius: 8,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    overflow: "hidden",
                    fontSize: 20,
                  }}
                >
                  🖼
                </div>
              ))}
            </div>
          </div>
        )}

        {pdfs.length === 0 && images.length === 0 && (
          <p style={{ color: "#888", fontSize: 14, textAlign: "center", marginBottom: 28 }}>No attachments in this conversation</p>
        )}

        {/* Open conversation */}
        <button
          onClick={onOpenConversation}
          style={{
            width: "100%", padding: 14,
            background: "#1a3a5c", borderRadius: 14,
            color: "white", fontSize: 15, fontWeight: 700,
            border: "none", cursor: "pointer",
          }}
        >
          💬 Open Conversation
        </button>
      </div>
    </div>
  );
}
