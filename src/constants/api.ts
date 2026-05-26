// src/constants/api.ts
// Central config. All env vars use EXPO_PUBLIC_ prefix (safe to bundle).
// DO NOT add private keys here. Backend holds all secrets.
// Updated: May 12, 2026 -- added REQUEST_TIMEOUT_MS, PROACTIVE_POLL_COOLDOWN_MS

export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ?? "https://web-production-b4083.up.railway.app";

// Owner auth code -- gates Freddie data, IRA features, morning briefing Freddie block.
// Set via .env (EXPO_PUBLIC_OWNER_CODE). Beta users never have this.
export const OWNER_AUTH_CODE = process.env.EXPO_PUBLIC_OWNER_CODE ?? "";

// OneSignal app ID -- wired from day one, even if push isn't live yet.
export const ONESIGNAL_APP_ID = process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID ?? "";

// Beta access code -- users enter this on first run. Public by design.
export const BETA_ACCESS_CODE = "herald2026";

// Max conversation turns sent to /ask (keeps payloads lean)
export const MAX_CONTEXT_MESSAGES = 20;

// Request timeout -- Railway cold starts can spike to 15-20s.
// 30s gives headroom without feeling broken.
export const REQUEST_TIMEOUT_MS = 30_000;

// Proactive queue -- don't re-poll within this window.
// Fixes the double greeting bug (app open + resume both fire within seconds).
export const PROACTIVE_POLL_COOLDOWN_MS = 60_000;
export const PROACTIVE_POLL_MS = 60_000;
export const TTS_RATE  = 0.82;
export const TTS_PITCH = 1.0;

export const FEATURE_FLAGS = {
  // Proactive queue: Herald speaks to you on app open
  PROACTIVE_ENABLED: true,
  // TTS: Herald reads responses aloud
  VOICE_TTS_ENABLED: true,
  // SSE streaming: requires react-native-sse -- V2 upgrade, not in this build
  STREAMING: false,
  // Freddie card: renders in ChatScreen for owner only -- always true,
  // gated at render time by isOwner from store (not this flag)
  FREDDIE_UI_ENABLED: true,
} as const;
