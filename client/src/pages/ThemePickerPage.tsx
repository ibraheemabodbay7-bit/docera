import { ArrowLeft, Check, Lock } from "lucide-react";
import {
  type ThemeMode,
  getThemeMode,
  setThemeMode,
  isDarkMode,
} from "@/lib/theme";
import { useReducer, useEffect } from "react";
import { useSubscription } from "@/hooks/use-subscription";

type Option = {
  mode: ThemeMode;
  label: string;
  description: string;
  swatches: [string, string]; // [primary bg, accent]
};

const OPTIONS: Option[] = [
  { mode: "light",  label: "Light",  description: "Clean and bright",                 swatches: ["#ececef", "#1a1f2a"] },
  { mode: "dark",   label: "Dark",   description: "Easy on the eyes at night",        swatches: ["#0a0a0c", "#e8e8ec"] },
  { mode: "system", label: "System", description: "Follow your iPhone setting",       swatches: ["#ececef", "#0a0a0c"] },
  { mode: "pro",    label: "Pro",    description: "Deep navy and gold — for members", swatches: ["#0a0f1e", "#c9a84c"] },
];

export default function ThemePickerPage({ onBack, onUpgrade }: { onBack: () => void; onUpgrade?: () => void }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const current = getThemeMode();
  const dark = isDarkMode();
  const subscription = useSubscription();

  // Re-render when theme changes (e.g. user switches and we want immediate visual feedback)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = () => force();
    if (mq.addEventListener) mq.addEventListener("change", h);
    return () => { if (mq.removeEventListener) mq.removeEventListener("change", h); };
  }, []);

  const select = (mode: ThemeMode) => {
    if (mode === "pro" && !subscription.active) {
      onUpgrade?.();
      return;
    }
    setThemeMode(mode);
    force();
  };

  const bg = "var(--bg)";
  const text = "var(--text)";
  const sub = "var(--text-secondary)";
  const border = "var(--app-border)";
  const surface = dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)";

  return (
    <div style={{ minHeight: "100vh", background: bg, color: text }}>
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 pb-4"
        style={{
          paddingTop: "max(3rem, env(safe-area-inset-top))",
          background: dark ? "rgba(14,14,18,0.88)" : "rgba(232,236,242,0.82)",
          backdropFilter: "blur(30px) saturate(160%)",
          WebkitBackdropFilter: "blur(30px) saturate(160%)",
          borderBottom: `0.5px solid ${border}`,
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <button
          onClick={onBack}
          aria-label="Back"
          style={{
            width: 32, height: 32, borderRadius: 16,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "transparent", border: "none", cursor: "pointer", color: text,
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>Theme</h1>
      </div>

      {/* Options */}
      <div style={{ padding: "16px 16px 32px" }}>
        <div
          style={{
            background: surface,
            borderRadius: 16,
            border: `0.5px solid ${border}`,
            overflow: "hidden",
          }}
        >
          {OPTIONS.map((opt, i) => {
            const selected = current === opt.mode;
            return (
              <button
                key={opt.mode}
                onClick={() => select(opt.mode)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "14px 16px",
                  background: "transparent",
                  border: "none",
                  borderTop: i === 0 ? "none" : `0.5px solid ${border}`,
                  cursor: "pointer",
                  color: text,
                  textAlign: "left",
                }}
              >
                {/* Swatch */}
                <div
                  style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: `linear-gradient(135deg, ${opt.swatches[0]} 0%, ${opt.swatches[0]} 50%, ${opt.swatches[1]} 50%, ${opt.swatches[1]} 100%)`,
                    border: `0.5px solid ${border}`,
                  }}
                />
                {/* Label + description */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 500 }}>{opt.label}</div>
                  <div style={{ fontSize: 13, color: sub, marginTop: 1 }}>{opt.description}</div>
                </div>
                {/* Check / Lock */}
                <div style={{ width: 24, display: "flex", justifyContent: "flex-end" }}>
                  {selected
                    ? <Check size={20} color="var(--text)" />
                    : opt.mode === "pro" && !subscription.active
                      ? <Lock size={16} color={sub} />
                      : null}
                </div>
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 12, color: sub, marginTop: 12, lineHeight: 1.5 }}>
          System follows your iPhone's appearance setting in Settings → Display & Brightness.
        </p>
      </div>
    </div>
  );
}
