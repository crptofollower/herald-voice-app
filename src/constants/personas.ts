export type PersonaKey = "beach" | "mountain" | "city" | "country" | "desert";

export interface Persona {
  key:      PersonaKey;
  name:     string;
  greeting: string;
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
  };
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  beach: {
    key: "beach", name: "Beach", greeting: "What's on your mind?",
    colors: { background: "#0A1628", surface: "#0F2040", surfaceElevated: "#1A3355", accent: "#00B4D8", accentMuted: "#00B4D822", text: "#E8F4F8", textMuted: "#7EB8CC", border: "#1E3A5A", userBubble: "#00B4D8", aiBubble: "#1A3355" },
  },
  mountain: {
    key: "mountain", name: "Mountain", greeting: "Ready when you are.",
    colors: { background: "#0D1F0D", surface: "#142814", surfaceElevated: "#1E3A1E", accent: "#4CAF72", accentMuted: "#4CAF7222", text: "#E4EDE4", textMuted: "#6B8A6B", border: "#2A3D2A", userBubble: "#4CAF72", aiBubble: "#1E3A1E" },
  },
  city: {
    key: "city", name: "City", greeting: "What do you want to know?",
    colors: { background: "#0D1117", surface: "#161B22", surfaceElevated: "#21262D", accent: "#1A9B8A", accentMuted: "#1A9B8A22", text: "#E6EDF3", textMuted: "#8B949E", border: "#30363D", userBubble: "#1A9B8A", aiBubble: "#21262D" },
  },
  country: {
    key: "country", name: "Country", greeting: "How can I help you today?",
    colors: { background: "#1A1200", surface: "#2B1E00", surfaceElevated: "#3D2D00", accent: "#C8960C", accentMuted: "#C8960C22", text: "#FFF3DC", textMuted: "#9A7A4A", border: "#4A3800", userBubble: "#C8960C", aiBubble: "#3D2D00" },
  },
  desert: {
    key: "desert", name: "Desert", greeting: "Let's figure it out.",
    colors: { background: "#1A0A00", surface: "#2D1500", surfaceElevated: "#3F2000", accent: "#E07B39", accentMuted: "#E07B3922", text: "#FAE8D0", textMuted: "#9A6A4A", border: "#4A2A00", userBubble: "#E07B39", aiBubble: "#3F2000" },
  },
};

export const DEFAULT_PERSONA: PersonaKey = "city";