import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ArrowLeft, Download, FileText, Send, ChevronDown, Layers } from "lucide-react";
import { format, isValid } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useState, useRef, useEffect } from "react";

interface EmailMessage {
  id: string;
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{ id: string; name: string; mimeType: string; size: number }>;
}

interface EmailThreadViewProps {
  threadId?: string;
  senderEmail?: string;
  subject: string;
  fromName: string;
  from: string;
  userEmail: string;
  onBack: () => void;
  onReply: (context: { to: string; subject: string; body: string }) => void;
  onOpenScanner: (imageUrl?: string) => void;
}

function formatSize(bytes: number) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function wrapEmailHtml(html: string, darkMode: boolean): string {
  const baseStyle = `
    body {
      margin: 0;
      padding: 12px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${darkMode ? "#e5e7eb" : "#111827"};
      background: transparent;
      word-break: break-word;
      overflow-x: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: #6366f1; }
    pre, code { white-space: pre-wrap; word-break: break-all; }
    table { max-width: 100%; }
  `;

  if (/<html/i.test(html)) {
    return html.replace(/<head>/i, `<head><base target="_blank"><style>${baseStyle}</style>`);
  }
  return `<html><head><base target="_blank"><style>${baseStyle}</style></head><body>${html}</body></html>`;
}

