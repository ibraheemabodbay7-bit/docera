import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Search, Mail, MessageSquare, Paperclip, Pencil, RefreshCw, AlertCircle, ChevronDown } from "lucide-react";
import { useState, useMemo, useCallback, useEffect } from "react";
import type { ConversationWithContact } from "@shared/schema";

interface EmailThread {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  snippet: string;
  date: string;
  hasAttachment: boolean;
  unread: boolean;
  messageCount: number;
}

interface SenderConversation {
  from: string;
  fromName: string;
  latestSnippet: string;
  latestDate: string;
  unreadCount: number;
  totalMessages: number;
  hasAttachment: boolean;
  lastSubject: string;
}

interface InboxViewProps {
  onSelectConversation: (id: string) => void;
  onSelectSender: (sender: { from: string; fromName: string; subject: string }) => void;
  onCompose: () => void;
}

type Tab = "chats" | "email";

function groupBySender(threads: EmailThread[]): SenderConversation[] {
  const map = new Map<string, SenderConversation>();
  const sorted = [...threads].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  for (const t of sorted) {
    const key = t.from.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        from: t.from,
        fromName: t.fromName || t.from,
        latestSnippet: t.snippet,
        latestDate: t.date,
        unreadCount: t.unread ? 1 : 0,
        totalMessages: t.messageCount,
        hasAttachment: t.hasAttachment,
        lastSubject: t.subject,
      });
    } else {
      const existing = map.get(key)!;
      if (new Date(t.date) > new Date(existing.latestDate)) {
        existing.latestDate = t.date;
        existing.latestSnippet = t.snippet;
        existing.lastSubject = t.subject;
      }
      existing.unreadCount += t.unread ? 1 : 0;
      existing.totalMessages += t.messageCount;
      existing.hasAttachment = existing.hasAttachment || t.hasAttachment;
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime()
  );
}

