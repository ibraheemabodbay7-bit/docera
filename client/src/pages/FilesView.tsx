import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { FileText, Download, Trash2, Search, FolderOpen, X, ArrowLeft } from "lucide-react";
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { File as DocFile } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

export default function FilesView() {
  const [search, setSearch] = useState("");
  const [previewFile, setPreviewFile] = useState<DocFile | null>(null);
  const { toast } = useToast();

  const { data: files = [], isLoading } = useQuery<DocFile[]>({
    queryKey: ["/api/files"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/files/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/files"] });
      toast({ title: "File deleted" });
      setPreviewFile(null);
    },
  });

  const filtered = files.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleDownload = (file: DocFile, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const a = document.createElement("a");
    a.href = file.dataUrl;
    a.download = file.name;
    a.click();
  };

  const formatSize = (bytes: number) => {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  };

  if (previewFile) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="flex-shrink-0 flex items-center justify-between px-4 pt-12 pb-3 border-b border-border bg-background">
          <button
            data-testid="button-preview-back"
            onClick={() => setPreviewFile(null)}
            className="flex items-center gap-2 text-primary font-medium text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Files
          </button>
          <h2 className="text-sm font-semibold text-foreground truncate max-w-[160px]">{previewFile.name}</h2>
          <div className="flex items-center gap-1">
            <button
              data-testid="button-preview-download"
              onClick={() => handleDownload(previewFile)}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              data-testid="button-preview-delete"
              onClick={() => {
                if (confirm(`Delete "${previewFile.name}"?`)) {
                  deleteMutation.mutate(previewFile.id);
                }
              }}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-destructive hover-elevate"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-muted/30">
          <iframe
            data-testid="iframe-pdf-preview"
            src={previewFile.dataUrl}
            title={previewFile.name}
            className="w-full h-full border-0"
          />
        </div>

        <div className="flex-shrink-0 px-4 py-3 border-t border-border bg-background">
          <p className="text-xs text-muted-foreground text-center">
            PDF · {formatSize(previewFile.size)}
            {previewFile.createdAt && ` · ${formatDistanceToNow(new Date(previewFile.createdAt), { addSuffix: true })}`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-shrink-0 px-4 pt-12 pb-4 bg-background">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Files</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {files.length} document{files.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            data-testid="input-file-search"
            type="search"
            placeholder="Search files..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-4 rounded-xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {isLoading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex items-center gap-3 p-4 rounded-2xl bg-card animate-pulse">
                <div className="w-12 h-12 rounded-xl bg-muted flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-muted rounded w-40" />
                  <div className="h-3 bg-muted rounded w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <FolderOpen className="w-12 h-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No files yet</p>
            <p className="text-muted-foreground/60 text-sm mt-1">Scan a document to add files here</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map(file => (
              <button
                key={file.id}
                data-testid={`file-card-${file.id}`}
                onClick={() => setPreviewFile(file)}
                className="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-card border border-card-border text-left hover-elevate active:scale-[0.99] transition-transform"
              >
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-6 h-6 text-primary" />
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground text-sm truncate">{file.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    PDF · {formatSize(file.size)}
                    {file.createdAt && ` · ${formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}`}
                  </p>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <div
                    data-testid={`button-download-${file.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); handleDownload(file); }}
                    onKeyDown={e => e.key === "Enter" && handleDownload(file)}
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                  </div>
                  <div
                    data-testid={`button-delete-${file.id}`}
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); deleteMutation.mutate(file.id); }}
                    onKeyDown={e => e.key === "Enter" && deleteMutation.mutate(file.id)}
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover-elevate cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
