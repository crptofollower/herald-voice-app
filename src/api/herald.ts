// src/api/herald.ts
// Herald API client -- all backend calls live here. Nothing fetches outside this file.
// Backend: https://web-production-b4083.up.railway.app (Railway, herald_api.py v8.4)
//
// Changes May 17, 2026 (streaming -- CORRECT format):
//
//   The backend /ask/stream emits Server-Sent Events:
//     data: {"t": "word"}        <- a token (append to text)
//     data: {"t": "[S]"}         <- SENTENCE COMPLETE (flush to TTS now)
//     data: {"done": true, "full": "...", "action": {...}, ...}  <- end
//     data: {"error": "..."}     <- failure
//
//   Previous bug: parser looked for parsed.token / parsed.reply.
//   Backend sends parsed.t. Every token was silently discarded ->
//   stream stayed open with nothing rendered -> the 2-minute hang.
//
//   This version reads parsed.t correctly AND uses [S] sentence markers
//   to drive progressive TTS: Herald speaks sentence 1 while sentence 2
//   is still generating. Words + voice flow together within ~1-2s.

import {
  API_BASE,
  MAX_CONTEXT_MESSAGES,
  OWNER_AUTH_CODE,
  REQUEST_TIMEOUT_MS,
} from "../constants/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface AskPayload {
  user_id: string;
  message: string;
  history: Pick<Message, "role" | "content">[];
  local_time?: string;
  local_date?: string;
  device_context?: string;
  persona?: string;
  location?: string;
  lat?: number;
  lng?: number;
  location_label?: string;
  access_code?: string;
  owner_code?: string;
}

export interface AskResponse {
  reply: string;
  memory_updated?: boolean;
  action?: {
    type: string;
    url?: string;
    label?: string;
    data?: unknown;
  };
}

export interface ProfilePayload {
  user_id: string;
  name: string;
  persona: string;
  access_code: string;
  owner_code?: string;
}

export interface ProactiveItem {
  id: string;
  // All known backend type values — "morning_briefing" etc. come from backend
  type: "freddie" | "weather" | "sports" | "health" | "reminder" | "news"
      | "morning_briefing" | "afternoon_checkin" | "medication_check" | "watcher_alert"
      | string; // fallback for future types
  title?: string;   // ProactiveCard UI shape
  body?: string;    // ProactiveCard UI shape
  text?: string;    // Backend shape — herald_api.py pushes { text } not { title, body }
  metadata?: Record<string, unknown>;
  timestamp?: number;
  created_at?: string;
  read: boolean;
  message?: string;
}

export interface ProactiveResponse {
  items: ProactiveItem[];
  count: number;
}

export interface FreddieStatus {
  gate: { progress: number; target: number; percent: number };
  regime: string;
  window: string;
  fg: number;
  near_miss: Array<{ asset: string; direction: string; score: number }>;
  health: "healthy" | "degraded" | "down";
  briefing_block: string;
  last_updated: string;
}

export interface FreddieTradesResponse {
  trades: Array<{
    id: string;
    asset: string;
    direction: "LONG" | "SHORT";
    entry: number;
    exit?: number;
    pnl?: number;
    grade: "A" | "B";
    score: number;
    opened_at: string;
    closed_at?: string;
    status: "open" | "closed" | "cancelled";
  }>;
  total: number;
}

export interface GreetingPayload {
  user_id: string;
  local_time?: string;
  lat?: number;
  lng?: number;
  location_label?: string;
}

export interface GreetingResponse {
  ok: boolean;
  greeting: string;
  ai_name: string;
  name: string;
}

export interface ExtractedFact {
  category: string;
  value: string;
}

// ─── Stream callbacks ──────────────────────────────────────────────────────────
//
// onToken    -- fired per token. Append to the visible bubble. [S] is stripped.
// onSentence -- fired when a sentence completes ([S] marker). Drives progressive TTS.
// onAction   -- fired once at the end with the parsed action (or null).
// onDone     -- fired once at the end with the complete reply text.
// onError    -- fired on failure.

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onSentence: (sentence: string) => void;
  onAction: (action: AskResponse["action"]) => void;
  onFacts: (facts: ExtractedFact[]) => void;
  onDone: (fullText: string) => void;
  onError: (err: Error) => void;
}

// ─── Timeout wrapper (non-streaming requests) ─────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const response = await fetchWithTimeout(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Herald API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<T>;
}

// ─── askHeraldStream -- the real one ──────────────────────────────────────────
//
// Connects to /ask/stream and parses the backend's actual SSE format.
// Tokens appear in ~1-2s. Sentence markers fire onSentence for progressive TTS.
//
// 12-second first-token deadline: if the backend sends nothing by then,
// abort and fall back to /ask. (Backend is fast now; this is insurance.)
//
// Returns AbortController so the caller can cancel on unmount.