export default function InboxView({ onSelectConversation, onSelectSender, onCompose }: InboxViewProps) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("email");
  const [allThreads, setAllThreads] = useState<EmailThread[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);

  const { data: conversations = [], isLoading: chatsLoading } = useQuery<ConversationWithContact[]>({
    queryKey: ["/api/conversations"],
  });

  const { data: emailData, isLoading: emailLoading, error: emailError, refetch: refetchEmail } = useQuery<{
    threads: EmailThread[];
    nextPageToken?: string;
    configured: boolean;
  }>({
    queryKey: ["/api/email/inbox"],
    enabled: tab === "email",
    retry: false,
  });

  useEffect(() => {
    if (emailData?.threads) {
      setAllThreads(emailData.threads);
      setNextPageToken(emailData.nextPageToken);
    }
  }, [emailData]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/email/inbox?pageToken=${encodeURIComponent(nextPageToken)}`, {
        credentials: "include",
      });
      const data = await res.json();
      setAllThreads(prev => [...prev, ...(data.threads ?? [])]);
      setNextPageToken(data.nextPageToken);
    } catch (e) {
      console.error("Load more failed:", e);
    } finally {
      setLoadingMore(false);
    }
  }, [nextPageToken, loadingMore]);

  const senderConversations = useMemo(() => groupBySender(allThreads), [allThreads]);

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
  const emailUnread = senderConversations.reduce((sum, s) => sum + s.unreadCount, 0);

  const filteredChats = conversations.filter(c =>
    c.contact.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.lastMessage ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const filteredSenders = senderConversations.filter(s =>
    s.fromName.toLowerCase().includes(search.toLowerCase()) ||
    s.from.toLowerCase().includes(search.toLowerCase()) ||
    s.latestSnippet.toLowerCase().includes(search.toLowerCase()) ||
    s.lastSubject.toLowerCase().includes(search.toLowerCase())
  );

  const handleRefresh = () => {
    setAllThreads([]);
    setNextPageToken(undefined);
    refetchEmail();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-shrink-0 px-4 pt-12 pb-3 bg-background">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Inbox</h1>
          <div className="flex items-center gap-2">
            {tab === "email" && (
              <button
                data-testid="button-refresh-email"
                onClick={handleRefresh}
                className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate"
              >
                <RefreshCw className={`w-4 h-4 ${emailLoading ? "animate-spin" : ""}`} />
              </button>
            )}
            {tab === "email" && (
              <button
                data-testid="button-compose-email"
                onClick={onCompose}
                className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center"
              >
                <Pencil className="w-4 h-4 text-primary-foreground" />
              </button>
            )}
          </div>
        </div>

        <div className="flex bg-muted rounded-xl p-0.5 mb-3">
          <button
            data-testid="tab-email"
            onClick={() => setTab("email")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
              tab === "email" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            Email
            {emailUnread > 0 && (
              <span className="min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
                {emailUnread}
              </span>
            )}
          </button>
          <button
            data-testid="tab-chats"
            onClick={() => setTab("chats")}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all ${
              tab === "chats" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Chats
            {totalUnread > 0 && (
              <span className="min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
                {totalUnread}
              </span>
            )}
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            data-testid="input-search"
            type="search"
            placeholder={tab === "chats" ? "Search conversations..." : "Search by sender or subject..."}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-4 rounded-xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {tab === "chats" ? (
          chatsLoading ? (
            <SkeletonList />
          ) : filteredChats.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="w-12 h-12 text-muted-foreground/40 mb-3" />}
              title="No conversations"
              subtitle="Scan a document to start chatting"
            />
          ) : (
            <div className="flex flex-col gap-1.5 mt-1">
              {filteredChats.map(conv => (
                <ConversationRow key={conv.id} conv={conv} onClick={() => onSelectConversation(conv.id)} />
              ))}
            </div>
          )
        ) : emailLoading && allThreads.length === 0 ? (
          <SkeletonList />
        ) : emailError ? (
          <EmailError />
        ) : !emailData?.configured && allThreads.length === 0 ? (
          <EmailNotConfigured />
        ) : filteredSenders.length === 0 ? (
          <EmptyState
            icon={<Mail className="w-12 h-12 text-muted-foreground/40 mb-3" />}
            title="No emails"
            subtitle={search ? "No senders match your search" : "Your inbox is empty"}
          />
        ) : (
          <div className="flex flex-col gap-1 mt-1">
            {filteredSenders.map(sender => (
              <SenderRow
                key={sender.from}
                sender={sender}
                onClick={() => onSelectSender({ from: sender.from, fromName: sender.fromName, subject: sender.lastSubject })}
              />
            ))}
            {nextPageToken && (
              <button
                data-testid="button-load-more"
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full mt-2 py-3 rounded-2xl bg-muted text-sm font-medium text-muted-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loadingMore ? (
                  <div className="w-4 h-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" />
                    Load more emails
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SenderRow({ sender, onClick }: { sender: SenderConversation; onClick: () => void }) {
  const timeAgo = sender.latestDate
    ? formatDistanceToNow(new Date(sender.latestDate), { addSuffix: true })
    : "";
  const initials = sender.fromName
    .split(" ").map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  const hasUnread = sender.unreadCount > 0;

  return (
    <button
      data-testid={`sender-row-${sender.from}`}
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-2xl bg-card hover-elevate text-left"
    >
      <div className="relative flex-shrink-0">
        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${hasUnread ? "bg-primary/15" : "bg-muted"}`}>
          <span className={`font-semibold text-sm ${hasUnread ? "text-primary" : "text-muted-foreground"}`}>
            {initials}
          </span>
        </div>
        {hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center px-1">
            {sender.unreadCount}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-sm truncate ${hasUnread ? "font-bold text-foreground" : "font-medium text-foreground"}`}>
            {sender.fromName}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {sender.hasAttachment && <Paperclip className="w-3 h-3 text-muted-foreground" />}
            <span className="text-[11px] text-muted-foreground">{timeAgo}</span>
          </div>
        </div>
        <p className={`text-xs truncate mt-0.5 ${hasUnread ? "text-foreground font-medium" : "text-muted-foreground"}`}>
          {sender.lastSubject}
        </p>
        <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">{sender.latestSnippet}</p>
      </div>
    </button>
  );
}

function ConversationRow({ conv, onClick }: { conv: ConversationWithContact; onClick: () => void }) {
  const timeAgo = conv.lastMessageAt
    ? formatDistanceToNow(new Date(conv.lastMessageAt), { addSuffix: true })
    : "";
  const statusColor: Record<string, string> = {
    online: "bg-status-online", away: "bg-status-away",
    busy: "bg-status-busy", offline: "bg-status-offline",
  };
  return (
    <button
      data-testid={`conversation-row-${conv.id}`}
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-2xl bg-card hover-elevate text-left"
    >
      <div className="relative flex-shrink-0">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
          <span className="text-primary font-semibold text-sm">{conv.contact.initials}</span>
        </div>
        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-card ${statusColor[conv.contact.status] ?? "bg-status-offline"}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-foreground text-sm truncate">{conv.contact.name}</span>
          <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground truncate">{conv.lastMessage ?? ""}</span>
          {(conv.unreadCount ?? 0) > 0 && (
            <span className="flex-shrink-0 min-w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1.5">
              {conv.unreadCount}
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">{conv.contact.role}</p>
      </div>
    </button>
  );
}

function SkeletonList() {
  return (
    <div className="flex flex-col gap-2 mt-1">
      {[1, 2, 3, 4, 5].map(i => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-card animate-pulse">
          <div className="w-12 h-12 rounded-2xl bg-muted flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted rounded w-32" />
            <div className="h-3 bg-muted rounded w-48" />
            <div className="h-3 bg-muted rounded w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-center">
      {icon}
      <p className="text-muted-foreground font-medium">{title}</p>
      <p className="text-muted-foreground/60 text-sm mt-1">{subtitle}</p>
    </div>
  );
}

function EmailNotConfigured() {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-center px-8">
      <Mail className="w-12 h-12 text-muted-foreground/40 mb-3" />
      <p className="text-muted-foreground font-medium">Inbox not connected</p>
      <p className="text-muted-foreground/60 text-sm mt-1 leading-relaxed">
        Sign in with Google or Microsoft to see your emails here.
      </p>
    </div>
  );
}

function EmailError() {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-center px-8">
      <AlertCircle className="w-12 h-12 text-destructive/50 mb-3" />
      <p className="text-foreground font-medium">Couldn't load inbox</p>
      <p className="text-muted-foreground/60 text-sm mt-1 leading-relaxed">
        Check your email settings and try refreshing.
      </p>
    </div>
  );
}
