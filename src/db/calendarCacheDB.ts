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

export type CalendarWindow = "today" | "tomorrow" | "this week" | "next week";

export function getCachedEvents(
  window: CalendarWindow
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
  } else if (window === "next week") {
    const nextMonday = new Date(todayStart);
    const day = nextMonday.getDay();
    const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
    nextMonday.setDate(nextMonday.getDate() + daysUntilNextMonday);
    windowStartMs = nextMonday.getTime();
    windowEndMs = windowStartMs + 7 * 24 * 60 * 60 * 1000 - 1;
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
  window: CalendarWindow
): string {
  const TITLE_HAS_WEEKDAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
  const dayLabel =
    window === "tomorrow"
      ? "tomorrow"
      : window === "next week"
      ? "next week"
      : window === "this week"
      ? "this week"
      : "today";

  if (events.length === 0) {
    return `Your calendar is clear ${dayLabel}.`;
  }

  const lines = events.map((e) => {
    // start_ms is now a number — no string parsing needed
    const start = new Date(e.start_ms);
    const titleHasWeekday = TITLE_HAS_WEEKDAY.test(e.title);
    if (e.all_day) {
      return (window === "this week" || window === "next week") && !titleHasWeekday
        ? `${e.title} on ${start.toLocaleDateString([], { weekday: "long" })}`
        : e.title;
    }
    const timeStr = start.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    return (window === "this week" || window === "next week") && !titleHasWeekday
      ? `${e.title} on ${start.toLocaleDateString([], { weekday: "long" })} at ${timeStr}`
      : `${e.title} at ${timeStr}`;
  });

  if (lines.length === 1) {
    if (TITLE_HAS_WEEKDAY.test(events[0].title)) {
      return `You have ${lines[0]}.`;
    }
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

// ─── getCachedEventsForDate ────────────────────────────────────────────────
//
// Same query shape as getCachedEvents, for one specific date instead of a
// fixed window. calendar_cache holds no history — callers must only pass
// today-or-forward dates. parseDatePhrase's weekday resolution never
// exceeds +7 days, so any date it produces is always inside the live
// 14-day cache; this function does not itself re-check that bound.

export function getCachedEventsForDate(dateISO: string): CachedEvent[] {
  const db = getDB();
  const [year, month, day] = dateISO.split("-").map(Number);
  const dayStart = new Date(year, month - 1, day);
  dayStart.setHours(0, 0, 0, 0);
  const windowStartMs = dayStart.getTime();
  const windowEndMs = windowStartMs + 24 * 60 * 60 * 1000 - 1;

  return db.getAllSync<CachedEvent>(
    `SELECT * FROM calendar_cache
     WHERE start_ms <= ? AND end_ms >= ?
     ORDER BY start_ms ASC;`,
    [windowEndMs, windowStartMs]
  );
}

// ─── formatEventsForSpecificDay ────────────────────────────────────────────
//
// Formats events for one caller-labeled day ("next Thursday", "today").
// Distinct from formatCachedEventsForSpeech, which only knows the four
// fixed CalendarWindow buckets.

export function formatEventsForSpecificDay(
  events: CachedEvent[],
  dayLabel: string
): string {
  if (events.length === 0) {
    return `Your calendar is clear ${dayLabel}.`;
  }

  const lines = events.map((e) => {
    if (e.all_day) return e.title;
    const start = new Date(e.start_ms);
    const timeStr = start.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${e.title} at ${timeStr}`;
  });

  if (lines.length === 1) {
    return `You have ${lines[0]} ${dayLabel}.`;
  }

  const last = lines.pop()!;
  return `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} you have: ${lines.join(", ")}, and ${last}.`;
}

// ─── findUpcomingEventsMatchingTerm ────────────────────────────────────────
//
// Generic forward calendar-evidence reader (Forward Calendar Evidence V1).
// NOT domain-specific -- it knows nothing about "doctor". Given grounded
// search TOKENS and a caller-supplied deterministic per-string normalizer, it
// returns the cache's currently-live matching events in chronological order
// (soonest first), from NOW forward only. Provenance is preserved: raw
// CachedEvent rows are returned; the CALLER decides how to speak them and is
// responsible for calendar-source phrasing.
//
// NAMESAKE FENCE (deterministic token-sequence match, not substring/regex):
// an event matches only if the normalized search-token sequence occurs as a
// run of COMPLETE ADJACENT tokens within the normalized title tokens. So
// "dr smith" matches "dr smith", "dr smith - follow up", and "appointment
// with dr smith", but NOT "dr smithson" or "dr smithers" (token inequality).
// Reuses the caller's normalizer (medicalDB.normalizeDoctorNameForMatch) for
// per-token normalization -- no second normalization rule invented here.
//
// Forward-only by construction: calendar_cache holds today→+14 days and is
// rebuilt each refresh (see refreshCalendarCache). This reader adds a
// start_ms >= now floor so an all-day or in-progress event earlier today does
// not surface as "upcoming". It cannot and does not read history.

// Split into normalized tokens: split raw on any run of non-letter/non-number
// characters FIRST (Unicode-aware: \p{L}=letter, \p{N}=number, u flag), then
// normalize each token. Splitting BEFORE normalization makes the result
// independent of whether the normalizer keeps or drops separators. The
// Unicode classes (not ASCII [A-Za-z0-9]) are required so ordinary
// international names are not shredded: "Dr. Muñoz" -> ["dr","muñoz"], NOT
// ["dr","mu","oz"]. Empty tokens dropped.
//
// RUNTIME NOTE: \p{L}/\p{N} with the u flag are ES2018 Unicode property
// escapes. They are supported by Hermes (React Native's engine) in current
// Herald builds and by the tsx/Node gate runner. If a future Hermes/RN
// downgrade ever rejects this pattern at load time, the ONLY approved
// fallback is a broader Unicode letter/number range check -- never revert to
// ASCII [A-Za-z0-9], which silently mis-tokenizes accented names. Do NOT add
// a Unicode library, ICU shim, or accent-folding step (accent-folding is an
// identity decision, out of scope for V1).
function normalizedTokens(raw: string, normalize: (s: string) => string): string[] {
  return raw
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => normalize(t))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// True iff `needle` occurs as a contiguous run of exactly-equal tokens in
// `haystack`. Empty needle never matches (fail closed).
function tokenSequenceContained(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let all = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

export function findUpcomingEventsMatchingTerm(
  rawTerm: string,
  normalize: (s: string) => string,
): CachedEvent[] {
  const needle = normalizedTokens(rawTerm, normalize);
  if (needle.length === 0) return [];
  const db = getDB();
  const nowMs = Date.now();
  const rows = db.getAllSync<CachedEvent>(
    `SELECT * FROM calendar_cache
     WHERE start_ms >= ?
     ORDER BY start_ms ASC;`,
    [nowMs],
  );
  return rows.filter(
    (e) => e.title && tokenSequenceContained(normalizedTokens(e.title, normalize), needle),
  );
}

// ─── formatCalendarEvidenceForSpeech ───────────────────────────────────────
//
// Speaks a single calendar event with EXPLICIT calendar provenance. The
// "Your calendar shows" prefix is load-bearing (Forward Calendar Evidence
// V1 / four-layer trust model): it marks the answer as a Source read, never
// a confirmed-memory claim. Do not remove or soften the prefix. displayName
// is the caller's grounded identity label (e.g. the doctor subject's
// displayName), used verbatim so a partial title match still speaks the full
// known name.
//
// Time rendering uses the platform's own locale (toLocaleTimeString) -- this
// is deliberately NOT pinned to a device/locale, so it renders correctly on
// any Android locale (12h or 24h) rather than assuming Samsung/en-US. Tests
// therefore assert on the provenance prefix and the DAY, and derive the
// expected time string from the SAME formatter helper rather than hardcoding
// "11:00 AM" (see buildCalendarEvidenceParts, exported for that purpose).

// Pure, locale-independent structural parts + the locale-rendered time, so
// tests can assert structure (prefix, name, weekday) without coupling to one
// device's AM/PM punctuation. Exported for direct unit testing.
export function buildCalendarEvidenceParts(
  displayName: string,
  event: CachedEvent,
): { prefix: string; displayName: string; weekday: string; timeStr: string | null } {
  const start = new Date(event.start_ms);
  const weekday = start.toLocaleDateString([], { weekday: 'long' });
  const timeStr = event.all_day
    ? null
    : start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { prefix: 'Your calendar shows', displayName, weekday, timeStr };
}

export function formatCalendarEvidenceForSpeech(
  displayName: string,
  event: CachedEvent,
): string {
  const p = buildCalendarEvidenceParts(displayName, event);
  return p.timeStr === null
    ? `${p.prefix} ${p.displayName} on ${p.weekday}.`
    : `${p.prefix} ${p.displayName} on ${p.weekday} at ${p.timeStr}.`;
}
