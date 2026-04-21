import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { X, Send, Paperclip, RotateCcw, FileText } from "lucide-react";
import type { File as DocFile } from "@shared/schema";
import ClientEmailSuggest from "@/components/ClientEmailSuggest";

interface ComposeEmailProps {
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
  linkedClientId?: string | null;
  onClose: () => void;
}

interface AttachedFile {
  name: string;
  dataUrl: string;
}

export default function ComposeEmail({
  initialTo = "",
  initialSubject = "",
  initialBody = "",
  linkedClientId,
  onClose,
}: ComposeEmailProps) {
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const { toast } = useToast();

  const { data: availableFiles = [] } = useQuery<DocFile[]>({
    queryKey: ["/api/files"],
    enabled: showFilePicker,
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/email/send", {
        to, subject, body, attachments,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Email sent successfully" });
      onClose();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to send email";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const addFileFromLibrary = (file: DocFile) => {
    setAttachments(prev => [...prev, { name: file.name, dataUrl: file.dataUrl }]);
    setShowFilePicker(false);
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const canSend = to.trim() && subject.trim() && !sendMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 pt-12 pb-4 border-b border-border">
        <button
          data-testid="button-compose-close"
          onClick={onClose}
          className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground hover-elevate"
        >
          <X className="w-5 h-5" />
        </button>
        <h2 className="text-base font-semibold text-foreground">New Email</h2>
        <button
          data-testid="button-send-email"
          onClick={() => sendMutation.mutate()}
          disabled={!canSend}
          className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center disabled:opacity-40"
        >
          {sendMutation.isPending ? (
            <RotateCcw className="w-4 h-4 text-primary-foreground animate-spin" />
          ) : (
            <Send className="w-4 h-4 text-primary-foreground" />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col divide-y divide-border">

          {/* To field — with client autocomplete */}
          <div className="flex items-center px-4 py-3 gap-3">
            <span className="text-xs font-semibold text-muted-foreground w-10 flex-shrink-0">To</span>
            <ClientEmailSuggest
              data-testid="input-compose-to"
              value={to}
              onChange={setTo}
              linkedClientId={linkedClientId}
              placeholder="recipient@example.com"
              inputClassName="w-full text-sm text-foreground bg-transparent border-0 outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Subject */}
          <div className="flex items-center px-4 py-3 gap-3">
            <span className="text-xs font-semibold text-muted-foreground w-10 flex-shrink-0">Subject</span>
            <input
              data-testid="input-compose-subject"
              type="text"
              placeholder="Subject"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              className="flex-1 text-sm text-foreground bg-transparent border-0 outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Attachments */}
          {attachments.length > 0 && (
            <div className="px-4 py-3 flex flex-wrap gap-2">
              {attachments.map((att, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20"
                >
                  <FileText className="w-3 h-3 text-primary" />
                  <span className="text-xs font-medium text-primary max-w-[120px] truncate">{att.name}</span>
                  <button onClick={() => removeAttachment(idx)}>
                    <X className="w-3 h-3 text-primary" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Body */}
          <div className="px-4 py-3 flex-1 min-h-48">
            <textarea
              data-testid="input-compose-body"
              placeholder="Write your message…"
              value={body}
              onChange={e => setBody(e.target.value)}
              className="w-full min-h-48 text-sm text-foreground bg-transparent border-0 outline-none placeholder:text-muted-foreground resize-none leading-relaxed"
            />
          </div>
        </div>

        {/* File picker */}
        {showFilePicker && (
          <div className="mx-4 mb-4 rounded-2xl bg-card border border-card-border">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <p className="text-sm font-semibold text-foreground">Attach from Files</p>
              <button onClick={() => setShowFilePicker(false)}>
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {availableFiles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No files available</p>
              ) : (
                availableFiles.map(file => (
                  <button
                    key={file.id}
                    data-testid={`attach-file-${file.id}`}
                    onClick={() => addFileFromLibrary(file)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover-elevate border-b border-border last:border-0"
                  >
                    <FileText className="w-4 h-4 text-primary flex-shrink-0" />
                    <span className="text-sm text-foreground truncate">{file.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-border">
        <button
          data-testid="button-attach-file"
          onClick={() => setShowFilePicker(p => !p)}
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Paperclip className="w-4 h-4" />
          Attach PDF from Files
        </button>
      </div>
    </div>
  );
}
