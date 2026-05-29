// src/db/calendarCacheDB.ts
// Herald device SQLite — calendar_cache table read/write.
// Session L — Device-First Intelligence Layer
//
// Caches device calendar events in a 14-day window.
// Refreshed on app open and after any calendar write.
//
// This eliminates the async timing race that caused intermittent calendar
// read failures — the tier router reads from this cache synchronously
// instead of racing against the live Calendar API async call.
//
// Refresh triggers (wired in ChatScreen.tsx Step 14):
//   1. AppState change to 'active'
//   2. After any successful calendar write
//   3. On cold open before first message fires
//
// Cache is best-effort — if the device calendar API fails, the existing
// cache is left intact. Stale cache is better than no cache.

import * as Calendar from "expo-calendar";
import { getDB } from "./schema";

export interface CachedEvent {
  id: string;
  title: string;
  start_time: string;   // ISO string
  end_time: string;     // ISO string
  all_day: number;      // 0 or 1
  notes?: string;
  cached_at: string;    // ISO string
}

// ─── refreshCalendarCache ─────────────────────────────────────────────────────
//
// Pulls events from the device calendar for the next 14 days and writes
// them to the cache table. Clears stale entries before writing.
// Silently no-ops if calendar permission is not granted.

export async function refreshCalendarCache(): Promise<void> {
  try {
    const { status } = await Calendar.getCalendarPermissionsAsync();
    if (status !== "granted") return;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 14);
    end.setHours(23, 59, 59, 999);

    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const events = await Calendar.getEventsAsync(
      calendars.map((c) => c.id),
      start,
      end
    );

    const db = getDB();
    const now = new Date().toISOString();

    // Clear existing cache — full refresh, not incremental
    db.runSync("DELETE FROM calendar_cache;");

    for (const event of events) {
      if (!event.title) continue;
      db.runSync(
        `INSERT OR REPLACE INTO calendar_cache
           (id, title, start_time, end_time, all_day, notes, cached_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [
          event.id,
          event.title,
          event.startDate?.toString() ?? now,
          event.endDate?.toString() ?? now,
          event.allDay ? 1 : 0,
          event.notes ?? null,
          now,
        ]
      );
    }
  } catch {
    // Silent — leave existing cache intact on error
  }
}

// ─── getCachedEvents ──────────────────────────────────────────────────────────
//
// Returns cached events for 'today', 'tomorrow', or 'this week'.
// All comparisons use local time via Date parsing.

export function getCachedEvents(
  window: "today" | "tomorrow" | "this week"
): CachedEvent[] {
  const db = getDB();

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  if (window === "tomorrow") {
    start.setDate(start.getDate() + 1);
  }

  const end = new Date(start);
  if (window === "this week") {
    end.setDate(end.getDate() + 7);
  }
  end.setHours(23, 59, 59, 999);

  const startISO = start.toISOString();
  const endISO = end.toISOString();

  return db.getAllSync<CachedEvent>(
    `SELECT * FROM calendar_cache
     WHERE start_time >= ? AND start_time <= ?
     ORDER BY start_time ASC;`,
    [startISO, endISO]
  );
}

// ─── formatCachedEventsForSpeech ─────────────────────────────────────────────
//
// Converts cached events into a spoken response string.
// Called by tier1Responses.ts for Tier 1 calendar answers.

export function formatCachedEventsForSpeech(
  events: CachedEvent[],
  window: "today" | "tomorrow" | "this week"
): string {
  const dayLabel = window === "tomorrow"
    ? "tomorrow"
    : window === "this week"
    ? "this week"
    : "today";

  if (events.length === 0) {
    return `Your calendar is clear ${dayLabel}.`;
  }

  const lines = events.map((e) => {
    const start = new Date(e.start_time);
    if (e.all_day) {
      return window === "this week"
        ? `${e.title} on ${start.toLocaleDateString([], { weekday: "long" })}`
        : e.title;
    }
    const timeStr = start.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    return window === "this week"
      ? `${e.title} on ${start.toLocaleDateString([], { weekday: "long" })} at ${timeStr}`
      : `${e.title} at ${timeStr}`;
  });

  if (lines.length === 1) {
    return `You have ${lines[0]} ${dayLabel}.`;
  }

  const last = lines.pop()!;
  return `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} you have: ${lines.join(", ")}, and ${last}.`;
}

// ─── getCacheAge ──────────────────────────────────────────────────────────────
//
// Returns how many minutes ago the cache was last refreshed.
// Returns null if cache is empty (never refreshed).

export function getCacheAge(): number | null {
  const db = getDB();
  const row = db.getFirstSync<{ cached_at: string }>(
    "SELECT cached_at FROM calendar_cache ORDER BY cached_at DESC LIMIT 1;"
  );
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.cached_at).getTime();
  return Math.floor(ageMs / 60_000);
}