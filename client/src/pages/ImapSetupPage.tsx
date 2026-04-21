import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Mail, Server, Lock, ArrowRight, SkipForward, ChevronDown, ChevronUp, Info } from "lucide-react";

interface ImapSetupPageProps {
  userEmail: string;
  onComplete: (user: any) => void;
}

const PROVIDER_ICONS: Record<string, string> = {
  Gmail: "🔴",
  Outlook: "🔵",
  "Yahoo Mail": "🟣",
  "iCloud Mail": "⚪",
  Email: "✉️",
};

export default function ImapSetupPage({ userEmail, onComplete }: ImapSetupPageProps) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUseSSL, setImapUseSSL] = useState(true);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [imapPassword, setImapPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [detectedProvider, setDetectedProvider] = useState("Email");
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetch(`/api/auth/detect-provider?email=${encodeURIComponent(userEmail)}`)
      .then(r => r.json())
      .then(data => {
        setDetectedProvider(data.provider ?? "Email");
        setImapHost(data.imapHost ?? "");
        setImapPort(String(data.imapPort ?? 993));
        setImapUseSSL(data.imapUseSSL ?? true);
        setSmtpHost(data.smtpHost ?? "");
        setSmtpPort(String(data.smtpPort ?? 587));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [userEmail]);

  const setupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/imap-setup", {
        imapHost, imapPort, imapPassword, imapUseSSL, smtpHost, smtpPort,
      });
      return res.json();
    },
    onSuccess: (user) => onComplete(user),
    onError: (err: any) => toast({ title: err.message ?? "Setup failed", variant: "destructive" }),
  });

  const skipMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/imap-skip", {});
      return res.json();
    },
    onSuccess: (user) => onComplete(user),
  });

  const isGmail = detectedProvider === "Gmail";
  const isOutlook = detectedProvider === "Outlook";

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <div className="flex-1 overflow-y-auto px-6 py-12">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Mail className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground text-center">Connect Your Inbox</h1>
          <p className="text-muted-foreground text-sm mt-2 text-center max-w-xs">
            See your {detectedProvider} emails right inside DocChat
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-24">
            <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="p-4 rounded-2xl bg-muted/50 border border-border">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Detected provider</p>
              <p className="text-sm font-semibold text-foreground">
                {PROVIDER_ICONS[detectedProvider] ?? "✉️"} {detectedProvider}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{userEmail}</p>
            </div>

            {(isGmail || isOutlook) && (
              <div className="p-4 rounded-2xl bg-accent border border-border">
                <div className="flex gap-2">
                  <Info className="w-4 h-4 text-foreground/60 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {isGmail ? "Gmail" : "Outlook"} requires an App Password
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {isGmail
                        ? "Go to Google Account → Security → 2-Step Verification → App Passwords. Generate one for Mail."
                        : "Go to Microsoft account → Security → Advanced security options → App passwords."}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground">
                {isGmail || isOutlook ? "App Password" : "Email Password"}
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  data-testid="input-imap-password"
                  type="password"
                  placeholder="Enter your app password"
                  value={imapPassword}
                  onChange={e => setImapPassword(e.target.value)}
                  className="w-full h-12 pl-10 pr-4 rounded-xl bg-muted text-sm text-foreground placeholder:text-muted-foreground border-0 outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </div>

            <button
              onClick={() => setShowAdvanced(p => !p)}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              Advanced server settings
            </button>

            {showAdvanced && (
              <div className="flex flex-col gap-3 p-4 rounded-2xl bg-muted/50 border border-border">
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground mb-1 block">IMAP Host</label>
                    <input
                      data-testid="input-imap-host"
                      value={imapHost}
                      onChange={e => setImapHost(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-background text-sm border border-border outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div className="w-20">
                    <label className="text-xs text-muted-foreground mb-1 block">Port</label>
                    <input
                      data-testid="input-imap-port"
                      value={imapPort}
                      onChange={e => setImapPort(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-background text-sm border border-border outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground mb-1 block">SMTP Host</label>
                    <input
                      data-testid="input-smtp-host"
                      value={smtpHost}
                      onChange={e => setSmtpHost(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-background text-sm border border-border outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  <div className="w-20">
                    <label className="text-xs text-muted-foreground mb-1 block">Port</label>
                    <input
                      data-testid="input-smtp-port"
                      value={smtpPort}
                      onChange={e => setSmtpPort(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg bg-background text-sm border border-border outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="use-ssl"
                    type="checkbox"
                    checked={imapUseSSL}
                    onChange={e => setImapUseSSL(e.target.checked)}
                    className="w-4 h-4 accent-primary"
                  />
                  <label htmlFor="use-ssl" className="text-sm text-foreground">Use SSL/TLS</label>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 px-6 pb-8 pt-4 flex flex-col gap-3">
        <button
          data-testid="button-connect-inbox"
          onClick={() => setupMutation.mutate()}
          disabled={!imapPassword || setupMutation.isPending}
          className="w-full h-14 rounded-2xl bg-primary text-primary-foreground font-semibold flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.98] transition-transform"
        >
          {setupMutation.isPending ? (
            <div className="w-5 h-5 rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground animate-spin" />
          ) : (
            <>Connect Inbox <ArrowRight className="w-4 h-4" /></>
          )}
        </button>

        <button
          data-testid="button-skip-inbox"
          onClick={() => skipMutation.mutate()}
          disabled={skipMutation.isPending}
          className="w-full h-12 rounded-2xl bg-transparent text-muted-foreground font-medium flex items-center justify-center gap-2"
        >
          <SkipForward className="w-4 h-4" />
          Skip for now
        </button>
      </div>
    </div>
  );
}
