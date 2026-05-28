// personas.ts -- Herald Persona System
// Updated May 28 2026
// Build 15: wallpaperNight field added -- time-based swap in PersonaBackground
// Handoff tokens (accent, surfaceTint, palette, description) are canonical for
// picker and notifications. colors.* remains the ChatScreen API.

export type PersonaKey = "beach" | "mountain" | "city" | "country" | "desert";

export interface Persona {
  key:           PersonaKey;
  name:          string;
  description:   string;
  accent:        string;
  surfaceTint:   string;
  palette:       [string, string, string];
  tagline:       string;   // mirrors description until picker migrates
  greeting:      string;   // what Herald says on first open (TTS)
  gradient:      [string, string, string, string];
  wallpaperNight: string;  // Build 15: night image filename (no path, no extension)
  colors: {
    background:      string;
    surface:         string;
    surfaceElevated: string;
    accent:          string;
    accentMuted:     string;
    text:            string;
    textMuted:       string;
    border:          string;
    userBubble:      string;
    aiBubble:        string;
    proactiveCard:   string;
  };
}

function accentColors(accent: string) {
  return { accent, accentMuted: `${accent}22`, userBubble: accent };
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  beach: {
    key:            "beach",
    name:           "Beach",
    description:    "Blues and sand. Light and open.",
    accent:         "#4dd4d6",
    surfaceTint:    "rgba(31, 58, 84, 0.55)",
    palette:        ["#4dd4d6", "#e8d9b0", "#8fb8d4"],
    tagline:        "Blues and sand. Light and open.",
    greeting:       "Good to see you.",
    wallpaperNight: "beach-night",
    gradient: [
      "rgba(2,24,40,0)",
      "rgba(2,24,40,0)",
      "rgba(2,24,40,0.65)",
      "rgba(2,24,40,0.96)",
    ],
    colors: {
      ...accentColors("#4dd4d6"),
      background: "#0A1628", surface: "#0F2040", surfaceElevated: "#1A3355",
      text: "#E8F4F8", textMuted: "#7EB8CC",
      border: "#1E3A5A", aiBubble: "#1A3355",
      proactiveCard: "rgba(20, 22, 26, 0.55)",
    },
  },
  mountain: {
    key:            "mountain",
    name:           "Mountain",
    description:    "Steel and slate. Crisp and focused.",
    accent:         "#7fa896",
    surfaceTint:    "rgba(26, 50, 44, 0.55)",
    palette:        ["#7fa896", "#b8c5cc", "#3a4a52"],
    tagline:        "Steel and slate. Crisp and focused.",
    greeting:       "Good to see you.",
    wallpaperNight: "mountain-night",
    gradient: [
      "rgba(5,15,32,0)",
      "rgba(5,15,32,0)",
      "rgba(5,15,32,0.65)",
      "rgba(5,15,32,0.96)",
    ],
    colors: {
      ...accentColors("#7fa896"),
      background: "#0D1F0D", surface: "#142814", surfaceElevated: "#1E3A1E",
      text: "#E4EDE4", textMuted: "#6B8A6B",
      border: "#2A3D2A", aiBubble: "#1E3A1E",
      proactiveCard: "rgba(20, 22, 26, 0.55)",
    },
  },
  city: {
    key:            "city",
    name:           "City",
    description:    "Charcoal and white. Sharp and clean.",
    accent:         "#2dd4bf",
    surfaceTint:    "rgba(36, 42, 52, 0.6)",
    palette:        ["#2dd4bf", "#e8edf2", "#1a1f26"],
    tagline:        "Charcoal and white. Sharp and clean.",
    greeting:       "Good to see you.",
    wallpaperNight: "city-night",
    gradient: [
      "rgba(10,4,2,0)",
      "rgba(10,4,2,0)",
      "rgba(10,4,2,0.65)",
      "rgba(10,4,2,0.96)",
    ],
    colors: {
      ...accentColors("#2dd4bf"),
      background: "#0D1117", surface: "#161B22", surfaceElevated: "#21262D",
      text: "#E6EDF3", textMuted: "#8B949E",
      border: "#30363D", aiBubble: "#21262D",
      proactiveCard: "rgba(20, 22, 26, 0.55)",
    },
  },
  country: {
    key:            "country",
    name:           "Country",
    description:    "Greens and earth. Warm and easy.",
    accent:         "#d4a83d",
    surfaceTint:    "rgba(58, 44, 24, 0.6)",
    palette:        ["#d4a83d", "#7a9a5c", "#c97a4a"],
    tagline:        "Greens and earth. Warm and easy.",
    greeting:       "Good to see you.",
    wallpaperNight: "country-night",
    gradient: [
      "rgba(30,14,2,0)",
      "rgba(30,14,2,0)",
      "rgba(30,14,2,0.65)",
      "rgba(30,14,2,0.96)",
    ],
    colors: {
      ...accentColors("#d4a83d"),
      background: "#1A1200", surface: "#2B1E00", surfaceElevated: "#3D2D00",
      text: "#FFF3DC", textMuted: "#9A7A4A",
      border: "#4A3800", aiBubble: "#3D2D00",
      proactiveCard: "rgba(20, 22, 26, 0.55)",
    },
  },
  desert: {
    key:            "desert",
    name:           "Desert",
    description:    "Terracotta and clay. Warm and grounded.",
    accent:         "#d97a4a",
    surfaceTint:    "rgba(58, 32, 24, 0.6)",
    palette:        ["#d97a4a", "#e8b878", "#5a3a2a"],
    tagline:        "Terracotta and clay. Warm and grounded.",
    greeting:       "Good to see you.",
    wallpaperNight: "desert-night",
    gradient: [
      "rgba(21,7,4,0)",
      "rgba(21,7,4,0)",
      "rgba(21,7,4,0.65)",
      "rgba(21,7,4,0.96)",
    ],
    colors: {
      ...accentColors("#d97a4a"),
      background: "#1A0A00", surface: "#2D1500", surfaceElevated: "#3F2000",
      text: "#FAE8D0", textMuted: "#9A6A4A",
      border: "#4A2A00", aiBubble: "#3F2000",
      proactiveCard: "rgba(20, 22, 26, 0.55)",
    },
  },
};

export const DEFAULT_PERSONA: PersonaKey = "city";

export const BRAND = {
  teal: '#2dd4bf', bgDeep: '#0d1217',
  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.72)',
  textMuted: 'rgba(255,255,255,0.55)',
} as const;

export function getPersona(id: PersonaKey | null | undefined): Persona {
  return PERSONAS[id ?? DEFAULT_PERSONA] ?? PERSONAS[DEFAULT_PERSONA];
}