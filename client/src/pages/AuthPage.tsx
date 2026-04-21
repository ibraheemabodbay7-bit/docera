import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Smartphone } from "lucide-react";
import { DaceraLogo } from "@/components/DaceraLogo";

interface AuthPageProps {
  onLogin: (user: { id: string; name: string; username: string }) => void;
}

/** Returns a stable device ID from localStorage, creating one on first call. */
function getOrCreateDeviceId(): string {
  const KEY = "docera_guest_device_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    // crypto.randomUUID() is available in all modern browsers and Capacitor.
    id = crypto.randomUUID().replace(/-/g, "");
    localStorage.setItem(KEY, id);
  }
  return id;
}

export default function AuthPage({ onLogin }: AuthPageProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const body = mode === "login" ? { email, password } : { email, password, name };
      const res = await apiRequest("POST", endpoint, body);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Something went wrong");
      }
      return res.json();
    },
    onSuccess: (user) => onLogin(user),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const guestMutation = useMutation({
    mutationFn: async () => {
      const deviceId = getOrCreateDeviceId();
      const res = await apiRequest("POST", "/api/auth/guest-device", { deviceId });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Could not start guest session");
      }
      return res.json();
    },
    onSuccess: (user) => onLogin(user),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || (mode === "signup" && !name)) return;
    mutation.mutate();
  };

  const isPending = mutation.isPending || guestMutation.isPending;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-10">
          <DaceraLogo variant="icon" size="lg" className="mb-4" />
          <h1 className="text-2xl font-bold text-foreground">Docera</h1>
          <p className="text-sm text-muted-foreground mt-1">PDF Scanner & Organizer</p>
        </div>

        <div className="flex bg-muted rounded-2xl p-1 mb-8">
          {(["login", "signup"] as const).map((m) => (
            <button
              key={m}
              data-testid={`tab-${m}`}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                mode === m ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {m === "login" ? "Sign In" : "Sign Up"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {mode === "signup" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Full Name</label>
              <input
                data-testid="input-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full px-4 py-3 rounded-2xl bg-muted border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Email</label>
            <input
              data-testid="input-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full px-4 py-3 rounded-2xl bg-muted border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Password</label>
            <div className="relative">
              <input
                data-testid="input-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "signup" ? "Min. 6 characters" : "Your password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className="w-full px-4 py-3 pr-12 rounded-2xl bg-muted border-0 outline-none text-sm text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-muted-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <button
            data-testid="button-submit"
            type="submit"
            disabled={isPending}
            className="w-full py-3.5 rounded-2xl bg-primary text-primary-foreground font-semibold text-sm mt-2 disabled:opacity-50 transition-opacity active:scale-[0.98]"
          >
            {mutation.isPending ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>

        {/* ── Guest / testing mode ─────────────────────────────────────── */}
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        <button
          data-testid="button-guest"
          onClick={() => guestMutation.mutate()}
          disabled={isPending}
          className="w-full py-3.5 rounded-2xl border border-border bg-card text-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition-all"
        >
          <Smartphone className="w-4 h-4 text-muted-foreground" />
          {guestMutation.isPending ? "Starting…" : "Try without an account"}
        </button>

        <p className="text-center text-xs text-muted-foreground mt-3 leading-relaxed px-2">
          Testing mode · Documents stay private to this device.{" "}
          <span className="text-foreground/60">Sign up anytime to keep your data.</span>
        </p>
      </div>
    </div>
  );
}
