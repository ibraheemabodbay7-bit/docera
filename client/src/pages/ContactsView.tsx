import { useQuery } from "@tanstack/react-query";
import { Search, MessageCircle, Mail, UserCircle2 } from "lucide-react";
import { useState } from "react";
import type { Contact } from "@shared/schema";

interface ContactsViewProps {
  onOpenChat: (contactId: string) => void;
  onCompose: (to: string) => void;
}

export default function ContactsView({ onOpenChat, onCompose }: ContactsViewProps) {
  const [search, setSearch] = useState("");

  const { data: contacts = [], isLoading } = useQuery<Contact[]>({
    queryKey: ["/api/contacts"],
  });

  const { data: conversations = [] } = useQuery<any[]>({
    queryKey: ["/api/conversations"],
  });

  const convByContact: Record<string, string> = {};
  conversations.forEach((c: any) => { convByContact[c.contactId] = c.id; });

  const filtered = contacts
    .filter(c =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      (c.email ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (c.role ?? "").toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const grouped: Record<string, Contact[]> = {};
  filtered.forEach(c => {
    const letter = c.name[0].toUpperCase();
    if (!grouped[letter]) grouped[letter] = [];
    grouped[letter].push(c);
  });

  const statusColor: Record<string, string> = {
    online: "bg-status-online",
    away: "bg-status-away",
    busy: "bg-status-busy",
    offline: "bg-status-offline",
  };

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-shrink-0 px-4 pt-12 pb-4 bg-background">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Contacts</h1>
          <span className="text-xs text-muted-foreground">{contacts.length} people</span>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            data-testid="input-contacts-search"
            type="search"
            placeholder="Search contacts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-4 rounded-xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {isLoading ? (
          <div className="flex flex-col gap-1 px-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-3 p-3 animate-pulse">
                <div className="w-12 h-12 rounded-2xl bg-muted flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded w-32" />
                  <div className="h-3 bg-muted rounded w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center px-8">
            <UserCircle2 className="w-12 h-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No contacts found</p>
            <p className="text-muted-foreground/60 text-sm mt-1">Contacts appear when you start conversations</p>
          </div>
        ) : (
          Object.entries(grouped).sort().map(([letter, group]) => (
            <div key={letter}>
              <div className="px-4 py-2 sticky top-0 bg-background z-10">
                <span className="text-xs font-bold text-muted-foreground tracking-wider">{letter}</span>
              </div>
              <div className="flex flex-col gap-0.5 px-4">
                {group.map(contact => (
                  <div
                    key={contact.id}
                    data-testid={`contact-row-${contact.id}`}
                    className="flex items-center gap-3 p-3 rounded-2xl hover-elevate"
                  >
                    <div className="relative flex-shrink-0">
                      <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                        <span className="text-primary font-semibold text-sm">{contact.initials}</span>
                      </div>
                      <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${statusColor[contact.status ?? ""] ?? "bg-status-offline"}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground text-sm">{contact.name}</p>
                      <p className="text-xs text-muted-foreground">{contact.role}</p>
                      {contact.email && (
                        <p className="text-xs text-muted-foreground/60 truncate">{contact.email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {convByContact[contact.id] && (
                        <button
                          data-testid={`button-chat-${contact.id}`}
                          onClick={() => onOpenChat(convByContact[contact.id])}
                          className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate"
                          title="Open chat"
                        >
                          <MessageCircle className="w-4 h-4" />
                        </button>
                      )}
                      {contact.email && (
                        <button
                          data-testid={`button-email-${contact.id}`}
                          onClick={() => onCompose(contact.email!)}
                          className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate"
                          title="Send email"
                        >
                          <Mail className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
