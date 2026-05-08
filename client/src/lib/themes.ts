// Shared theme definitions for inbox + profile pages.

export type ThemeMode = "light" | "dark" | "pro";

// ─── Inbox theme (GmailInboxPage) ────────────────────────────────────────────

export interface InboxTheme {
  bg: string;
  orbBg: string;
  header: string;
  cardBg: string;
  receivedBg: string;
  receivedText: string;
  sentBg: string;
  sentText: string;
  subText: string;
  inputBg: string;
  border: string;
  pillBg: string;
  searchBg: string;
  avatarBg: string;
  avatarText: string;
  accent: string;
  accentSoft: string;
  dark: boolean;
}

export function getInboxTheme(mode: ThemeMode): InboxTheme {
  if (mode === "pro") {
    return {
      bg: "#0a0f1e",
      orbBg: [
        "radial-gradient(ellipse at 20% 15%, #111935 0%, #0a0f1e 30%, transparent 60%)",
        "radial-gradient(ellipse at 80% 85%, #1f2c50 0%, #0d1b3e 35%, transparent 65%)",
        "radial-gradient(ellipse at 50% 50%, #000000 0%, transparent 50%)",
        "#0a0f1e",
      ].join(", "),
      header: "rgba(13,27,62,0.88)",
      cardBg: "rgba(17,25,53,0.65)",
      receivedBg: "rgba(17,25,53,0.65)",
      receivedText: "#f4ead0",
      sentBg: "rgba(201,168,76,0.4)",
      sentText: "#f4ead0",
      subText: "#a89970",
      inputBg: "rgba(17,25,53,0.65)",
      border: "rgba(201,168,76,0.15)",
      pillBg: "rgba(17,25,53,0.65)",
      searchBg: "rgba(17,25,53,0.65)",
      avatarBg: "#1f2c50",
      avatarText: "#f4ead0",
      accent: "#c9a84c",
      accentSoft: "#e8d5a3",
      dark: true,
    };
  }
  if (mode === "dark") {
    return {
      bg: "#050507",
      orbBg: [
        "radial-gradient(ellipse at 20% 15%, #1a1a1f 0%, #0e0e12 30%, transparent 60%)",
        "radial-gradient(ellipse at 80% 85%, #16161a 0%, #0a0a0c 35%, transparent 65%)",
        "radial-gradient(ellipse at 50% 50%, #000000 0%, transparent 50%)",
        "#050507",
      ].join(", "),
      header: "rgba(14,14,18,0.88)",
      cardBg: "rgba(28,28,32,0.65)",
      receivedBg: "rgba(28,28,32,0.65)",
      receivedText: "#ececef",
      sentBg: "rgba(38,38,46,0.72)",
      sentText: "#ececef",
      subText: "#a0a8b8",
      inputBg: "rgba(28,28,32,0.65)",
      border: "rgba(255,255,255,0.08)",
      pillBg: "rgba(28,28,32,0.65)",
      searchBg: "rgba(28,28,32,0.65)",
      avatarBg: "#1a1a1f",
      avatarText: "#d4d4dc",
      accent: "#e8e8ec",
      accentSoft: "#a0a0a8",
      dark: true,
    };
  }
  // light
  return {
    bg: "#ececef",
    orbBg: [
      "radial-gradient(ellipse at 20% 15%, #e8ecf2 0%, #c8d0dc 30%, transparent 60%)",
      "radial-gradient(ellipse at 80% 85%, #d8dee8 0%, #a8b0c0 35%, transparent 65%)",
      "radial-gradient(ellipse at 50% 50%, #6a7388 0%, transparent 50%)",
      "#b8c0cc",
    ].join(", "),
    header: "rgba(232,236,242,0.82)",
    cardBg: "rgba(255,255,255,0.55)",
    receivedBg: "rgba(255,255,255,0.55)",
    receivedText: "#1a1f2a",
    sentBg: "rgba(200,215,240,0.65)",
    sentText: "#1a1f2a",
    subText: "#4a5262",
    inputBg: "rgba(255,255,255,0.55)",
    border: "rgba(255,255,255,0.4)",
    pillBg: "rgba(255,255,255,0.55)",
    searchBg: "rgba(255,255,255,0.55)",
    avatarBg: "#2a2a30",
    avatarText: "#e8e8ec",
    accent: "#1a1f2a",
    accentSoft: "#6a6a72",
    dark: false,
  };
}

// ─── Profile theme (ClientProfilePage) ───────────────────────────────────────

