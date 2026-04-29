import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, Smartphone } from "lucide-react";
import { DaceraLogo } from "@/components/DaceraLogo";
import { isDarkMode } from "@/lib/theme";

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

function glassStyle(dark: boolean): React.CSSProperties {
  return {
    backdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`,
    WebkitBackdropFilter: `blur(30px) saturate(${dark ? 140 : 160}%)`,
    border: dark ? "0.5px solid rgba(255,255,255,0.08)" : "0.5px solid rgba(255,255,255,0.4)",
    boxShadow: dark
      ? "0 1px 0 rgba(255,255,255,0.05) inset, 0 4px 20px rgba(0,0,0,0.5)"
      : "0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.15)",
  };
}

export default function AuthPage({ onLogin }: AuthPageProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const { toast } = useToast();

  const dark = isDarkMode();
  const orbBg = dark ? ORB_DARK : ORB_LIGHT;
  const cardBg = dark ? "rgba(28,28,32,0.65)" : "rgba(255,255,255,0.55)";
  const inputBg = dark ? "rgba(28,28,32,0.55)" : "rgba(255,255,255,0.4)";
  const textPrimary = dark ? "#ececef" : "#1a1f2a";
  const textSecondary = dark ? "#a0a8b8" : "#4a5262";

  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "transparent";
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

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
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, background: orbBg, pointerEvents: "none" }} />
      <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10" style={{ position: "relative", zIndex: 1 }}>
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-10">
            <DaceraLogo variant="icon" size="lg" className="mb-4" />
            <h1 className="text-2xl font-bold" style={{ color: textPrimary }}>Docera</h1>
            <p className="text-sm mt-1" style={{ color: textSecondary }}>PDF Scanner & Organizer</p>
          </div>

          <div
            className="flex rounded-2xl p-1 mb-8"
            style={{ background: cardBg, ...glassStyle(dark) }}
          >
            {(["login", "signup"] as const).map((m) => (
              <button
                key={m}
                data-testid={`tab-${m}`}
                onClick={() => setMode(m)}
                className="flex-1 py-2 rounded-xl text-sm font-medium transition-all"
                style={mode === m
                  ? { background: dark ? "rgba(50,50,58,0.9)" : "rgba(255,255,255,0.9)", color: textPrimary }
                  : { background: "transparent", color: textSecondary }}
              >
                {m === "login" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {mode === "signup" && (
              <div>
                <label className="text-xs font-medium mb-1.5 block" style={{ color: textSecondary }}>Full Name</label>
                <input
                  data-testid="input-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  className="w-full px-4 py-3 rounded-2xl border-0 outline-none text-sm placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
                  style={{ background: inputBg, color: textPrimary }}
                />
              </div>
            )}
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: textSecondary }}>Email</label>
              <input
                data-testid="input-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                className="w-full px-4 py-3 rounded-2xl border-0 outline-none text-sm placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
                style={{ background: inputBg, color: textPrimary }}
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1.5 block" style={{ color: textSecondary }}>Password</label>
              <div className="relative">
                <input
                  data-testid="input-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "signup" ? "Min. 6 characters" : "Your password"}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full px-4 py-3 pr-12 rounded-2xl border-0 outline-none text-sm placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30"
                  style={{ background: inputBg, color: textPrimary }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center"
                  style={{ color: textSecondary }}
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

          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px" style={{ background: dark ? "rgba(255,255,255,0.1)" : "rgba(26,31,42,0.15)" }} />
            <span className="text-xs" style={{ color: textSecondary }}>or</span>
            <div className="flex-1 h-px" style={{ background: dark ? "rgba(255,255,255,0.1)" : "rgba(26,31,42,0.15)" }} />
          </div>

          <button
            data-testid="button-guest"
            onClick={() => guestMutation.mutate()}
            disabled={isPending}
            className="w-full py-3.5 rounded-2xl font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.98] transition-all"
            style={{ background: cardBg, color: textPrimary, ...glassStyle(dark) }}
          >
            <Smartphone className="w-4 h-4" style={{ color: textSecondary }} />
            {guestMutation.isPending ? "Starting…" : "Try without an account"}
          </button>

          <p className="text-center text-xs mt-3 leading-relaxed px-2" style={{ color: textSecondary }}>
            Testing mode · Documents stay private to this device.{" "}
            <span style={{ color: dark ? "rgba(236,236,239,0.6)" : "rgba(26,31,42,0.5)" }}>Sign up anytime to keep your data.</span>
          </p>
        </div>
      </div>
    </>
  );
}
