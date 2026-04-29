import { useState, useRef, useCallback, useEffect } from "react";
import { X, Camera, ImagePlus, FileText, Send, RotateCcw, CheckCircle2, Layers, Copy } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isDarkMode } from "@/lib/theme";
import type { ConversationWithContact } from "@shared/schema";

const ORB_LIGHT = [
  "radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%)",
  "radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%)",
  "radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%)",
  "#b8c0cc",
].join(", ");

const ORB_DARK = [
  "radial-gradient(ellipse at 20% 15%, #1a1a1f 0%, #0e0e12 30%, transparent 60%)",
  "radial-gradient(ellipse at 80% 85%, #16161a 0%, #0a0a0c 35%, transparent 65%)",
  "radial-gradient(ellipse at 50% 50%, #000000 0%, transparent 50%)",
  "#050507",
].join(", ");

interface ScannerOverlayProps {
  conversationId: string | null;
  onClose: () => void;
  onSent: (conversationId: string) => void;
}

type Step = "capture" | "review" | "send";
type PdfMode = "merge" | "separate";

export default function ScannerOverlay({ conversationId, onClose, onSent }: ScannerOverlayProps) {
  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const headerBg = dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)";
  const borderColor = dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  const [step, setStep] = useState<Step>("capture");
  const [images, setImages] = useState<string[]>([]);
  const [docName, setDocName] = useState("");
  const [selectedConvId, setSelectedConvId] = useState(conversationId ?? "");
  const [pdfMode, setPdfMode] = useState<PdfMode>("merge");
  const [pdfResults, setPdfResults] = useState<Array<{ dataUrl: string; name: string }>>([]);
  const [isConverting, setIsConverting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data: conversations = [] } = useQuery<ConversationWithContact[]>({
    queryKey: ["/api/conversations"],
  });

  const saveMutation = useMutation({
    mutationFn: async ({ pdfs, convId }: { pdfs: Array<{ dataUrl: string; name: string }>; convId: string }) => {
      for (const pdf of pdfs) {
        const sizeEstimate = Math.round(pdf.dataUrl.length * 0.75);
        const fileRes = await apiRequest("POST", "/api/files", {
          name: pdf.name,
          type: "pdf",
          size: sizeEstimate,
          dataUrl: pdf.dataUrl,
          conversationId: convId,
        });
        const file = await fileRes.json();
        await apiRequest("POST", `/api/conversations/${convId}/messages`, {
          conversationId: convId,
          content: pdf.name,
          type: "file",
          fromMe: true,
          fileId: file.id,
          fileName: pdf.name,
          fileSize: sizeEstimate,
        });
      }
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", vars.convId, "messages"] });
      onSent(vars.convId);
    },
    onError: () => toast({ title: "Failed to send document", variant: "destructive" }),
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files ?? []);
    if (selectedFiles.length === 0) return;
    const readers = selectedFiles.map(file => new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = ev => resolve(ev.target?.result as string);
      reader.readAsDataURL(file);
    }));
    Promise.all(readers).then(results => {
      setImages(prev => [...prev, ...results]);
      setStep("review");
    });
    e.target.value = "";
  };

  const convertToPdf = useCallback(async () => {
    if (images.length === 0) return;
    setIsConverting(true);
    try {
      const { jsPDF } = await import("jspdf");

      const createPdfFromImages = async (imgs: string[]): Promise<string> => {
        const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
        for (let i = 0; i < imgs.length; i++) {
          if (i > 0) pdf.addPage();
          const img = new Image();
          await new Promise<void>(resolve => {
            img.onload = () => {
              const pageW = 210, pageH = 297, margin = 10;
              const maxW = pageW - margin * 2, maxH = pageH - margin * 2;
              const ratio = Math.min(maxW / img.width, maxH / img.height);
              const w = img.width * ratio, h = img.height * ratio;
              pdf.addImage(imgs[i], "JPEG", (pageW - w) / 2, (pageH - h) / 2, w, h);
              resolve();
            };
            img.src = imgs[i];
          });
        }
        return pdf.output("datauristring");
      };

      const baseName = docName || `Scan_${new Date().toISOString().slice(0, 10)}`;

      if (pdfMode === "merge") {
        const dataUrl = await createPdfFromImages(images);
        const name = baseName.endsWith(".pdf") ? baseName : `${baseName}.pdf`;
        setPdfResults([{ dataUrl, name }]);
        if (!docName) setDocName(name);
      } else {
        const results: Array<{ dataUrl: string; name: string }> = [];
        for (let i = 0; i < images.length; i++) {
          const dataUrl = await createPdfFromImages([images[i]]);
          results.push({ dataUrl, name: `${baseName}_${i + 1}.pdf` });
        }
        setPdfResults(results);
        if (!docName) setDocName(baseName);
      }
      setStep("send");
    } catch {
      toast({ title: "PDF conversion failed", variant: "destructive" });
    } finally {
      setIsConverting(false);
    }
  }, [images, docName, pdfMode, toast]);

  const handleSend = () => {
    if (pdfResults.length === 0 || !selectedConvId) {
      toast({ title: "Please select a conversation", variant: "destructive" });
      return;
    }
    const pdfs = pdfResults.map((p, i) => ({
      dataUrl: p.dataUrl,
      name: pdfMode === "separate" && pdfResults.length > 1
        ? `${(docName || "Scan").replace(/\.pdf$/i, "")}_${i + 1}.pdf`
        : (docName || p.name),
    }));
    saveMutation.mutate({ pdfs, convId: selectedConvId });
  };

  return (
    <>
    <div style={{ position: "fixed", inset: 0, zIndex: 49, background: orbBg, pointerEvents: "none" }} />
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "transparent" }}>
      <div className="flex-shrink-0 flex items-center justify-between px-4 pb-4" style={{ paddingTop: "max(3rem, env(safe-area-inset-top))", background: headerBg, backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`, borderBottom: `0.5px solid ${borderColor}` }}>
        <button data-testid="button-scanner-close" onClick={onClose}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground hover-elevate">
          <X className="w-5 h-5" />
        </button>
        <div className="text-center">
          <h2 className="text-base font-semibold text-foreground">
            {step === "capture" ? "Scan Document" : step === "review" ? "Review Pages" : "Send PDF"}
          </h2>
          {step !== "capture" && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {step === "review" ? `${images.length} page${images.length !== 1 ? "s" : ""}` : `${pdfResults.length} PDF${pdfResults.length !== 1 ? "s" : ""} ready`}
            </p>
          )}
        </div>
        <div className="w-9" />
      </div>

      <div className="flex-1 overflow-y-auto">
        {step === "capture" && <CaptureStep fileInputRef={fileInputRef} />}
        {step === "review" && (
          <ReviewStep
            images={images}
            pdfMode={pdfMode}
            setPdfMode={setPdfMode}
            isConverting={isConverting}
            onRemove={idx => {
              const newImgs = images.filter((_, i) => i !== idx);
              setImages(newImgs);
              if (newImgs.length === 0) setStep("capture");
            }}
            onAddMore={() => fileInputRef.current?.click()}
            onConvert={convertToPdf}
          />
        )}
        {step === "send" && (
          <SendStep
            docName={docName}
            setDocName={setDocName}
            selectedConvId={selectedConvId}
            setSelectedConvId={setSelectedConvId}
            conversations={conversations}
            pdfResults={pdfResults}
            pdfMode={pdfMode}
            onBack={() => setStep("review")}
            onSend={handleSend}
            isPending={saveMutation.isPending}
          />
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" multiple capture="environment"
        className="hidden" onChange={handleFileSelect} />
    </div>
    </>
  );
}

function CaptureStep({ fileInputRef }: { fileInputRef: React.RefObject<HTMLInputElement> }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 py-12 gap-8">
      <div className="w-24 h-24 rounded-3xl bg-primary/10 flex items-center justify-center">
        <Camera className="w-12 h-12 text-primary" />
      </div>
      <div className="text-center">
        <h3 className="text-xl font-bold text-foreground mb-2">Scan a Document</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Take a photo or upload an image. It will be automatically converted to PDF.
        </p>
      </div>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <button data-testid="button-take-photo"
          onClick={() => {
            if (fileInputRef.current) { fileInputRef.current.capture = "environment"; fileInputRef.current.click(); }
          }}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-3 active:scale-[0.98] transition-transform">
          <Camera className="w-5 h-5" /> Take Photo
        </button>
        <button data-testid="button-upload-image"
          onClick={() => {
            if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); }
          }}
          className="w-full h-14 rounded-2xl bg-muted text-foreground font-semibold flex items-center justify-center gap-3 active:scale-[0.98] transition-transform">
          <ImagePlus className="w-5 h-5" /> Upload from Gallery
        </button>
      </div>
    </div>
  );
}

function ReviewStep({ images, pdfMode, setPdfMode, isConverting, onRemove, onAddMore, onConvert }: {
  images: string[];
  pdfMode: PdfMode;
  setPdfMode: (m: PdfMode) => void;
  isConverting: boolean;
  onRemove: (idx: number) => void;
  onAddMore: () => void;
  onConvert: () => void;
}) {
  return (
    <div className="flex flex-col h-full px-4 py-4">
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3 mb-4">
          {images.map((img, idx) => (
            <div key={idx} className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-muted">
              <img src={img} alt={`Page ${idx + 1}`} className="w-full h-full object-cover" />
              <div className="absolute top-2 left-2 bg-black/60 rounded-lg px-2 py-0.5">
                <span className="text-white text-[11px] font-medium">p.{idx + 1}</span>
              </div>
              <button data-testid={`button-remove-page-${idx}`} onClick={() => onRemove(idx)}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-black/60 flex items-center justify-center">
                <X className="w-3.5 h-3.5 text-white" />
              </button>
            </div>
          ))}
          <button data-testid="button-add-more" onClick={onAddMore}
            className="aspect-[3/4] rounded-2xl border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImagePlus className="w-6 h-6" />
            <span className="text-xs font-medium">Add Page</span>
          </button>
        </div>

        {images.length > 1 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">PDF Output</p>
            <div className="flex bg-muted rounded-xl p-0.5">
              <button
                data-testid="toggle-merge"
                onClick={() => setPdfMode("merge")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                  pdfMode === "merge" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                One PDF ({images.length} pages)
              </button>
              <button
                data-testid="toggle-separate"
                onClick={() => setPdfMode("separate")}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                  pdfMode === "separate" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
                }`}
              >
                <Copy className="w-3.5 h-3.5" />
                {images.length} Separate PDFs
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 pt-4 border-t border-border">
        <button data-testid="button-convert-pdf" onClick={onConvert}
          disabled={images.length === 0 || isConverting}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-3 disabled:opacity-50 active:scale-[0.98] transition-transform">
          {isConverting ? (
            <><RotateCcw className="w-5 h-5 animate-spin" /> Converting…</>
          ) : (
            <><FileText className="w-5 h-5" /> Convert to PDF</>
          )}
        </button>
      </div>
    </div>
  );
}

