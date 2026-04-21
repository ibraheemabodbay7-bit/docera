import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import jsPDF from "jspdf";
import {
  ArrowLeft, Camera, Upload, RotateCcw, Loader2,
  Save, AlignRight, Info, FileText, ImageIcon, X,
  Minus, Plus, PlusCircle, ChevronLeft, ChevronRight,
  Sparkles,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useHwCredits } from "@/hooks/use-hw-credits";

// ── Block-based text document format (v2) ────────────────────────────────────
// Each block has a side ("left"|"right") and vertical order (y 0-1).
// Rendered as two clean readable columns, not scattered absolute positions.
export interface TextBlock {
  id: string;
  text: string;
  side: "left" | "right"; // which column on the page
  y: number;              // 0-1, vertical position for ordering within column
}

export interface TextDocPage {
  blocks: TextBlock[];
}

/** Multi-page text document — always stored as pages[] array */
export interface TextDocPages {
  v: 2;
  type: "text";
  lang: "he" | "en" | "mixed";
  pages: TextDocPage[];
  /** @deprecated legacy single-page field — present in old docs only */
  blocks?: TextBlock[];
}

/** Normalize a raw block from storage (handles both old x/y/w format and new side/y format) */
function normalizeBlock(b: Record<string, unknown>, i: number): TextBlock {
  const id = typeof b.id === "string" ? b.id : `b${i}`;
  const text = typeof b.text === "string" ? b.text : "";
  const y = typeof b.y === "number" ? b.y : 0.04;
  // New format has "side"
  if (b.side === "left" || b.side === "right") {
    return { id, text, side: b.side, y };
  }
  // Old format had "x" — derive side from position
  const x = typeof b.x === "number" ? b.x : 0;
  return { id, text, side: x < 0.5 ? "left" : "right", y };
}

export function parseTextDocPages(pagesJson: string): TextDocPages | null {
  try {
    const p = JSON.parse(pagesJson);
    if (p?.v === 2 && p?.type === "text") {
      // New multi-page format
      if (Array.isArray(p.pages)) {
        return {
          v: 2, type: "text",
          lang: p.lang ?? "en",
          pages: (p.pages as Array<{ blocks: unknown[] }>).map(pg => ({
            blocks: (Array.isArray(pg.blocks) ? pg.blocks : []).map(
              (b, i) => normalizeBlock(b as Record<string, unknown>, i)
            ),
          })),
        };
      }
      // Old single-page format with blocks[]
      if (Array.isArray(p.blocks)) {
        return {
          v: 2, type: "text",
          lang: p.lang ?? "en",
          pages: [{ blocks: (p.blocks as Record<string, unknown>[]).map(normalizeBlock) }],
        };
      }
    }
    // v1 legacy → single block on side determined by language
    if (p?.v === 1 && p?.type === "text" && typeof p.text === "string") {
      const lang = p.lang ?? "he";
      return {
        v: 2, type: "text", lang,
        pages: [{ blocks: [{ id: "b0", text: p.text, side: lang === "he" ? "right" : "left", y: 0.04 }] }],
      };
    }
  } catch {
    // not a text doc
  }
  return null;
}

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text: string): "he" | "en" | "mixed" | null {
  const hebChars = (text.match(/[\u05D0-\u05EA\uFB1D-\uFB4F]/g) ?? []).length;
  const engChars = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = hebChars + engChars;
  if (total === 0) return null;
  const hebRatio = hebChars / total;
  if (hebRatio >= 0.85) return "he";
  if (hebRatio <= 0.15) return "en";
  return "mixed";
}

function isRTLText(text: string): boolean {
  const heb = (text.match(/[\u05D0-\u05EA\uFB1D-\uFB4F]/g) ?? []).length;
  const eng = (text.match(/[A-Za-z]/g) ?? []).length;
  return heb > 0 && heb >= eng;
}

// ── BlockCell: single editable text block ────────────────────────────────────
interface BlockCellProps {
  block: TextBlock;
  fontSize: number;
  onTextChange: (id: string, text: string) => void;
}

