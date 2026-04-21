import { Camera, CameraResultType, CameraSource, GalleryImageOptions } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import {
  useRef, useState, useEffect, useCallback, useMemo, memo,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, apiFetch } from "@/lib/queryClient";
import {
  ImageIcon, Plus, X, FileText, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  RotateCw, RotateCcw, Check, ScanSearch,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import jsPDF from "jspdf";
import {
  type QuadPoints, DEFAULT_QUAD, perspectiveWarp, documentFilter, idFilter,
  flipCanvas, noShadowFilter, isScreenshotLike, sharpenCanvas,
} from "@/lib/imageProcessing";
import { detectDocumentCorners } from "@/lib/documentDetection";
import { getSetting, getBoolSetting } from "@/lib/settings";
import { dataUrlToBlob, docFilename } from "@/lib/docUtils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScannerPageProps {
  folderId?: string;
  /** If provided, load this document's pages for re-editing instead of starting the camera */
  editDocId?: string;
  /** If provided, auto-assign this client to the document after saving */
  clientId?: string;
  onSaved: () => void;
  onCancel: () => void;
  /**
   * Return mode: pre-load a single image for editing.
   * When set, the editor opens immediately with this canvas pre-loaded.
   * Requires onEditedImage to be provided.
   */
  singleImageCanvas?: HTMLCanvasElement;
  /**
   * Return mode callback: called instead of saving to the API.
   * Receives the processed (warped + filtered + rotated) canvas and its JPEG data URL.
   */
  onEditedImage?: (canvas: HTMLCanvasElement, dataUrl: string) => void;
}

/** Serializable form of a ScanPage stored in the DB for later re-editing */
interface SerializablePage {
  id: string;
  originalDataUrl: string; // JPEG 0.92 — lossless enough to re-warp and re-filter
  quad: QuadPoints;
  filterMode: FilterMode;
  filterStrength: number;
  rotation: Rotation;
  flipH?: boolean;
  flipV?: boolean;
}

type Stage = "camera" | "editor" | "pdf-name";
type FilterMode = "none" | "auto" | "noshadow" | "color" | "document" | "id";
type Rotation = number;
type FilterScope = "page" | "all";

interface ScanPage {
  id: string;
  original: HTMLCanvasElement;
  previewUrl: string;   // medium quality for editor display
  thumbUrl: string;     // low quality for thumbnail strip
  quad: QuadPoints;
  filterMode: FilterMode;
  filterStrength: number;
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  processedUrl: string; // cached document-filter / noshadow preview
  /** True once the user has manually dragged a crop corner — blocks auto-detection from overwriting */
  manualCrop: boolean;
  /** True when the source image is likely a screenshot (affects sharpness treatment in export) */
  isScreenshot: boolean;
}

interface ImgRect { x: number; y: number; w: number; h: number }

// ─── Pure helpers (module-level, never recreated) ──────────────────────────────

const FILTER_LABELS: Record<FilterMode, string> = {
  none: "Original", auto: "Auto", noshadow: "No Shadow", color: "Color", document: "B&W Doc", id: "ID Card",
};

function getFilterCSS(mode: FilterMode, strength: number): string {
  if (mode === "noshadow") {
    const s = strength / 100;
    return `brightness(${(1 + s * 0.55).toFixed(2)}) contrast(${(1 + s * 2.8).toFixed(2)}) saturate(${Math.max(0, 0.4 - s * 0.4).toFixed(2)})`;
  }
  if (mode === "auto") return "brightness(1.1) contrast(1.4) saturate(0.85)";
  if (mode === "color") return "brightness(1.15) contrast(1.5) saturate(1.3)";
  if (mode === "document") return "brightness(1.3) contrast(2.5) saturate(0) grayscale(1)";
  // "id": live CSS preview approximates the canvas unsharp-mask + S-curve
  if (mode === "id") return "brightness(1.04) contrast(1.2) saturate(0.92)";
  return "";
}

function getFilteredCanvas(canvas: HTMLCanvasElement, mode: FilterMode, strength: number): HTMLCanvasElement {
  if (mode === "none") return canvas;
  if (mode === "document") return documentFilter(canvas);
  if (mode === "id") return idFilter(canvas);
  if (mode === "noshadow") return noShadowFilter(canvas, strength);
  const css = getFilterCSS(mode, strength);
  if (!css) return canvas;
  const out = document.createElement("canvas");
  out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext("2d")!;
  ctx.filter = css; ctx.drawImage(canvas, 0, 0); ctx.filter = "none";
  return out;
}

function rotateCanvas(canvas: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  if (deg === 0) return canvas;
  const rad = (deg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  const w = Math.round(canvas.width * absCos + canvas.height * absSin);
  const h = Math.round(canvas.width * absSin + canvas.height * absCos);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

function makeId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

/**
 * Apply a drag update for any handle key.
 * Corner keys (tl/tr/bl/br): move that single corner in x+y.
 * Edge keys (tc/bc/lc/rc): move the two corners on that edge along
 * the constrained axis only — opposite edge is untouched.
 */
// Rotate a normalised [0,1] point from original-image space into display space.
// Uses rad = -rot so that 90° CW produces the same result as the original switch:
//   90°→(y,1-x)  180°→(1-x,1-y)  270°→(1-y,x)
function rotatePoint(p: { x: number; y: number }, rot: number): { x: number; y: number } {
  if (rot === 0) return p;
  const rad = -(rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = p.x - 0.5, cy = p.y - 0.5;
  return { x: cx * cos - cy * sin + 0.5, y: cx * sin + cy * cos + 0.5 };
}

// Inverse of rotatePoint — maps display-space back to original-image space.
// Uses rad = +rot (inverse rotation).
function unrotatePoint(rx: number, ry: number, rot: number): { x: number; y: number } {
  if (rot === 0) return { x: rx, y: ry };
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = rx - 0.5, cy = ry - 0.5;
  return { x: cx * cos - cy * sin + 0.5, y: cx * sin + cy * cos + 0.5 };
}

function applyDragUpdate(base: QuadPoints, handleKey: string, relX: number, relY: number): QuadPoints {
  switch (handleKey) {
    // Corners — free movement
    case "tl": return { ...base, tl: { x: relX, y: relY } };
    case "tr": return { ...base, tr: { x: relX, y: relY } };
    case "bl": return { ...base, bl: { x: relX, y: relY } };
    case "br": return { ...base, br: { x: relX, y: relY } };
    // Edges — constrained to one axis, two corners, opposite edge unchanged
    case "tc": return { ...base, tl: { x: base.tl.x, y: relY }, tr: { x: base.tr.x, y: relY } };
    case "bc": return { ...base, bl: { x: base.bl.x, y: relY }, br: { x: base.br.x, y: relY } };
    case "lc": return { ...base, tl: { x: relX, y: base.tl.y }, bl: { x: relX, y: base.bl.y } };
    case "rc": return { ...base, tr: { x: relX, y: base.tr.y }, br: { x: relX, y: base.br.y } };
    default:   return base;
  }
}

/**
 * Maximum pixel dimension for any edge of a captured/imported image.
 * 3000px covers 3× Retina screenshots (iPhone 15 Pro is 1290×2796) without
 * downscaling them, keeping text at full clarity on import.
 */
const MAX_SCAN_DIM = 3000;

/**
 * Maximum dimension for PDF page images (camera photos).
 * 2048px gives crisp text at ~185 DPI equivalent for A4.
 */
const PDF_DIM = 2048;

/**
 * Maximum dimension for PDF page images when the source is a screenshot.
 * Screenshots are already pixel-perfect; we use their full imported resolution
 * (up to MAX_SCAN_DIM) to avoid any resolution loss before the perspective warp.
 */
const PDF_DIM_SCREENSHOT = MAX_SCAN_DIM;

/**
 * Maximum dimension for serialised original pages (stored for re-editing).
 * 2048px is the same as the import cap so no extra downscale occurs on save.
 */
const ORIG_DIM = 2048;

/** Yield one animation frame to let the browser paint before heavy work. */
const yieldToMain = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Downscale canvas so its longest edge is ≤ maxDim.
 * Returns the SAME canvas unchanged if it already fits.
 */
function downscaleCanvas(canvas: HTMLCanvasElement, maxDim = MAX_SCAN_DIM): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= maxDim) return canvas;
  const scale = maxDim / longest;
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

/** Load a data URL into a canvas element (async — waits for decode), then downscale to MAX_SCAN_DIM. */
function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      resolve(downscaleCanvas(canvas));
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = dataUrl;
  });
}

/**
 * Downscale canvas to at most maxW wide (maintaining aspect ratio) and encode as JPEG.
 * @param maxW  Max output width in pixels (use 480+ for card thumbnails, 240 for strips)
 * @param quality  JPEG quality 0-1 (use 0.82+ for cards, 0.45 for tiny strips)
 */
function makeThumbnail(canvas: HTMLCanvasElement, maxW = 480, quality = 0.82): string {
  const scale = Math.min(1, maxW / canvas.width);
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, w, h);
  return out.toDataURL("image/jpeg", quality);
}

function makeScanPage(original: HTMLCanvasElement, isScreenshot = false): ScanPage {
  return {
    id: makeId(), original,
    previewUrl: original.toDataURL("image/jpeg", 0.88),  // editor display — slightly higher than before
    thumbUrl: makeThumbnail(original, 240, 0.45),        // tiny strip thumbnail — cheap
    quad: DEFAULT_QUAD,
    filterMode: "none", filterStrength: 60,
    rotation: 0, flipH: false, flipV: false,
    processedUrl: "",
    manualCrop: false, // auto-detection allowed until user drags a corner
    isScreenshot,
  };
}

// ─── Memoized sub-components ───────────────────────────────────────────────────

interface ThumbnailStripProps {
  pages: ScanPage[];
  currentIndex: number;
  onSelect: (i: number) => void;
  onAdd: () => void;
}

const ThumbnailStrip = memo(function ThumbnailStrip({ pages, currentIndex, onSelect, onAdd }: ThumbnailStripProps) {
  return (
    <div className="flex gap-1.5 px-3 pb-2 overflow-x-auto scrollbar-none" style={{ WebkitOverflowScrolling: "touch" }}>
      {pages.map((p, i) => {
        const css = p.filterMode !== "none" && p.filterMode !== "document" && p.filterMode !== "id"
          ? getFilterCSS(p.filterMode, p.filterStrength) : "";
        return (
          <button key={p.id} data-testid={`editor-thumb-${i}`} onClick={() => onSelect(i)}
            className={`relative flex-shrink-0 rounded-lg overflow-hidden transition-opacity ${i === currentIndex ? "ring-2 ring-primary" : "opacity-50"}`}>
            <img src={p.thumbUrl} alt="" loading="lazy"
              className="w-9 object-cover" style={{ height: 44, filter: css || undefined }} />
            <div className="absolute bottom-0 inset-x-0 bg-black/55 text-center" style={{ paddingBottom: 1, paddingTop: 1 }}>
              <span className="text-white font-bold" style={{ fontSize: 8 }}>{i + 1}</span>
            </div>
          </button>
        );
      })}
      <button data-testid="button-add-page-editor" onClick={onAdd}
        className="flex-shrink-0 w-9 rounded-lg bg-muted flex items-center justify-center" style={{ height: 44 }}>
        <Plus className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  );
});

interface FilterStripProps {
  filterMode: FilterMode;
  filterStrength: number;
  scope: FilterScope;
  pageCount: number;
  onFilterChange: (f: FilterMode) => void;
  onStrengthChange: (v: number) => void;
  onScopeChange: (s: FilterScope) => void;
}