export const TONE_GRADIENTS_LIGHT = [
  "linear-gradient(135deg, #d8d8dc 0%, #c0c0c8 100%)",
  "linear-gradient(135deg, #e8e8ec 0%, #d0d0d8 100%)",
  "linear-gradient(135deg, #2a2a30 0%, #1a1a1f 100%)",
  "linear-gradient(135deg, #ececef 0%, #dcdce0 100%)",
];
export const TONE_GRADIENTS_DARK = [
  "linear-gradient(135deg, #2a2a30 0%, #3a3a42 100%)",
  "linear-gradient(135deg, #3a3a42 0%, #4a4a54 100%)",
  "linear-gradient(135deg, #0a0a0c 0%, #1c1c20 100%)",
  "linear-gradient(135deg, #d4d4dc 0%, #b0b0bc 100%)",
];
export const TONE_GRADIENTS_PRO = [
  "linear-gradient(135deg, #1f2c50 0%, #111935 100%)",
  "linear-gradient(135deg, #c9a84c 0%, #b08a30 100%)",
  "linear-gradient(135deg, #0a0f1e 0%, #0d1b3e 100%)",
  "linear-gradient(135deg, #e8d5a3 0%, #c9a84c 100%)",
];

export interface ProfileTheme {
  base: string;
  headerBg: string;
  headerInk: string;
  headerSubtle: string;
  headerFaint: string;
  ink: string;
  subtle: string;
  muted: string;
  hair: string;
  statsCard: string;
  statsCardShadow: string;
  statsCardBorder: string;
  accentInk: string;
  accentBg: string;
  accentShadow: string;
  avatarBg: string;
  frameDark: boolean;
  toneGradients: string[];
  accent: string;
  accentSoft: string;
}

export function getProfileTheme(mode: ThemeMode): ProfileTheme {
  if (mode === "pro") {
    return {
      base: "transparent",
      headerBg: "rgba(13,27,62,0.88)",
      headerInk: "#f4ead0",
      headerSubtle: "rgba(244,234,208,0.72)",
      headerFaint: "rgba(244,234,208,0.46)",
      ink: "#f4ead0",
      subtle: "rgba(244,234,208,0.72)",
      muted: "#a89970",
      hair: "rgba(201,168,76,0.15)",
      statsCard: "rgba(17,25,53,0.65)",
      statsCardShadow: "0 1px 0 rgba(201,168,76,0.08) inset, 0 4px 20px rgba(0,0,0,0.5)",
      statsCardBorder: "0.5px solid rgba(201,168,76,0.18)",
      accentInk: "#0a0f1e",
      accentBg: "linear-gradient(160deg, #d4b65c, #b08a30)",
      accentShadow: "0 10px 24px -8px rgba(201,168,76,0.45), inset 0 1px 0 rgba(255,255,255,0.18)",
      avatarBg: "radial-gradient(circle at 30% 25%, #c9a84c, #b08a30 80%)",
      frameDark: true,
      toneGradients: TONE_GRADIENTS_PRO,
      accent: "#c9a84c",
      accentSoft: "#e8d5a3",
    };
  }
  if (mode === "dark") {
    return {
      base: "transparent",
      headerBg: "rgba(14,14,18,0.88)",
      headerInk: "#e8e8ec",
      headerSubtle: "rgba(232,232,236,0.72)",
      headerFaint: "rgba(232,232,236,0.46)",
      ink: "#e8e8ec",
      subtle: "rgba(232,232,236,0.72)",
      muted: "#a0a0a8",
      hair: "rgba(255,255,255,0.08)",
      statsCard: "rgba(28,28,32,0.65)",
      statsCardShadow: "0 1px 0 rgba(255,255,255,0.05) inset, 0 4px 20px rgba(0,0,0,0.5)",
      statsCardBorder: "0.5px solid rgba(255,255,255,0.08)",
      accentInk: "#e8e8ec",
      accentBg: "linear-gradient(160deg, #3a3a42, #2a2a30)",
      accentShadow: "0 10px 24px -8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.08)",
      avatarBg: "radial-gradient(circle at 30% 25%, #3a3a42, #2a2a30 80%)",
      frameDark: true,
      toneGradients: TONE_GRADIENTS_DARK,
      accent: "#e8e8ec",
      accentSoft: "#a0a0a8",
    };
  }
  // light
  return {
    base: "transparent",
    headerBg: "rgba(232,236,242,0.82)",
    headerInk: "#1a1f2a",
    headerSubtle: "rgba(26,31,42,0.7)",
    headerFaint: "rgba(26,31,42,0.45)",
    ink: "#1a1a1f",
    subtle: "#6a6a72",
    muted: "rgba(26,26,31,0.28)",
    hair: "rgba(255,255,255,0.4)",
    statsCard: "rgba(255,255,255,0.55)",
    statsCardShadow: "0 1px 0 rgba(255,255,255,0.7) inset, 0 4px 16px rgba(0,0,0,0.15)",
    statsCardBorder: "0.5px solid rgba(255,255,255,0.4)",
    accentInk: "#e8e8ec",
    accentBg: "linear-gradient(160deg, #3a3a42, #2a2a30)",
    accentShadow: "0 10px 24px -8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.12)",
    avatarBg: "radial-gradient(circle at 30% 25%, #ffffff, #e4e4e8 80%)",
    frameDark: false,
    toneGradients: TONE_GRADIENTS_LIGHT,
    accent: "#1a1f2a",
    accentSoft: "#6a6a72",
  };
}
