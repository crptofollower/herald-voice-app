// src/api/herald.ts
// Herald API client -- all backend calls live here. Nothing fetches outside this file.
// Backend: https://web-production-b4083.up.railway.app (Railway, herald_api.py v7.8)
//
// Changes May 12, 2026:
//   - Added fetchWithTimeout() -- wraps every request, 30s abort
//   - Added createProfile() -- called once at onboarding end
//   - Freddie endpoints stay owner-gated (backend enforces, frontend mirrors)

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
  persona?: string;
  location?: string;
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
  type: "freddie" | "weather" | "sports" | "health" | "reminder" | "news";
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  read: boolean;
  // Compatibility: backend may return older format with just `message`
  message?: string;
}

export interface ProactiveResponse {
  items: ProactiveItem[];
  count: number;
}

export interface FreddieStatus {
  gate: {
    progress: number;
    target: number;
    percent: number;
  };
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

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
// Every fetch goes through this. Railway cold starts can spike; 30s abort
// prevents the UI from hanging on dead requests.

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
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "Unknown error");
    throw new Error(`Herald API ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

// ─── Profile -- called once at onboarding completion ─────────────────────────
// Creates the user record on Railway SQLite.
// Without this, the backend has no name/persona and falls back to defaults.

export async function createProfile(payload: ProfilePayload): Promise<void> {
  await apiFetch<void>("/profile", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ─── /ask -- main chat endpoint ───────────────────────────────────────────────

export async function askHerald(payload: AskPayload): Promise<AskResponse> {
  const trimmedHistory = payload.history
    .slice(-MAX_CONTEXT_MESSAGES)
    .map(({ role, content }) => ({ role, content }));

  return apiFetch<AskResponse>("/ask", {
    method: "POST",
    body: JSON.stringify({ ...payload, history: trimmedHistory }),
  });
}

// ─── /proactive -- fetch queue on app open ────────────────────────────────────

export async function fetchProactiveQueue(
  userId: string
): Promise<ProactiveResponse> {
  try {
    const result = await apiFetch<ProactiveResponse | ProactiveItem[]>(
      `/proactive/${userId}`
    );
    // Backend may return array or { items, count } -- normalize both
    if (Array.isArray(result)) {
      return { items: result, count: result.length };
    }
    return result;
  } catch {
    // Proactive is best-effort -- never crash the app if this fails
    return { items: [], count: 0 };
  }
}

export async function markProactiveRead(
  userId: string,
  itemId: string
): Promise<void> {
  try {
    await apiFetch(`/proactive/${userId}/${itemId}/read`, { method: "POST" });
  } catch {
    // Non-critical -- swallow silently
  }
}

// ─── /freddie -- owner-gated endpoints ───────────────────────────────────────
// Backend enforces is_owner() on every call.
// Frontend should also check isOwner from store before calling these.

export async function fetchFreddieStatus(
  userId: string
): Promise<FreddieStatus> {
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

// ─── /health -- liveness check ────────────────────────────────────────────────

export async function checkHealth(): Promise<boolean> {
  try {
    await apiFetch("/health");
    return true;
  } catch {
    return false;
  }
}
