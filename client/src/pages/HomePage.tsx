import { useState, useMemo, memo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { getSetting } from "@/lib/settings";
import { Capacitor } from "@capacitor/core";
import {
  Camera, FileText, FolderOpen, Plus, Search, MoreVertical, Trash2, Edit2, X,
  Check, User, Pencil, Copy, FolderInput, FolderMinus, Tag, Mail, Send, AlertCircle, Users, UserCheck, Star,
  Share2, Download, ChevronRight, SlidersHorizontal, Settings,
} from "lucide-react";
import { dataUrlToBlob, docFilename, docMime } from "@/lib/docUtils";
import { DaceraLogo } from "@/components/DaceraLogo";
import ClientEmailSuggest from "@/components/ClientEmailSuggest";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import type { DocumentSummary, Folder, DocStatus, Client } from "@shared/schema";

interface HomePageProps {
  user: { id: string; name: string; username: string };
  onScan: (folderId?: string) => void;
  onOpenDoc: (docId: string) => void;
  onEditDoc: (docId: string) => void;
  onOpenFolder: (folderId: string, folderName: string) => void;
  onProfile: () => void;
  onOpenClients: () => void;
  onOpenInbox: () => void;
  onLogout: () => void;
}

function sizeStr(size: number) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size > 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

const STATUS_META: Record<DocStatus, { label: string; dot: string }> = {
  draft:    { label: "Draft",    dot: "bg-gray-400" },
  pending:  { label: "Waiting for Reply", dot: "bg-amber-400" },
  sent:     { label: "Sent",     dot: "bg-blue-400" },
  approved: { label: "Approved", dot: "bg-green-400" },
  rejected: { label: "Rejected", dot: "bg-red-400" },
};

const ALL_STATUSES: DocStatus[] = ["draft", "pending", "sent", "approved", "rejected"];

const DocCard = memo(function DocCard({ doc, onOpen, onDelete, onRename, onEdit, onDuplicate, onMoveToFolder, onSetStatus, onSendEmail, onSetClient, onToggleFavorite, onShare, onDownload, folders, clients, clientName, variant = "grid" }: {
  doc: DocumentSummary;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onSetStatus: (status: DocStatus) => void;
  onSendEmail: (clientEmail?: string) => void;
  onSetClient: (clientId: string | null) => void;
  onToggleFavorite: () => void;
  onShare: () => void;
  onDownload: () => void;
  folders: Folder[];
  clients: Client[];
  clientName?: string;
  variant?: "grid" | "recent";
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showStatusPicker, setShowStatusPicker] = useState(false);
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [newName, setNewName] = useState(doc.name);

  const thumbHeight = variant === "recent" ? "h-36" : "h-32";
  const cardWidth = variant === "recent" ? "w-36 flex-shrink-0" : "";

  const docStatus = (doc.status as DocStatus | undefined) ?? "draft";
  const statusMeta = STATUS_META[docStatus] ?? STATUS_META.draft;

  const dateToShow = (() => {
    const created = doc.createdAt ? new Date(doc.createdAt).getTime() : 0;
    const updated = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
    const showUpdated = updated - created > 60_000;
    const ts = showUpdated ? updated : created;
    return ts ? format(new Date(ts), "MMM d") : "";
  })();

  return (
    <div data-testid={`doc-card-${doc.id}`} className={`relative bg-card rounded-2xl overflow-hidden shadow-sm border border-border ${cardWidth}`}>
      {/* Thumbnail — tap to open */}
      <button className="w-full text-left block" onClick={onOpen}>
        <div className={`${thumbHeight} bg-muted flex items-center justify-center overflow-hidden relative`}>
          {doc.thumbUrl ? (
            <img src={doc.thumbUrl} alt={doc.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-9 h-11 bg-primary rounded-lg flex items-center justify-center shadow-sm">
                <span className="text-primary-foreground text-[9px] font-bold tracking-wider">{doc.type === "pdf" ? "PDF" : doc.type.toUpperCase()}</span>
              </div>
            </div>
          )}
          <span className="absolute top-1.5 left-1.5 bg-black/50 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase">
            {doc.type}
          </span>
          {doc.isFavorite && (
            <span className="absolute bottom-1.5 right-1.5 pointer-events-none">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400 drop-shadow" />
            </span>
          )}
        </div>
      </button>
      {/* Footer — separate div so star button doesn't nest inside a button */}
      <div
        className="px-2.5 pt-2 pb-2 cursor-pointer bg-primary"
        onClick={onOpen}
      >
        <div className="flex items-start gap-1">
          <p className="text-[13px] font-semibold truncate leading-tight flex-1 text-primary-foreground">{doc.name}</p>
          <button
            data-testid={`button-favorite-${doc.id}`}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
            className="flex-shrink-0 p-0.5 rounded active:opacity-60"
            title={doc.isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Star className={`w-3.5 h-3.5 transition-colors ${doc.isFavorite ? "fill-amber-400 text-amber-400" : "fill-none text-white/30"}`} />
          </button>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusMeta.dot}`} />
          <span className="text-[10px] leading-tight text-primary-foreground/65">
            {statusMeta.label}{dateToShow ? ` · ${dateToShow}` : ""}
          </span>
        </div>
        {clientName && (
          <div className="flex items-center gap-1 mt-1.5">
            <User className="w-2.5 h-2.5 flex-shrink-0 text-primary-foreground/55" />
            <span className="text-[10px] truncate text-primary-foreground/55">{clientName}</span>
          </div>
        )}
      </div>

      <button
        data-testid={`doc-menu-${doc.id}`}
        onClick={(e) => { e.stopPropagation(); setMenu(true); setShowFolderPicker(false); setShowStatusPicker(false); setShowClientPicker(false); setRenaming(false); }}
        className="absolute top-1.5 right-1.5 w-8 h-8 bg-black/30 backdrop-blur-sm rounded-lg flex items-center justify-center"
      >
        <MoreVertical className="w-4 h-4 text-white" />
      </button>

      {menu && (
        <div className="absolute inset-0 bg-background/95 backdrop-blur-sm flex flex-col p-3 gap-1.5 z-10 overflow-y-auto">
          {renaming ? (
            <>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onRename(newName); setRenaming(false); setMenu(false); }
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="w-full px-3 py-2 rounded-xl bg-muted text-sm text-foreground border-0 outline-none mb-1"
              />
              <div className="flex gap-2">
                <button onClick={() => { onRename(newName); setRenaming(false); setMenu(false); }}
                  className="flex-1 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center gap-1">
                  <Check className="w-3 h-3" /> Save
                </button>
                <button onClick={() => setRenaming(false)}
                  className="flex-1 py-2 rounded-xl bg-muted text-foreground text-xs font-medium flex items-center justify-center gap-1">
                  <X className="w-3 h-3" /> Cancel
                </button>
              </div>
            </>
          ) : showFolderPicker ? (
            <>
              <p className="text-[11px] text-muted-foreground font-semibold px-1 mb-0.5">Move to…</p>
              {folders.map((f) => (
                <button key={f.id} onClick={() => { onMoveToFolder(f.id); setMenu(false); setShowFolderPicker(false); }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${doc.folderId === f.id ? "bg-primary/10 text-primary font-medium" : "bg-muted text-foreground"}`}>
                  <FolderOpen className="w-4 h-4 flex-shrink-0" /> {f.name}
                </button>
              ))}
              {doc.folderId && (
                <button onClick={() => { onMoveToFolder(null); setMenu(false); setShowFolderPicker(false); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted text-sm text-muted-foreground">
                  <FolderMinus className="w-4 h-4" /> Remove from folder
                </button>
              )}
              <button onClick={() => setShowFolderPicker(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted text-sm text-muted-foreground mt-1">
                <X className="w-4 h-4" /> Back
              </button>
            </>
          ) : showStatusPicker ? (
            <>
              <p className="text-[11px] text-muted-foreground font-semibold px-1 mb-0.5">Set status…</p>
              {ALL_STATUSES.map((s) => (
                <button key={s} onClick={() => { onSetStatus(s); setMenu(false); setShowStatusPicker(false); }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${docStatus === s ? "bg-primary/10 text-primary font-medium" : "bg-muted text-foreground"}`}>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_META[s].dot}`} />
                  {STATUS_META[s].label}
                  {docStatus === s && <Check className="w-3 h-3 ml-auto" />}
                </button>
              ))}
              <button onClick={() => setShowStatusPicker(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted text-sm text-muted-foreground mt-1">
                <X className="w-4 h-4" /> Back
              </button>
            </>
          ) : showClientPicker ? (
            <>
              <p className="text-[11px] text-muted-foreground font-semibold px-1 mb-0.5">Assign client…</p>
              {clients.length === 0 ? (
                <p className="text-xs text-muted-foreground px-2 py-2 italic">No clients yet</p>
              ) : (
                clients.map((c) => (
                  <button key={c.id} onClick={() => { onSetClient(c.id); setMenu(false); setShowClientPicker(false); }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm ${doc.clientId === c.id ? "bg-primary/10 text-primary font-medium" : "bg-muted text-foreground"}`}>
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold bg-primary text-primary-foreground flex-shrink-0">
                      {c.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
                    </div>
                    <span className="truncate flex-1">{c.name}</span>
                    {doc.clientId === c.id && <Check className="w-3 h-3 ml-auto flex-shrink-0" />}
                  </button>
                ))
              )}
              {doc.clientId && (
                <button onClick={() => { onSetClient(null); setMenu(false); setShowClientPicker(false); }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted text-sm text-muted-foreground">
                  <X className="w-4 h-4" /> Unlink client
                </button>
              )}
              <button onClick={() => setShowClientPicker(false)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl bg-muted text-sm text-muted-foreground mt-1">
                <X className="w-4 h-4" /> Back
              </button>
            </>
          ) : (
            <>
              <button
                data-testid={`button-menu-favorite-${doc.id}`}
                onClick={() => { onToggleFavorite(); setMenu(false); }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium ${doc.isFavorite ? "bg-amber-50 dark:bg-amber-950/30 text-amber-600 dark:text-amber-400" : "bg-muted text-foreground"}`}
              >
                <Star className={`w-4 h-4 ${doc.isFavorite ? "fill-amber-400 text-amber-400" : ""}`} />
                {doc.isFavorite ? "Starred" : "Star document"}
                {doc.isFavorite && <Check className="w-3 h-3 ml-auto" />}
              </button>
              <button onClick={() => { setMenu(false); onEdit(); }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/10 text-sm text-primary font-medium">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => setRenaming(true)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <Edit2 className="w-4 h-4" /> Rename
              </button>
              <button onClick={() => setShowStatusPicker(true)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <Tag className="w-4 h-4" />
                <span>Status</span>
                <span className={`ml-auto w-2 h-2 rounded-full ${statusMeta.dot}`} />
              </button>
              <button onClick={() => setShowClientPicker(true)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <UserCheck className="w-4 h-4" />
                <span className="flex-1 text-left">Client</span>
                {clientName ? (
                  <span className="text-[10px] text-muted-foreground truncate max-w-[60px]">{clientName}</span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/50">None</span>
                )}
              </button>
              <button onClick={() => { setMenu(false); onDuplicate(); }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <Copy className="w-4 h-4" /> Duplicate
              </button>
              <button
                data-testid={`button-menu-share-${doc.id}`}
                onClick={() => { setMenu(false); onShare(); }}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground"
              >
                <Share2 className="w-4 h-4" /> Share
              </button>
              <button
                data-testid={`button-menu-download-${doc.id}`}
                onClick={() => { setMenu(false); onDownload(); }}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground"
              >
                <Download className="w-4 h-4" /> Download PDF
              </button>
              {folders.length > 0 && (
                <button onClick={() => setShowFolderPicker(true)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                  <FolderInput className="w-4 h-4" /> Move to folder
                </button>
              )}
              <button onClick={() => {
                const linkedClient = doc.clientId ? clients.find((c) => c.id === doc.clientId) : undefined;
                setMenu(false);
                onSendEmail(linkedClient?.email ?? undefined);
              }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <Mail className="w-4 h-4" />
                <span className="flex-1 text-left">Send by Email</span>
              </button>
              <button onClick={() => { onDelete(); setMenu(false); }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/30 text-sm text-red-500">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
              <button onClick={() => setMenu(false)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-muted-foreground">
                <X className="w-4 h-4" /> Cancel
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});

function FolderChip({ folder, onOpen, onDelete, onRename }: { folder: Folder; onOpen: () => void; onDelete: () => void; onRename: (name: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(folder.name);

  return (
    <div data-testid={`folder-chip-${folder.id}`} className="relative flex-shrink-0 w-24">
      <button onClick={onOpen} className="w-full flex flex-col items-center gap-1.5 p-3 bg-card rounded-2xl border border-border shadow-sm">
        <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
          <FolderOpen className="w-5 h-5 text-amber-500" />
        </div>
        <p className="text-[11px] font-medium text-foreground truncate w-full text-center">{folder.name}</p>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
        className="absolute top-1 right-1 w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground"
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>

      {menu && (
        <div className="absolute left-0 top-full mt-1 z-30 bg-card border border-border rounded-2xl shadow-lg overflow-hidden min-w-[160px]">
          {renaming ? (
            <div className="p-2 flex flex-col gap-2">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { onRename(newName); setRenaming(false); setMenu(false); } }}
                className="w-full px-3 py-2 rounded-xl bg-muted text-sm text-foreground border-0 outline-none" />
              <div className="flex gap-1.5">
                <button onClick={() => { onRename(newName); setRenaming(false); setMenu(false); }}
                  className="flex-1 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium">Save</button>
                <button onClick={() => { setRenaming(false); setMenu(false); }}
                  className="flex-1 py-1.5 rounded-xl bg-muted text-foreground text-xs font-medium">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <button onClick={() => setRenaming(true)} className="flex items-center gap-2 px-4 py-3 text-sm text-foreground w-full active:bg-muted">
                <Edit2 className="w-4 h-4 text-muted-foreground" /> Rename
              </button>
              <button onClick={() => { onDelete(); setMenu(false); }} className="flex items-center gap-2 px-4 py-3 text-sm text-red-500 w-full active:bg-muted">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function HomePage({ user, onScan, onOpenDoc, onEditDoc, onOpenFolder, onProfile, onOpenClients, onOpenInbox, onLogout }: HomePageProps) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | DocStatus>(() => getSetting("defaultFilter", "all") as "all" | DocStatus);
  const [clientFilter, setClientFilter] = useState<"all" | string>("all");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const docsRef = useRef<HTMLDivElement>(null);

  // Send-by-email modal state (triggered from DocCard menu)
  const [sendingDoc, setSendingDoc] = useState<{ id: string; name: string; clientId: string | null } | null>(null);
  const [cardEmailTo, setCardEmailTo] = useState("");
  const [cardEmailMsg, setCardEmailMsg] = useState("");
  const [cardEmailError, setCardEmailError] = useState("");
  const [cardEmailSuccess, setCardEmailSuccess] = useState(false);

  const { data: docs = [] } = useQuery<DocumentSummary[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) {
        const { listLocalDocs } = await import("@/lib/localDocs");
        return (await listLocalDocs()) as unknown as DocumentSummary[];
      }
      const res = await apiFetch("/api/documents");
      return res.json();
    },
  });

  const { data: foldersData = [] } = useQuery<Folder[]>({
    queryKey: ["/api/folders"],
    initialData: [],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) return [];
      const res = await apiFetch("/api/folders");
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const { data: clientsData = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    initialData: [],
    queryFn: async () => {
      if (Capacitor.isNativePlatform()) return [];
      const res = await apiFetch("/api/clients");
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const clientMap = useMemo(() => new Map(clientsData.map((c) => [c.id, c])), [clientsData]);

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      if (Capacitor.isNativePlatform()) {
        const { deleteLocalDoc } = await import("@/lib/localDocs");
        await deleteLocalDoc(id); return;
      }
      return apiRequest("DELETE", `/api/documents/${id}`, {});
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const renameDoc = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { name }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { name });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
  });

  const setDocStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: DocStatus }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { status }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { status });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to update status", variant: "destructive" }),
  });

  const duplicateDoc = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/documents/${id}/duplicate`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Document duplicated" }); },
    onError: () => toast({ title: "Failed to duplicate", variant: "destructive" }),
  });

  const moveToFolder = useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      apiRequest("PUT", `/api/documents/${id}`, { folderId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/documents"] }); toast({ title: "Moved" }); },
    onError: () => toast({ title: "Failed to move", variant: "destructive" }),
  });

  const sendEmailCard = useMutation({
    mutationFn: ({ id, to, message }: { id: string; to: string; message?: string }) =>
      apiRequest("POST", `/api/documents/${id}/send-email`, { to, message }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      setCardEmailSuccess(true);
      toast({ title: "Email sent", description: `Document sent to ${vars.to}` });
      setTimeout(() => {
        setSendingDoc(null);
        setCardEmailTo("");
        setCardEmailMsg("");
        setCardEmailError("");
        setCardEmailSuccess(false);
      }, 1800);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      setCardEmailError(msg);
    },
  });

  const createFolder = useMutation({
    mutationFn: (name: string) => apiRequest("POST", "/api/folders", { name }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/folders"] }); setShowNewFolder(false); setNewFolderName(""); },
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/folders/${id}`, {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/folders"] }); queryClient.invalidateQueries({ queryKey: ["/api/documents"] }); },
  });

  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiRequest("PUT", `/api/folders/${id}`, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/folders"] }),
  });

  const setDocClient = useMutation({
    mutationFn: ({ id, clientId }: { id: string; clientId: string | null }) => apiRequest("PUT", `/api/documents/${id}`, { clientId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to assign client", variant: "destructive" }),
  });

  const toggleFavorite = useMutation({
    mutationFn: async ({ id, isFavorite }: { id: string; isFavorite: boolean }) => {
      if (Capacitor.isNativePlatform()) {
        const { updateLocalDoc } = await import("@/lib/localDocs");
        await updateLocalDoc(id, { isFavorite }); return;
      }
      return apiRequest("PUT", `/api/documents/${id}`, { isFavorite });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/documents"] }),
    onError: () => toast({ title: "Failed to update favorite", variant: "destructive" }),
  });

  const handleCardShare = async (docId: string) => {
    try {
      const res = await apiFetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error("fetch failed");
      const fullDoc: { dataUrl: string; name: string; type: string } = await res.json();
      if (!fullDoc.dataUrl || fullDoc.dataUrl.length < 50) {
        toast({ title: "No file available", description: "This document has no exported file yet.", variant: "destructive" });
        return;
      }
      const filename = docFilename(fullDoc.name, fullDoc.type);
      const mimeType = docMime(fullDoc.type);
      const blob = dataUrlToBlob(fullDoc.dataUrl);
      const file = new File([blob], filename, { type: mimeType });
      if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: fullDoc.name, text: "Shared from Docera" });
        return;
      }
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ title: fullDoc.name, text: `Check out: ${fullDoc.name}`, url: window.location.href });
          return;
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") return;
        }
      }
      toast({ title: "Open the document to share", description: "Your browser doesn't support direct file sharing.", variant: "destructive" });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast({ title: "Could not share", description: "Please try again.", variant: "destructive" });
    }
  };

  const handleCardDownload = async (docId: string) => {
    try {
      const res = await apiFetch(`/api/documents/${docId}`);
      if (!res.ok) throw new Error("fetch failed");
      const fullDoc: { dataUrl: string; name: string; type: string } = await res.json();
      if (!fullDoc.dataUrl || fullDoc.dataUrl.length < 50) {
        toast({ title: "No file available", description: "This document has no exported file yet.", variant: "destructive" });
        return;
      }
      const blob = dataUrlToBlob(fullDoc.dataUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = docFilename(fullDoc.name, fullDoc.type);
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      toast({ title: "Download failed", description: "Please try again.", variant: "destructive" });
    }
  };

  const isFiltering = search.trim() !== "" || statusFilter !== "all" || clientFilter !== "all" || showFavoritesOnly;

  const filteredDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return docs.filter((d) => {
      const client = d.clientId ? clientMap.get(d.clientId) : undefined;
      const matchesSearch = !q ||
        d.name.toLowerCase().includes(q) ||
        (d.status ?? "").toLowerCase().includes(q) ||
        (client?.name ?? "").toLowerCase().includes(q) ||
        (client?.email ?? "").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "all" || d.status === statusFilter;
      const matchesClient = clientFilter === "all" || d.clientId === clientFilter;
      const matchesFavorite = !showFavoritesOnly || d.isFavorite;
      return matchesSearch && matchesStatus && matchesClient && matchesFavorite;
    }).sort((a, b) => {
      if (!showFavoritesOnly) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      return 0;
    });
  }, [docs, search, statusFilter, clientFilter, showFavoritesOnly, clientMap]);

  const recent = useMemo(
    () => docs.slice().sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()),
    [docs],
  );

  const statCounts = useMemo(() => ({
    total:    docs.length,
    draft:    docs.filter((d) => (d.status ?? "draft") === "draft").length,
    pending:  docs.filter((d) => d.status === "pending").length,
    sent:     docs.filter((d) => d.status === "sent").length,
    approved: docs.filter((d) => d.status === "approved").length,
    starred:  docs.filter((d) => d.isFavorite).length,
  }), [docs]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-shrink-0 bg-background border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <DaceraLogo variant="full" />
          </div>

        </div>
        <div className="flex items-center gap-2 bg-muted rounded-xl px-3 py-2.5">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            data-testid="input-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search documents…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-muted-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Filter pills — Starred + Status */}
        <div className="flex gap-2 overflow-x-auto pt-2.5 scrollbar-none -mx-1 px-1">
          {/* Starred pill */}
          <button
            data-testid="filter-favorites"
            onClick={() => setShowFavoritesOnly((v) => !v)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              showFavoritesOnly
                ? "bg-amber-400 text-white"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <Star className={`w-3 h-3 ${showFavoritesOnly ? "fill-white text-white" : ""}`} />
            Starred
          </button>
          {/* Status pills */}
          {([
            ["all",      "All"],
            ["draft",    "Draft"],
            ["sent",     "Sent"],
            ["pending",  "Waiting for Reply"],
            ["approved", "Approved"],
            ["rejected", "Rejected"],
          ] as [string, string][]).map(([value, label]) => (
            <button
              key={value}
              data-testid={`filter-${value}`}
              onClick={() => setStatusFilter(value as "all" | DocStatus)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                statusFilter === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Client filter pills — only shown when clients exist */}
        {clientsData.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pt-2 scrollbar-none -mx-1 px-1">
            <button
              data-testid="filter-client-all"
              onClick={() => setClientFilter("all")}
              className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                clientFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              <Users className="w-3 h-3" />
              All Clients
            </button>
            {clientsData.map((c) => (
              <button
                key={c.id}
                data-testid={`filter-client-${c.id}`}
                onClick={() => setClientFilter(clientFilter === c.id ? "all" : c.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                  clientFilter === c.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-28">

        {/* ── Hero section — only shown to first-time users with no documents ── */}
        {docs.length === 0 && (
          <div className="px-8 pt-12 pb-8 flex flex-col items-center text-center">
            <h1 className="text-[1.65rem] font-extrabold text-foreground leading-tight max-w-[280px] tracking-tight">
              Turn handwritten notes into clean documents
            </h1>
            <p className="text-sm text-muted-foreground mt-3 leading-relaxed max-w-[240px]">
              Tap the camera below to scan your first document
            </p>
          </div>
        )}

        {/* ── Dashboard summary strip — only shown once there are documents ── */}
        {docs.length > 0 && <div className="px-4 pt-4 pb-1">
          <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-0.5 px-0.5">
            {([
              { key: "total",    label: "Total",    dot: "bg-muted-foreground/50", value: statCounts.total },
              { key: "draft",    label: "Draft",    dot: "bg-gray-400",            value: statCounts.draft },
              { key: "pending",  label: "Waiting",  dot: "bg-amber-400",           value: statCounts.pending },
              { key: "sent",     label: "Sent",     dot: "bg-blue-400",            value: statCounts.sent },
              { key: "approved", label: "Approved", dot: "bg-green-400",           value: statCounts.approved },
            ] as { key: string; label: string; dot: string; value: number }[]).map(({ key, label, dot, value }) => {
              const isActive = key === "total"
                ? statusFilter === "all" && !showFavoritesOnly
                : statusFilter === key && !showFavoritesOnly;
              return (
                <button
                  key={key}
                  data-testid={`stat-${key}`}
                  onClick={() => {
                    if (key === "total") { setStatusFilter("all"); setShowFavoritesOnly(false); }
                    else { setStatusFilter(key as DocStatus); setShowFavoritesOnly(false); }
                  }}
                  className={`flex-shrink-0 w-[70px] flex flex-col items-center justify-center gap-1 py-3 rounded-2xl border transition-colors ${
                    isActive
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-card border-border text-foreground"
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive ? "bg-primary-foreground/50" : dot}`} />
                  <span className={`text-[22px] font-bold leading-none tabular-nums ${isActive ? "text-primary-foreground" : "text-foreground"}`}>{value}</span>
                  <span className={`text-[9px] font-semibold leading-none ${isActive ? "text-primary-foreground/75" : "text-muted-foreground"}`}>{label}</span>
                </button>
              );
            })}

            {/* Starred */}
            <button
              data-testid="stat-starred"
              onClick={() => setShowFavoritesOnly((v) => !v)}
              className={`flex-shrink-0 w-[70px] flex flex-col items-center justify-center gap-1 py-3 rounded-2xl border transition-colors ${
                showFavoritesOnly
                  ? "bg-amber-400 border-amber-400"
                  : "bg-card border-border"
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${showFavoritesOnly ? "fill-white text-white" : "text-amber-400"}`} />
              <span className={`text-[22px] font-bold leading-none tabular-nums ${showFavoritesOnly ? "text-white" : "text-foreground"}`}>
                {statCounts.starred}
              </span>
              <span className={`text-[9px] font-semibold leading-none ${showFavoritesOnly ? "text-white/75" : "text-muted-foreground"}`}>Starred</span>
            </button>

            {/* Clients */}
            {clientsData.length > 0 && (
              <button
                data-testid="stat-clients"
                onClick={onOpenClients}
                className="flex-shrink-0 w-[70px] flex flex-col items-center justify-center gap-1 py-3 rounded-2xl border bg-card border-border"
              >
                <Users className="w-3.5 h-3.5 text-primary" />
                <span className="text-[22px] font-bold leading-none tabular-nums text-foreground">{clientsData.length}</span>
                <span className="text-[9px] font-semibold leading-none text-muted-foreground">Clients</span>
              </button>
            )}
          </div>
        </div>}

        <div className="pt-4 px-4 mb-4">
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-sm font-bold text-foreground">Folders</h2>
            <button
              data-testid="button-new-folder"
              onClick={(e) => { e.stopPropagation(); setShowNewFolder(true); }}
              className="text-xs text-primary font-semibold flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> New
            </button>
          </div>

          {showNewFolder && (
            <div className="flex gap-2 mb-3" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newFolderName.trim()) createFolder.mutate(newFolderName.trim()); if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); } }}
                placeholder="Folder name…"
                className="flex-1 px-3 py-2 rounded-xl bg-muted text-sm text-foreground border-0 outline-none"
              />
              <button onClick={() => { if (newFolderName.trim()) createFolder.mutate(newFolderName.trim()); }}
                className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium">Add</button>
              <button onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}
                className="px-2.5 py-2 rounded-xl bg-muted text-muted-foreground"><X className="w-4 h-4" /></button>
            </div>
          )}

          <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none">
            {foldersData.length === 0 && !showNewFolder ? (
              <button
                onClick={() => setShowNewFolder(true)}
                className="flex-shrink-0 w-24 flex flex-col items-center gap-1.5 p-3 bg-card rounded-2xl border border-dashed border-border"
              >
                <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                  <Plus className="w-5 h-5 text-muted-foreground" />
                </div>
                <p className="text-[11px] text-muted-foreground font-medium">New folder</p>
              </button>
            ) : (
              <>
                {foldersData.map((folder) => (
                  <FolderChip
                    key={folder.id}
                    folder={folder}
                    onOpen={() => onOpenFolder(folder.id, folder.name)}
                    onDelete={() => deleteFolder.mutate(folder.id)}
                    onRename={(name) => renameFolder.mutate({ id: folder.id, name })}
                  />
                ))}
                <button
                  onClick={() => setShowNewFolder(true)}
                  className="flex-shrink-0 w-24 flex flex-col items-center gap-1.5 p-3 bg-card rounded-2xl border border-dashed border-border"
                >
                  <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                    <Plus className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <p className="text-[11px] text-muted-foreground font-medium">New folder</p>
                </button>
              </>
            )}
          </div>
        </div>

        {recent.length > 0 && !isFiltering && (
          <div className="mb-4">
            <div className="flex items-center justify-between px-4 mb-2.5">
              <h2 className="text-sm font-bold text-foreground">Recent</h2>
              <span className="text-xs text-muted-foreground">{recent.length} doc{recent.length !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex gap-3 overflow-x-auto px-4 pb-1 scrollbar-none">
              {recent.slice(0, 10).map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  variant="recent"
                  folders={foldersData}
                  clients={clientsData}
                  clientName={doc.clientId ? clientMap.get(doc.clientId)?.name : undefined}
                  onOpen={() => onOpenDoc(doc.id)}
                  onEdit={() => onEditDoc(doc.id)}
                  onDelete={() => deleteDoc.mutate(doc.id)}
                  onRename={(name) => renameDoc.mutate({ id: doc.id, name })}
                  onDuplicate={() => duplicateDoc.mutate(doc.id)}
                  onMoveToFolder={(folderId) => moveToFolder.mutate({ id: doc.id, folderId })}
                  onSetStatus={(status) => setDocStatus.mutate({ id: doc.id, status })}
                  onSetClient={(clientId) => setDocClient.mutate({ id: doc.id, clientId })}
                  onToggleFavorite={() => toggleFavorite.mutate({ id: doc.id, isFavorite: !doc.isFavorite })}
                  onShare={() => handleCardShare(doc.id)}
                  onDownload={() => handleCardDownload(doc.id)}
                  onSendEmail={(clientEmail) => {
                    setCardEmailError("");
                    setCardEmailTo(clientEmail || "");
                    setSendingDoc({ id: doc.id, name: doc.name, clientId: doc.clientId ?? null });
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={docsRef} className="px-4">
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
              {showFavoritesOnly ? (
                <>
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  Starred
                </>
              ) : isFiltering ? "Results" : "Your Documents"}
              {filteredDocs.length > 0 && (
                <span className="text-muted-foreground font-normal ml-0.5">({filteredDocs.length})</span>
              )}
            </h2>
          </div>
          {filteredDocs.length === 0 ? (
            docs.length === 0 ? (
              /* ── First-time user onboarding ── */
              <div className="flex flex-col items-center px-5 pt-6 pb-8">
                <div className="w-20 h-20 rounded-3xl bg-primary/10 flex items-center justify-center mb-5">
                  <FileText className="w-10 h-10 text-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground mb-2 text-center">Welcome to Docera</h2>
                <p className="text-sm text-muted-foreground leading-relaxed text-center mb-7 max-w-xs">
                  Scan any physical document with your camera, organize it by client, and send it — all in one place.
                </p>

                {/* Workflow strip */}
                <div className="w-full bg-card border border-border rounded-2xl px-4 pt-4 pb-5 mb-6">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-4 text-center">How it works</p>
                  <div className="flex items-center justify-center gap-1">
                    {([
                      { icon: Camera, label: "Scan" },
                      { icon: SlidersHorizontal, label: "Edit" },
                      { icon: FileText, label: "Save" },
                      { icon: Send, label: "Send" },
                    ] as const).map((step, i) => (
                      <div key={step.label} className="flex items-center gap-1">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center">
                            <step.icon className="w-5 h-5 text-primary" />
                          </div>
                          <span className="text-[11px] font-semibold text-foreground">{step.label}</span>
                        </div>
                        {i < 3 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 mb-3 flex-shrink-0" />}
                      </div>
                    ))}
                  </div>
                </div>

                <button
                  data-testid="button-scan-first-doc"
                  onClick={() => onScan()}
                  className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-2xl active:opacity-80 text-[15px]"
                >
                  Add your first document
                </button>
              </div>
            ) : showFavoritesOnly ? (
              /* ── No starred documents ── */
              <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
                  <Star className="w-7 h-7 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-semibold text-foreground">No starred documents</p>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Tap the star on any document card to add it here for quick access.
                </p>
              </div>
            ) : (
              /* ── Active filter / search yields nothing ── */
              <div className="flex flex-col items-center justify-center py-16 px-8 text-center gap-3">
                <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
                  <Search className="w-7 h-7 text-muted-foreground/50" />
                </div>
                <p className="text-sm font-semibold text-foreground">No documents found</p>
                <p className="text-sm text-muted-foreground leading-relaxed">Try adjusting your search or filter.</p>
                <button
                  data-testid="button-clear-filters"
                  onClick={() => { setSearch(""); setStatusFilter("all"); setClientFilter("all"); setShowFavoritesOnly(false); }}
                  className="mt-1 text-sm font-semibold text-primary active:opacity-60"
                >
                  Clear filters
                </button>
              </div>
            )
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {filteredDocs.map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  folders={foldersData}
                  clients={clientsData}
                  clientName={doc.clientId ? clientMap.get(doc.clientId)?.name : undefined}
                  onOpen={() => onOpenDoc(doc.id)}
                  onEdit={() => onEditDoc(doc.id)}
                  onDelete={() => deleteDoc.mutate(doc.id)}
                  onRename={(name) => renameDoc.mutate({ id: doc.id, name })}
                  onDuplicate={() => duplicateDoc.mutate(doc.id)}
                  onMoveToFolder={(folderId) => moveToFolder.mutate({ id: doc.id, folderId })}
                  onSetStatus={(status) => setDocStatus.mutate({ id: doc.id, status })}
                  onSetClient={(clientId) => setDocClient.mutate({ id: doc.id, clientId })}
                  onToggleFavorite={() => toggleFavorite.mutate({ id: doc.id, isFavorite: !doc.isFavorite })}
                  onShare={() => handleCardShare(doc.id)}
                  onDownload={() => handleCardDownload(doc.id)}
                  onSendEmail={(clientEmail) => {
                    setCardEmailError("");
                    setCardEmailTo(clientEmail || "");
                    setSendingDoc({ id: doc.id, name: doc.name, clientId: doc.clientId ?? null });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Send-by-email modal (triggered from DocCard menu) ─────────────── */}
      {sendingDoc && (
        <div
          className="fixed inset-0 z-[60] flex items-end"
          onClick={() => { if (!sendEmailCard.isPending) { setSendingDoc(null); setCardEmailTo(""); setCardEmailMsg(""); setCardEmailError(""); setCardEmailSuccess(false); } }}
        >
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full bg-card rounded-t-3xl shadow-2xl"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pt-3 pb-4 px-5 border-b border-border">
              <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-4" />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-base font-bold text-foreground">Send by Email</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[240px]">{sendingDoc.name}</p>
                </div>
                <button
                  data-testid="button-card-email-close"
                  onClick={() => { setSendingDoc(null); setCardEmailTo(""); setCardEmailMsg(""); setCardEmailError(""); setCardEmailSuccess(false); }}
                  disabled={sendEmailCard.isPending}
                  className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-muted-foreground active:opacity-60 disabled:opacity-40"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="px-5 pt-5 pb-2 flex flex-col gap-4">

              {/* Document chip */}
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-primary/8 border border-primary/15">
                <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Sending</p>
                  <p className="text-sm font-semibold text-foreground truncate">{sendingDoc.name}</p>
                </div>
              </div>

              {/* Recipient email */}
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">Recipient email</label>
                <ClientEmailSuggest
                  data-testid="input-card-email-to"
                  value={cardEmailTo}
                  onChange={(v) => { setCardEmailTo(v); setCardEmailError(""); }}
                  linkedClientId={sendingDoc?.clientId}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const t = cardEmailTo.trim();
                      if (t && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) sendEmailCard.mutate({ id: sendingDoc!.id, to: t, message: cardEmailMsg.trim() || undefined });
                      else setCardEmailError("Please enter a valid email address.");
                    }
                  }}
                  disabled={sendEmailCard.isPending || cardEmailSuccess}
                  inputClassName="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </div>

              {/* Message */}
              <div>
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide block mb-1.5">
                  Message <span className="text-muted-foreground/50 font-normal normal-case">(optional)</span>
                </label>
                <textarea
                  data-testid="input-card-email-message"
                  placeholder="Add a personal note to the recipient…"
                  value={cardEmailMsg}
                  onChange={(e) => setCardEmailMsg(e.target.value)}
                  rows={3}
                  disabled={sendEmailCard.isPending || cardEmailSuccess}
                  className="w-full px-4 py-3 rounded-2xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none resize-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
                />
              </div>

              {/* Error */}
              {cardEmailError && (
                <div className="flex items-start gap-2.5 px-4 py-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/30">
                  <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <span className="text-red-600 dark:text-red-400 text-sm leading-snug">{cardEmailError}</span>
                </div>
              )}

              {/* Send button / success */}
              {cardEmailSuccess ? (
                <div className="w-full py-3.5 rounded-2xl bg-green-500/10 border border-green-500/20 text-green-600 text-sm font-bold flex items-center justify-center gap-2">
                  <Check className="w-4 h-4" />
                  Document sent successfully
                </div>
              ) : (
                <button
                  data-testid="button-card-email-send"
                  onClick={() => {
                    const t = cardEmailTo.trim();
                    if (!t || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) { setCardEmailError("Please enter a valid email address."); return; }
                    setCardEmailError("");
                    sendEmailCard.mutate({ id: sendingDoc.id, to: t, message: cardEmailMsg.trim() || undefined });
                  }}
                  disabled={sendEmailCard.isPending || !cardEmailTo.trim()}
                  className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50 transition-opacity"
                >
                  {sendEmailCard.isPending ? (
                    <>
                      <div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      Send Document
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-30">
        <div
          className="flex items-end justify-around"
          style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        >
          {/* Docs */}
          <button
            data-testid="tab-docs"
            className="flex-1 flex flex-col items-center gap-0.5 pt-3 pb-1 text-primary relative"
          >
            <FileText className="w-[22px] h-[22px]" />
            <span className="text-[9px] font-semibold tracking-tight">Docs</span>
            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
          </button>

          {/* Inbox */}
          <button
            data-testid="tab-inbox"
            onClick={onOpenInbox}
            className="flex-1 flex flex-col items-center gap-0.5 pt-3 pb-1 text-muted-foreground active:opacity-60"
          >
            <Mail className="w-[22px] h-[22px]" />
            <span className="text-[9px] font-semibold tracking-tight">Inbox</span>
          </button>

          {/* Camera — elevated center FAB */}
          <div className="flex-1 flex flex-col items-center pb-1">
            <button
              data-testid="button-scan"
              onClick={() => onScan()}
              className="-mt-7 w-[60px] h-[60px] rounded-full bg-primary flex items-center justify-center active:scale-95 transition-transform"
              style={{ boxShadow: "0 4px 20px rgba(17,62,97,0.45)" }}
            >
              <Camera className="w-7 h-7 text-primary-foreground" />
            </button>
          </div>

          {/* Settings */}
          <button
            data-testid="tab-settings"
            onClick={onProfile}
            className="flex-1 flex flex-col items-center gap-0.5 pt-3 pb-1 text-muted-foreground active:opacity-60"
          >
            <Settings className="w-[22px] h-[22px]" />
            <span className="text-[9px] font-semibold tracking-tight">Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}
