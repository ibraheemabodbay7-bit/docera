const KEYS = {
  filenamePrefix: "docera_pref_filenamePrefix",
  defaultFilter:  "docera_pref_defaultFilter",
  autoExport:     "docera_pref_autoExport",
} as const;

type SettingKey = keyof typeof KEYS;

export function getSetting(key: SettingKey, fallback: string): string {
  try {
    return localStorage.getItem(KEYS[key]) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setSetting(key: SettingKey, value: string): void {
  try {
    localStorage.setItem(KEYS[key], value);
  } catch { /* ignore quota errors */ }
}

export function getBoolSetting(key: SettingKey, fallback = false): boolean {
  try {
    const v = localStorage.getItem(KEYS[key]);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function setBoolSetting(key: SettingKey, value: boolean): void {
  try {
    localStorage.setItem(KEYS[key], value ? "1" : "0");
  } catch { /* ignore */ }
}
