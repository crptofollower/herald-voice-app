// src/routing/tier1Responses.ts
// Herald — Tier 1 deterministic response formatters.
// Session L — Device-First Intelligence Layer
//
// Tier 1 responses never call an LLM. The answer comes from device SQLite
// and is formatted here into natural spoken language.
//
// Target: under 200ms from message received to spoken response.
// Works fully offline.
//
// Usage in ChatScreen.tsx sendMessage():
//   const decision = classifyQuery(text);
//   if (decision.tier === 1 && decision.tier1Response) {
//     return handleTier1(decision.tier1Response, text, addMessage, speak);
//   }

import { setProfileField, getProfileSummary } from "../db/profileDB";
import { getAmbientFactsSummary } from "../db/factDB";
import { getRecentSessionSummaries } from '../db/sessionDB';

// ─── handleTier1 ──────────────────────────────────────────────────────────────
//
// Called from sendMessage() when classifyQuery returns tier: 1.
// Adds the user message and device response to the message store,
// speaks the response, and returns true so sendMessage() can exit early.
//
// Parameters match what's already available in sendMessage() closure —
// no new imports needed in ChatScreen beyond this file and tierRouter.

export function handleTier1(
  response: string,
  userMessage: string,
  addMessage: (msg: {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }) => void,
  speak: (text: string, options?: { rate?: number }) => void,
  generateId: (prefix: string) => string
): void {
  const now = Date.now();
  addMessage({
    id: generateId("msg"),
    role: "user",
    content: userMessage,
    timestamp: now,
  });
  addMessage({
    id: generateId("msg"),
    role: "assistant",
    content: response,
    timestamp: now + 1,
  });
  speak(response);
}

// ─── buildTier2DeviceContext ──────────────────────────────────────────────────
//
// Formats the local context string to inject into the backend request
// for Tier 2 queries (memory probes) until Phi-3 ships in Session W.
// Called from sendMessage() when classifyQuery returns tier: 2.
//
// The backend receives this as device_context in the /ask/stream payload.
// The system prompt on the backend detects intent: 'memory_probe' and
// synthesizes naturally from the structured data instead of dumping history.

export function buildTier2DeviceContext(localContext: {
  facts?: string;
  profile?: string;
  medical?: string;
  intent?: string;
}): string {
  const parts: string[] = [];
  parts.push("[DEVICE CONTEXT — structured facts from local SQLite]");
  parts.push(`Intent: ${localContext.intent ?? "memory_probe"}`);

  if (localContext.profile) {
    parts.push(`\nProfile:\n${localContext.profile}`);
  }
  if (localContext.facts) {
    parts.push(`\nKnown facts:\n${localContext.facts}`);
  }
  if (localContext.medical) {
    parts.push(`\nMedical context:\n${localContext.medical}`);
  }

  parts.push("\n[Synthesize the above into a natural, spoken response. Do not list raw data. Speak as a friend who knows the person well.]");

  return parts.join("\n");
}

// ─── buildAmbientDeviceContext ────────────────────────────────────────────────
// Injected on every non-probe turn (Tier 1 fall-through + Tier 3). Combines the
// legacy context block with device profile + non-medical facts so the model can
// reference what Herald knows mid-conversation. Returns undefined if empty.
export function buildAmbientDeviceContext(legacyContext?: string): string | undefined {
  const parts: string[] = [];
  const profile = getProfileSummary();
  if (profile) parts.push(profile);
  const facts = getAmbientFactsSummary();
  if (facts) parts.push(`What you know about them: ${facts}`);
  const sessions = getRecentSessionSummaries(3);
  if (sessions) parts.push(`Recent conversation history:\n${sessions}`);
  if (legacyContext && legacyContext.trim()) parts.push(legacyContext.trim());
  const combined = parts.join("\n");
  return combined.length > 0 ? combined : undefined;
}

// ─── writeProfileFromOnboarding ──────────────────────────────────────────────
//
// Called after onboarding completes to seed the device profile table.
// Fixes the Session W gap: profile fields were never written to device SQLite
// on onboarding — they only existed in Railway and Zustand store.

export function writeProfileFromOnboarding(fields: {
  userId?: string;
  name?: string;
  aiName?: string;
  persona?: string;
  city?: string;
  lat?: number;
  lng?: number;
}): void {
  if (fields.userId) setProfileField("user_id", fields.userId);
  if (fields.name) setProfileField("name", fields.name);
  if (fields.aiName) setProfileField("ai_name", fields.aiName);
  if (fields.persona) setProfileField("persona", fields.persona);
  if (fields.city) setProfileField("city", fields.city);
  if (fields.lat != null) setProfileField("lat", String(fields.lat));
  if (fields.lng != null) setProfileField("lng", String(fields.lng));
  setProfileField("onboarding_complete", "true");
}