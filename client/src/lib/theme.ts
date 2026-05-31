// Theme mode system. Supports 4 user-facing modes:
//   "light" | "dark" | "system" | "pro"
// Internally applied as either "light" or "dark" or "pro" — "system" follows OS.

export type ThemeMode = "light" | "dark" | "system" | "pro";
export type AppliedTheme = "light" | "dark" | "pro";

const STORAGE_KEY = "docera_theme_mode";
const LEGACY_DARK_KEY = "docera_dark_mode";

type Listener = (applied: AppliedTheme, mode: ThemeMode) => void;
const listeners = new Set<Listener>();

function readSystemPref(): "light" | "dark" {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getThemeMode(): ThemeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system" || stored === "pro") {
    return stored;
  }
  // Migrate legacy boolean key
  const legacy = localStorage.getItem(LEGACY_DARK_KEY);
  if (legacy === "true") return "dark";
  if (legacy === "false") return "light";
  return "system";
}

export function getAppliedTheme(mode: ThemeMode = getThemeMode()): AppliedTheme {
  if (mode === "system") return readSystemPref();
  return mode;
}

function applyClasses(applied: AppliedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", applied === "dark" || applied === "pro");
  root.classList.toggle("pro", applied === "pro");

  // Body bg + meta theme-color for native chrome (fallback colors when CSS vars not yet applied)
  const bg = applied === "pro" ? "#0a0f1e" : applied === "dark" ? "#0a0a0c" : "#ececef";
  document.body.style.backgroundColor = bg;
  if (typeof window !== "undefined") {
    let meta = document.querySelector('meta[name="theme-color"]:not([media])') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = bg;
  }
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(STORAGE_KEY, mode);
  const applied = getAppliedTheme(mode);
  applyClasses(applied);
  listeners.forEach((fn) => fn(applied, mode));
}

export const setTheme = setThemeMode;

export function subscribeToTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ─── Back-compat shims (existing code keeps working) ──────────────────

export function isDarkMode(): boolean {
  return document.documentElement.classList.contains("dark");
}

export function setDarkMode(dark: boolean) {
  setThemeMode(dark ? "dark" : "light");
}

export function toggleDarkMode() {
  setDarkMode(!isDarkMode());
}

export function initDarkMode() {
  const mode = getThemeMode();
  applyClasses(getAppliedTheme(mode));
  // If user is on "system", follow OS changes live
  if (typeof window !== "undefined" && window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getThemeMode() === "system") {
        const applied = getAppliedTheme();
        applyClasses(applied);
        listeners.forEach((fn) => fn(applied, "system"));
      }
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
    else mql.addListener(handler);
  }
}
