import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import { ArrowLeft, Camera, FileText, MoreVertical, Trash2, Edit2, X, Check, User, Pencil } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import type { DocumentSummary, DocStatus } from "@shared/schema";

const STATUS_META: Record<DocStatus, { label: string; dot: string }> = {
  draft:    { label: "Draft",    dot: "bg-gray-400" },
  pending:  { label: "Waiting for Reply", dot: "bg-amber-400" },
  sent:     { label: "Sent",     dot: "bg-blue-400" },
  approved: { label: "Approved", dot: "bg-green-400" },
  rejected: { label: "Rejected", dot: "bg-red-400" },
};

interface FolderPageProps {
  folderId: string;
  folderName: string;
  onBack: () => void;
  onScan: () => void;
  onOpenDoc: (docId: string) => void;
  onEditDoc: (docId: string) => void;
  onProfile: () => void;
}

function DocCard({ doc, onOpen, onDelete, onRename, onEdit }: {
  doc: DocumentSummary; onOpen: () => void; onDelete: () => void; onRename: (name: string) => void; onEdit: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(doc.name);

  const docStatus = (doc.status as DocStatus | undefined) ?? "draft";
  const statusMeta = STATUS_META[docStatus] ?? STATUS_META.draft;

  const dateToShow = (() => {
    const created = doc.createdAt ? new Date(doc.createdAt).getTime() : 0;
    const updated = doc.updatedAt ? new Date(doc.updatedAt).getTime() : 0;
    const ts = updated - created > 60_000 ? updated : created;
    return ts ? format(new Date(ts), "MMM d") : "";
  })();

  return (
    <div data-testid={`doc-card-${doc.id}`} className="relative bg-card rounded-2xl overflow-hidden shadow-sm border border-border">
      <button className="w-full text-left" onClick={onOpen}>
        <div className="h-32 bg-muted flex items-center justify-center overflow-hidden relative">
          {doc.thumbUrl ? (
            <img src={doc.thumbUrl} alt={doc.name} className="w-full h-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-9 h-11 bg-red-500 rounded-lg flex items-center justify-center shadow-sm">
                <span className="text-white text-[9px] font-bold tracking-wider">{doc.type === "pdf" ? "PDF" : doc.type.toUpperCase()}</span>
              </div>
            </div>
          )}
          <span className="absolute top-1.5 left-1.5 bg-black/50 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase">{doc.type}</span>
        </div>
        <div className="px-2.5 pt-2 pb-2 bg-primary">
          <p className="text-[13px] font-semibold truncate leading-tight text-primary-foreground">{doc.name}</p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusMeta.dot}`} />
            <span className="text-[10px] leading-tight text-primary-foreground/65">
              {statusMeta.label}{dateToShow ? ` · ${dateToShow}` : ""}
            </span>
          </div>
        </div>
      </button>
      <button
        data-testid={`doc-menu-${doc.id}`}
        onClick={(e) => { e.stopPropagation(); setMenu(true); }}
        className="absolute top-1.5 right-1.5 w-6 h-6 bg-black/30 backdrop-blur-sm rounded-lg flex items-center justify-center"
      >
        <MoreVertical className="w-3.5 h-3.5 text-white" />
      </button>

      {menu && (
        <div className="absolute inset-0 bg-background/95 backdrop-blur-sm flex flex-col p-3 gap-2 z-10">
          {renaming ? (
            <>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-muted text-sm text-foreground border-0 outline-none" />
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
          ) : (
            <>
              <button onClick={() => { setMenu(false); onEdit(); }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-primary/10 text-sm text-primary font-medium">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => setRenaming(true)} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground">
                <Edit2 className="w-4 h-4" /> Rename
              </button>
              <button onClick={() => { onDelete(); setMenu(false); }} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 text-sm text-red-500">
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
}

export default function FolderPage({ folderId, folderName, onBack, onScan, onOpenDoc, onEditDoc, onProfile }: FolderPageProps) {
  const { toast } = useToast();

  const { data: docs = [], isLoading } = useQuery<DocumentSummary[]>({
    queryKey: ["/api/documents", folderId],
    queryFn: async () => {
      const res = await apiFetch(`/api/documents?folderId=${folderId}`);
      return res.json();
    },
  });

  const deleteDoc = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/documents/${id}`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents", folderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
    },
    onError: () => toast({ title: "Failed to delete", variant: "destructive" }),
  });

  const renameDoc = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiRequest("PUT", `/api/documents/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents", folderId] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
    },
  });

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="flex-shrink-0 bg-card border-b border-border px-3 pb-3" style={{ paddingTop: "max(3rem, env(safe-area-inset-top))" }}>
        <div className="flex items-center gap-2">
          <button data-testid="button-back" onClick={onBack}
            className="w-11 h-11 rounded-xl flex items-center justify-center text-foreground -ml-1 flex-shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <p className="flex-1 text-base font-bold text-foreground truncate">{folderName}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-28 px-4 pt-4">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <FileText className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground text-center">No documents in this folder yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {docs.map((doc) => (
              <DocCard
                key={doc.id}
                doc={doc}
                onOpen={() => onOpenDoc(doc.id)}
                onEdit={() => onEditDoc(doc.id)}
                onDelete={() => deleteDoc.mutate(doc.id)}
                onRename={(name) => renameDoc.mutate({ id: doc.id, name })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border">
        <div className="flex items-center justify-around px-2" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
          <button data-testid="tab-docs" onClick={onBack} className="flex flex-col items-center gap-1 pt-3 pb-1 px-8 text-muted-foreground">
            <FileText className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Docs</span>
          </button>

          <button
            data-testid="button-scan"
            onClick={onScan}
            className="-mt-6 w-16 h-16 rounded-full bg-primary flex items-center justify-center active:scale-95 transition-transform"
            style={{ boxShadow: "0 4px 24px hsl(212 100% 47% / 0.5)" }}
          >
            <Camera className="w-7 h-7 text-primary-foreground" />
          </button>

          <button
            data-testid="tab-me"
            onClick={onProfile}
            className="flex flex-col items-center gap-1 pt-3 pb-1 px-8 text-muted-foreground"
          >
            <User className="w-5 h-5" />
            <span className="text-[10px] font-semibold">Profile</span>
          </button>
        </div>
      </div>
    </div>
  );
}
