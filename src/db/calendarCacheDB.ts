// src/db/calendarCacheDB.ts
// Herald device SQLite — calendar_cache table read/write.
// Session L — Device-First Intelligence Layer
// Build 20 fix: store/compare as Unix ms timestamps (not ISO strings).
//   Eliminates timezone mismatch on Android where expo-calendar returns
//   non-standard ISO strings that break string comparison in SQLite.
// Build 20 fix: requestCalendarPermissionsAsync (prompt) on first cache
//   refresh so users who were never prompted get the dialog.

import * as Calendar from "expo-calendar";
import { getDB } from "./schema";

export interface CachedEvent {
  id: string;
  title: string;
  start_ms: number;   // Unix milliseconds — NOT ISO string
  end_ms: number;     // Unix milliseconds
  all_day: number;    // 0 or 1
  notes?: string;
  cached_at: string;  // ISO string — fine for age check, not for filtering
}

// ─── refreshCalendarCache ─────────────────────────────────────────────────────
//
// Pulls events from the device calendar for the next 14 days and writes
// them to the cache table. Clears stale entries before writing.
//
// On first call: requests permission (shows dialog if not yet granted).
// On subsequent calls: checks permission only (no dialog spam).

export async function refreshCalendarCache(): Promise<void> {
  try {
    // Request permission on first call — this is what shows the dialog.
    // getCalendarPermissionsAsync only checks; it never prompts.
    let { status } = await Calendar.getCalendarPermissionsAsync();
    if (status !== "granted") {
      const result = await Calendar.requestCalendarPermissionsAsync();
      status = result.status;
    }
    if (status !== "granted") return;

    const now = Date.now();
    const startMs = new Date().setHours(0, 0, 0, 0);
    const endMs = startMs + 14 * 24 * 60 * 60 * 1000 - 1; // 14 days, end of day

    const start = new Date(startMs);
    const end = new Date(endMs);

    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const events = await Calendar.getEventsAsync(
      calendars.map((c) => c.id),
      start,
      end
    );

    const db = getDB();
    const nowISO = new Date().toISOString();

    db.execSync("BEGIN IMMEDIATE;");
    try {
      // Full refresh — clear existing cache
      db.runSync("DELETE FROM calendar_cache;");

      for (const event of events) {
        if (!event.title) continue;

        // Parse startDate/endDate safely — expo-calendar returns strings on Android
        // that may not be standard ISO. new Date() handles most formats.
        let startMs = event.startDate ? new Date(event.startDate).getTime() : now;
        let endMs = event.endDate ? new Date(event.endDate).getTime() : now;

        // All-day events on Android are stored as UTC midnight.
        // This causes them to appear on the wrong day in local time.
        // Normalize: shift to local midnight so overlap queries work correctly.
        if (event.allDay) {
          const startLocal = new Date(startMs);
          startLocal.setHours(0, 0, 0, 0);
          startMs = startLocal.getTime();
          const endLocal = new Date(endMs);
          endLocal.setHours(23, 59, 59, 999);
          endMs = endLocal.getTime();
        }

        // Skip events with unparseable dates
        if (isNaN(startMs) || isNaN(endMs)) continue;

        db.runSync(
          `INSERT OR REPLACE INTO calendar_cache
             (id, title, start_ms, end_ms, all_day, notes, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            event.id,
            event.title,
            startMs,
            endMs,
            event.allDay ? 1 : 0,
            event.notes ?? null,
            nowISO,
          ]
        );
      }

      db.execSync("COMMIT;");
    } catch {
      db.execSync("ROLLBACK;");
      return; // leave existing cache intact
    }
  } catch {
    // Silent — leave existing cache intact on error
  }
}

// ─── getCachedEvents ──────────────────────────────────────────────────────────
//
// Returns cached events for 'today', 'tomorrow', or 'this week'.
// Compares Unix milliseconds — no timezone string parsing.

export function getCachedEvents(
  window: "today" | "tomorrow" | "this week"
): CachedEvent[] {
  const db = getDB();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let windowStartMs: number;
  let windowEndMs: number;

  if (window === "today") {
    windowStartMs = todayStart.getTime();
    windowEndMs = windowStartMs + 24 * 60 * 60 * 1000 - 1;
  } else if (window === "tomorrow") {
    windowStartMs = todayStart.getTime() + 24 * 60 * 60 * 1000;
    windowEndMs = windowStartMs + 24 * 60 * 60 * 1000 - 1;
  } else {
    // this week — 7 days from start of today
    windowStartMs = todayStart.getTime();
    windowEndMs = windowStartMs + 7 * 24 * 60 * 60 * 1000 - 1;
  }

  return db.getAllSync<CachedEvent>(
    `SELECT * FROM calendar_cache
     WHERE start_ms <= ? AND end_ms >= ?
     ORDER BY start_ms ASC;`,
    [windowEndMs, windowStartMs]
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
  const dayLabel =
    window === "tomorrow"
      ? "tomorrow"
      : window === "this week"
      ? "this week"
      : "today";

  if (events.length === 0) {
    return `Your calendar is clear ${dayLabel}.`;
  }

  const lines = events.map((e) => {
    // start_ms is now a number — no string parsing needed
    const start = new Date(e.start_ms);
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