function SendStep({ docName, setDocName, selectedConvId, setSelectedConvId, conversations, pdfResults, pdfMode, onBack, onSend, isPending }: {
  docName: string; setDocName: (v: string) => void;
  selectedConvId: string; setSelectedConvId: (v: string) => void;
  conversations: ConversationWithContact[];
  pdfResults: Array<{ dataUrl: string; name: string }>;
  pdfMode: PdfMode;
  onBack: () => void; onSend: () => void; isPending: boolean;
}) {
  const summaryText = pdfMode === "separate" && pdfResults.length > 1
    ? `${pdfResults.length} separate PDFs will be sent`
    : `1 PDF · ${pdfResults.length > 0 ? "ready" : ""}`;

  return (
    <div className="flex flex-col px-4 py-6 gap-5">
      <div className="flex items-center gap-4 p-4 rounded-2xl bg-primary/5 border border-primary/15">
        <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-6 h-6 text-primary" />
        </div>
        <div>
          <p className="font-semibold text-foreground text-sm">PDF Ready</p>
          <p className="text-muted-foreground text-xs mt-0.5">{summaryText}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          {pdfMode === "separate" && pdfResults.length > 1 ? "Base Name (number added automatically)" : "Document Name"}
        </label>
        <input data-testid="input-doc-name" type="text" value={docName}
          onChange={e => setDocName(e.target.value)} placeholder="e.g. Contract_2025.pdf"
          className="w-full h-12 px-4 rounded-xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30" />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">Send to Conversation</label>
        <div className="flex flex-col gap-2">
          {conversations.map(conv => (
            <button key={conv.id} data-testid={`select-conv-${conv.id}`}
              onClick={() => setSelectedConvId(conv.id)}
              className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                selectedConvId === conv.id ? "border-primary bg-primary/5" : "border-border bg-card"
              }`}>
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-primary font-semibold text-xs">{conv.contact.initials}</span>
              </div>
              <div className="flex-1 text-left">
                <p className="font-medium text-foreground text-sm">{conv.contact.name}</p>
                <p className="text-muted-foreground text-xs">{conv.contact.role}</p>
              </div>
              {selectedConvId === conv.id && <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 pt-2">
        <button data-testid="button-send-pdf" onClick={onSend}
          disabled={!selectedConvId || isPending}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-3 disabled:opacity-40 active:scale-[0.98] transition-transform">
          {isPending ? <><RotateCcw className="w-5 h-5 animate-spin" />Sending…</> : <><Send className="w-5 h-5" />Send PDF</>}
        </button>
        <button data-testid="button-back-review" onClick={onBack}
          className="w-full h-12 rounded-2xl bg-muted text-foreground font-medium flex items-center justify-center">
          Back to Review
        </button>
      </div>
    </div>
  );
}