function BlockCell({ block, fontSize, onTextChange }: BlockCellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const rtl = block.side === "right";

  useEffect(() => {
    if (ref.current) ref.current.textContent = block.text;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      dir={rtl ? "rtl" : "ltr"}
      onInput={() => {
        if (ref.current) onTextChange(block.id, ref.current.innerText);
      }}
      data-testid={`block-cell-${block.id}`}
      style={{
        fontFamily: "Arial, 'Arial Hebrew', 'Noto Sans Hebrew', Helvetica, sans-serif",
        fontSize: `${fontSize}px`,
        lineHeight: "1.9",
        textAlign: rtl ? "right" : "left",
        direction: rtl ? "rtl" : "ltr",
        outline: "none",
        minHeight: `${fontSize * 1.9}px`,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        width: "100%",
      }}
      className="focus:bg-primary/5 rounded-lg px-2 py-1 hover:bg-muted/20 transition-colors cursor-text"
    />
  );
}

// ── BlockEditor: row-by-row two-column layout preserving original page order ───
interface BlockEditorProps {
  blocks: TextBlock[];
  fontSize: number;
  onBlocksChange: (blocks: TextBlock[]) => void;
}

function BlockEditor({ blocks, fontSize, onBlocksChange }: BlockEditorProps) {
  function updateText(id: string, text: string) {
    onBlocksChange(blocks.map(b => (b.id === id ? { ...b, text } : b)));
  }

  if (blocks.length === 0) {
    return (
      <div className="w-full rounded-2xl border border-border/60 bg-white shadow-sm p-8 flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground/40 text-sm select-none">Recognized text will appear here</p>
      </div>
    );
  }

  // Sort all blocks by their vertical position to preserve original page order
  const sorted = [...blocks].sort((a, b) => a.y - b.y);
  const hasBoth = sorted.some(b => b.side === "left") && sorted.some(b => b.side === "right");

  if (!hasBoth) {
    // Single-column fallback
    return (
      <div className="w-full rounded-2xl border border-border/60 bg-white shadow-sm p-5 flex flex-col gap-3 min-h-[60vh]">
        {sorted.map(block => (
          <BlockCell key={block.id} block={block} fontSize={fontSize} onTextChange={updateText} />
        ))}
      </div>
    );
  }

  // Two-column grid — each row occupies one grid row, placed in its correct column.
  // Rows are rendered in top-to-bottom page order; the opposite column cell is empty.
  // rowGap is adaptive: y-difference between consecutive blocks drives the gap,
  // clamped between MIN_GAP and MAX_GAP so spacing stays natural.
  const MIN_GAP_PX = 6;
  const MAX_GAP_PX = 40;
  return (
    <div className="w-full rounded-2xl border border-border/60 bg-white shadow-sm p-5 min-h-[60vh]">
      {sorted.map((block, i) => {
        const prevY = i > 0 ? sorted[i - 1].y : block.y;
        const rawDiff = (block.y - prevY) * 600; // scale 0-1 diff to px-ish range
        const gap = i === 0 ? 0 : Math.max(MIN_GAP_PX, Math.min(rawDiff, MAX_GAP_PX));
        return (
          <div
            key={block.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1px 1fr",
              alignItems: "start",
              marginTop: `${gap}px`,
            }}
          >
            <Row block={block} fontSize={fontSize} onTextChange={updateText} />
          </div>
        );
      })}
    </div>
  );
}

// Renders one grid row: content in its column, divider in the middle, empty div on the other side
function Row({ block, fontSize, onTextChange }: { block: TextBlock; fontSize: number; onTextChange: (id: string, text: string) => void }) {
  const isLeft = block.side === "left";
  const cell = <BlockCell block={block} fontSize={fontSize} onTextChange={onTextChange} />;
  const empty = <div />;
  const divider = <div style={{ backgroundColor: "var(--border)", opacity: 0.4, width: "1px", alignSelf: "stretch" }} />;
  return (
    <>
      {isLeft ? cell : empty}
      {divider}
      {isLeft ? empty : cell}
    </>
  );
}