function EmailCard({
  msg,
  showSubject,
  defaultExpanded,
  onSaveFile,
  onViewAttachment,
}: {
  msg: EmailMessage;
  showSubject: boolean;
  defaultExpanded: boolean;
  onSaveFile: (att: EmailMessage["attachments"][0]) => void;
  onViewAttachment: (messageId: string, att: EmailMessage["attachments"][0]) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(200);

  const initials = (msg.fromName || msg.from)
    .split(/\s+/).map((w: string) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  const dateShort = msg.date
    ? (() => { try { const d = new Date(msg.date); return isValid(d) ? format(d, "MMM d · h:mm a") : ""; } catch { return ""; } })()
    : "";
  const snippet = (msg.textBody || stripHtml(msg.htmlBody)).replace(/\s+/g, " ").trim().slice(0, 180);

  const darkMode = document.documentElement.classList.contains("dark");

  const handleIframeLoad = () => {
    try {
      const iframe = iframeRef.current;
      if (iframe?.contentDocument?.body) {
        const h = iframe.contentDocument.body.scrollHeight;
        if (h > 0) setIframeHeight(Math.min(h + 8, 1200));
      }
    } catch {}
  };

  return (
    <div
      data-testid={`email-card-${msg.id}`}
      className="w-full bg-card rounded-2xl border border-border overflow-hidden"
    >
      <button
        className="w-full text-left p-4 flex items-start gap-3"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <span className="text-primary font-semibold text-xs">{initials}</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
              {msg.fromName || msg.from}
            </span>
            <span className="text-xs text-muted-foreground flex-shrink-0">{dateShort}</span>
          </div>
          <p className="text-[11px] text-muted-foreground truncate">{msg.from}</p>
          {showSubject && msg.subject && (
            <p className="text-xs font-medium text-foreground/80 mt-0.5 truncate">
              {msg.subject}
            </p>
          )}
          {!expanded && (
            <p className="text-sm text-foreground/60 mt-1 line-clamp-2 leading-relaxed">
              {snippet || "(no content)"}
            </p>
          )}
        </div>

        <ChevronDown
          className={`w-4 h-4 text-muted-foreground flex-shrink-0 mt-1 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-border">
          {msg.htmlBody ? (
            <iframe
              ref={iframeRef}
              srcDoc={wrapEmailHtml(msg.htmlBody, darkMode)}
              sandbox="allow-same-origin"
              onLoad={handleIframeLoad}
              title={`email-body-${msg.id}`}
              data-testid={`email-iframe-${msg.id}`}
              className="w-full border-0 block"
              style={{ height: `${iframeHeight}px`, minHeight: "100px" }}
            />
          ) : (
            <div className="px-4 py-3">
              <pre className="text-sm text-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {msg.textBody || "(no content)"}
              </pre>
            </div>
          )}

          {msg.attachments?.length > 0 && (
            <div className="border-t border-border p-3 flex flex-col gap-1.5">
              {msg.attachments.map(att => (
                <button
                  key={att.id}
                  data-testid={`attachment-${att.id}`}
                  onClick={e => { e.stopPropagation(); onViewAttachment(msg.id, att); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 text-left w-full"
                >
                  <div className="w-8 h-8 rounded-lg bg-red-500 flex items-center justify-center flex-shrink-0">
                    <span className="text-white text-[8px] font-bold">PDF</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate text-foreground">{att.name}</p>
                    <p className="text-[10px] text-muted-foreground">{formatSize(att.size)}</p>
                  </div>
                  <Download
                    className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0"
                    onClick={e => { e.stopPropagation(); onSaveFile(att); }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PdfModal({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-3 px-4 pt-12 pb-3 border-b border-border bg-background">
        <button
          data-testid="button-close-pdf"
          onClick={onClose}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <p className="flex-1 text-sm font-semibold text-foreground truncate">{name}</p>
        <a
          href={url}
          download={name}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground"
        >
          <Download className="w-5 h-5" />
        </a>
      </div>
      <div className="flex-1 overflow-hidden">
        <iframe
          src={url}
          title={name}
          className="w-full h-full border-0"
        />
      </div>
    </div>
  );
}

export default function EmailThreadView({
  threadId,
  senderEmail,
  subject,
  fromName,
  from,
  userEmail,
  onBack,
  onReply,
  onOpenScanner,
}: EmailThreadViewProps) {
  const { toast } = useToast();
  const [replyText, setReplyText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isSenderMode = !!senderEmail;
  const [pdfModal, setPdfModal] = useState<{ url: string; name: string } | null>(null);
  const [loadingAttId, setLoadingAttId] = useState<string | null>(null);

  const handleViewAttachment = async (messageId: string, att: EmailMessage["attachments"][0]) => {
    setLoadingAttId(att.id);
    try {
      const res = await fetch(`/api/email/attachment/${messageId}/${att.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch attachment");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      setPdfModal({ url: blobUrl, name: att.name });
    } catch {
      toast({ title: "Could not open attachment", variant: "destructive" });
    } finally {
      setLoadingAttId(null);
    }
  };

  const closePdfModal = () => {
    if (pdfModal) {
      URL.revokeObjectURL(pdfModal.url);
      setPdfModal(null);
    }
  };

  const { data: messages = [], isLoading, error } = useQuery<EmailMessage[]>({
    queryKey: isSenderMode
      ? ["/api/email/sender-messages", senderEmail]
      : ["/api/email/thread", threadId],
    queryFn: async () => {
      if (isSenderMode) {
        const res = await fetch(`/api/email/sender-messages?from=${encodeURIComponent(senderEmail!)}`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error("Failed to load sender messages");
        return res.json();
      }
      const res = await fetch(`/api/email/thread/${threadId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load thread");
      return res.json();
    },
    enabled: isSenderMode ? !!senderEmail : !!threadId,
  });

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, [messages]);

  const saveFileMutation = useMutation({
    mutationFn: async (att: { id: string; name: string; mimeType: string }) => {
      const res = await apiRequest("POST", "/api/files", {
        name: att.name,
        type: att.mimeType.includes("pdf") ? "pdf" : "file",
        size: 0,
        dataUrl: `data:${att.mimeType};base64,`,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
      toast({ title: "Saved to Files" });
    },
  });

  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const res = await apiRequest("POST", "/api/email/send", {
        to: from,
        subject: replySubject,
        body: text,
      });
      return res.json();
    },
    onSuccess: () => {
      setReplyText("");
      if (isSenderMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/email/sender-messages", senderEmail] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/email/thread", threadId] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/email/inbox"] });
      toast({ title: "Sent" });
    },
    onError: () => toast({ title: "Failed to send", variant: "destructive" }),
  });

  const handleSend = () => {
    const text = replyText.trim();
    if (!text || sendMutation.isPending) return;
    sendMutation.mutate(text);
  };

  const initials = fromName?.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase() || "?";

  return (
    <div className="relative flex flex-col h-full bg-background">
      {pdfModal && (
        <PdfModal url={pdfModal.url} name={pdfModal.name} onClose={closePdfModal} />
      )}

      <div className="flex-shrink-0 flex items-center gap-3 px-4 pt-12 pb-3 bg-background border-b border-border">
        <button
          data-testid="button-back-email"
          onClick={onBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground hover-elevate"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <span className="text-primary font-semibold text-xs">{initials}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-foreground text-sm truncate">{fromName || from}</p>
          <p className="text-xs text-muted-foreground truncate">{from}</p>
        </div>
        {isSenderMode && messages.length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0 bg-muted px-2 py-1 rounded-lg">
            <Layers className="w-3 h-3 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground font-medium">{messages.length}</span>
          </div>
        )}
      </div>

      {!isSenderMode && subject && (
        <div className="flex-shrink-0 px-4 py-2 bg-muted/40 border-b border-border">
          <p className="text-xs font-medium text-muted-foreground truncate">{subject}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <p className="text-sm text-muted-foreground">Loading emails…</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <p className="text-muted-foreground">Couldn't load this conversation</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <p className="text-muted-foreground">No messages found</p>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <EmailCard
              key={msg.id}
              msg={msg}
              showSubject={isSenderMode}
              defaultExpanded={isSenderMode ? idx === messages.length - 1 : true}
              onSaveFile={att => saveFileMutation.mutate(att)}
              onViewAttachment={handleViewAttachment}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex-shrink-0 px-4 pb-6 pt-2 bg-background border-t border-border">
        <div className="flex items-end gap-2">
          <textarea
            data-testid="input-reply"
            placeholder={`Reply to ${fromName || from}…`}
            value={replyText}
            onChange={e => setReplyText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            className="flex-1 resize-none rounded-2xl bg-muted px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30 max-h-32 overflow-y-auto"
            style={{ minHeight: "44px" }}
          />
          <button
            data-testid="button-send-reply"
            onClick={handleSend}
            disabled={!replyText.trim() || sendMutation.isPending}
            className="w-11 h-11 rounded-2xl bg-primary flex items-center justify-center flex-shrink-0 disabled:opacity-40 transition-opacity"
          >
            {sendMutation.isPending ? (
              <div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
            ) : (
              <Send className="w-4 h-4 text-primary-foreground" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
