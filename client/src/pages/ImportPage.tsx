import { useState, useRef, useCallback } from "react";
import {
  X, Plus, FileText, ChevronUp, ChevronDown, Scissors, Merge,
  Upload, Check, AlertCircle, Pencil, FolderInput,
} from "lucide-react";
import jsPDF from "jspdf";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import ScannerPage from "@/pages/ScannerPage";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImportItem {
  id: string;
  type: "image" | "pdf";
  previewUrl: string;
  canvas?: HTMLCanvasElement;
  pdfDataUrl?: string;
  filename: string;
}

interface DocGroup {
  id: string;
  name: string;
  items: ImportItem[];
}

export interface ImportPageProps {
  folderId?: string | null;
  clientId?: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

// ─── File loading utilities ───────────────────────────────────────────────────

const MAX_DIM = 2048;
const PDF_DIM = 1440;

function downscaleCanvas(c: HTMLCanvasElement, maxDim: number): HTMLCanvasElement {
  if (Math.max(c.width, c.height) <= maxDim) return c;
  const scale = maxDim / Math.max(c.width, c.height);
  const out = document.createElement("canvas");
  out.width = Math.round(c.width * scale);
  out.height = Math.round(c.height * scale);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(c, 0, 0, out.width, out.height);
  return out;
}

async function loadImageItem(file: File): Promise<ImportItem> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const raw = document.createElement("canvas");
        raw.width = img.width;
        raw.height = img.height;
        raw.getContext("2d")!.drawImage(img, 0, 0);
        const scaled = downscaleCanvas(raw, MAX_DIM);
        const previewUrl = downscaleCanvas(scaled, 480).toDataURL("image/jpeg", 0.75);
        resolve({
          id: crypto.randomUUID(),
          type: "image",
          previewUrl,
          canvas: scaled,
          filename: file.name,
        });
      };
      img.onerror = reject;
      img.src = dataUrl;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadPdfItem(file: File): Promise<ImportItem> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      resolve({
        id: crypto.randomUUID(),
        type: "pdf",
        previewUrl: "",
        pdfDataUrl: ev.target?.result as string,
        filename: file.name,
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement): string {
  const c = downscaleCanvas(canvas, PDF_DIM);
  return c.toDataURL("image/jpeg", 0.88);
}

async function groupToDocument(
  group: DocGroup,
  folderId?: string | null,
  clientId?: string | null,
): Promise<void> {
  const imageItems = group.items.filter((it) => it.type === "image" && it.canvas);
  const pdfItems = group.items.filter((it) => it.type === "pdf" && it.pdfDataUrl);

  if (imageItems.length > 0) {
    const canvases = imageItems.map((it) => it.canvas!);
    const first = canvases[0];
    const firstJpeg = canvasToJpeg(first);
    const firstOrientation = first.width >= first.height ? "l" : "p";
    const pdf = new jsPDF({ unit: "px", format: [first.width, first.height], orientation: firstOrientation });
    pdf.addImage(firstJpeg, "JPEG", 0, 0, first.width, first.height);
    for (let i = 1; i < canvases.length; i++) {
      const c = canvases[i];
      const pageOrientation = c.width >= c.height ? "l" : "p";
      pdf.addPage([c.width, c.height], pageOrientation);
      pdf.addImage(canvasToJpeg(c), "JPEG", 0, 0, c.width, c.height);
    }
    const dataUrl = pdf.output("datauristring");
    const size = Math.round((dataUrl.length * 3) / 4);
    const thumbUrl = firstJpeg;
    const res = await apiRequest("POST", "/api/documents", {
      name: group.name, type: "pdf", dataUrl, size, thumbUrl,
      folderId: folderId ?? null,
    });
    if (!res.ok) throw new Error("Failed to save document");
    const saved = await res.json() as { id: string };
    if (clientId && saved?.id) {
      try { await apiRequest("PUT", `/api/documents/${saved.id}`, { clientId }); } catch { /* ignore */ }
    }
  }

  for (const pdfItem of pdfItems) {
    const dataUrl = pdfItem.pdfDataUrl!;
    const size = Math.round((dataUrl.length * 3) / 4);
    const pdfName = pdfItem.filename.replace(/\.pdf$/i, "").trim() || group.name;
    const res = await apiRequest("POST", "/api/documents", {
      name: pdfName, type: "pdf", dataUrl, size, folderId: folderId ?? null,
    });
    if (!res.ok) throw new Error("Failed to save PDF");
    const saved = await res.json() as { id: string };
    if (clientId && saved?.id) {
      try { await apiRequest("PUT", `/api/documents/${saved.id}`, { clientId }); } catch { /* ignore */ }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uid() { return crypto.randomUUID(); }

function defaultGroupName(index: number) {
  return index === 0 ? "Document" : `Document ${index + 1}`;
}

function countOutputDocs(groups: DocGroup[]): number {
  return groups.reduce((sum, g) => {
    const hasImages = g.items.some((it) => it.type === "image");
    const pdfCount = g.items.filter((it) => it.type === "pdf").length;
    return sum + (hasImages ? 1 : 0) + pdfCount;
  }, 0);
}

/** Split an array into consecutive chunks of `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ImportPage({ folderId, clientId, onSaved, onCancel }: ImportPageProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [groups, setGroups] = useState<DocGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);

  const [editingItem, setEditingItem] = useState<{
    groupId: string;
    itemId: string;
    canvas: HTMLCanvasElement;
  } | null>(null);

  const handleEditComplete = useCallback((editedCanvas: HTMLCanvasElement, dataUrl: string) => {
    if (!editingItem) return;
    const maxW = 480;
    const previewUrl = (() => {
      if (editedCanvas.width <= maxW && editedCanvas.height <= maxW) return dataUrl;
      const scale = maxW / Math.max(editedCanvas.width, editedCanvas.height);
      const sc = document.createElement("canvas");
      sc.width = Math.round(editedCanvas.width * scale);
      sc.height = Math.round(editedCanvas.height * scale);
      sc.getContext("2d")!.drawImage(editedCanvas, 0, 0, sc.width, sc.height);
      return sc.toDataURL("image/jpeg", 0.75);
    })();
    setGroups((prev) => prev.map((g) => {
      if (g.id !== editingItem.groupId) return g;
      return {
        ...g,
        items: g.items.map((it) =>
          it.id !== editingItem.itemId ? it : { ...it, canvas: editedCanvas, previewUrl }
        ),
      };
    }));
    setEditingItem(null);
  }, [editingItem]);

  // ── File loading ──────────────────────────────────────────────────────────

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setLoading(true);
    try {
      const images = arr.filter((f) => f.type.startsWith("image/"));
      const pdfs = arr.filter((f) => f.type === "application/pdf");
      const imageItems = await Promise.all(images.map(loadImageItem));
      const pdfItems = await Promise.all(pdfs.map(loadPdfItem));
      const allItems = [...imageItems, ...pdfItems];
      if (!allItems.length) return;
      setGroups((prev) => {
        if (prev.length === 0) {
          return [{ id: uid(), name: defaultGroupName(0), items: allItems }];
        }
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          items: [...updated[updated.length - 1].items, ...allItems],
        };
        return updated;
      });
    } catch {
      toast({ title: "Some files could not be loaded", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    e.target.value = "";
  }, [handleFiles]);

  // ── Group mutations ───────────────────────────────────────────────────────

  const renameGroup = (groupId: string, name: string) => {
    setGroups((prev) => prev.map((g) => g.id === groupId ? { ...g, name } : g));
  };

  const removeItem = (groupId: string, itemId: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.id !== groupId ? g : { ...g, items: g.items.filter((it) => it.id !== itemId) }
      ).filter((g) => g.items.length > 0)
    );
  };

  const moveItemUp = (groupId: string, itemId: string) => {
    setGroups((prev) => {
      const gIdx = prev.findIndex((g) => g.id === groupId);
      if (gIdx < 0) return prev;
      const group = prev[gIdx];
      const iIdx = group.items.findIndex((it) => it.id === itemId);
      if (iIdx < 0) return prev;
      const next = prev.map((g) => ({ ...g, items: [...g.items] }));
      if (iIdx > 0) {
        [next[gIdx].items[iIdx - 1], next[gIdx].items[iIdx]] =
          [next[gIdx].items[iIdx], next[gIdx].items[iIdx - 1]];
      } else if (gIdx > 0) {
        const item = next[gIdx].items.splice(iIdx, 1)[0];
        next[gIdx - 1].items.push(item);
        if (next[gIdx].items.length === 0) next.splice(gIdx, 1);
      }
      return next.filter((g) => g.items.length > 0);
    });
  };

  const moveItemDown = (groupId: string, itemId: string) => {
    setGroups((prev) => {
      const gIdx = prev.findIndex((g) => g.id === groupId);
      if (gIdx < 0) return prev;
      const group = prev[gIdx];
      const iIdx = group.items.findIndex((it) => it.id === itemId);
      if (iIdx < 0) return prev;
      const next = prev.map((g) => ({ ...g, items: [...g.items] }));
      if (iIdx < group.items.length - 1) {
        [next[gIdx].items[iIdx], next[gIdx].items[iIdx + 1]] =
          [next[gIdx].items[iIdx + 1], next[gIdx].items[iIdx]];
      } else if (gIdx < prev.length - 1) {
        const item = next[gIdx].items.splice(iIdx, 1)[0];
        next[gIdx + 1].items.unshift(item);
        if (next[gIdx].items.length === 0) next.splice(gIdx, 1);
      }
      return next.filter((g) => g.items.length > 0);
    });
  };

  const splitAfterItem = (groupId: string, itemId: string) => {
    setGroups((prev) => {
      const gIdx = prev.findIndex((g) => g.id === groupId);
      if (gIdx < 0) return prev;
      const group = prev[gIdx];
      const iIdx = group.items.findIndex((it) => it.id === itemId);
      if (iIdx < 0 || iIdx === group.items.length - 1) return prev;
      const a: DocGroup = { ...group, items: group.items.slice(0, iIdx + 1) };
      const b: DocGroup = {
        id: uid(),
        name: defaultGroupName(gIdx + 1),
        items: group.items.slice(iIdx + 1),
      };
      const next = [...prev];
      next.splice(gIdx, 1, a, b);
      return next;
    });
  };

  const mergeWithNext = (groupId: string) => {
    setGroups((prev) => {
      const gIdx = prev.findIndex((g) => g.id === groupId);
      if (gIdx < 0 || gIdx >= prev.length - 1) return prev;
      const merged: DocGroup = {
        ...prev[gIdx],
        items: [...prev[gIdx].items, ...prev[gIdx + 1].items],
      };
      const next = [...prev];
      next.splice(gIdx, 2, merged);
      return next;
    });
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const nonEmpty = groups.filter((g) => g.items.length > 0);
    if (!nonEmpty.length) return;
    setSaving(true);
    setSaveProgress(0);
    let saved = 0;
    let failed = 0;
    try {
      for (const group of nonEmpty) {
        try {
          await groupToDocument(group, folderId, clientId);
          saved++;
        } catch {
          failed++;
        }
        setSaveProgress(Math.round(((saved + failed) / nonEmpty.length) * 100));
      }
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      if (failed > 0) {
        toast({ title: `${saved} saved, ${failed} failed`, variant: "destructive" });
      } else {
        toast({ title: saved === 1 ? "Document added to Docera!" : `${saved} documents added to Docera!` });
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const outputDocCount = countOutputDocs(groups);
  const hasItems = groups.some((g) => g.items.length > 0);
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);

  // ── Render: empty state ───────────────────────────────────────────────────

  if (!hasItems && !loading) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col z-50">
        <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onFileInputChange} />

        <div className="flex-shrink-0 bg-card border-b border-border"
          style={{ paddingTop: "max(env(safe-area-inset-top), 1rem)" }}>
          <div className="flex items-center justify-between px-4 pb-3">
            <button data-testid="button-import-cancel" onClick={onCancel}
              className="text-sm font-medium text-muted-foreground active:opacity-60 py-1 pr-3">
              Cancel
            </button>
            <span className="text-sm font-bold text-foreground">Import Files</span>
            <div className="w-16" />
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8">
          <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center">
            <Upload className="w-10 h-10 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-foreground mb-2">Import from your device</p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Photos and PDFs from your gallery, Files app, or shared from WhatsApp and other apps land here as a staging area before becoming Docera documents.
            </p>
          </div>
          <div className="w-full space-y-3">
            <button data-testid="button-pick-files" onClick={() => fileInputRef.current?.click()}
              className="w-full py-4 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm active:scale-[0.98] transition-transform flex items-center justify-center gap-2">
              <Plus className="w-5 h-5" />
              Choose Photos & PDFs
            </button>
            <p className="text-xs text-muted-foreground text-center">JPEG · PNG · HEIC · PDF · Multiple files at once</p>
          </div>
          <div className="bg-amber-50 dark:bg-amber-950/30 rounded-2xl p-4 w-full border border-amber-200/60 dark:border-amber-800/40">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground">From WhatsApp?</span> Long-press any file in WhatsApp → Share → select Docera from the share sheet.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: loading ───────────────────────────────────────────────────────

  if (loading && !hasItems) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50 gap-4">
        <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Loading files…</p>
      </div>
    );
  }

  // ── Render: saving progress ───────────────────────────────────────────────

  if (saving) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50 gap-5 px-8">
        <div className="w-14 h-14 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        <div className="text-center">
          <p className="text-base font-bold text-foreground">Saving to Docera…</p>
          <p className="text-sm text-muted-foreground mt-1">Creating your documents</p>
        </div>
        <div className="w-full bg-muted rounded-full h-2">
          <div className="bg-primary h-2 rounded-full transition-all duration-500" style={{ width: `${saveProgress}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">{saveProgress}%</p>
      </div>
    );
  }

  // ── Render: staging area ──────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 flex flex-col z-50 bg-background">
      <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onFileInputChange} />

      {/* ── Header ── */}
      <div className="flex-shrink-0 bg-card border-b border-border"
        style={{ paddingTop: "max(env(safe-area-inset-top), 1rem)" }}>
        <div className="flex items-center gap-3 px-4 pb-3">
          <button data-testid="button-import-cancel" onClick={onCancel}
            className="text-sm font-medium text-muted-foreground active:opacity-60 py-1">
            Cancel
          </button>
          <div className="flex-1 text-center">
            <p className="text-sm font-bold text-foreground leading-none">Staging Area</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totalItems} file{totalItems !== 1 ? "s" : ""} · {outputDocCount} document{outputDocCount !== 1 ? "s" : ""}
            </p>
          </div>
          <button data-testid="button-add-more-files" onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 text-sm font-semibold text-primary active:opacity-60 py-1">
            <Plus className="w-4 h-4" />
            Add
          </button>
        </div>
      </div>

      {/* ── Scrollable staging area ── */}
      <div className="flex-1 overflow-y-auto py-4 px-4 space-y-3">

        {groups.map((group, gIdx) => {
          const rows = chunk(group.items, 2);
          const hasPdfs = group.items.some((it) => it.type === "pdf");

          return (
            <div key={group.id}>
              {/* ── Document card ── */}
              <div className="bg-card rounded-2xl overflow-hidden border border-border/60"
                style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>

                {/* Card header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40"
                  style={{ borderLeftWidth: 4, borderLeftColor: "#113e61", borderLeftStyle: "solid" }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: "rgba(17,62,97,0.08)" }}>
                    <FolderInput className="w-4 h-4 text-primary" />
                  </div>
                  <input
                    data-testid={`input-group-name-${gIdx}`}
                    value={group.name}
                    onChange={(e) => renameGroup(group.id, e.target.value)}
                    className="flex-1 text-sm font-bold bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
                    placeholder="Document name…"
                  />
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {group.items.length} file{group.items.length !== 1 ? "s" : ""}
                    {hasPdfs && <span className="text-amber-500"> · PDF</span>}
                  </span>
                </div>

                {/* Thumbnail grid */}
                <div className="p-3 space-y-1.5">
                  {rows.map((pair, rowIdx) => {
                    const isLastRow = rowIdx === rows.length - 1;
                    const lastItemInRow = pair[pair.length - 1];
                    const lastItemInRowIdx = group.items.indexOf(lastItemInRow);

                    return (
                      <div key={rowIdx}>
                        {/* Row */}
                        <div className="grid grid-cols-2 gap-2">
                          {pair.map((item) => {
                            const iIdx = group.items.indexOf(item);
                            const isFirstEver = gIdx === 0 && iIdx === 0;
                            const isLastEver = gIdx === groups.length - 1 && iIdx === group.items.length - 1;

                            return (
                              <div
                                key={item.id}
                                data-testid={`import-item-${item.id}`}
                                className="relative rounded-xl overflow-hidden bg-muted"
                                style={{ aspectRatio: "1" }}
                              >
                                {/* Main content */}
                                {item.type === "image" ? (
                                  <img
                                    src={item.previewUrl}
                                    alt={item.filename}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3 bg-red-50 dark:bg-red-950/20">
                                    <FileText className="w-8 h-8 text-red-400" />
                                    <p className="text-[10px] text-center text-muted-foreground leading-tight line-clamp-3 break-all">{item.filename}</p>
                                  </div>
                                )}

                                {/* Edit overlay for images — tap the thumbnail */}
                                {item.type === "image" && item.canvas && (
                                  <button
                                    data-testid={`button-edit-photo-${item.id}`}
                                    onClick={() => setEditingItem({ groupId: group.id, itemId: item.id, canvas: item.canvas! })}
                                    className="absolute inset-0 flex items-end justify-start p-1.5 active:bg-black/20 transition-colors"
                                    aria-label="Edit photo"
                                  >
                                    <div className="w-7 h-7 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
                                      <Pencil className="w-3.5 h-3.5 text-white" />
                                    </div>
                                  </button>
                                )}

                                {/* Remove button — top-right */}
                                <button
                                  data-testid={`button-remove-item-${item.id}`}
                                  onClick={() => removeItem(group.id, item.id)}
                                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center active:bg-black/70"
                                  aria-label="Remove"
                                >
                                  <X className="w-3 h-3 text-white" />
                                </button>

                                {/* Reorder buttons — top-left */}
                                <div className="absolute top-1.5 left-1.5 flex flex-col gap-1">
                                  <button
                                    data-testid={`button-move-up-${item.id}`}
                                    onClick={() => moveItemUp(group.id, item.id)}
                                    disabled={isFirstEver}
                                    className="w-6 h-6 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center disabled:opacity-20 active:bg-black/70"
                                    aria-label="Move up"
                                  >
                                    <ChevronUp className="w-3 h-3 text-white" />
                                  </button>
                                  <button
                                    data-testid={`button-move-down-${item.id}`}
                                    onClick={() => moveItemDown(group.id, item.id)}
                                    disabled={isLastEver}
                                    className="w-6 h-6 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center disabled:opacity-20 active:bg-black/70"
                                    aria-label="Move down"
                                  >
                                    <ChevronDown className="w-3 h-3 text-white" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                          {/* Phantom cell if odd row */}
                          {pair.length === 1 && <div />}
                        </div>

                        {/* Split button between rows (not after the last row) */}
                        {!isLastRow && (
                          <button
                            data-testid={`button-split-after-${lastItemInRow.id}`}
                            onClick={() => splitAfterItem(group.id, lastItemInRow.id)}
                            className="w-full flex items-center gap-2 py-2 text-xs text-muted-foreground active:text-foreground transition-colors"
                          >
                            <div className="flex-1 h-px bg-border/60" />
                            <span className="flex items-center gap-1 text-[11px] font-medium">
                              <Scissors className="w-3 h-3" />
                              Split into new document
                            </span>
                            <div className="flex-1 h-px bg-border/60" />
                          </button>
                        )}
                        {/* Also show split after last row if items exist after it in the flat list (extra: when last item is not last in group) */}
                        {isLastRow && lastItemInRowIdx < group.items.length - 1 && (
                          <button
                            data-testid={`button-split-after-${lastItemInRow.id}`}
                            onClick={() => splitAfterItem(group.id, lastItemInRow.id)}
                            className="w-full flex items-center gap-2 py-2 text-xs text-muted-foreground active:text-foreground transition-colors"
                          >
                            <div className="flex-1 h-px bg-border/60" />
                            <span className="flex items-center gap-1 text-[11px] font-medium">
                              <Scissors className="w-3 h-3" />
                              Split into new document
                            </span>
                            <div className="flex-1 h-px bg-border/60" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Card footer tip */}
                {group.items.some((it) => it.type === "image") && (
                  <div className="px-4 pb-3">
                    <p className="text-[11px] text-muted-foreground">
                      Tap a photo to crop, rotate, or apply filters before saving.
                    </p>
                  </div>
                )}
              </div>

              {/* ── Between groups: merge separator ── */}
              {gIdx < groups.length - 1 && (
                <div className="flex items-center gap-3 py-0.5">
                  <div className="flex-1 h-px bg-border" />
                  <button
                    data-testid={`button-merge-group-${group.id}`}
                    onClick={() => mergeWithNext(group.id)}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-card border border-border rounded-full px-4 py-2 active:bg-muted"
                    style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}
                  >
                    <Merge className="w-3.5 h-3.5 rotate-90" />
                    Merge into one document
                  </button>
                  <div className="flex-1 h-px bg-border" />
                </div>
              )}
            </div>
          );
        })}

        {/* Add another document */}
        <button
          data-testid="button-add-new-group"
          onClick={() => {
            const newGroup: DocGroup = {
              id: uid(),
              name: defaultGroupName(groups.length),
              items: [],
            };
            setGroups((prev) => [...prev, newGroup]);
            setTimeout(() => fileInputRef.current?.click(), 80);
          }}
          className="w-full py-4 rounded-2xl border-2 border-dashed border-border/60 flex items-center justify-center gap-2 text-sm text-muted-foreground bg-card/50 active:bg-card"
        >
          <Plus className="w-4 h-4" />
          Add another document
        </button>

        <div className="h-4" />
      </div>

      {/* ── Bottom action bar ── */}
      <div className="flex-shrink-0 bg-card border-t border-border px-4 pt-3"
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}>
        {groups.some((g) => g.items.some((it) => it.type === "pdf")) && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 text-center mb-2">
            PDFs will be imported as-is into separate documents
          </p>
        )}
        <button
          data-testid="button-save-import"
          onClick={handleSave}
          disabled={!hasItems}
          className="w-full py-4 rounded-2xl bg-primary text-primary-foreground font-bold text-sm active:scale-[0.98] transition-transform flex items-center justify-center gap-2 disabled:opacity-40"
        >
          <Check className="w-5 h-5" />
          Save {outputDocCount} Document{outputDocCount !== 1 ? "s" : ""} to Docera
        </button>
      </div>

      {/* ── Photo editor overlay ── */}
      {editingItem && (
        <ScannerPage
          singleImageCanvas={editingItem.canvas}
          onEditedImage={handleEditComplete}
          onSaved={() => setEditingItem(null)}
          onCancel={() => setEditingItem(null)}
        />
      )}
    </div>
  );
}
