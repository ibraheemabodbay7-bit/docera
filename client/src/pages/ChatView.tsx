import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Send, Download, Eye, X } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import type { ConversationWithContact, MessageWithFile } from "@shared/schema";

interface ChatViewProps {
  conversationId: string;
  onBack: () => void;
}

export default function ChatView({ conversationId, onBack }: ChatViewProps) {
  const [text, setText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: conv } = useQuery<ConversationWithContact>({
    queryKey: ["/api/conversations", conversationId],
    queryFn: async () => {
      const res = await fetch(`/api/conversations/${conversationId}`);
      if (!res.ok) throw new Error("Failed to load conversation");
      return res.json();
    },
  });

  const { data: messages = [], isLoading } = useQuery<MessageWithFile[]>({
    queryKey: ["/api/conversations", conversationId, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) throw new Error("Failed to load messages");
      return res.json();
    },
  });

  useEffect(() => {
    fetch(`/api/conversations/${conversationId}/read`, { method: "POST" });
    queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", `/api/conversations/${conversationId}/messages`, {
        content,
        type: "text",
        fromMe: true,
        conversationId,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", conversationId, "messages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
    },
  });

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMutation.mutate(trimmed);
    setText("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const statusColor: Record<string, string> = {
    online: "bg-status-online",
    away: "bg-status-away",
    busy: "bg-status-busy",
    offline: "bg-status-offline",
  };

  const statusLabel: Record<string, string> = {
    online: "Online",
    away: "Away",
    busy: "Busy",
    offline: "Offline",
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-shrink-0 flex items-center gap-3 px-4 pt-12 pb-3 bg-background border-b border-border">
        <button
          data-testid="button-back"
          onClick={onBack}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground hover-elevate"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {conv && (
          <div className="flex items-center gap-3 flex-1">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-primary font-semibold text-xs">{conv.contact.initials}</span>
              </div>
              <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-background ${statusColor[conv.contact.status] ?? "bg-status-offline"}`} />
            </div>
            <div>
              <p className="font-semibold text-foreground text-sm leading-tight">{conv.contact.name}</p>
              <p className="text-[11px] text-muted-foreground">{statusLabel[conv.contact.status] ?? "Offline"} · {conv.contact.role}</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className={`flex ${i % 2 === 0 ? "justify-end" : "justify-start"}`}>
                <div className={`h-12 rounded-2xl bg-muted animate-pulse ${i % 2 === 0 ? "w-40" : "w-52"}`} />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((msg, idx) => {
              const prevMsg = messages[idx - 1];
              const showDate = !prevMsg ||
                new Date(msg.sentAt!).toDateString() !== new Date(prevMsg.sentAt!).toDateString();

              return (
                <div key={msg.id}>
                  {showDate && (
                    <div className="flex justify-center my-3">
                      <span className="text-[11px] text-muted-foreground bg-muted px-3 py-1 rounded-full">
                        {format(new Date(msg.sentAt!), "MMM d, yyyy")}
                      </span>
                    </div>
                  )}
                  <MessageBubble msg={msg} conversationId={conversationId} />
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-3 pt-2 bg-background border-t border-border">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            data-testid="input-message"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message…"
            rows={1}
            className="flex-1 resize-none rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground px-4 py-2.5 border-0 outline-none focus:ring-2 focus:ring-primary/30 max-h-28"
            style={{ lineHeight: "1.5" }}
          />
          <button
            data-testid="button-send"
            onClick={handleSend}
            disabled={!text.trim() || sendMutation.isPending}
            className="w-10 h-10 rounded-2xl bg-primary flex items-center justify-center flex-shrink-0 disabled:opacity-40 transition-opacity duration-150 active:scale-95"
          >
            <Send className="w-4 h-4 text-primary-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}


function MessageBubble({ msg, conversationId }: { msg: MessageWithFile; conversationId: string }) {
  const isMe = msg.fromMe;
  const timeStr = msg.sentAt ? formatDistanceToNow(new Date(msg.sentAt), { addSuffix: true }) : "";
  const [showPdf, setShowPdf] = useState(false);

  if (msg.type === "file") {
    const sizeStr = msg.fileSize
      ? msg.fileSize > 1024 * 1024
        ? `${(msg.fileSize / 1024 / 1024).toFixed(1)} MB`
        : `${Math.round(msg.fileSize / 1024)} KB`
      : "";

    const hasPdf = !!msg.file?.dataUrl;

    return (
      <>
        {showPdf && hasPdf && (
          <div className="fixed inset-0 z-50 flex flex-col bg-background">
            <div className="flex-shrink-0 flex items-center gap-3 px-4 pt-12 pb-3 border-b border-border">
              <button
                data-testid="button-close-pdf"
                onClick={() => setShowPdf(false)}
                className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
              <p className="flex-1 text-sm font-semibold text-foreground truncate">{msg.fileName ?? "Document"}</p>
              <a
                href={msg.file!.dataUrl!}
                download={msg.fileName ?? "document.pdf"}
                className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground"
              >
                <Download className="w-5 h-5" />
              </a>
            </div>
            <div className="flex-1 overflow-hidden bg-card">
              <iframe src={msg.file!.dataUrl!} title={msg.fileName ?? "Document"} className="w-full h-full border-0" />
            </div>
          </div>
        )}

        <div className="w-full px-1">
          <div
            data-testid={`file-message-${msg.id}`}
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted border border-border"
          >
            <div className="w-9 h-9 rounded-lg bg-red-500 flex items-center justify-center flex-shrink-0">
              <span className="text-white text-[9px] font-bold">PDF</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-foreground leading-tight">
                {msg.fileName ?? "Document"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{sizeStr || "PDF Document"}</p>
            </div>
            {hasPdf && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  data-testid={`button-view-pdf-${msg.id}`}
                  onClick={() => setShowPdf(true)}
                  className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center"
                >
                  <Eye className="w-4 h-4 text-primary-foreground" />
                </button>
                <a
                  href={msg.file!.dataUrl!}
                  download={msg.fileName ?? "document.pdf"}
                  data-testid={`button-download-pdf-${msg.id}`}
                  className="w-8 h-8 rounded-lg bg-background border border-border flex items-center justify-center"
                >
                  <Download className="w-4 h-4 text-foreground" />
                </a>
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1 px-1">{timeStr}</p>
        </div>
      </>
    );
  }

  return (
    <div className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[72%] px-4 py-2.5 rounded-2xl ${isMe ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-card border border-border text-foreground"}`}
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.content}</p>
        <p className={`text-[10px] mt-1 text-right ${isMe ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
          {timeStr}
        </p>
      </div>
    </div>
  );
}