const FilterStrip = memo(function FilterStrip({
  filterMode, filterStrength, scope, pageCount,
  onFilterChange, onStrengthChange, onScopeChange,
}: FilterStripProps) {
  return (
    <div className="px-4 mb-2">
      {/* Scope toggle */}
      {pageCount > 1 && (
        <div className="flex rounded-xl overflow-hidden border border-border mb-2 w-fit">
          <button data-testid="scope-page" onClick={() => onScopeChange("page")}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${scope === "page" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}>
            This page
          </button>
          <button data-testid="scope-all" onClick={() => onScopeChange("all")}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors ${scope === "all" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}>
            All {pageCount} pages
          </button>
        </div>
      )}

      {/* Filter buttons */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-none mb-1">
        {(["none", "auto", "noshadow", "document", "id"] as FilterMode[]).map((f) => (
          <button key={f} data-testid={`filter-${f}`} onClick={() => onFilterChange(f)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              filterMode === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}>
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {/* Noshadow strength slider */}
      {filterMode === "noshadow" && (
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-muted-foreground w-5 text-right flex-shrink-0">0%</span>
          <input type="range" min="0" max="100" step="1" value={filterStrength}
            onChange={(e) => onStrengthChange(Number(e.target.value))}
            className="flex-1 accent-primary" style={{ height: 4 }}
            data-testid="slider-noshadow-strength" />
          <span className="text-[10px] text-muted-foreground w-7 flex-shrink-0">100%</span>
          <span className="text-xs font-semibold text-primary w-8 flex-shrink-0">{filterStrength}%</span>
        </div>
      )}
    </div>
  );
});

interface PageDotsProps {
  count: number;
  current: number;
  onSelect: (i: number) => void;
}

const PageDots = memo(function PageDots({ count, current, onSelect }: PageDotsProps) {
  if (count <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-1.5 mb-2" data-testid="page-dots">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} onClick={() => onSelect(i)}
          className={`rounded-full transition-all duration-150 ${i === current ? "w-4 h-2 bg-primary" : "w-2 h-2 bg-muted-foreground/35"}`} />
      ))}
    </div>
  );
});

// ─── Main component ────────────────────────────────────────────────────────────

export default function ScannerPage({
  folderId, editDocId, clientId, onSaved, onCancel,
  singleImageCanvas, onEditedImage,
}: ScannerPageProps) {
  const { toast } = useToast();
  console.log("isNative:", Capacitor.isNativePlatform());
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // White save-bar is collapsible — collapsed by default to give max image area.
  const [panelExpanded, setPanelExpanded] = useState(false);

  // In edit mode or return mode we skip the camera and start straight in editor stage
  const [stage, setStage] = useState<Stage>(editDocId || singleImageCanvas ? "editor" : "camera");
  // In return mode, pre-populate with the provided canvas as a single page
  const [pages, _setPages] = useState<ScanPage[]>(
    singleImageCanvas ? [makeScanPage(singleImageCanvas, isScreenshotLike(singleImageCanvas))] : []
  );
  // True once any page is added / modified — starts false in edit mode so a
  // name-only save can skip full PDF regeneration.
  const pagesModifiedRef = useRef(!editDocId);
  // Stable wrapper that marks pages as modified before any state update.
  const setPages = useCallback((action: React.SetStateAction<ScanPage[]>) => {
    pagesModifiedRef.current = true;
    _setPages(action);
  }, []);
  // Save-flow progress message shown in the button label.
  const [saveProgress, setSaveProgress] = useState("");
  const setSaveProgressRef = useRef(setSaveProgress);
  setSaveProgressRef.current = setSaveProgress;
  // True while we are fetching + reconstructing an existing document's pages
  const [loadingEdit, setLoadingEdit] = useState(!!editDocId);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [cropFullscreen, setCropFullscreen] = useState(false);
  const cropContainerRef = useRef<HTMLDivElement>(null);
  const cropImgRectRef = useRef<ImgRect>({ x: 0, y: 0, w: 1, h: 1 });

  // ── PERFORMANCE: hot drag state (does NOT touch pages[] during drag) ────────
  const [activeQuad, setActiveQuad] = useState<QuadPoints | null>(null);

  // Always-current refs so the export mutation captures live state rather than
  // a potentially stale React closure (TanStack Query's mutationFn is synced via
  // useEffect, which fires after paint — a rapid drag→save tap can read old state).
  const pagesRef = useRef<ScanPage[]>(pages);
  pagesRef.current = pages;
  const activeQuadRef = useRef<QuadPoints | null>(null);
  activeQuadRef.current = activeQuad;
  const currentIndexRef = useRef(0);
  currentIndexRef.current = currentIndex;
  const draggingCorner = useRef<string | null>(null);
  const isDraggingHandle = useRef(false);
  // Quad captured at drag-START so the base is stable for the entire drag gesture.
  // This prevents a race where detection completes mid-drag and changes pages[].quad,
  // which would make the non-dragged corners appear to jump.
  const dragBaseRef = useRef<QuadPoints | null>(null);
  // svgDataRef: always-current mirror of svgData (set each render) so native
  // touch handlers can read handle screen positions without stale closures.
  const svgDataRef = useRef<{ qpx: Record<string, { x: number; y: number }>; mid: Record<string, { x: number; y: number }> } | null>(null);

  // ── PERFORMANCE: local slider state, debounced commit to pages[] ────────────
  const [localStrength, setLocalStrength] = useState(60);
  const strengthDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Non-hot state ────────────────────────────────────────────────────────────
  const [imgRect, setImgRect] = useState<ImgRect>({ x: 0, y: 0, w: 1, h: 1 });
  // imgRectRef: always-current mirror of imgRect so native touch handlers never read stale values
  const imgRectRef = useRef<ImgRect>({ x: 0, y: 0, w: 1, h: 1 });
  // elemRect: CSS layout bounds for the <img> element — always equals imgRect
  // because rotation is baked into displayUrl (no CSS rotation on the element).
  const [elemRect, setElemRect] = useState<ImgRect>({ x: 0, y: 0, w: 1, h: 1 });
  // Rotation value kept in a ref so drag callbacks can read it without
  // needing a stale-closure workaround.
  const rotationRef = useRef(0);
  // displayUrl: the source URL shown in the <img> element.
  // For rotation=0 it equals imgSrc; for other angles it is a canvas-rotated
  // copy so that no CSS transform is needed and overflow:hidden never clips it.
  const [displayUrl, setDisplayUrl] = useState("");
  const [containerSize, setContainerSize] = useState({ w: 1, h: 1 });
  const [processing, setProcessing] = useState(false);
  const [documentName, setDocumentName] = useState(() => {
    const prefix = getSetting("filenamePrefix", "Scan");
    return `${prefix} ${new Date().toLocaleDateString()}`;
  });
  const [cameraError, setCameraError] = useState("");

  // PDF import
  const [pickedPdfDataUrl, setPickedPdfDataUrl] = useState("");
  const [pickedPdfName, setPickedPdfName] = useState("");

  const isNative = Capacitor.isNativePlatform();

  // ── Auto-detection state (tracks which pages are currently being analysed) ──
  // Stored as a Set of page IDs so we can show a "Detecting…" indicator per page.
  const [detectingIds, setDetectingIds] = useState<Set<string>>(new Set());

  // Swipe tracking (refs = no re-renders)
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  // ── Derived state ─────────────────────────────────────────────────────────────

  // Memoize currentPage so sub-components receive a stable reference when other pages change
  const currentPage = useMemo(() => pages[currentIndex] ?? null, [pages, currentIndex]);

  // The quad shown in the overlay: use live drag state if dragging, else committed page quad
  const displayQuad = activeQuad ?? currentPage?.quad ?? DEFAULT_QUAD;

  // Sync localStrength when switching pages
  useEffect(() => {
    if (currentPage) setLocalStrength(currentPage.filterStrength);
  }, [currentPage?.id]); // only when page id changes (i.e. navigating to different page)

  // ── Camera ────────────────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    setCameraError("");

    // ── Capacitor (native iOS / Android) ─────────────────────────────────────
    // On a real device wrapped in Capacitor, navigator.mediaDevices is often
    // unavailable inside the WKWebView. Use the Capacitor Camera plugin instead:
    // it opens the OS native camera picker and returns an image data URL.
    // We detect Capacitor by checking for window.Capacitor.
    const isCapacitor = Capacitor.isNativePlatform();
    if (isCapacitor) {
      // Signal the UI to show the "use gallery / take photo" buttons instead of
      // a live viewfinder — the native OS camera handles the capture flow.
      // We set a special error message that the UI renders as native action buttons.
      setCameraError("__native__");
      return;
    }

    // 1. Secure context check — getUserMedia only works over HTTPS or localhost
    if (!window.isSecureContext) {
      setCameraError(
        "Camera requires a secure (HTTPS) connection.\n" +
        "Open this app via its HTTPS URL to use the camera, or pick an image from your library below."
      );
      return;
    }

    // 2. API availability check — undefined in some browsers / restricted iframes
    if (!navigator.mediaDevices?.getUserMedia) {
      let isEmbedded = false;
      try { isEmbedded = window.self !== window.top; } catch { isEmbedded = true; }

      setCameraError(
        isEmbedded
          ? "Camera is blocked in the embedded preview.\nOpen the app in a new browser tab to use the camera."
          : "Camera is not available in this browser.\nTry a different browser or pick an image from your library."
      );
      return;
    }

    // 3. Try to open camera — rear-facing, high resolution, autofocus.
    //
    // Constraint strategy:
    //   • Always request the rear camera (environment) — front camera is too
    //     low quality for document scanning.
    //   • Set a MINIMUM resolution floor (1280×720) so we never fall back to
    //     the default 640×480 which looks blurry at full-screen.
    //   • Cap frameRate at 30fps — the camera dedicates more sensor exposure
    //     time per frame, which results in sharper stills.
    //   • After obtaining the stream, apply continuous autofocus via
    //     applyConstraints() — this is the reliable path; advanced constraints
    //     in getUserMedia are silently ignored on many browsers.
    try {
      let stream: MediaStream | null = null;

      const attempts: MediaStreamConstraints[] = [
        // ① Rear camera, 4K ideal, 720p minimum — best quality
        {
          video: {
            facingMode: { exact: "environment" },
            width:  { min: 1280, ideal: 3840 },
            height: { min:  720, ideal: 2160 },
            frameRate: { ideal: 30, max: 30 },
          },
        },
        // ② Rear camera (soft), 1080p — works on desktops without "exact"
        {
          video: {
            facingMode: "environment",
            width:  { min: 1280, ideal: 1920 },
            height: { min:  720, ideal: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
        },
        // ③ Any camera, 1080p minimum — last resort, still usable
        {
          video: {
            width:  { min: 1280, ideal: 1920 },
            height: { min:  720, ideal: 1080 },
          },
        },
        // ④ Absolute fallback — accept whatever is available
        { video: true },
      ];

      for (const constraints of attempts) {
        try { stream = await navigator.mediaDevices.getUserMedia(constraints); break; }
        catch { /* try next */ }
      }

      if (!stream) throw new DOMException("All camera attempts failed", "NotFoundError");

      // Apply continuous autofocus on the video track.
      // This is the correct method — advanced constraints inside getUserMedia
      // are frequently ignored; applyConstraints() on the live track works.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          // @ts-expect-error — focusMode is a valid Chrome/Android extension
          await videoTrack.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        } catch { /* not supported on this device — autofocus handled by OS */ }
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Wait until the video has actual pixel data before the user can see it
        await new Promise<void>((resolve) => {
          const v = videoRef.current!;
          if (v.readyState >= 2) { resolve(); return; }
          v.onloadeddata = () => resolve();
        });
        await videoRef.current.play();
      }
    } catch (err: unknown) {
      // 4. Classify the error so the user gets an actionable message
      let msg = "Camera unavailable. Pick an image from your library below.";

      if (err instanceof DOMException) {
        switch (err.name) {
          case "NotAllowedError":
          case "PermissionDeniedError":
            msg =
              "Camera permission was denied.\n" +
              "Tap the camera/lock icon in your browser address bar, allow camera access, then tap Try Again.";
            break;
          case "NotFoundError":
          case "DevicesNotFoundError":
            msg = "No camera found on this device. Use the file picker below to import a photo.";
            break;
          case "NotReadableError":
          case "TrackStartError":
            msg =
              "Camera is already in use by another app.\n" +
              "Close any other app that may be using the camera, then tap Try Again.";
            break;
          case "OverconstrainedError":
          case "ConstraintNotSatisfiedError":
            msg = "Camera doesn't support the requested settings. Tap Try Again.";
            break;
          case "SecurityError":
            msg =
              "Camera access is blocked by browser security.\n" +
              "Try opening the app in a new browser tab.";
            break;
          case "AbortError":
            msg = "Camera access was interrupted. Tap Try Again.";
            break;
          default:
            msg = `Camera error (${err.name}). Tap Try Again or pick an image below.`;
        }
      }
      setCameraError(msg);
    }
  }, []);

  useEffect(() => {
    if (editDocId || isNative) return; // edit mode or native — don't start the web camera
    startCamera();
    return () => { streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, [startCamera, editDocId, isNative]);

  // ── Native: auto-open iOS camera immediately when entering camera stage ──
  useEffect(() => {
    if (stage === "camera" && isNative) {
      nativeCapture();
    }
  // nativeCapture is a stable useCallback; run only when stage/isNative changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, isNative]);

  // ── Live document detection — samples a down-scaled video frame every 600 ms ──
  // Computes the brightness contrast between the centre region and the outer border
  // of the frame. A significant difference indicates a document (typically bright)
  // against a contrasting background. The result drives the scanner overlay UI.
  useEffect(() => {
    if (stage !== "camera" || cameraError) {
      setDocDetected("searching");
      return;
    }
    const analyze = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;
      try {
        const W = 80, H = 60;
        const tmp = document.createElement("canvas");
        tmp.width = W; tmp.height = H;
        const ctx = tmp.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, W, H);
        const { data } = ctx.getImageData(0, 0, W, H);
        let cSum = 0, oSum = 0, cN = 0, oN = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * 4;
            const b = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            const inC = x > W * 0.15 && x < W * 0.85 && y > H * 0.15 && y < H * 0.85;
            if (inC) { cSum += b; cN++; } else { oSum += b; oN++; }
          }
        }
        setDocDetected(Math.abs(cSum / cN - oSum / oN) > 18 ? "detected" : "searching");
      } catch { /* ignore — frame not ready */ }
    };
    const id = window.setInterval(analyze, 600);
    return () => window.clearInterval(id);
  }, [stage, cameraError]);

  // ── Edit mode: fetch existing document and reconstruct pages ─────────────────
  // Runs once on mount when editDocId is provided. Fetches the document from the
  // DB, deserializes its pages JSON into ScanPage objects, then enters the editor.

  useEffect(() => {
    if (!editDocId) return;
    let cancelled = false;

    async function loadForEdit() {
      try {
        let doc: { name: string; pages: string };
        if (Capacitor.isNativePlatform()) {
          const { getLocalDoc } = await import("@/lib/localDocs");
          const localDoc = await getLocalDoc(editDocId!);
          if (!localDoc) throw new Error("Not found");
          doc = { name: localDoc.name, pages: localDoc.pages ?? "[]" };
        } else {
          const res = await apiFetch(`/api/documents/${editDocId}`);
          if (!res.ok) throw new Error("Not found");
          doc = await res.json() as { name: string; pages: string };
        }
        if (!cancelled) setDocumentName(doc.name);

        const serialized: SerializablePage[] = JSON.parse(doc.pages || "[]");
        if (serialized.length === 0) {
          // Document has no edit data — cannot reconstruct; bail out gracefully
          if (!cancelled) {
            toast({ title: "This document cannot be re-edited (no page data saved)", variant: "destructive" });
            setLoadingEdit(false);
          }
          return;
        }

        const loadedPages: ScanPage[] = await Promise.all(
          serialized.map(async (sp) => {
            const canvas = await dataUrlToCanvas(sp.originalDataUrl);
            return {
              id: sp.id,
              original: canvas,
              previewUrl: sp.originalDataUrl, // reuse stored JPEG as editor preview
              thumbUrl: canvas.toDataURL("image/jpeg", 0.28),
              quad: sp.quad,
              filterMode: sp.filterMode,
              filterStrength: sp.filterStrength,
              rotation: sp.rotation,
              flipH: sp.flipH ?? false,
              flipV: sp.flipV ?? false,
              processedUrl: "",
              manualCrop: true, // stored quad is the user's saved crop — protect it
            };
          })
        );

        if (!cancelled) {
          setPages(loadedPages);
          setCurrentIndex(0);
          setLoadingEdit(false);
        }
      } catch (err) {
        if (!cancelled) {
          toast({ title: "Failed to load document for editing", variant: "destructive" });
          setLoadingEdit(false);
        }
      }
    }

    loadForEdit();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editDocId]);

  // ── Return mode: run auto-detection on the pre-loaded single image ────────────
  useEffect(() => {
    if (!singleImageCanvas) return;
    const page = pages[0];
    if (!page) return;
    // Delay slightly so runDetection (defined later via useCallback) is stable
    const tid = setTimeout(() => runDetection(page), 100);
    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const loadImageToCanvas = useCallback((file: File): Promise<HTMLCanvasElement> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d")!.drawImage(img, 0, 0);
          resolve(downscaleCanvas(c));
        };
        img.onerror = reject;
        img.src = ev.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }), []);

  // ── Auto-detection ─────────────────────────────────────────────────────────
  //
  // Runs Canny edge detection on a page's original canvas (asynchronously,
  // by yielding the microtask queue so the UI can paint first).
  // On success: updates that page's quad in pages[].
  // On failure (poor lighting, no clear edges): keeps DEFAULT_QUAD silently.

  const runDetection = useCallback(async (page: ScanPage) => {
    setDetectingIds((prev) => new Set([...prev, page.id]));

    // Yield so the camera frame / editor can render before we do heavy CPU work
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const result = detectDocumentCorners(page.original);

    if (result) {
      const { quad, docType } = result;
      // Update only THIS page's quad — but ONLY if the user hasn't touched the handles yet.
      // Also sets manualCrop: true after writing so detection never fires a second time
      // automatically; the only way to re-run it is the explicit "Auto Detect" button.
      // Store docType so the editor can suggest the right filter (ID card → idFilter).
      setPages((prev) => prev.map((p) => {
        if (p.id !== page.id) return p;
        if (p.manualCrop) return p;
        const suggestedFilter: ScanPage["filterMode"] =
          docType === "id_card" ? "id" : p.filterMode;
        return { ...p, quad, manualCrop: true, filterMode: suggestedFilter };
      }));
    } else {
      // Detection found nothing — restore manualCrop protection so the quad the user
      // had before pressing "Auto Detect" cannot be overwritten by future auto-detections.
      setPages((prev) => prev.map((p) =>
        p.id !== page.id ? p : { ...p, manualCrop: true }
      ));
    }

    setDetectingIds((prev) => {
      const next = new Set(prev);
      next.delete(page.id);
      return next;
    });
  }, []);

  // ── Capture ────────────────────────────────────────────────────────────────────

  const [captureFlash, setCaptureFlash] = useState(false);
  // Prevents double-taps while an async capture (ImageCapture.takePhoto) is in progress.
  const [capturing, setCapturing] = useState(false);
  // "detected" when live frame analysis sees a bright rectangle in the guide frame.
  const [docDetected, setDocDetected] = useState<"searching" | "detected">("searching");

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturing) return;

    setCaptureFlash(true);
    setTimeout(() => setCaptureFlash(false), 150);

    // Processes a raw canvas: downscales → creates a ScanPage → queues detection.
    const addPage = (raw: HTMLCanvasElement) => {
      const canvas = downscaleCanvas(raw);
      const page = makeScanPage(canvas);
      setPages((prev) => [...prev, page]);
      runDetection(page);
    };

    // Main async capture routine.
    //
    // Priority order for capture quality:
    //   1. ImageCapture.takePhoto()  — captures at full camera sensor resolution
    //      (e.g. 12 MP on iPhone) using the OS shutter. Much sharper than the
    //      video stream because the sensor uses longer exposure + noise reduction.
    //      Supported on Chrome Android, Samsung Browser; partial on iOS Safari 17.4+.
    //   2. drawImage(video) on requestVideoFrameCallback  — grabs the exact next
    //      decoded frame from the hardware decoder. Sharper than a mid-frame draw.
    //   3. drawImage(video) on requestAnimationFrame  — fallback for older browsers.
    const doCapture = async () => {
      const track = streamRef.current?.getVideoTracks()[0];

      // ── Path 1: ImageCapture.takePhoto() ─────────────────────────────────────
      if (track && "ImageCapture" in window) {
        setCapturing(true);
        try {
          // @ts-expect-error — ImageCapture not yet in TypeScript lib
          const ic = new ImageCapture(track);
          const blob: Blob = await ic.takePhoto();
          const bitmap = await createImageBitmap(blob);
          const raw = document.createElement("canvas");
          raw.width  = bitmap.width;
          raw.height = bitmap.height;
          // Draw at native resolution — no smoothing needed (1:1 pixels)
          const ctx = raw.getContext("2d")!;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          addPage(raw);
          return;
        } catch {
          // takePhoto() can fail on restricted environments — fall through
        } finally {
          setCapturing(false);
        }
      }

      // ── Path 2/3: drawImage from the live video element ───────────────────────
      const draw = () => {
        const raw = document.createElement("canvas");
        raw.width  = video.videoWidth;
        raw.height = video.videoHeight;
        const ctx = raw.getContext("2d")!;
        // Drawing at native resolution — smoothing doesn't affect quality here
        // but disable it to avoid any sub-pixel blending artefacts.
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(video, 0, 0);
        addPage(raw);
      };

      if ("requestVideoFrameCallback" in video) {
        // requestVideoFrameCallback fires on the very next decoded hardware frame —
        // guaranteed not to be a partial / torn frame, so the image is sharper.
        (video as HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => void;
        }).requestVideoFrameCallback(draw);
      } else {
        requestAnimationFrame(draw);
      }
    };

    doCapture().catch(() => { /* capture errors are non-fatal */ });
  }, [runDetection, capturing]);

  const nativeCapture = useCallback(async () => {
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.DataUrl,
        quality: 90,
        allowEditing: false,
      });
      if (photo.dataUrl) {
        const canvas = await dataUrlToCanvas(photo.dataUrl);
        const page = makeScanPage(canvas, isScreenshotLike(canvas));
        setPages((prev) => [...prev, page]);
        setStage("editor");
        setTimeout(() => runDetection(page), 80);
      }
    } catch (err) {
      console.error("Camera error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("cancel")) {
        toast({ title: `Camera error: ${msg}`, variant: "destructive" });
      }
    }
  }, [runDetection, toast]);

  const nativeGallery = useCallback(async () => {
    try {
      const result = await Camera.pickImages({
        quality: 90,
        limit: 0,
      } as GalleryImageOptions);
      const photos = result.photos ?? [];
      if (!photos.length) return;
      const newPages: ScanPage[] = [];
      for (const photo of photos) {
        const url = photo.webPath
          ? photo.webPath
          : photo.dataUrl ?? "";
        if (!url) continue;
        let dataUrl = url;
        if (!url.startsWith("data:")) {
          // Convert webPath blob URL to dataUrl
          const resp = await fetch(url);
          const blob = await resp.blob();
          dataUrl = await new Promise<string>((res) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result as string);
            fr.readAsDataURL(blob);
          });
        }
        const canvas = await dataUrlToCanvas(dataUrl);
        newPages.push(makeScanPage(canvas, isScreenshotLike(canvas)));
      }
      if (!newPages.length) return;
      setPages((prev) => [...prev, ...newPages]);
      setStage("editor");
      newPages.forEach((p, i) => setTimeout(() => runDetection(p), 80 + i * 60));
    } catch (err) {
      console.error("Gallery error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("cancel")) {
        toast({ title: `Gallery error: ${msg}`, variant: "destructive" });
      }
    }
  }, [runDetection, toast]);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    e.target.value = "";

    const pdfFiles = files.filter((f) => f.type === "application/pdf");
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));

    if (files.length === 1 && pdfFiles.length === 1) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setPickedPdfDataUrl(ev.target?.result as string);
        setPickedPdfName(pdfFiles[0].name.replace(/\.pdf$/i, "") || `PDF ${new Date().toLocaleDateString()}`);
        stopCamera();
        setStage("pdf-name");
      };
      reader.readAsDataURL(pdfFiles[0]);
      return;
    }

    if (imageFiles.length > 0) {
      const canvases = await Promise.all(imageFiles.map(loadImageToCanvas));
      const newPages = canvases.map((c) => makeScanPage(c, isScreenshotLike(c)));
      setPages((prev) => {
        const next = [...prev, ...newPages];
        setCurrentIndex(next.length - newPages.length);
        return next;
      });
      stopCamera();
      setStage("editor");
      // Run detection on each imported image (staggered so UI stays responsive)
      newPages.forEach((page, i) => {
        setTimeout(() => runDetection(page), i * 80);
      });
    }
  }, [stopCamera, loadImageToCanvas, runDetection]);

  const openEditor = useCallback((startIndex = 0) => {
    stopCamera();
    setCurrentIndex(startIndex);
    setStage("editor");
  }, [stopCamera]);

  // ── Page mutation helpers ──────────────────────────────────────────────────────

  const updatePageAt = useCallback((index: number, updates: Partial<ScanPage>) => {
    setPages((prev) => prev.map((p, i) => i === index ? { ...p, ...updates } : p));
  }, []);

  const removePage = useCallback((index: number) => {
    setPages((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) { startCamera(); setStage("camera"); }
      else setCurrentIndex((ci) => Math.min(ci, next.length - 1));
      return next;
    });
  }, [startCamera]);

  // ── Canvas-filter lazy compute (only for current visible page) ────────────────
  // Handles "document", "id", and "noshadow" filters — all require canvas work.
  // For "noshadow" the processedUrl also depends on filterStrength, so strength
  // changes clear processedUrl (handled in the debounce) which re-triggers this effect.

  useEffect(() => {
    const needsCanvas =
      currentPage?.filterMode === "document" ||
      currentPage?.filterMode === "id" ||
      currentPage?.filterMode === "noshadow";
    if (stage !== "editor" || !currentPage || !needsCanvas) return;
    if (currentPage.processedUrl) return; // already cached
    let cancelled = false;
    setProcessing(true);
    const { original, filterMode, filterStrength } = currentPage;
    const idx = currentIndex;
    // Single setTimeout (80 ms) — enough to let the browser paint the processing
    // indicator before the heavy canvas work blocks the main thread.
    const tid = setTimeout(() => {
      if (cancelled) return;
      let processed: HTMLCanvasElement;
      if (filterMode === "id") processed = idFilter(original);
      else if (filterMode === "noshadow") processed = noShadowFilter(original, filterStrength);
      else processed = documentFilter(original);
      const url = processed.toDataURL("image/jpeg", 0.85);
      if (!cancelled) {
        updatePageAt(idx, { processedUrl: url });
        setProcessing(false);
      }
    }, 80);
    return () => { cancelled = true; clearTimeout(tid); setProcessing(false); };
  // Re-run when page id, filterMode change. For noshadow, processedUrl is cleared
  // by the debounce on strength change, which causes filterStrength to be re-read here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, currentPage?.id, currentPage?.filterMode, currentPage?.filterStrength]);

  // ── ImgRect + ElemRect computation ────────────────────────────────────────────
  //
  // Rotation is baked into displayUrl (see effect below), so the <img> element
  // never has a CSS rotation transform.  imgRect and elemRect are therefore always
  // identical — both represent the visual on-screen bounds of the displayed image.
  // rotationRef is still updated here so the crop SVG and drag handlers know the
  // current rotation for their coordinate transforms.

  useEffect(() => {
    if (stage !== "editor" || !imgContainerRef.current || !currentPage?.original) return;
    const compute = () => {
      const el = imgContainerRef.current;
      if (!el || !currentPage?.original) return;
      const cw = el.clientWidth, ch = el.clientHeight;
      const rot = currentPage.rotation;
      rotationRef.current = rot;

      const ow = currentPage.original.width;
      const oh = currentPage.original.height;

      // Bounding-box dimensions of the rotated image (matches rotateCanvas output)
      const rad = (rot * Math.PI) / 180;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const vw = ow * absCos + oh * absSin;
      const vh = ow * absSin + oh * absCos;

      if (!cw || !ch || !vw || !vh) return;
      const scale = Math.min(cw / vw, ch / vh);

      const visW = vw * scale, visH = vh * scale;
      const visX = (cw - visW) / 2, visY = (ch - visH) / 2;

      // imgRect and elemRect are identical — no CSS rotation, no layout/visual mismatch
      const rect = { x: visX, y: visY, w: visW, h: visH };
      imgRectRef.current = rect;
      setImgRect(rect);
      setElemRect(rect);

      setContainerSize({ w: cw, h: ch });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(imgContainerRef.current);
    return () => { ro.disconnect(); };
  }, [stage, currentIndex, currentPage?.rotation]);

  // ── displayUrl: source image with rotation baked in ────────────────────────
  //
  // Instead of rotating the <img> element via CSS (which causes overflow:hidden
  // to clip the layout region that extends outside the container), we canvas-rotate
  // the source image and store the result as a data URL.  The element always sits
  // flush inside the container with no clipping.
  //
  // The crop quad is stored in original-image coordinates; the svgData memo and
  // the drag handlers use rotatePoint/unrotatePoint to translate between spaces.

  useEffect(() => {
    if (stage !== "editor" || !currentPage) return;
    const { rotation, previewUrl, processedUrl, filterMode } = currentPage;
    const needsCanvas = filterMode === "document" || filterMode === "id" || filterMode === "noshadow";
    const src = (needsCanvas && processedUrl) ? processedUrl : previewUrl;
    if (!src) { setDisplayUrl(""); return; }
    if (rotation === 0) { setDisplayUrl(src); return; }

    // Do NOT set displayUrl = src here.  Setting it to the unrotated source
    // while imgRect already reflects the rotated dimensions causes a brief
    // mismatch: the portrait thumbnail letterboxes inside a landscape-sized
    // element, so any drag during that window maps touch coords into a
    // compressed centre strip instead of the full image.  The previous
    // displayUrl stays visible until the rotated canvas is ready.
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const rad = (rotation * Math.PI) / 180;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const dw = Math.round(iw * absCos + ih * absSin);
      const dh = Math.round(iw * absSin + ih * absCos);
      const canvas = document.createElement("canvas");
      canvas.width = dw; canvas.height = dh;
      const ctx = canvas.getContext("2d");
      if (!ctx) { return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.translate(dw / 2, dh / 2);
      ctx.rotate(rad);
      ctx.drawImage(img, -iw / 2, -ih / 2);
      if (!cancelled) setDisplayUrl(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { /* keep the unrotated fallback already set */ };
    img.src = src;
    return () => { cancelled = true; };
  }, [stage, currentPage?.id, currentPage?.rotation, currentPage?.previewUrl,
      currentPage?.processedUrl, currentPage?.filterMode]);

  // ── Keyboard navigation ────────────────────────────────────────────────────────

  useEffect(() => {
    if (stage !== "editor") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setCurrentIndex((i) => Math.min(i + 1, pages.length - 1));
      if (e.key === "ArrowLeft") setCurrentIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [stage, pages.length]);

  // ── Mobile gesture lockdown (editor only) ─────────────────────────────────────
  //
  // React's synthetic onTouchMove is passive since React 17 — calling
  // e.preventDefault() there has NO effect on modern mobile browsers.
  // We must attach a native listener with { passive: false } to actually
  // block browser-level pan / back-swipe / pull-to-refresh gestures.

  useEffect(() => {
    if (stage !== "editor") return;

    // ── Lock body/html: position:fixed kills iOS WKWebView vertical scroll steal ──
    const prev = {
      bodyOverflow: document.body.style.overflow,
      bodyPosition: document.body.style.position,
      bodyWidth: document.body.style.width,
      bodyHeight: document.body.style.height,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverflow: document.documentElement.style.overflow,
      htmlPosition: document.documentElement.style.position,
      htmlWidth: document.documentElement.style.width,
      htmlHeight: document.documentElement.style.height,
      htmlOverscroll: document.documentElement.style.overscrollBehavior,
    };
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    document.body.style.height = "100%";
    document.body.style.touchAction = "none";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.position = "fixed";
    document.documentElement.style.width = "100%";
    document.documentElement.style.height = "100%";
    document.documentElement.style.overscrollBehavior = "none";

    const el = imgContainerRef.current;

    const nativeTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length !== 1) return;
      const containerEl = imgContainerRef.current;
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const touch = e.touches[0];
      const localX = touch.clientX - rect.left;
      const localY = touch.clientY - rect.top;
      const sd = svgDataRef.current;
      if (!sd) return;
      const candidates: Array<[string, { x: number; y: number }]> = [
        ["tl", sd.qpx.tl], ["tr", sd.qpx.tr],
        ["bl", sd.qpx.bl], ["br", sd.qpx.br],
        ["tc", sd.mid.tc], ["bc", sd.mid.bc],
        ["lc", sd.mid.lc], ["rc", sd.mid.rc],
      ];
      let closestKey: string | null = null;
      let closestDist = 70;
      for (const [key, pt] of candidates) {
        const d = Math.hypot(localX - pt.x, localY - pt.y);
        if (d < closestDist) { closestDist = d; closestKey = key; }
      }
      if (closestKey) {
        draggingCorner.current = closestKey;
        isDraggingHandle.current = true;
        touchStartX.current = null;
        touchStartY.current = null;
        dragBaseRef.current = pagesRef.current[currentIndexRef.current]?.quad ?? DEFAULT_QUAD;
        setActiveQuad(pagesRef.current[currentIndexRef.current]?.quad ?? DEFAULT_QUAD);
        setPages((prev) => prev.map((p, i) =>
          i === currentIndexRef.current ? { ...p, manualCrop: true } : p
        ));
      } else {
        touchStartX.current = touch.clientX;
        touchStartY.current = touch.clientY;
      }
    };

    const nativeTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!isDraggingHandle.current || !draggingCorner.current) return;
      const containerEl = imgContainerRef.current;
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      const ir = imgRectRef.current;
      const touch = e.touches[0];
      const rawX = Math.max(0, Math.min(1, (touch.clientX - rect.left - ir.x) / ir.w));
      const rawY = Math.max(0, Math.min(1, (touch.clientY - rect.top - ir.y) / ir.h));
      const { x: relX, y: relY } = unrotatePoint(rawX, rawY, rotationRef.current);
      const key = draggingCorner.current;
      setActiveQuad((prev) => {
        const base = prev ?? dragBaseRef.current ?? DEFAULT_QUAD;
        return applyDragUpdate(base, key, relX, relY);
      });
    };

    const nativeTouchEnd = (_e: TouchEvent) => {
      if (!isDraggingHandle.current) return;
      const liveQuad = activeQuadRef.current;
      if (liveQuad) {
        setPages((prev) => prev.map((p, i) =>
          i === currentIndexRef.current ? { ...p, quad: liveQuad, manualCrop: true } : p
        ));
      }
      setActiveQuad(null);
      draggingCorner.current = null;
      isDraggingHandle.current = false;
    };

    el?.addEventListener("touchstart", nativeTouchStart, { passive: false });
    el?.addEventListener("touchmove",  nativeTouchMove,  { passive: false });
    el?.addEventListener("touchend",   nativeTouchEnd,   { passive: false });
    // Block touchmove on document too so nothing scrolls while editor is open
    document.addEventListener("touchmove", nativeTouchMove, { passive: false });

    return () => {
      document.body.style.overflow = prev.bodyOverflow;
      document.body.style.position = prev.bodyPosition;
      document.body.style.width = prev.bodyWidth;
      document.body.style.height = prev.bodyHeight;
      document.body.style.touchAction = prev.bodyTouchAction;
      document.documentElement.style.overflow = prev.htmlOverflow;
      document.documentElement.style.position = prev.htmlPosition;
      document.documentElement.style.width = prev.htmlWidth;
      document.documentElement.style.height = prev.htmlHeight;
      document.documentElement.style.overscrollBehavior = prev.htmlOverscroll;
      el?.removeEventListener("touchstart", nativeTouchStart);
      el?.removeEventListener("touchmove",  nativeTouchMove);
      el?.removeEventListener("touchend",   nativeTouchEnd);
      document.removeEventListener("touchmove", nativeTouchMove);
    };
  }, [stage]);

  // ── Fullscreen crop touch handlers ────────────────────────────────────────────
  useEffect(() => {
    if (!cropFullscreen) return;
    const el = cropContainerRef.current;
    if (!el) return;
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length !== 1) return;
      const rect = el.getBoundingClientRect();
      const touch = e.touches[0];
      const localX = touch.clientX - rect.left;
      const localY = touch.clientY - rect.top;
      const sd = svgDataRef.current;
      if (!sd) return;
      const candidates: Array<[string, { x: number; y: number }]> = [
        ["tl", sd.qpx.tl], ["tr", sd.qpx.tr],
        ["bl", sd.qpx.bl], ["br", sd.qpx.br],
        ["tc", sd.mid.tc], ["bc", sd.mid.bc],
        ["lc", sd.mid.lc], ["rc", sd.mid.rc],
      ];
      let closestKey: string | null = null;
      let closestDist = 60;
      for (const [key, pt] of candidates) {
        const d = Math.hypot(localX - pt.x, localY - pt.y);
        if (d < closestDist) { closestDist = d; closestKey = key; }
      }
      if (closestKey) {
        draggingCorner.current = closestKey;
        isDraggingHandle.current = true;
        dragBaseRef.current = pagesRef.current[currentIndexRef.current]?.quad ?? DEFAULT_QUAD;
        setActiveQuad(pagesRef.current[currentIndexRef.current]?.quad ?? DEFAULT_QUAD);
        setPages((prev) => prev.map((p, i) =>
          i === currentIndexRef.current ? { ...p, manualCrop: true } : p
        ));
      }
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if (!isDraggingHandle.current || !draggingCorner.current) return;
      const rect = el.getBoundingClientRect();
      const ir = cropImgRectRef.current;
      const touch = e.touches[0];
      const rawX = Math.max(0, Math.min(1, (touch.clientX - rect.left - ir.x) / ir.w));
      const rawY = Math.max(0, Math.min(1, (touch.clientY - rect.top  - ir.y) / ir.h));
      const { x: relX, y: relY } = unrotatePoint(rawX, rawY, rotationRef.current);
      const key = draggingCorner.current;
      setActiveQuad((prev) => {
        const base = prev ?? dragBaseRef.current ?? DEFAULT_QUAD;
        return applyDragUpdate(base, key, relX, relY);
      });
    };
    const onEnd = (_e: TouchEvent) => {
      if (!isDraggingHandle.current) return;
      const liveQuad = activeQuadRef.current;
      if (liveQuad) {
        setPages((prev) => prev.map((p, i) =>
          i === currentIndexRef.current ? { ...p, quad: liveQuad, manualCrop: true } : p
        ));
      }
      setActiveQuad(null);
      draggingCorner.current = null;
      isDraggingHandle.current = false;
    };
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove",  onMove,  { passive: false });
    el.addEventListener("touchend",   onEnd,   { passive: false });
    document.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove",  onMove);
      el.removeEventListener("touchend",   onEnd);
      document.removeEventListener("touchmove", onMove);
    };
  }, [cropFullscreen]);

  // ── Memoized SVG overlay data (avoids re-computation on unrelated state changes) ──

  const svgData = useMemo(() => {
    const q = displayQuad;
    const ir = imgRect;
    const cs = containerSize;
    const rot = rotationRef.current;

    // Transform each quad corner from original-image [0,1] space into
    // display [0,1] space (accounting for CSS rotation), then to screen px.
    const toScreen = (p: { x: number; y: number }) => {
      const d = rotatePoint(p, rot);
      return { x: ir.x + d.x * ir.w, y: ir.y + d.y * ir.h };
    };
    const qpx = {
      tl: toScreen(q.tl),
      tr: toScreen(q.tr),
      bl: toScreen(q.bl),
      br: toScreen(q.br),
    };
    const path = `M0,0 L${cs.w},0 L${cs.w},${cs.h} L0,${cs.h} Z M${qpx.tl.x},${qpx.tl.y} L${qpx.tr.x},${qpx.tr.y} L${qpx.br.x},${qpx.br.y} L${qpx.bl.x},${qpx.bl.y} Z`;
    const poly = `${qpx.tl.x},${qpx.tl.y} ${qpx.tr.x},${qpx.tr.y} ${qpx.br.x},${qpx.br.y} ${qpx.bl.x},${qpx.bl.y}`;
    // Mid-points for edge handles (computed from the already-rotated screen points)
    const mid = {
      tc: { x: (qpx.tl.x + qpx.tr.x) / 2, y: (qpx.tl.y + qpx.tr.y) / 2 },
      bc: { x: (qpx.bl.x + qpx.br.x) / 2, y: (qpx.bl.y + qpx.br.y) / 2 },
      lc: { x: (qpx.tl.x + qpx.bl.x) / 2, y: (qpx.tl.y + qpx.bl.y) / 2 },
      rc: { x: (qpx.tr.x + qpx.br.x) / 2, y: (qpx.tr.y + qpx.br.y) / 2 },
    };
    return { qpx, mid, path, poly };
  // rotationRef.current is a ref so won't be in deps — it's always current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayQuad, imgRect, containerSize]);
  // Keep svgDataRef current on every render so native touch handlers can read
  // handle positions without stale closure values.
  svgDataRef.current = svgData;

  // ── Fullscreen crop: compute image rect from window dimensions (no ResizeObserver lag) ──
  const cropSvgData = useMemo(() => {
    if (!cropFullscreen || !currentPage?.original) return null;
    const cw = window.innerWidth, ch = window.innerHeight;
    const rot = currentPage.rotation;
    const ow = currentPage.original.width, oh = currentPage.original.height;
    const rad = (rot * Math.PI) / 180;
    const absCos = Math.abs(Math.cos(rad)), absSin = Math.abs(Math.sin(rad));
    const vw = ow * absCos + oh * absSin, vh = ow * absSin + oh * absCos;
    const scale = Math.min(cw / vw, ch / vh);
    const ir: ImgRect = { x: (cw - vw * scale) / 2, y: (ch - vh * scale) / 2, w: vw * scale, h: vh * scale };
    cropImgRectRef.current = ir;
    const q = displayQuad;
    const toScreen = (p: { x: number; y: number }) => {
      const d = rotatePoint(p, rot);
      return { x: ir.x + d.x * ir.w, y: ir.y + d.y * ir.h };
    };
    const qpx = { tl: toScreen(q.tl), tr: toScreen(q.tr), bl: toScreen(q.bl), br: toScreen(q.br) };
    const path = `M0,0 L${cw},0 L${cw},${ch} L0,${ch} Z M${qpx.tl.x},${qpx.tl.y} L${qpx.tr.x},${qpx.tr.y} L${qpx.br.x},${qpx.br.y} L${qpx.bl.x},${qpx.bl.y} Z`;
    const poly = `${qpx.tl.x},${qpx.tl.y} ${qpx.tr.x},${qpx.tr.y} ${qpx.br.x},${qpx.br.y} ${qpx.bl.x},${qpx.bl.y}`;
    const mid = {
      tc: { x: (qpx.tl.x + qpx.tr.x) / 2, y: (qpx.tl.y + qpx.tr.y) / 2 },
      bc: { x: (qpx.bl.x + qpx.br.x) / 2, y: (qpx.bl.y + qpx.br.y) / 2 },
      lc: { x: (qpx.tl.x + qpx.bl.x) / 2, y: (qpx.tl.y + qpx.bl.y) / 2 },
      rc: { x: (qpx.tr.x + qpx.br.x) / 2, y: (qpx.tr.y + qpx.br.y) / 2 },
    };
    return { qpx, mid, path, poly, cw, ch };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropFullscreen, displayQuad, currentPage?.rotation, currentIndex]);
  // When fullscreen is open, point svgDataRef at the fullscreen-computed positions
  // so the fullscreen touch handler's hit detection uses the correct screen coords.
  if (cropFullscreen && cropSvgData) svgDataRef.current = cropSvgData;

  // ── Touch / swipe / drag (uses refs to avoid closure stale state) ─────────────

  const onContainerTouchStart = useCallback((e: React.TouchEvent) => {
    // Only set swipe tracking if NOT already dragging a handle
    if (isDraggingHandle.current || draggingCorner.current) return;
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const onContainerTouchMove = useCallback((e: React.TouchEvent) => {
    // Allow move if a corner handle is being dragged (isDraggingHandle) OR if
    // draggingCorner is set (covers edge case where isDraggingHandle wasn't set
    // before the first touchmove fires on some iOS versions).
    if ((!isDraggingHandle.current && !draggingCorner.current) || !imgContainerRef.current) return;
    e.preventDefault();
    const rect = imgContainerRef.current.getBoundingClientRect();
    const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
    // Map screen → visual-image [0,1], then unrotate → original-image [0,1]
    const rawX = Math.max(0, Math.min(1, (cx - rect.left - imgRect.x) / imgRect.w));
    const rawY = Math.max(0, Math.min(1, (cy - rect.top  - imgRect.y) / imgRect.h));
    const { x: relX, y: relY } = unrotatePoint(rawX, rawY, rotationRef.current);
    const handleKey = draggingCorner.current;
    if (!handleKey) return;
    // Use dragBaseRef (captured at touch-start) as the stable base — this means
    // detection completing mid-drag cannot move the non-dragged corners.
    setActiveQuad((prev) => {
      const base = prev ?? dragBaseRef.current ?? DEFAULT_QUAD;
      return applyDragUpdate(base, handleKey, relX, relY);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgRect]);

  const onContainerMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingCorner.current || !imgContainerRef.current) return;
    const rect = imgContainerRef.current.getBoundingClientRect();
    // Map screen → visual-image [0,1], then unrotate → original-image [0,1]
    const rawX = Math.max(0, Math.min(1, (e.clientX - rect.left - imgRect.x) / imgRect.w));
    const rawY = Math.max(0, Math.min(1, (e.clientY - rect.top  - imgRect.y) / imgRect.h));
    const { x: relX, y: relY } = unrotatePoint(rawX, rawY, rotationRef.current);
    const handleKey = draggingCorner.current;
    setActiveQuad((prev) => {
      const base = prev ?? dragBaseRef.current ?? DEFAULT_QUAD;
      return applyDragUpdate(base, handleKey, relX, relY);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgRect]);

  // Commit drag to pages[] on release — also locks out auto-detection for this page
  const commitDrag = useCallback(() => {
    if (activeQuad) {
      updatePageAt(currentIndex, { quad: activeQuad, manualCrop: true });
    }
    setActiveQuad(null);
    draggingCorner.current = null;
    isDraggingHandle.current = false;
  }, [activeQuad, currentIndex, updatePageAt]);

  const onContainerTouchEnd = useCallback((e: React.TouchEvent) => {
    if (isDraggingHandle.current) { commitDrag(); return; }
    const sx = touchStartX.current, sy = touchStartY.current;
    if (sx === null || sy === null) return;
    const ex = e.changedTouches[0].clientX, ey = e.changedTouches[0].clientY;
    const dx = ex - sx, dy = Math.abs(ey - sy);
    if (Math.abs(dx) > 55 && dy < 90) {
      setCurrentIndex((i) => dx < 0
        ? Math.min(i + 1, pages.length - 1)
        : Math.max(i - 1, 0));
    }
    touchStartX.current = null; touchStartY.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitDrag, pages.length]);

  // ── Re-detect: user-initiated — resets manualCrop and re-runs edge detection ──

  const rerunDetection = useCallback(() => {
    if (!currentPage) return;
    // Clear the manual-crop lock so runDetection is allowed to write the new quad
    updatePageAt(currentIndex, { manualCrop: false });
    // runDetection reads manualCrop from the state callback (not the closure),
    // so by the time it calls setPages the lock will already be cleared.
    runDetection(currentPage);
  }, [currentPage, currentIndex, updatePageAt, runDetection]);

  // ── Filter / scope handlers (stable callbacks for FilterStrip memo) ────────────

  const handleFilterChange = useCallback((f: FilterMode) => {
    setPages((prev) => prev.map((p) => ({ ...p, filterMode: f, processedUrl: "" })));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PERF: slider updates localStrength immediately (no re-render in pages[]),
  // then debounce-commits to pages[] after 120ms of no movement.
  // For "noshadow" we must also clear processedUrl so the canvas re-computes.
  const handleStrengthChange = useCallback((v: number) => {
    setLocalStrength(v);
    if (strengthDebounce.current) clearTimeout(strengthDebounce.current);
    strengthDebounce.current = setTimeout(() => {
      setPages((prev) => prev.map((p) => ({
        ...p, filterStrength: v,
        processedUrl: p.filterMode === "noshadow" ? "" : p.processedUrl,
      })));
    }, 120);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Rotate / Flip ────────────────────────────────────────────────────────────────

  const rotatePage = useCallback(() => {
    updatePageAt(currentIndex, {
      rotation: ((currentPage?.rotation ?? 0) + 90) % 360,
      processedUrl: "",
    });
  }, [currentIndex, currentPage?.rotation, updatePageAt]);

  const rotateCcwPage = useCallback(() => {
    updatePageAt(currentIndex, {
      rotation: (((currentPage?.rotation ?? 0) - 90) % 360 + 360) % 360,
      processedUrl: "",
    });
  }, [currentIndex, currentPage?.rotation, updatePageAt]);

  const flipPageH = useCallback(() => {
    updatePageAt(currentIndex, { flipH: !(currentPage?.flipH ?? false), processedUrl: "" });
  }, [currentIndex, currentPage?.flipH, updatePageAt]);

  const flipPageV = useCallback(() => {
    updatePageAt(currentIndex, { flipV: !(currentPage?.flipV ?? false), processedUrl: "" });
  }, [currentIndex, currentPage?.flipV, updatePageAt]);

  // ── Thumbnail / dot callbacks (stable for ThumbnailStrip / PageDots memos) ────

  const handleThumbSelect = useCallback((i: number) => setCurrentIndex(i), []);
  const handleThumbAdd = useCallback(() => fileInputRef.current?.click(), []);

  // ── Export ──────────────────────────────────────────────────────────────────────

  const exportMutation = useMutation({
    mutationFn: async () => {
      // Read always-current refs so this function always exports exactly what
      // the crop overlay is showing, even if React hasn't flushed state updates
      // since the last drag-commit (TanStack Query's mutationFn is updated via
      // useEffect which fires after paint).
      const latestPages = pagesRef.current;
      const latestActiveQuad = activeQuadRef.current;
      const latestCurrentIndex = currentIndexRef.current;

      // If a drag is still live (finger down on handle when save was tapped),
      // merge the in-progress quad into the export pages so the export matches
      // exactly what the overlay is showing.
      const exportPages: ScanPage[] = latestActiveQuad
        ? latestPages.map((p, i) =>
            i === latestCurrentIndex
              ? { ...p, quad: latestActiveQuad, manualCrop: true }
              : p
          )
        : latestPages;

      if (!exportPages.length) throw new Error("No pages");
      const setProgress = setSaveProgressRef.current;
      const name = documentName.trim() || "Scan";

      // ── Fast path: name-only update in edit mode ─────────────────────────
      // If the user only changed the document name (no page modifications),
      // skip PDF regeneration entirely — just PATCH the name.
      if (editDocId && !pagesModifiedRef.current) {
        setProgress("Saving…");
        await yieldToMain();
        if (Capacitor.isNativePlatform()) {
          const { updateLocalDoc } = await import("@/lib/localDocs");
          await updateLocalDoc(editDocId, { name });
          return { id: editDocId, _name: name };
        }
        const res = await apiRequest("PATCH", `/api/documents/${editDocId}`, { name });
        if (!res.ok) throw new Error("Failed to save");
        const json = await res.json();
        return { ...json, _name: name };
      }

      // ── Full path: serialise originals + generate PDF ────────────────────

      // Step 1 — Serialise original pages for future re-editing.
      // Downscale to ORIG_DIM (2048px) so re-cropping/re-filtering stays sharp.
      setProgress("Preparing pages…");
      await yieldToMain();
      const serializedPages: SerializablePage[] = [];
      for (const p of exportPages) {
        const scaled = downscaleCanvas(p.original, ORIG_DIM);
        // High quality JPEG — fewer artifacts when re-editing later
        const dataUrl = scaled.toDataURL("image/jpeg", 0.92);
        serializedPages.push({
          id: p.id,
          originalDataUrl: dataUrl,
          quad: p.quad,
          filterMode: p.filterMode,
          filterStrength: p.filterStrength,
          rotation: p.rotation,
          flipH: p.flipH,
          flipV: p.flipV,
        });
        await yieldToMain();
      }
      const pagesJson = JSON.stringify(serializedPages);

      // Step 2 — Process and composite into PDF.
      // For camera photos, pre-downscale to PDF_DIM (2048px) before warping.
      // Screenshots keep their full imported resolution (up to PDF_DIM_SCREENSHOT)
      // and receive a post-warp sharpening pass to compensate for bilinear softness.
      setProgress("Generating PDF…");

      const processPage = (p: ScanPage): HTMLCanvasElement => {
        // Screenshots preserve full imported resolution; camera photos are capped
        // at PDF_DIM to keep file sizes reasonable.
        const srcDim = p.isScreenshot ? PDF_DIM_SCREENSHOT : PDF_DIM;
        const src = downscaleCanvas(p.original, srcDim);
        const warped = perspectiveWarp(src, p.quad);
        const rotated = rotateCanvas(warped, p.rotation);
        const flipped = flipCanvas(rotated, p.flipH, p.flipV);
        const filtered = getFilteredCanvas(flipped, p.filterMode, p.filterStrength);
        // For screenshots the bilinear perspective warp slightly softens sharp text
        // edges.  A stronger unsharp mask restores crispness without affecting
        // camera photos (which already go through _unsharpMask inside noShadowFilter).
        const sharpened = p.isScreenshot && p.filterMode === "none"
          ? sharpenCanvas(filtered, 0.75)
          : filtered;
        return sharpened;
      };

      await yieldToMain();
      const first = processPage(exportPages[0]);
      const thumbUrl = makeThumbnail(first, 480, 0.82);
      // jsPDF defaults to portrait orientation which silently reorders format
      // dimensions when width > height, making landscape pages portrait.
      // Always pass the explicit orientation so the PDF page matches the canvas.
      const firstOrientation = first.width >= first.height ? "l" : "p";
      const pdf = new jsPDF({ unit: "px", format: [first.width, first.height], orientation: firstOrientation });
      const firstJpeg = first.toDataURL("image/jpeg", 0.92);
      pdf.addImage(firstJpeg, "JPEG", 0, 0, first.width, first.height);
      for (let i = 1; i < exportPages.length; i++) {
        await yieldToMain();
        setProgress(`Generating PDF… (${i + 1}/${exportPages.length})`);
        const c = processPage(exportPages[i]);
        const pageOrientation = c.width >= c.height ? "l" : "p";
        pdf.addPage([c.width, c.height], pageOrientation);
        const jpeg = c.toDataURL("image/jpeg", 0.92);
        pdf.addImage(jpeg, "JPEG", 0, 0, c.width, c.height);
      }
      const dataUrl = pdf.output("datauristring");
      const size = Math.round((dataUrl.length * 3) / 4);

      // Step 3 — Save locally on native, or upload to server on web.
      setProgress("Saving…");
      await yieldToMain();

      if (Capacitor.isNativePlatform()) {
        const { createLocalDoc, updateLocalDoc } = await import("@/lib/localDocs");
        if (editDocId) {
          const updated = await updateLocalDoc(editDocId, { name, dataUrl, size, pages: pagesJson, thumbUrl });
          if (!updated) throw new Error("Document not found");
          return { id: editDocId, _dataUrl: dataUrl, _name: name };
        } else {
          const doc = await createLocalDoc({
            name, type: "pdf", dataUrl, size, thumbUrl,
            folderId: folderId ?? null, pages: pagesJson,
            status: "draft", isFavorite: false,
          });
          return { id: doc.id, _dataUrl: dataUrl, _name: name };
        }
      }

      const sizeBytes = Math.round((dataUrl.length * 3) / 4);
      if (sizeBytes > 15 * 1024 * 1024) {
        console.warn(`PDF is large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) — upload may be slow`);
      }

      let res: Response;
      if (editDocId) {
        res = await apiRequest("PATCH", `/api/documents/${editDocId}`, {
          name, dataUrl, size, pages: pagesJson, thumbUrl,
        });
      } else {
        res = await apiRequest("POST", "/api/documents", {
          name, type: "pdf", dataUrl, size, thumbUrl,
          folderId: folderId ?? null, pages: pagesJson,
        });
      }
      if (!res.ok) throw new Error("Failed to save");
      const json = await res.json();
      return { ...json, _dataUrl: dataUrl, _name: name };
    },
    onSuccess: async (savedDoc: { id: string; _dataUrl?: string; _name?: string }) => {
      setSaveProgress("");
      if (clientId && savedDoc?.id) {
        try { await apiRequest("PUT", `/api/documents/${savedDoc.id}`, { clientId }); } catch { /* ignore */ }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      if (editDocId) queryClient.invalidateQueries({ queryKey: ["/api/documents", editDocId] });

      // Export: on native iOS/Android use Capacitor Share so the user gets a
      // real "Save to Files / AirDrop / …" sheet. On web, trigger a download
      // only if autoExport is enabled (avoids surprise downloads otherwise).
      if (savedDoc._dataUrl) {
        try {
          if (Capacitor.isNativePlatform()) {
            // ── Native: write to cache dir then open the iOS share sheet ─────
            const { Filesystem, Directory } = await import("@capacitor/filesystem");
            const { Share } = await import("@capacitor/share");
            const filename = docFilename(savedDoc._name ?? "Scan", "pdf");
            const base64 = savedDoc._dataUrl.split(",")[1];
            const writeResult = await Filesystem.writeFile({
              path: filename,
              data: base64,
              directory: Directory.Cache,
            });
            await Share.share({
              title: filename,
              url: writeResult.uri,
              dialogTitle: "Save or share your PDF",
            });
          } else if (getBoolSetting("autoExport", false)) {
            // ── Web: download only when autoExport setting is on ─────────────
            const blob = dataUrlToBlob(savedDoc._dataUrl);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = docFilename(savedDoc._name ?? "Scan", "pdf");
            a.click();
            URL.revokeObjectURL(url);
          }
        } catch { /* share cancelled — PDF is still saved inside the app */ }
      }

      toast({ title: editDocId ? "Document updated!" : "Document saved!" });
      onSaved();
    },
    onError: (err) => {
      setSaveProgress("");
      console.error("PDF export error:", err);
      // If server upload failed, offer a local download as fallback
      toast({
        title: "Save failed — tap to download locally",
        variant: "destructive",
      });
    },
  });

  const savePdfMutation = useMutation({
    mutationFn: async () => {
      const dataUrl = pickedPdfDataUrl;
      if (Capacitor.isNativePlatform()) {
        const { createLocalDoc } = await import("@/lib/localDocs");
        return await createLocalDoc({
          name: pickedPdfName.trim() || "Document", type: "pdf",
          dataUrl, size: Math.round((dataUrl.length * 3) / 4),
          thumbUrl: null, folderId: folderId ?? null,
          status: "draft", isFavorite: false,
        });
      }
      const res = await apiRequest("POST", "/api/documents", {
        name: pickedPdfName.trim() || "Document", type: "pdf",
        dataUrl, size: Math.round((dataUrl.length * 3) / 4),
        folderId: folderId ?? null,
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: async (savedDoc: { id: string }) => {
      if (clientId && savedDoc?.id) {
        try { await apiRequest("PUT", `/api/documents/${savedDoc.id}`, { clientId }); } catch { /* ignore */ }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "PDF imported!" });
      onSaved();
    },
    onError: () => toast({ title: "Failed to import PDF", variant: "destructive" }),
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EDIT MODE LOADING SCREEN
  // ══════════════════════════════════════════════════════════════════════════

  if (loadingEdit) {
    return (
      <div className="fixed inset-0 bg-background flex flex-col items-center justify-center z-50 gap-4">
        <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Loading document for editing…</p>
        <button onClick={onCancel} className="text-xs text-muted-foreground underline mt-2 active:opacity-60">Cancel</button>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CAMERA
  // ══════════════════════════════════════════════════════════════════════════

  if (stage === "camera") {
    // ── Native iOS: camera opens immediately via useEffect; show minimal backdrop ──
    if (isNative) {
      return (
        <div className="fixed inset-0 bg-black flex flex-col z-50">
          {/* Top bar */}
          <div className="flex-shrink-0 flex items-center justify-between px-5 pb-2"
            style={{ paddingTop: "max(env(safe-area-inset-top), 1.5rem)" }}>
            <button data-testid="button-cancel" onClick={onCancel}
              className="text-white text-sm font-medium opacity-80 active:opacity-50 py-1 pr-3">Cancel</button>
            <p className="text-white text-sm font-semibold opacity-75">Scan Document</p>
            {pages.length > 0
              ? <button onClick={() => openEditor(pages.length - 1)}
                  className="flex items-center gap-1 bg-white/20 rounded-xl px-3 py-1.5 active:bg-white/30">
                  <span className="text-white text-xs font-bold">{pages.length} pg</span>
                  <ChevronRight className="w-3.5 h-3.5 text-white" />
                </button>
              : <div className="w-16" />}
          </div>

          {/* Camera opening indicator */}
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            <p className="text-white/50 text-sm">Opening camera…</p>
          </div>

          {/* Bottom bar: gallery corner button + captured thumbnails */}
          <div className="flex-shrink-0 px-4 pb-8 flex items-end justify-between"
            style={{ paddingBottom: "max(2rem, calc(env(safe-area-inset-bottom) + 1.25rem))" }}>
            {/* Gallery button */}
            <button
              data-testid="button-native-gallery"
              onClick={nativeGallery}
              className="w-16 h-16 rounded-2xl bg-white/15 flex flex-col items-center justify-center gap-1 active:opacity-60">
              <ImageIcon className="w-6 h-6 text-white" />
              <span className="text-white text-[10px] font-semibold">Gallery</span>
            </button>

            {/* Captured thumbnails scroll */}
            {pages.length > 0 && (
              <div className="flex gap-2 overflow-x-auto scrollbar-none max-w-[60vw]">
                {pages.map((p, i) => (
                  <button key={p.id} onClick={() => openEditor(i)} className="relative flex-shrink-0 active:opacity-70">
                    <img src={p.thumbUrl} alt="" className="w-12 rounded-xl object-cover bg-white/10" style={{ height: 64 }} />
                    <div className="absolute bottom-1 left-1 bg-black/60 rounded px-1">
                      <span className="text-white font-bold" style={{ fontSize: 9 }}>{i + 1}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Edit all / placeholder right side */}
            {pages.length > 0
              ? <button onClick={() => openEditor(0)}
                  className="flex-shrink-0 flex items-center gap-1.5 bg-white rounded-2xl px-4 py-2.5 active:opacity-80">
                  <span className="text-black text-sm font-bold">Edit</span>
                  <ChevronRight className="w-4 h-4 text-black" />
                </button>
              : <div className="w-16" />}
          </div>
        </div>
      );
    }

    // ── Web: live viewfinder ──
    return (
      <div className="fixed inset-0 bg-black flex flex-col z-50">
        <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={handleFileChange} />

        {/* ── Top bar ── */}
        <div className="flex-shrink-0 flex items-center justify-between px-5 pb-2" style={{ paddingTop: "max(env(safe-area-inset-top), 1.5rem)" }}>
          <button data-testid="button-cancel" onClick={onCancel} className="text-white text-sm font-medium opacity-80 active:opacity-50 py-1 pr-3">Cancel</button>
          <p className="text-white text-sm font-semibold opacity-75">Scan Document</p>
          {pages.length > 0
            ? <button data-testid="button-open-editor" onClick={() => openEditor(pages.length - 1)}
                className="flex items-center gap-1 bg-white/20 rounded-xl px-3 py-1.5 active:bg-white/30">
                <span className="text-white text-xs font-bold">{pages.length} pg</span>
                <ChevronRight className="w-3.5 h-3.5 text-white" />
              </button>
            : <div className="w-16" />}
        </div>

        {/* ── Camera preview ── */}
        <div className="flex-1 relative overflow-hidden">
          {cameraError
            ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8">
                {cameraError === "__native__" ? (
                  // ── Native Capacitor mode: use capture button below, gallery button on left ──
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                    <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
                      <ImageIcon className="w-10 h-10 text-white/60" />
                    </div>
                    <p className="text-white/60 text-sm text-center">Tap the button below to scan</p>
                  </div>
                ) : (
                  // ── Web camera error ──
                  <>
                    <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center">
                      <ImageIcon className="w-10 h-10 text-white/40" />
                    </div>
                    <p className="text-white/70 text-sm text-center leading-relaxed whitespace-pre-line">{cameraError}</p>
                    <div className="flex flex-col gap-2.5 w-full max-w-xs">
                      <button
                        data-testid="button-camera-retry"
                        onClick={() => startCamera()}
                        className="w-full py-3.5 rounded-2xl bg-white text-black text-sm font-bold active:opacity-70"
                      >
                        Try Again
                      </button>
                      <button
                        data-testid="button-camera-library"
                        onClick={() => fileInputRef.current?.click()}
                        className="w-full py-3.5 rounded-2xl bg-white/20 text-white text-sm font-semibold active:opacity-70 flex items-center justify-center gap-2"
                      >
                        <ImageIcon className="w-4 h-4" /> Pick from Library
                      </button>
                      <a
                        href={window.location.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-white/45 text-xs text-center mt-1 underline underline-offset-2"
                      >
                        Open in new tab (may fix camera access)
                      </a>
                    </div>
                  </>
                )}
              </div>
            : <video
                ref={videoRef}
                data-testid="camera-preview"
                autoPlay
                playsInline
                muted
                disablePictureInPicture
                // @ts-expect-error — disableRemotePlayback is valid but not in React types
                disableRemotePlayback
                className="w-full h-full object-cover"
              />}
          {!cameraError && (
            <>
              {/* Scanner animation keyframes */}
              <style>{`
                @keyframes docScanLine {
                  0%   { top: 0%;   opacity: 0; }
                  6%   { opacity: 1; }
                  94%  { opacity: 1; }
                  100% { top: 100%; opacity: 0; }
                }
                @keyframes docCornerPop {
                  0%, 100% { transform: scale(1); }
                  45%       { transform: scale(1.22); }
                }
                @keyframes docFrameGlow {
                  0%, 100% { opacity: 0.65; }
                  50%       { opacity: 1; }
                }
                @keyframes docBadgeFade {
                  from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
                  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
              `}</style>

              {/* Guide frame — colour and glow shift on detection */}
              <div
                className="absolute inset-x-6 inset-y-12 rounded-2xl pointer-events-none"
                style={docDetected === "detected" ? {
                  border: "2px solid rgba(59,130,246,0.9)",
                  boxShadow: "0 0 0 1px rgba(59,130,246,0.2), inset 0 0 32px rgba(59,130,246,0.06)",
                  animation: "docFrameGlow 1.8s ease-in-out infinite",
                } : {
                  border: "1px solid rgba(255,255,255,0.22)",
                }}
              >
                {/* Corner brackets */}
                {([
                  "top-0 left-0 border-t-[3px] border-l-[3px] rounded-tl-xl",
                  "top-0 right-0 border-t-[3px] border-r-[3px] rounded-tr-xl",
                  "bottom-0 left-0 border-b-[3px] border-l-[3px] rounded-bl-xl",
                  "bottom-0 right-0 border-b-[3px] border-r-[3px] rounded-br-xl",
                ] as const).map((cls, i) => (
                  <div
                    key={i}
                    className={`absolute w-7 h-7 ${cls}`}
                    style={docDetected === "detected" ? {
                      borderColor: "rgba(59,130,246,1)",
                      animation: "docCornerPop 1.6s ease-in-out infinite",
                      animationDelay: `${i * 0.13}s`,
                    } : {
                      borderColor: "rgba(255,255,255,0.85)",
                    }}
                  />
                ))}

                {/* Sweep scan line — only while searching */}
                {docDetected === "searching" && (
                  <div
                    className="absolute left-0 right-0 h-[2px] pointer-events-none"
                    style={{
                      top: 0,
                      background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 10%, rgba(255,255,255,0.7) 40%, rgba(255,255,255,0.95) 50%, rgba(255,255,255,0.7) 60%, rgba(255,255,255,0.1) 90%, transparent 100%)",
                      animation: "docScanLine 2.6s ease-in-out infinite",
                    }}
                  />
                )}
              </div>

              {/* "Document detected" floating badge */}
              {docDetected === "detected" && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    top: "calc(3rem + 14px)",
                    left: "50%",
                    animation: "docBadgeFade 0.3s ease-out forwards",
                  }}
                >
                  <div
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full"
                    style={{
                      background: "rgba(37,99,235,0.88)",
                      backdropFilter: "blur(8px)",
                      transform: "translateX(-50%)",
                    }}
                  >
                    <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                    <span className="text-white font-semibold" style={{ fontSize: 11, letterSpacing: "0.04em" }}>
                      Document detected
                    </span>
                  </div>
                </div>
              )}

              {/* Capture flash */}
              {captureFlash && (
                <div className="absolute inset-0 bg-white/60 pointer-events-none" />
              )}
            </>
          )}
        </div>

        {/* ── Captured page thumbnails (above capture bar) ── */}
        {pages.length > 0 && (
          <div className="flex-shrink-0 bg-black/70 px-4 pt-2.5 pb-2.5 flex items-center gap-3">
            <div className="flex-1 flex gap-2 overflow-x-auto scrollbar-none">
              {pages.map((p, i) => (
                <button key={p.id} data-testid={`thumb-${i}`} onClick={() => openEditor(i)} className="relative flex-shrink-0 active:opacity-70">
                  <img src={p.thumbUrl} alt="" className="w-12 rounded-xl object-cover bg-white/10" style={{ height: 64 }} />
                  <div className="absolute bottom-1 left-1 bg-black/60 rounded px-1">
                    <span className="text-white font-bold" style={{ fontSize: 9 }}>{i + 1}</span>
                  </div>
                </button>
              ))}
            </div>
            <button data-testid="button-edit-all" onClick={() => openEditor(0)}
              className="flex-shrink-0 flex items-center gap-1.5 bg-white rounded-2xl px-4 py-2.5 active:opacity-80">
              <span className="text-black text-sm font-bold">Edit All</span>
              <ChevronRight className="w-4 h-4 text-black" />
            </button>
          </div>
        )}

        {/* ── Bottom capture bar — fixed above safe-area ── */}
        {/*  Extra 2.5rem ensures the bar clears the Replit mobile UI / browser controls */}
        <div className="flex-shrink-0 flex items-center justify-between px-8 bg-black"
          style={{ paddingTop: "1rem", paddingBottom: "max(2.5rem, calc(env(safe-area-inset-bottom) + 1.25rem))" }}>
          <button data-testid="button-library"
            onClick={() => isNative ? nativeGallery() : fileInputRef.current?.click()}
            className="w-16 h-16 rounded-2xl bg-white/20 flex flex-col items-center justify-center gap-1 active:opacity-60">
            <ImageIcon className="w-6 h-6 text-white" />
            <span className="text-white text-[10px] font-semibold">Gallery</span>
          </button>

          <button data-testid="button-capture"
            onClick={isNative ? nativeCapture : capture}
            disabled={(!!cameraError && !isNative) || capturing}
            className="relative flex items-center justify-center disabled:opacity-30 active:scale-95 transition-transform" style={{ width: 84, height: 84 }}>
            <div className="absolute inset-0 rounded-full border-4 border-white opacity-90" />
            {capturing
              ? <div className="w-[68px] h-[68px] rounded-full bg-white/60 shadow-lg flex items-center justify-center">
                  <div className="w-7 h-7 rounded-full border-[3px] border-black/30 border-t-black animate-spin" />
                </div>
              : <div className="w-[68px] h-[68px] rounded-full bg-white shadow-lg" />}
          </button>

          <div className="w-16 h-16 flex flex-col items-center justify-center gap-1">
            {pages.length > 0 && <>
              <span className="text-white text-2xl font-bold leading-none">{pages.length}</span>
              <span className="text-white/60 text-[10px] font-semibold">captured</span>
            </>}
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PDF IMPORT NAME
  // ══════════════════════════════════════════════════════════════════════════

  if (stage === "pdf-name") {
    return (
      <div className="fixed inset-0 bg-black flex flex-col z-50">
        <div className="flex-shrink-0 flex items-center justify-between px-6 pt-14 pb-4">
          <button onClick={() => { setStage("camera"); startCamera(); }} className="text-white text-sm font-medium opacity-80 active:opacity-50">Back</button>
          <p className="text-white text-sm font-semibold opacity-75">Import PDF</p>
          <div className="w-14" />
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-24 h-32 rounded-2xl bg-white/10 flex flex-col items-center justify-center gap-2">
            <FileText className="w-10 h-10 text-white/50" />
            <span className="text-white/40 text-xs">PDF</span>
          </div>
        </div>
        <div className="flex-shrink-0 bg-white rounded-t-3xl pt-2" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
          <div className="w-10 h-1 bg-muted rounded-full mx-auto mb-4" />
          <p className="text-sm font-semibold text-foreground text-center mb-4">Name your PDF</p>
          <div className="px-5 mb-4">
            <input autoFocus data-testid="input-pdf-name" value={pickedPdfName}
              onChange={(e) => setPickedPdfName(e.target.value)} placeholder="Document name…"
              className="w-full px-4 py-3 rounded-xl bg-muted text-sm border-0 outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="px-5">
            <button data-testid="button-save-pdf" onClick={() => savePdfMutation.mutate()} disabled={savePdfMutation.isPending}
              className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-50 active:scale-[0.98] transition-transform flex items-center justify-center gap-2">
              {savePdfMutation.isPending ? <><div className="w-4 h-4 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />Saving…</> : "Import PDF"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EDITOR (swipeable multi-page, performance-optimized)
  // ══════════════════════════════════════════════════════════════════════════

  if (stage === "editor" && currentPage) {
    const rot = currentPage.rotation;
    const showCropOverlay = true; // crop works at any rotation via coordinate transform

    // Image display: use cached processedUrl for canvas-processed filters (document/id/noshadow),
    // else fall back to previewUrl + CSS filter for auto/color, or raw for none.
    const useProcUrl = (
      currentPage.filterMode === "document" ||
      currentPage.filterMode === "id" ||
      currentPage.filterMode === "noshadow"
    ) && !!currentPage.processedUrl;
    const imgSrc = useProcUrl ? currentPage.processedUrl : currentPage.previewUrl;
    const cssFilter = !useProcUrl && currentPage.filterMode !== "none" && currentPage.filterMode !== "noshadow"
      ? getFilterCSS(currentPage.filterMode, currentPage.filterStrength) : "";

    return (
      <div className="fixed inset-0 bg-black flex flex-col z-50">
        <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />

        {/* ── Header ── */}
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2"
          style={{ paddingTop: "max(env(safe-area-inset-top), 1.5rem)" }}>
          {onEditedImage ? (
            /* Return mode: Cancel goes back to import organizer */
            <>
              <button data-testid="button-edit-cancel"
                onClick={onCancel}
                className="text-white text-sm font-medium opacity-80 active:opacity-50 flex items-center gap-1">
                <ChevronLeft className="w-4 h-4" /> Cancel
              </button>
              <span className="text-white text-sm font-bold">Edit Photo</span>
              <div className="w-16" />
            </>
          ) : (
            /* Normal mode */
            <>
              <button data-testid="button-back-to-camera"
                onClick={() => { startCamera(); setStage("camera"); }}
                className="text-white text-sm font-medium opacity-80 active:opacity-50 flex items-center gap-1">
                <ChevronLeft className="w-4 h-4" /> Add
              </button>

              <span className="text-white text-sm font-bold">
                Page {currentIndex + 1} of {pages.length}
              </span>

              <button data-testid="button-remove-current" onClick={() => removePage(currentIndex)}
                className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center active:bg-white/30">
                <X className="w-4 h-4 text-white" />
              </button>
            </>
          )}
        </div>

        {/* ── Image area (swipeable, crop handles, arrows) ── */}
        <div
          ref={imgContainerRef}
          className="flex-1 relative overflow-hidden select-none"
          style={{
            touchAction: "none",          /* tell browser: we handle ALL touch, don't steal */
            overscrollBehavior: "none",   /* kill rubber-band / pull-to-refresh */
            userSelect: "none",
            WebkitUserSelect: "none",
          } as React.CSSProperties}
          onMouseMove={onContainerMouseMove}
          onMouseUp={commitDrag}
          onMouseLeave={commitDrag}
          onTouchStart={onContainerTouchStart}
          onTouchMove={onContainerTouchMove}   /* React handler (also fires; passive: false is via native listener) */
          onTouchEnd={onContainerTouchEnd}
          data-testid="editor-image-area"
        >
          <div
            className="absolute pointer-events-none"
            style={{
              left: elemRect.x, top: elemRect.y,
              width: elemRect.w, height: elemRect.h,
              transformOrigin: "center center",
              willChange: "transform",
            }}
          >
            <img
              key={`img-${currentPage.id}`}
              src={displayUrl || imgSrc}
              alt="page"
              decoding="async"
              className="w-full h-full pointer-events-none"
              style={{
                filter: cssFilter || undefined,
                transform: [
                  currentPage.flipH ? "scaleX(-1)" : "",
                  currentPage.flipV ? "scaleY(-1)" : "",
                ].filter(Boolean).join(" ") || undefined,
                transformOrigin: "center",
              }}
              draggable={false}
            />
          </div>

          {/* Crop overlay — always shown; quad coords are rotation-transformed in svgData */}
          {showCropOverlay && (
            <svg className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox={`0 0 ${containerSize.w} ${containerSize.h}`} data-testid="quad-overlay">

              {/* Dark mask outside crop area */}
              <path d={svgData.path} fill="rgba(0,0,0,0.52)" fillRule="evenodd" />

              {/* Crop edges — dashed orange lines */}
              {(["tl-tr","tr-br","br-bl","bl-tl"] as const).map((seg) => {
                const [a, b] = seg.split("-") as [keyof typeof svgData.qpx, keyof typeof svgData.qpx];
                return <line key={seg}
                  x1={svgData.qpx[a].x} y1={svgData.qpx[a].y}
                  x2={svgData.qpx[b].x} y2={svgData.qpx[b].y}
                  stroke="rgba(251,146,60,0.95)" strokeWidth="2.5" strokeDasharray="9 5" />;
              })}

              {/* Corner L-brackets — white arms pointing inward for clear corner markers */}
              {(["tl", "tr", "bl", "br"] as const).map((c) => {
                const pt = svgData.qpx[c];
                const cx = (svgData.qpx.tl.x + svgData.qpx.tr.x + svgData.qpx.bl.x + svgData.qpx.br.x) / 4;
                const cy = (svgData.qpx.tl.y + svgData.qpx.tr.y + svgData.qpx.bl.y + svgData.qpx.br.y) / 4;
                const L = 22;
                const sx = Math.sign(cx - pt.x);
                const sy = Math.sign(cy - pt.y);
                return (
                  <g key={c} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x} y1={pt.y} x2={pt.x + sx * L} y2={pt.y} />
                    <line x1={pt.x} y1={pt.y} x2={pt.x} y2={pt.y + sy * L} />
                  </g>
                );
              })}

              {/* Mid-side tick marks — short white bars at each edge midpoint */}
              {(["tc", "bc"] as const).map((e) => {
                const pt = svgData.mid[e];
                return (
                  <g key={e} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x - 14} y1={pt.y} x2={pt.x + 14} y2={pt.y} />
                  </g>
                );
              })}
              {(["lc", "rc"] as const).map((e) => {
                const pt = svgData.mid[e];
                return (
                  <g key={e} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x} y1={pt.y - 14} x2={pt.x} y2={pt.y + 14} />
                  </g>
                );
              })}
            </svg>
          )}

          {/* Corner crop handles — 88×88px touch target */}
          {showCropOverlay && (["tl", "tr", "bl", "br"] as const).map((corner) => {
            const pt = svgData.qpx[corner];
            return (
              <div key={corner} data-testid={`crop-handle-${corner}`}
                className="absolute flex items-center justify-center cursor-pointer z-10"
                style={{
                  left: pt.x - 44, top: pt.y - 44, width: 88, height: 88,
                  touchAction: "none",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  draggingCorner.current = corner;
                  dragBaseRef.current = pages[currentIndex]?.quad ?? DEFAULT_QUAD;
                  setPages((prev) => prev.map((p, i) =>
                    i === currentIndex ? { ...p, manualCrop: true } : p
                  ));
                }}>
                <div className="w-12 h-12 rounded-full bg-orange-400/25 flex items-center justify-center shadow-lg">
                  <div className="w-8 h-8 rounded-full bg-orange-400 shadow-xl border-[3px] border-white" />
                </div>
              </div>
            );
          })}

          {/* Mid-side edge handles — pill-shaped, axis-constrained drag.
              For rotation=90/270 the tc/bc handles visually appear on the
              left/right sides of the display, so their pill orientation and
              cursor must flip accordingly. */}
          {showCropOverlay && (() => {
            const rot90or270 = currentPage.rotation === 90 || currentPage.rotation === 270;
            return [
              { key: "tc", pt: svgData.mid.tc, horiz: !rot90or270 },
              { key: "bc", pt: svgData.mid.bc, horiz: !rot90or270 },
              { key: "lc", pt: svgData.mid.lc, horiz:  rot90or270 },
              { key: "rc", pt: svgData.mid.rc, horiz:  rot90or270 },
            ] as const;
          })().map(({ key, pt, horiz }) => {
            // Touch target: wide for top/bottom edges, tall for left/right edges
            const tw = horiz ? 88 : 52, th = horiz ? 52 : 88;
            // Visual pill orientation
            const vw = horiz ? 36 : 14, vh = horiz ? 14 : 36;
            return (
              <div key={key} data-testid={`crop-handle-${key}`}
                className="absolute flex items-center justify-center z-10"
                style={{
                  left: pt.x - tw / 2, top: pt.y - th / 2,
                  width: tw, height: th,
                  cursor: horiz ? "ns-resize" : "ew-resize",
                  touchAction: "none",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  draggingCorner.current = key;
                  dragBaseRef.current = pages[currentIndex]?.quad ?? DEFAULT_QUAD;
                  setPages((prev) => prev.map((p, i) =>
                    i === currentIndex ? { ...p, manualCrop: true } : p
                  ));
                }}>
                {/* Visual: semi-transparent halo + white-bordered orange pill */}
                <div className="bg-orange-400/20 rounded-full flex items-center justify-center shadow"
                  style={{ width: vw + 14, height: vh + 14 }}>
                  <div className="bg-orange-400 border-[3px] border-white shadow-lg"
                    style={{ width: vw, height: vh, borderRadius: 999 }} />
                </div>
              </div>
            );
          })}


          {/* Detecting corners indicator — non-blocking, fades in after 300ms */}
          {detectingIds.has(currentPage.id) && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2
              bg-black/65 backdrop-blur-sm rounded-full px-3 py-1.5 pointer-events-none"
              data-testid="detecting-indicator">
              <div className="w-3 h-3 rounded-full border border-white/40 border-t-white animate-spin" />
              <span className="text-white text-xs font-medium">Detecting document…</span>
            </div>
          )}

          {processing && (
            <div className="absolute inset-0 bg-black/55 flex flex-col items-center justify-center gap-3">
              <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              <p className="text-white text-sm font-medium">Applying filter…</p>
            </div>
          )}

        </div>

        {/* ── Compact dark toolbar: prev arrow | controls | next arrow ── */}
        <div className="flex-shrink-0 bg-neutral-900 flex items-center"
          style={{ paddingTop: 3, paddingBottom: 3 }}>

          {/* Prev page arrow */}
          {pages.length > 1 && (
            <button
              data-testid="button-prev-page"
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              disabled={currentIndex === 0}
              className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-white/15 text-white disabled:opacity-25 disabled:pointer-events-none active:bg-white/30 ml-1"
              style={{ touchAction: "manipulation" }}>
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}

          {/* Scrollable controls strip */}
          <div className="flex-1 flex items-center gap-2 overflow-x-auto scrollbar-none px-1">

            {/* Rotate + detect grouped in one pill */}
            <div className="flex-shrink-0 flex items-center rounded-lg overflow-hidden" style={{ background: "rgba(255,255,255,0.12)" }}>
              <button data-testid="button-rotate-ccw"
                onClick={rotateCcwPage}
                onTouchStart={(e) => { e.preventDefault(); rotateCcwPage(); }}
                className="flex items-center justify-center w-10 h-10 active:bg-white/20"
                style={{ touchAction: "manipulation" }}>
                <RotateCcw className="w-4 h-4 text-white" />
              </button>
              <div className="w-px h-4 bg-white/20 flex-shrink-0" />
              <button data-testid="button-rotate"
                onClick={rotatePage}
                onTouchStart={(e) => { e.preventDefault(); rotatePage(); }}
                className="flex items-center justify-center w-10 h-10 active:bg-white/20"
                style={{ touchAction: "manipulation" }}>
                <RotateCw className="w-4 h-4 text-white" />
              </button>
              <div className="w-px h-4 bg-white/20 flex-shrink-0" />
              <button data-testid="button-redetect" onClick={rerunDetection}
                disabled={detectingIds.has(currentPage.id)}
                className="flex items-center justify-center w-8 h-8 active:bg-white/20 disabled:opacity-35">
                <ScanSearch className="w-4 h-4 text-white" />
              </button>
              <div className="w-px h-4 bg-white/20 flex-shrink-0" />
              <button data-testid="button-crop-fullscreen"
                onClick={() => setCropFullscreen(true)}
                onTouchStart={(e) => { e.preventDefault(); setCropFullscreen(true); }}
                className="flex items-center justify-center w-10 h-10 active:bg-white/20"
                style={{ touchAction: "manipulation" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <path d="M6 2v4M2 6h4M18 2v4M22 6h-4M6 22v-4M2 18h4M18 22v-4M22 18h-4"/>
                </svg>
              </button>
            </div>

            {/* Divider */}
            <div className="w-px h-5 bg-white/20 flex-shrink-0" />

            {/* Filter chips */}
            {(["none", "auto", "noshadow", "document", "id"] as FilterMode[]).map((f) => (
              <button key={f} data-testid={`filter-${f}`} onClick={() => handleFilterChange(f)}
                className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors ${
                  currentPage.filterMode === f
                    ? "bg-white text-black"
                    : "text-white/75 active:bg-white/20"
                }`}
                style={currentPage.filterMode === f ? {} : { background: "rgba(255,255,255,0.10)" }}>
                {FILTER_LABELS[f]}
              </button>
            ))}

            {/* Noshadow strength slider inline — only shown when that filter is active */}
            {currentPage.filterMode === "noshadow" && (
              <>
                <div className="w-px h-5 bg-white/20 flex-shrink-0" />
                <span className="text-[10px] text-white/45 flex-shrink-0">0%</span>
                <input type="range" min="0" max="100" step="1" value={localStrength}
                  onChange={(e) => handleStrengthChange(Number(e.target.value))}
                  className="flex-shrink-0 accent-white w-24" style={{ height: 3 }}
                  data-testid="slider-noshadow-strength" />
                <span className="text-[10px] text-white/45 flex-shrink-0">100%</span>
                <span className="text-[11px] font-semibold text-white/80 flex-shrink-0">{localStrength}%</span>
              </>
            )}
          </div>{/* end scrollable strip */}

          {/* Next page arrow */}
          {pages.length > 1 && (
            <button
              data-testid="button-next-page"
              onClick={() => setCurrentIndex((i) => Math.min(pages.length - 1, i + 1))}
              disabled={currentIndex === pages.length - 1}
              className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-white/15 text-white disabled:opacity-25 disabled:pointer-events-none active:bg-white/30 mr-1"
              style={{ touchAction: "manipulation" }}>
              <ChevronRight className="w-5 h-5" />
            </button>
          )}
        </div>{/* end toolbar */}

        {/* ── White save bar ── */}
        <div className="flex-shrink-0 bg-white rounded-t-2xl"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>

          {onEditedImage ? (
            /* ── RETURN MODE: single "Use This Photo" button ── */
            <div className="px-4 pt-3 pb-1">
              <button
                data-testid="button-use-photo"
                onClick={() => {
                  const p = pages[0];
                  if (!p) return;
                  const src = downscaleCanvas(p.original, PDF_DIM);
                  const warped = perspectiveWarp(src, p.quad);
                  const rotated = rotateCanvas(warped, p.rotation);
                  const flipped = flipCanvas(rotated, p.flipH, p.flipV);
                  const filtered = getFilteredCanvas(flipped, p.filterMode, p.filterStrength);
                  const dataUrl = filtered.toDataURL("image/jpeg", 0.88);
                  onEditedImage(filtered, dataUrl);
                }}
                disabled={!pages.length}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm active:scale-[0.98] transition-transform disabled:opacity-40"
              >
                <Check className="w-4 h-4" />
                Use This Photo
              </button>
            </div>
          ) : (
            /* ── NORMAL MODE: collapsible bar with name + save ── */
            <>
              {/* ── COLLAPSED row (always visible) ── */}
              <div className="flex items-center gap-2 px-3 pt-2 pb-2">
                {/* Chevron toggle — expands/collapses the panel */}
                <button
                  data-testid="button-toggle-panel"
                  onClick={() => setPanelExpanded((v) => !v)}
                  className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-muted active:bg-muted-foreground/20"
                  aria-label={panelExpanded ? "Collapse panel" : "Expand panel"}>
                  {panelExpanded
                    ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
                </button>

                {/* Name hint — tapping expands the panel and focuses the input */}
                <button
                  className="flex-1 min-w-0 text-left px-3 py-2 rounded-xl bg-muted active:bg-muted-foreground/20"
                  onClick={() => {
                    setPanelExpanded(true);
                    setTimeout(() => nameInputRef.current?.focus(), 50);
                  }}>
                  <span className={`text-sm truncate block ${documentName ? "text-foreground" : "text-muted-foreground"}`}>
                    {documentName || "Document name…"}
                  </span>
                </button>

                {/* Save / Update button — always accessible without expanding */}
                <button data-testid="button-export-pdf" onClick={() => exportMutation.mutate()}
                  disabled={exportMutation.isPending || !pages.length}
                  className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-2xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform">
                  {exportMutation.isPending
                    ? <>
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
                        <span className="whitespace-nowrap text-xs">{saveProgress || "Saving…"}</span>
                      </>
                    : editDocId
                      ? <><Check className="w-3.5 h-3.5" /><span className="whitespace-nowrap text-xs">Update</span></>
                      : <><Check className="w-3.5 h-3.5" /><span className="whitespace-nowrap text-xs">Save PDF</span></>
                  }
                </button>
              </div>

              {/* ── EXPANDED content (thumbnail strip + name input) ── */}
              {panelExpanded && (
                <>
                  {/* Thumbnail strip — has its own px-3, render at full width */}
                  {pages.length > 1 && (
                    <ThumbnailStrip
                      pages={pages}
                      currentIndex={currentIndex}
                      onSelect={handleThumbSelect}
                      onAdd={handleThumbAdd}
                    />
                  )}
                  {/* Editable name input */}
                  <div className="px-3 pb-2">
                    <input
                      ref={nameInputRef}
                      data-testid="input-document-name"
                      value={documentName}
                      onChange={(e) => setDocumentName(e.target.value)}
                      placeholder="Document name…"
                      className="w-full px-3 py-2.5 rounded-xl bg-muted text-sm text-foreground border-0 outline-none placeholder:text-muted-foreground" />
                  </div>
                </>
              )}
            </>
          )}
        </div>


        {/* ── Fullscreen crop overlay ── */}
        {cropFullscreen && cropSvgData && (() => {
          const sd = cropSvgData;
          const rot90or270 = currentPage.rotation === 90 || currentPage.rotation === 270;
          return (
            <div
              ref={cropContainerRef}
              className="fixed inset-0 bg-black z-[60] select-none"
              style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
            >
              {/* Image */}
              <img
                src={displayUrl || imgSrc}
                alt="page"
                className="absolute pointer-events-none"
                style={{
                  left: cropImgRectRef.current.x, top: cropImgRectRef.current.y,
                  width: cropImgRectRef.current.w, height: cropImgRectRef.current.h,
                  filter: cssFilter || undefined,
                }}
                draggable={false}
              />

              {/* Crop mask + lines */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none"
                viewBox={`0 0 ${sd.cw} ${sd.ch}`}>
                <path d={sd.path} fill="rgba(0,0,0,0.52)" fillRule="evenodd" />
                {(["tl-tr","tr-br","br-bl","bl-tl"] as const).map((seg) => {
                  const [a, b] = seg.split("-") as [keyof typeof sd.qpx, keyof typeof sd.qpx];
                  return <line key={seg}
                    x1={sd.qpx[a].x} y1={sd.qpx[a].y} x2={sd.qpx[b].x} y2={sd.qpx[b].y}
                    stroke="rgba(251,146,60,0.95)" strokeWidth="2.5" strokeDasharray="9 5" />;
                })}
                {(["tl","tr","bl","br"] as const).map((c) => {
                  const pt = sd.qpx[c];
                  const cx2 = (sd.qpx.tl.x + sd.qpx.tr.x + sd.qpx.bl.x + sd.qpx.br.x) / 4;
                  const cy2 = (sd.qpx.tl.y + sd.qpx.tr.y + sd.qpx.bl.y + sd.qpx.br.y) / 4;
                  const L = 22, sx = Math.sign(cx2 - pt.x), sy = Math.sign(cy2 - pt.y);
                  return <g key={c} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x} y1={pt.y} x2={pt.x + sx * L} y2={pt.y} />
                    <line x1={pt.x} y1={pt.y} x2={pt.x} y2={pt.y + sy * L} />
                  </g>;
                })}
                {(["tc","bc"] as const).map((e2) => {
                  const pt = sd.mid[e2];
                  return <g key={e2} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x - 14} y1={pt.y} x2={pt.x + 14} y2={pt.y} />
                  </g>;
                })}
                {(["lc","rc"] as const).map((e2) => {
                  const pt = sd.mid[e2];
                  return <g key={e2} stroke="white" strokeWidth="4" strokeLinecap="round" fill="none">
                    <line x1={pt.x} y1={pt.y - 14} x2={pt.x} y2={pt.y + 14} />
                  </g>;
                })}
              </svg>

              {/* Corner handles */}
              {(["tl","tr","bl","br"] as const).map((corner) => {
                const pt = sd.qpx[corner];
                return (
                  <div key={corner} className="absolute flex items-center justify-center z-10"
                    style={{ left: pt.x - 44, top: pt.y - 44, width: 88, height: 88, touchAction: "none" }}>
                    <div className="w-12 h-12 rounded-full bg-orange-400/25 flex items-center justify-center shadow-lg">
                      <div className="w-8 h-8 rounded-full bg-orange-400 shadow-xl border-[3px] border-white" />
                    </div>
                  </div>
                );
              })}

              {/* Edge handles */}
              {[
                { key: "tc", pt: sd.mid.tc, horiz: !rot90or270 },
                { key: "bc", pt: sd.mid.bc, horiz: !rot90or270 },
                { key: "lc", pt: sd.mid.lc, horiz:  rot90or270 },
                { key: "rc", pt: sd.mid.rc, horiz:  rot90or270 },
              ].map(({ key, pt, horiz }) => {
                const tw = horiz ? 88 : 52, th = horiz ? 52 : 88;
                const vw2 = horiz ? 36 : 14, vh2 = horiz ? 14 : 36;
                return (
                  <div key={key} className="absolute flex items-center justify-center z-10"
                    style={{ left: pt.x - tw / 2, top: pt.y - th / 2, width: tw, height: th, touchAction: "none" }}>
                    <div className="bg-orange-400/20 rounded-full flex items-center justify-center shadow"
                      style={{ width: vw2 + 14, height: vh2 + 14 }}>
                      <div className="bg-orange-400 border-[3px] border-white shadow-lg"
                        style={{ width: vw2, height: vh2, borderRadius: 999 }} />
                    </div>
                  </div>
                );
              })}

              {/* Done button */}
              <button
                onClick={() => setCropFullscreen(false)}
                onTouchStart={(e) => { e.stopPropagation(); e.preventDefault(); setCropFullscreen(false); }}
                className="fixed bottom-8 left-1/2 -translate-x-1/2 px-8 py-3 bg-white rounded-full text-black font-semibold text-base shadow-xl z-10"
                style={{ touchAction: "manipulation" }}>
                Done
              </button>
            </div>
          );
        })()}
      </div>
    );
  }

  return null;
}