export function askHeraldStream(
  payload: AskPayload,
  callbacks: StreamCallbacks
): AbortController {
  const outerController = new AbortController();

  const trimmedHistory = payload.history
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));

  const body = JSON.stringify({ ...payload, history: trimmedHistory });

  (async () => {
    const streamController = new AbortController();
    outerController.signal.addEventListener("abort", () => streamController.abort());

    let firstTokenReceived = false;
    let streamFinished = false;

    const firstTokenTimeout = setTimeout(() => {
      if (!firstTokenReceived) streamController.abort();
    }, 12_000);

    let accumulated = ""; // full visible text (no [S] markers)
    let sentenceBuf = ""; // current sentence being built (no [S])

    const flushSentence = () => {
      const s = sentenceBuf.trim();
      if (s) callbacks.onSentence(s);
      sentenceBuf = "";
    };

    try {
      const response = await fetch(`${API_BASE}/ask/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: streamController.signal,
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        const handleEvent = (jsonStr: string) => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            return;
          }

          if (parsed.typing) {
            firstTokenReceived = true;
            clearTimeout(firstTokenTimeout);
            return;
          }

          if (parsed.done) {
            clearTimeout(firstTokenTimeout);
            streamFinished = true;
            flushSentence();
            callbacks.onAction(parsed.action as AskResponse["action"]);
            callbacks.onFacts((parsed.facts as ExtractedFact[]) ?? []);
            const full =
              typeof parsed.full === "string" && parsed.full
                ? (parsed.full as string)
                : accumulated;
            callbacks.onDone(full);
            return;
          }

          if (parsed.error) {
            clearTimeout(firstTokenTimeout);
            streamFinished = true;
            callbacks.onError(new Error(String(parsed.error)));
            return;
          }

          const t = parsed.t;
          if (typeof t === "string") {
            if (t === "[S]") {
              flushSentence();
              return;
            }
            if (!firstTokenReceived) {
              firstTokenReceived = true;
              clearTimeout(firstTokenTimeout);
            }
            accumulated += t;
            sentenceBuf += t;
            callbacks.onToken(t);
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("data: ")) {
              handleEvent(trimmed.slice(6).trim());
            }
          }
        }

        if (!streamFinished) {
          clearTimeout(firstTokenTimeout);
          streamFinished = true;
          flushSentence();
          if (accumulated) {
            callbacks.onFacts([]);
            callbacks.onDone(accumulated);
          }
        }

        reader.releaseLock();
      }
    } catch {
      clearTimeout(firstTokenTimeout);
      if (outerController.signal.aborted) return;
    }

    if (streamFinished) return;

    // ── Fallback: /ask (only if stream produced nothing) ─────────────────────
    try {
      if (outerController.signal.aborted) return;

      const fbController = new AbortController();
      outerController.signal.addEventListener("abort", () => fbController.abort());
      const fbTimeout = setTimeout(() => fbController.abort(), 45_000);

      let response: Response;
      try {
        response = await fetch(`${API_BASE}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: fbController.signal,
        });
      } finally {
        clearTimeout(fbTimeout);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "Unknown error");
        throw new Error(`Herald API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as AskResponse;
      const reply = data.reply || "";

      callbacks.onToken(reply);
      callbacks.onSentence(reply);
      callbacks.onAction(data.action);
      callbacks.onFacts([]);
      callbacks.onDone(reply);
    } catch (fbErr) {
      if (outerController.signal.aborted) return;
      callbacks.onError(fbErr instanceof Error ? fbErr : new Error(String(fbErr)));
    }
  })();

  return outerController;
}

// ─── /ask -- non-streaming (kept for internal callers) ────────────────────────

export async function askHerald(payload: AskPayload): Promise<AskResponse> {
  const trimmedHistory = payload.history
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
  return apiFetch<AskResponse>("/ask", {
    method: "POST",
    body: JSON.stringify({ ...payload, history: trimmedHistory }),
  });
}

// ─── /profile ─────────────────────────────────────────────────────────────────

export async function createProfile(payload: ProfilePayload): Promise<void> {
  await apiFetch<void>("/profile", { method: "POST", body: JSON.stringify(payload) });
}

// ─── /greeting ────────────────────────────────────────────────────────────────
//
// Called on app open to get the personalised greeting (name + weather + memory hook).
// Uses GPS coords if available so Herald can say "right now in Plano it is 84 degrees."

export async function fetchGreeting(payload: GreetingPayload): Promise<GreetingResponse> {
  return apiFetch<GreetingResponse>("/greeting", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ─── /proactive ───────────────────────────────────────────────────────────────

export async function fetchProactiveQueue(userId: string): Promise<ProactiveResponse> {
  try {
    // Backend returns {messages: [...]} — normalize to {items: [...]} here.
    // The mismatch was silently swallowing all proactive messages and
    // preventing lastPolled from ever being set (setProactiveItems threw
    // on undefined, caught silently, debounce never fired → runaway polling).
    const result = await apiFetch<any>(`/proactive/${userId}`);
    if (Array.isArray(result)) return { items: result, count: result.length };
    const items: ProactiveItem[] = result.items ?? result.messages ?? [];
    return { items, count: items.length };
  } catch {
    return { items: [], count: 0 };
  }
}

export async function markProactiveRead(userId: string, itemId: string): Promise<void> {
  try {
    await apiFetch(`/proactive/${userId}/${itemId}/read`, { method: "POST" });
  } catch {}
}

// ─── /freddie ─────────────────────────────────────────────────────────────────

export async function fetchFreddieStatus(userId: string): Promise<FreddieStatus> {
  return apiFetch<FreddieStatus>(
    `/freddie/status?user_id=${userId}&auth_code=${OWNER_AUTH_CODE}`
  );
}

export async function fetchFreddieTrades(
  userId: string,
  limit = 20
): Promise<FreddieTradesResponse> {
  return apiFetch<FreddieTradesResponse>(
    `/freddie/trades?user_id=${userId}&auth_code=${OWNER_AUTH_CODE}&limit=${limit}`
  );
}