// ── PDF renderer: two-column canvas layout matching the editor ────────────────
function renderBlocksToCanvases(blocks: TextBlock[]): HTMLCanvasElement[] {
  const W = 1240, H = 1754;
  const FONT_SIZE = 26;
  const LINE_H = Math.round(FONT_SIZE * 1.9);
  const FONT = "Arial, 'Arial Hebrew', 'Noto Sans Hebrew', Helvetica, sans-serif";
  const MARGIN = 70;
  const GAP = 40;
  // Two symmetric columns
  const COL_W = Math.floor((W - MARGIN * 2 - GAP) / 2);
  const LEFT_X  = MARGIN;             // LTR: draw from here rightward
  const RIGHT_X = MARGIN + COL_W + GAP; // RTL: draw from (RIGHT_X + COL_W) leftward

  function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
      if (!para.trim()) { out.push(""); continue; }
      const words = para.split(/\s+/).filter(Boolean);
      let cur = "";
      for (const w of words) {
        const cand = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(cand).width <= maxW) { cur = cand; }
        else { if (cur) out.push(cur); cur = w; }
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.font = `${FONT_SIZE}px ${FONT}`;
  ctx.fillStyle = "#1a1a1a";

  const rtlDrawX = RIGHT_X + COL_W;
  // Gap limits for sequential rendering:
  // MIN: at least one line height between consecutive rows (never too tight)
  // MAX: at most 2.5 line heights (no huge empty stretches from raw y gaps)
  const MIN_BLOCK_GAP = Math.round(LINE_H * 1.2);
  const MAX_BLOCK_GAP = Math.round(LINE_H * 2.5);
  const CONTENT_H = H - MARGIN * 2;

  // Render blocks in page order using clamped-gap sequential positioning.
  // Raw y differences are preserved for relative spacing (close rows stay close,
  // distant rows get a bigger gap) but clamped so no gap exceeds MAX_BLOCK_GAP.
  const sorted = [...blocks].sort((a, b) => a.y - b.y);
  let cursorY = MARGIN + LINE_H;
  let prevBlockY = sorted.length > 0 ? sorted[0].y : 0;

  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];
    if (!block.text.trim()) continue;

    if (i > 0) {
      const rawGapPx = (block.y - prevBlockY) * CONTENT_H;
      const gap = Math.max(MIN_BLOCK_GAP, Math.min(rawGapPx, MAX_BLOCK_GAP));
      cursorY += gap;
    }

    const drawLines = (lines: string[], x: number) => {
      lines.forEach((line, li) => {
        if (line) ctx.fillText(line, x, cursorY + li * LINE_H);
      });
      cursorY += lines.length * LINE_H;
    };

    if (block.side === "left") {
      ctx.direction = "ltr";
      ctx.textAlign = "left";
      drawLines(wrapText(ctx, block.text, COL_W), LEFT_X);
    } else {
      ctx.direction = "rtl";
      ctx.textAlign = "right";
      drawLines(wrapText(ctx, block.text, COL_W), rtlDrawX);
    }

    prevBlockY = block.y;
  }

  // Footer watermark
  ctx.direction = "ltr";
  ctx.textAlign = "center";
  ctx.font = `14px ${FONT}`;
  ctx.fillStyle = "#aaaaaa";
  ctx.fillText("Created with Docera", W / 2, H - 30);

  return [canvas];
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function todayEN(): string {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function downscale(dataUrl: string, maxPx: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d")!.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.src = dataUrl;
  });
}

type Stage = "capture" | "processing" | "editor" | "saving";

/** One scan page inside the component */
interface ScanPage {
  id: string;
  imageUrl: string | null;
  blocks: TextBlock[];
}

function newScanPage(idx: number): ScanPage {
  return { id: `p${idx}-${Date.now()}`, imageUrl: null, blocks: [] };
}

interface ConvertPageProps {
  onBack: () => void;
  onSaved: () => void;
  editDocId?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function ConvertPage({ onBack, onSaved, editDocId }: ConvertPageProps) {
  const [stage, setStage] = useState<Stage>(editDocId ? "editor" : "capture");
  const [scanPages, setScanPages] = useState<ScanPage[]>([newScanPage(0)]);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  // captureImageUrl is transient — only used between "image selected" and "OCR done"
  const [captureImageUrl, setCaptureImageUrl] = useState<string | null>(null);
  const [docName, setDocName] = useState(`Handwriting ${todayEN()}`);
  const [ocrWarning, setOcrWarning] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showTip, setShowTip] = useState(true);
  const [loadingEdit, setLoadingEdit] = useState(!!editDocId);
  const [fontSize, setFontSize] = useState(14);
  const [editorKey, setEditorKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { credits, daysUntilReset } = useHwCredits();

  // Derived helpers for current page
  const currentPage = scanPages[currentPageIdx] ?? scanPages[0];
  const currentBlocks = currentPage?.blocks ?? [];

  // Derived helpers across all pages (for summary / lang detection)
  const allText = scanPages.flatMap(pg => pg.blocks.map(b => b.text)).join(" ");
  const wordCount = allText.trim() ? allText.trim().split(/\s+/).length : 0;
  const docLang = detectLang(allText) ?? "en";

  function setCurrentBlocks(blocks: TextBlock[]) {
    setScanPages(prev => prev.map((pg, i) => i === currentPageIdx ? { ...pg, blocks } : pg));
  }

  // ── Load existing text document for editing ──────────────────────────────
  useEffect(() => {
    if (!editDocId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await apiFetch(`/api/documents/${editDocId}`);
        if (!res.ok) throw new Error("Not found");
        const doc = await res.json() as { name: string; pages: string };
        if (cancelled) return;
        const parsed = parseTextDocPages(doc.pages || "");
        if (!parsed) {
          toast({ title: "Cannot edit this document", description: "Text content was not found", variant: "destructive" });
          onBack();
          return;
        }
        setDocName(doc.name);
        // Populate scanPages from the parsed multi-page doc
        setScanPages(parsed.pages.map((pg, i) => ({
          id: `loaded-p${i}`,
          imageUrl: null,
          blocks: pg.blocks,
        })));
        setCurrentPageIdx(0);
        setEditorKey(k => k + 1);
        setLoadingEdit(false);
      } catch (err: unknown) {
        if (!cancelled) {
          toast({ title: "Failed to load", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
          onBack();
        }
      }
    }
    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDocId]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCaptureImageUrl(ev.target?.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  }, []);

  // ── OCR recognition — server-side via OpenAI Vision ──────────────────────
  // targetIdx: which scanPages slot to update with the result
  const runOCR = useCallback(async (imgUrl: string, targetIdx: number) => {
    setStage("processing");
    setOcrWarning(null);
    try {
      const scaled = await downscale(imgUrl, 1500);
      const res = await apiRequest("POST", "/api/ocr/hebrew", { imageDataUrl: scaled });
      if (!res.ok) {
        const errData = await res.json() as { error?: string; remaining?: number };
        if (res.status === 402 && errData.error === "no_credits") {
          // Invalidate credits cache so the paywall renders immediately
          queryClient.invalidateQueries({ queryKey: ["/api/credits/hw"] });
          throw new Error("no_credits");
        }
        throw new Error(errData.error ?? "Recognition failed");
      }
      // Refresh credits count after a successful scan
      queryClient.invalidateQueries({ queryKey: ["/api/credits/hw"] });
      const data = await res.json() as { blocks: Array<{ text: string; side: string; y?: number }>; warning?: string };
      const mapped: TextBlock[] = (data.blocks ?? [])
        .filter(b => b.text?.trim())
        .map((b, i) => ({
          id: `b${i}`,
          text: b.text.trim(),
          side: (b.side === "left" || b.side === "right") ? b.side : "left",
          y: typeof b.y === "number" ? Math.max(0, Math.min(0.95, b.y)) : 0.05 + i * 0.01,
        }));
      // Store blocks + image in the target page
      setScanPages(prev => prev.map((pg, i) => i === targetIdx
        ? { ...pg, imageUrl: imgUrl, blocks: mapped }
        : pg
      ));
      setCurrentPageIdx(targetIdx);
      setEditorKey(k => k + 1);
      setOcrWarning(data.warning ?? null);
      setShowTip(true);
      setShowOriginal(false);
      setCaptureImageUrl(null);
      setStage("editor");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "OCR failed";
      // no_credits: paywall is shown automatically — don't show a confusing error toast
      if (msg !== "no_credits") {
        toast({ title: "Recognition failed", description: msg, variant: "destructive" });
      }
      // If this was a new page being added, remove the empty placeholder
      setScanPages(prev => {
        if (prev.length > 1 && prev[targetIdx]?.blocks.length === 0) {
          const next = prev.filter((_, i) => i !== targetIdx);
          return next;
        }
        return prev;
      });
      setCurrentPageIdx(prev => Math.min(prev, scanPages.length - 2 < 0 ? 0 : scanPages.length - 2));
      setCaptureImageUrl(null);
      setStage(scanPages.length > 1 ? "editor" : "capture");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  // ── Export / save ─────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      // Render every scan page to canvas(es), then combine into one multi-page PDF
      const EMPTY_BLOCK: TextBlock = { id: "b0", text: "(empty)", side: "left", y: 0.04 };
      const allCanvases: HTMLCanvasElement[] = [];
      for (const pg of scanPages) {
        const blocks = pg.blocks.length ? pg.blocks : [EMPTY_BLOCK];
        const pageCanvases = renderBlocksToCanvases(blocks);
        allCanvases.push(...pageCanvases);
      }

      const first = allCanvases[0];
      const pdf = new jsPDF({ unit: "px", format: [first.width, first.height], orientation: "p" });
      pdf.addImage(first.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, first.width, first.height);
      for (let i = 1; i < allCanvases.length; i++) {
        const c = allCanvases[i];
        pdf.addPage([c.width, c.height], "p");
        pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, c.width, c.height);
      }
      const dataUrl = pdf.output("datauristring");
      const size = Math.round((dataUrl.length * 3) / 4);

      const thumbCanvas = document.createElement("canvas");
      thumbCanvas.width = 480;
      thumbCanvas.height = Math.round(480 * (first.height / first.width));
      thumbCanvas.getContext("2d")!.drawImage(first, 0, 0, thumbCanvas.width, thumbCanvas.height);
      const thumbUrl = thumbCanvas.toDataURL("image/jpeg", 0.80);

      const pages: TextDocPages = {
        v: 2, type: "text", lang: docLang,
        pages: scanPages.map(pg => ({ blocks: pg.blocks })),
      };

      if (editDocId) {
        const res = await apiRequest("PATCH", `/api/documents/${editDocId}`, {
          name: docName, dataUrl, size, thumbUrl, pages: JSON.stringify(pages),
        });
        if (!res.ok) throw new Error("Failed to update document");
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/documents", {
          name: docName, type: "pdf", dataUrl, size, thumbUrl, folderId: null,
          pages: JSON.stringify(pages),
        });
        if (!res.ok) throw new Error("Failed to save document");
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      if (editDocId) queryClient.invalidateQueries({ queryKey: ["/api/documents", editDocId] });
      toast({ title: editDocId ? "Updated!" : "Saved!", description: `"${docName}" saved to your library.` });
      onSaved();
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setStage("editor");
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 1 — CAPTURE
  // ═══════════════════════════════════════════════════════════════════════════
  if (stage === "capture") {
    // Are we adding a page to an already-started document?
    const isAddingPage = scanPages.length > 1 || scanPages[0].blocks.length > 0;
    const addingPageNumber = currentPageIdx + 1;

    // Determine back button behaviour:
    // - Adding page → go back to editor (don't lose existing pages)
    // - First page → exit to home
    const handleCaptureBack = () => {
      if (isAddingPage) {
        // Remove the empty placeholder page we added when the user clicked "+ Add Page"
        setScanPages(prev => {
          if (prev.length > 1 && prev[currentPageIdx]?.blocks.length === 0) {
            return prev.filter((_, i) => i !== currentPageIdx);
          }
          return prev;
        });
        setCurrentPageIdx(prev => Math.max(0, prev - 1));
        setCaptureImageUrl(null);
        setStage("editor");
      } else {
        onBack();
      }
    };

    return (
      <div className="min-h-screen bg-background flex flex-col">
        <div
          className="flex items-center gap-3 px-4 pb-4 border-b border-border bg-card"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          <button data-testid="button-convert-back" onClick={handleCaptureBack}
            className="p-2 -ml-2 rounded-full active:opacity-60">
            <ArrowLeft className="w-5 h-5 text-foreground" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-foreground text-lg leading-none">
              {isAddingPage ? `Add Page ${addingPageNumber}` : "Handwriting"}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isAddingPage ? `Scanning page ${addingPageNumber} of ${scanPages.length}` : "Step 1 of 3 — Scan"}
            </p>
          </div>
          {/* Credits badge */}
          <div
            data-testid="credits-badge"
            className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-semibold ${
              credits === 0
                ? "bg-red-100 text-red-600"
                : credits <= 3
                ? "bg-amber-100 text-amber-700"
                : "bg-primary/10 text-primary"
            }`}
          >
            <Sparkles className="w-3 h-3" />
            <span>{credits} scans left</span>
          </div>
        </div>

        {captureImageUrl ? (
          <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5">
            <div className="w-full max-w-sm rounded-2xl overflow-hidden border border-border shadow-md">
              <img src={captureImageUrl} alt="Selected page" className="w-full object-contain max-h-[50vh]" />
            </div>
            <div className="flex items-start gap-2.5 w-full max-w-sm bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 leading-relaxed">
                For best results — clear ink, good lighting, page straight and centered.
              </p>
            </div>
            <div className="flex gap-3 w-full max-w-sm">
              <button data-testid="button-convert-retake" onClick={() => setCaptureImageUrl(null)}
                className="flex-1 py-3.5 rounded-2xl border border-border bg-card text-foreground font-medium text-sm flex items-center justify-center gap-2 active:scale-[0.98]">
                <RotateCcw className="w-4 h-4" />
                Retake
              </button>
              <button data-testid="button-convert-run" onClick={() => runOCR(captureImageUrl, currentPageIdx)}
                className="flex-[2] py-3.5 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 active:scale-[0.98]"
                style={{ boxShadow: "0 4px 20px rgba(17,62,97,0.35)" }}>
                <AlignRight className="w-4 h-4" />
                Recognize Text
              </button>
            </div>
          </div>
        ) : credits === 0 ? (
          /* ── Scan limit reached ────────────────────────────────────────────── */
          <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6">
            <div className="w-24 h-24 rounded-3xl bg-amber-50 border border-amber-100 flex items-center justify-center">
              <Sparkles className="w-11 h-11 text-amber-500" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-bold text-foreground mb-2">
                You've used all 10 scans this month
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                {daysUntilReset !== null && daysUntilReset > 0
                  ? `Your 10 scans reset in ${daysUntilReset} day${daysUntilReset === 1 ? "" : "s"}.`
                  : "Your scans reset at the start of each month."}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-8 gap-6">
            <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center">
              <AlignRight className="w-12 h-12 text-primary" />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-bold text-foreground mb-2">Handwriting → Text</h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                Take a photo of a handwritten page. The AI recognizes Hebrew and English text and preserves the original layout.
              </p>
            </div>
            <div className="flex flex-col gap-3 w-full max-w-xs">
              <button data-testid="button-convert-camera"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.accept = "image/*";
                    fileInputRef.current.setAttribute("capture", "environment");
                    fileInputRef.current.click();
                  }
                }}
                className="w-full py-4 rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2.5 active:scale-[0.98]"
                style={{ boxShadow: "0 4px 20px rgba(17,62,97,0.35)" }}>
                <Camera className="w-5 h-5" />
                Take Photo
              </button>
              <button data-testid="button-convert-upload"
                onClick={() => {
                  if (fileInputRef.current) {
                    fileInputRef.current.removeAttribute("capture");
                    fileInputRef.current.accept = "image/*";
                    fileInputRef.current.click();
                  }
                }}
                className="w-full py-4 rounded-2xl border border-border bg-card text-foreground font-medium flex items-center justify-center gap-2.5 active:scale-[0.98]">
                <Upload className="w-5 h-5 text-muted-foreground" />
                Upload from Gallery
              </button>
            </div>
            <div className="w-full max-w-xs bg-card border border-border rounded-2xl p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Tips for better results</p>
              {["Clear writing with dark ink", "Good lighting, no shadows", "Page straight and centered"].map((t) => (
                <p key={t} className="text-xs text-muted-foreground mb-1">• {t}</p>
              ))}
            </div>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESSING
  // ═══════════════════════════════════════════════════════════════════════════
  if (stage === "processing") {
    const processingPageNum = currentPageIdx + 1;
    const totalPages = scanPages.length;
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8 gap-8">
        <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center">
          <Loader2 className="w-12 h-12 text-primary animate-spin" />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold text-foreground mb-1">Recognizing handwriting…</h2>
          <p className="text-sm text-muted-foreground">
            {totalPages > 1
              ? `Processing page ${processingPageNum} of ${totalPages}`
              : "Sending to AI for recognition"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">AI Recognition</p>
        </div>
        <div className="w-full max-w-xs bg-card border border-border rounded-2xl px-5 py-4 text-center">
          <p className="text-xs text-muted-foreground leading-relaxed">
            AI-powered recognition may take a few seconds.
            <br />
            You can correct any mistakes after recognition.
          </p>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2 — TEXT EDITOR
  // ═══════════════════════════════════════════════════════════════════════════
  if (stage === "editor") {
    if (loadingEdit) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-10 h-10 text-primary animate-spin" />
        </div>
      );
    }

    // "Add Page" handler — appends a new empty ScanPage and goes to capture
    const handleAddPage = () => {
      const newIdx = scanPages.length;
      setScanPages(prev => [...prev, newScanPage(newIdx)]);
      setCurrentPageIdx(newIdx);
      setCaptureImageUrl(null);
      setShowOriginal(false);
      setStage("capture");
    };

    // "Delete page" handler — removes a page (only if more than 1 page)
    const handleDeletePage = (idx: number) => {
      if (scanPages.length <= 1) return;
      setScanPages(prev => prev.filter((_, i) => i !== idx));
      setCurrentPageIdx(prev => Math.min(prev, scanPages.length - 2));
      setEditorKey(k => k + 1);
    };

    return (
      <div className="min-h-screen bg-background flex flex-col">
        {/* Editor header */}
        <div
          className="flex-shrink-0 flex items-center gap-2 px-4 pb-3 border-b border-border bg-card"
          style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
        >
          <button data-testid="button-editor-back"
            onClick={() => {
              if (editDocId) { onBack(); return; }
              if (scanPages.length <= 1) { setStage("capture"); return; }
              // Multi-page new doc: back goes to capture for page 1
              setCurrentPageIdx(0);
              setStage("capture");
            }}
            className="p-2 -ml-2 rounded-full active:opacity-60">
            <ArrowLeft className="w-5 h-5 text-foreground" />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground font-medium leading-none truncate">{docName || "Untitled"}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {scanPages.length} page{scanPages.length !== 1 ? "s" : ""} · {wordCount} words
            </p>
          </div>

          {/* Font size controls */}
          <div className="flex items-center gap-0.5 border border-border rounded-xl overflow-hidden">
            <button
              data-testid="button-font-decrease"
              onClick={() => setFontSize(s => Math.max(10, s - 2))}
              className="px-2.5 py-1.5 active:opacity-60 active:bg-border"
              aria-label="Decrease font size"
            >
              <Minus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <span className="text-xs font-medium text-muted-foreground w-7 text-center select-none">{fontSize}</span>
            <button
              data-testid="button-font-increase"
              onClick={() => setFontSize(s => Math.min(34, s + 2))}
              className="px-2.5 py-1.5 active:opacity-60 active:bg-border"
              aria-label="Increase font size"
            >
              <Plus className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          <button data-testid="button-editor-next"
            onClick={() => setStage("saving")}
            className="px-4 py-2 rounded-xl bg-primary text-primary-foreground font-semibold text-sm flex items-center gap-1.5 active:scale-[0.98]"
            style={{ boxShadow: "0 2px 12px rgba(17,62,97,0.30)" }}>
            <Save className="w-4 h-4" />
            Save
          </button>
        </div>

        {/* ── Page tabs ─────────────────────────────────────────────────────── */}
        <div className="flex-shrink-0 bg-card border-b border-border">
          <div className="flex items-center overflow-x-auto scrollbar-none px-2 py-1.5 gap-1">
            {scanPages.map((pg, idx) => (
              <div key={pg.id} className="flex items-center flex-shrink-0">
                <button
                  data-testid={`button-page-tab-${idx}`}
                  onClick={() => { setCurrentPageIdx(idx); setEditorKey(k => k + 1); setShowOriginal(false); }}
                  className={[
                    "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5",
                    idx === currentPageIdx
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-border/60 active:opacity-70",
                  ].join(" ")}
                >
                  {idx === currentPageIdx ? (
                    <>
                      <ChevronLeft className="w-3 h-3 opacity-60" />
                      Page {idx + 1}
                      <ChevronRight className="w-3 h-3 opacity-60" />
                    </>
                  ) : (
                    `Page ${idx + 1}`
                  )}
                </button>
                {/* Delete page button — only visible when > 1 page */}
                {scanPages.length > 1 && (
                  <button
                    data-testid={`button-delete-page-${idx}`}
                    onClick={() => handleDeletePage(idx)}
                    className="ml-0.5 p-0.5 rounded-full text-muted-foreground/50 hover:text-destructive active:opacity-60"
                    aria-label={`Delete page ${idx + 1}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}

            {/* Add Page button */}
            {!editDocId && (
              <button
                data-testid="button-add-page"
                onClick={handleAddPage}
                className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-primary border border-dashed border-primary/40 hover:bg-primary/5 active:opacity-70 ml-1"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                Add Page
              </button>
            )}
          </div>
        </div>

        {/* Accuracy tip */}
        {showTip && !editDocId && (
          <div className="flex-shrink-0 flex items-start gap-2.5 bg-blue-50 border-b border-blue-200 px-4 py-3">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-blue-800 leading-relaxed flex-1">
              Tap any text block to edit. Use "Add Page" to scan more pages. Tap Save when done.
            </p>
            <button onClick={() => setShowTip(false)} className="flex-shrink-0 active:opacity-60">
              <X className="w-3.5 h-3.5 text-blue-500" />
            </button>
          </div>
        )}

        {/* Low-confidence warning */}
        {ocrWarning && (
          <div className="flex-shrink-0 flex items-start gap-2.5 bg-amber-50 border-b border-amber-200 px-4 py-3">
            <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 leading-relaxed flex-1">{ocrWarning}</p>
            <button onClick={() => setOcrWarning(null)} className="flex-shrink-0 active:opacity-60">
              <X className="w-3.5 h-3.5 text-amber-500" />
            </button>
          </div>
        )}

        {/* Original image toggle — shows image for current page */}
        {currentPage?.imageUrl && (
          <div className="flex-shrink-0 border-b border-border">
            <button
              data-testid="button-toggle-original"
              onClick={() => setShowOriginal(v => !v)}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-muted-foreground active:opacity-60"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              {showOriginal ? "Hide original scan" : "Show original scan"}
            </button>
            {showOriginal && (
              <div className="px-4 pb-3">
                <img src={currentPage.imageUrl} alt={`Original page ${currentPageIdx + 1}`}
                  className="w-full max-h-48 object-contain rounded-xl border border-border" />
              </div>
            )}
          </div>
        )}

        {/* Document editor area */}
        <div className="flex-1 flex flex-col bg-background overflow-hidden">
          {/* Document title */}
          <div className="px-5 pt-4 pb-3 border-b border-border/50 flex items-center gap-3">
            <input
              data-testid="input-doc-title"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              dir="auto"
              placeholder="Document title"
              className="flex-1 bg-transparent text-xl font-bold text-foreground border-none outline-none placeholder:text-muted-foreground/50"
              style={{ fontFamily: "Arial, 'Arial Hebrew', Helvetica, sans-serif" }}
            />
            {(() => {
              const lang = detectLang(allText);
              if (lang === "he") return <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0">✓ Hebrew</span>;
              if (lang === "en") return <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2 py-0.5 shrink-0">✓ English</span>;
              if (lang === "mixed") return <span className="text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-2 py-0.5 shrink-0">✓ Mixed</span>;
              return null;
            })()}
          </div>

          {/* Page label */}
          {scanPages.length > 1 && (
            <div className="px-5 pt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Page {currentPageIdx + 1} of {scanPages.length}
              </span>
              <span className="text-xs text-muted-foreground">
                · {currentBlocks.length} block{currentBlocks.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}

          {/* Page layout editor — keyed to currentPageIdx so it resets on tab switch */}
          <div className="flex-1 overflow-y-auto p-4">
            <BlockEditor
              key={`${editorKey}-${currentPageIdx}`}
              blocks={currentBlocks}
              fontSize={fontSize}
              onBlocksChange={setCurrentBlocks}
            />
          </div>

          <div className="flex-shrink-0 px-5 pb-5 pt-1">
            <p className="text-center text-xs text-muted-foreground">
              Tap any block to edit · Tap Save to export all pages as PDF
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 3 — EXPORT
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div
        className="flex items-center gap-3 px-4 pb-4 border-b border-border bg-card"
        style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}
      >
        <button data-testid="button-saving-back" onClick={() => setStage("editor")}
          disabled={saveMutation.isPending}
          className="p-2 -ml-2 rounded-full active:opacity-60 disabled:opacity-40">
          <ArrowLeft className="w-5 h-5 text-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-foreground text-lg leading-none">Save</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Step 3 of 3 — Export PDF</p>
        </div>
      </div>

      <div className="flex-1 flex flex-col px-6 py-8 gap-6">
        <div className="bg-card border border-border rounded-2xl p-5">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide block mb-2">Document name</label>
          <input
            data-testid="input-save-doc-name"
            value={docName}
            onChange={(e) => setDocName(e.target.value)}
            disabled={saveMutation.isPending}
            className="w-full bg-transparent text-lg font-bold text-foreground border-b border-border pb-1 outline-none focus:border-primary disabled:opacity-60"
            placeholder="Document name"
          />
        </div>

        <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Summary</p>
          <div className="flex items-center gap-3">
            <FileText className="w-9 h-9 text-primary flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">{docName || "Untitled document"}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {scanPages.length} page{scanPages.length !== 1 ? "s" : ""} · {wordCount} words · {docLang === "en" ? "English" : docLang === "mixed" ? "Hebrew + English" : "Hebrew"} · PDF
              </p>
            </div>
          </div>
          <div className="pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Text blocks will be exported to a PDF preserving the original page layout. You can reopen and edit at any time.
            </p>
          </div>
        </div>

        <button data-testid="button-save-confirm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !docName.trim()}
          className="w-full py-4 rounded-2xl bg-primary text-primary-foreground font-bold text-base flex items-center justify-center gap-2.5 active:scale-[0.98] disabled:opacity-60"
          style={{ boxShadow: "0 4px 20px rgba(17,62,97,0.35)" }}>
          {saveMutation.isPending
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Saving…</>
            : <><Save className="w-5 h-5" /> {editDocId ? "Update Document" : "Save as PDF"}</>}
        </button>

        <p className="text-center text-xs text-muted-foreground">
          The document will be saved to your library and can be reopened and edited at any time
        </p>
      </div>
    </div>
  );
}
