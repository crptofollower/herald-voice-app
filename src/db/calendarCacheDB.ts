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
        const parsed = parseRawCalendarEvent(event, now);
        if (!parsed) continue;

        // NOTE: cached_at here is the WRITE-TIME timestamp (nowISO, when this
        // refresh ran), not parsed.cached_at (which parseRawCalendarEvent
        // sets for its own return-value shape, used by queryCalendarEvidence
        // below where there is no cache write at all). Do not swap these.
        db.runSync(
          `INSERT OR REPLACE INTO calendar_cache
             (id, title, start_ms, end_ms, all_day, notes, cached_at)
           VALUES (?, ?, ?, ?, ?, ?, ?);`,
          [
            parsed.id,
            parsed.title,
            parsed.start_ms,
            parsed.end_ms,
            parsed.all_day,
            parsed.notes ?? null,
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

// Doctor-calendar title match (Vance repair). Does NOT replace
// tokenSequenceContained. Exact adjacent runs still win first.
//
// Relaxed form is NOT "surname appears somewhere after Dr". Punctuation is
// discarded by normalizedTokens, so "Dr. Estil Vance" and "Dr. Smith - Patel"
// are token-identical unless the matcher keeps local title structure.
// A doctor-name SPAN is the raw substring from each "Dr" until the next
// structural title break (dash, colon, paren, slash, comma, semicolon, pipe,
// ampersand, plus, at-sign, or a period after a multi-letter token).
// Only that span is tokenized for the relaxed form. Positive shapes, with
// the surname as the span's last token:
//   dr + given + surname
//   dr + given + single-letter initial + surname
// Two unrestricted given-name tokens are refused (Dr. Smith re Patel).
function isDoctorSpanBreakChar(c: string): boolean {
  return (
    c === '-' || c === '–' || c === '—' ||
    c === ':' || c === '(' || c === '[' || c === '{' ||
    c === '|' || c === '/' || c === ';' || c === ',' ||
    c === '&' || c === '+' || c === '@'
  );
}

function doctorNameSpanEnd(title: string, from: number): number {
  for (let i = from; i < title.length; i++) {
    const c = title[i];
    if (isDoctorSpanBreakChar(c)) return i;
    if (c !== '.') continue;
    let letterCount = 0;
    for (let j = i - 1; j >= from && /\p{L}/u.test(title[j]); j--) letterCount++;
    const next = title[i + 1];
    if (letterCount >= 2 && (next === undefined || /\s/.test(next))) return i;
  }
  return title.length;
}

function extractDoctorNameSpans(title: string): string[] {
  const spans: string[] = [];
  const startRe = /\b[Dd]r\.?/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(title)) !== null) {
    const from = m.index;
    const afterDr = from + m[0].length;
    spans.push(title.slice(from, doctorNameSpanEnd(title, afterDr)));
  }
  return spans;
}

// Exact 3-token Given Surname, or 4-token Given + initial + Surname.
// Returns the identity tokens or null. Surname must be the last token.
function parseDoctorShapedSpan(toks: string[], surname: string): string[] | null {
  if (toks.length < 3 || toks[0] !== 'dr') return null;
  if (toks[toks.length - 1] !== surname) return null;
  if (toks.some((t, i) => i > 0 && t === 'dr')) return null;
  if (toks.length === 3) return toks;
  if (toks.length === 4 && toks[2].length === 1) return toks;
  return null;
}

function doctorSpanIdentityKey(toks: string[], surname: string): string | null {
  if (toks.length < 2 || toks[0] !== 'dr') return null;
  if (toks[1] === surname) return `dr|${surname}`;
  const shaped = parseDoctorShapedSpan(toks, surname);
  return shaped ? shaped.join('|') : null;
}

function strongDoctorSpanNameTokensAreTitleCase(span: string): boolean {
  const raw = span.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (raw.length < 2) return false;
  return raw.slice(1).every((t) => /^\p{Lu}/u.test(t));
}

export function titleHasStrongDoctorNameSpan(
  title: string,
  normalize: (s: string) => string,
): boolean {
  for (const span of extractDoctorNameSpans(title)) {
    const toks = normalizedTokens(span, normalize);
    if (toks.length < 3) continue;
    if (!parseDoctorShapedSpan(toks, toks[toks.length - 1])) continue;
    if (!strongDoctorSpanNameTokensAreTitleCase(span)) continue;
    return true;
  }
  return false;
}

export function genericDoctorCalendarLabel(
  title: string,
  normalize: (s: string) => string,
  knownTerms: string[],
): string {
  for (const span of extractDoctorNameSpans(title)) {
    const toks = normalizedTokens(span, normalize);
    if (toks.length >= 3 && parseDoctorShapedSpan(toks, toks[toks.length - 1])
      && strongDoctorSpanNameTokensAreTitleCase(span)) {
      return span.trim();
    }
  }
  for (const term of knownTerms) {
    if (titleMatchesDoctorCalendarTerm(title, term, normalize)) return term;
  }
  return title;
}

export function titleMatchesDoctorCalendarTerm(
  title: string,
  rawTerm: string,
  normalize: (s: string) => string,
): boolean {
  const needle = normalizedTokens(rawTerm, normalize);
  const haystack = normalizedTokens(title, normalize);
  if (tokenSequenceContained(haystack, needle)) return true;
  if (needle.length !== 2 || needle[0] !== 'dr' || !needle[1]) return false;
  const surname = needle[1];
  for (const span of extractDoctorNameSpans(title)) {
    if (parseDoctorShapedSpan(normalizedTokens(span, normalize), surname)) return true;
  }
  return false;
}

export function doctorCalendarIdentityKey(
  title: string,
  rawTerm: string,
  normalize: (s: string) => string,
): string {
  const needle = normalizedTokens(rawTerm, normalize);
  const haystack = normalizedTokens(title, normalize);
  if (needle.length === 2 && needle[0] === 'dr' && needle[1]) {
    const surname = needle[1];
    for (const span of extractDoctorNameSpans(title)) {
      const key = doctorSpanIdentityKey(normalizedTokens(span, normalize), surname);
      if (key) return key;
    }
  }
  return haystack.join('|');
}

export function findUpcomingEventsMatchingTerm(
  rawTerm: string,
  normalize: (s: string) => string,
  matchTitle?: (title: string) => boolean,
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
  const matches = matchTitle
    ?? ((title: string) => tokenSequenceContained(normalizedTokens(title, normalize), needle));
  return rows.filter(
    (e) => e.title && matches(e.title),
  );
}

export function findUpcomingCachedEvents(): CachedEvent[] {
  const db = getDB();
  const nowMs = Date.now();
  return db.getAllSync<CachedEvent>(
    `SELECT * FROM calendar_cache
     WHERE start_ms >= ?
     ORDER BY start_ms ASC;`,
    [nowMs],
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
): { prefix: string; displayName: string; weekday: string; dateLabel: string; timeStr: string | null } {
  const start = new Date(event.start_ms);
  const weekday = start.toLocaleDateString([], { weekday: 'long' });
  // dateLabel includes the year unconditionally -- an event that is months
  // or a year old must never rely on the listener tracking which year is
  // implied (Elder Safety: never assume relative-date tracking).
  const dateLabel = start.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = event.all_day
    ? null
    : start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return { prefix: 'Your calendar shows', displayName, weekday, dateLabel, timeStr };
}

// mode='weekday' (default) preserves EVERY existing call site's behavior
// byte-for-byte (the 14-day-cache fallback, already device-proven last
// session) -- weekday is meaningful and unambiguous within ~2 weeks. New
// wide-range/historical/year-bounded call sites (Android Calendar Range V1)
// pass mode='date': for anything outside the near-term cache window,
// "Wednesday" is ambiguous (which Wednesday?) -- an actual calendar date is
// the honest, unambiguous phrasing.
export function formatCalendarEvidenceForSpeech(
  displayName: string,
  event: CachedEvent,
  mode: 'weekday' | 'date' = 'weekday',
): string {
  const p = buildCalendarEvidenceParts(displayName, event);
  const when = mode === 'date' ? p.dateLabel : p.weekday;
  return p.timeStr === null
    ? `${p.prefix} ${p.displayName} on ${when}.`
    : `${p.prefix} ${p.displayName} on ${when} at ${p.timeStr}.`;
}

// ─── parseRawCalendarEvent ──────────────────────────────────────────────────
//
// Shared event-parsing logic (Android Calendar Range V1 / Rule 11 — machinery
// unified at the second occurrence, per Harvest §B item 6(a)). Factored out
// of refreshCalendarCache's inline loop, which now calls this too (see above)
// — behavior there is unchanged, this is purely a mechanical extraction.
// Handles the two known Android/expo-calendar quirks this file's header
// already documents: non-standard ISO date strings, and all-day events
// stored as UTC midnight (normalized to local-day bounds here). Returns null
// for a missing title or unparseable dates -- caller skips the row.
function parseRawCalendarEvent(
  event: { id: string; title?: string | null; startDate?: string | Date | null; endDate?: string | Date | null; allDay?: boolean; notes?: string | null },
  fallbackNowMs: number,
): CachedEvent | null {
  if (!event.title) return null;
  let startMs = event.startDate ? new Date(event.startDate).getTime() : fallbackNowMs;
  let endMs = event.endDate ? new Date(event.endDate).getTime() : fallbackNowMs;
  if (event.allDay) {
    const startLocal = new Date(startMs);
    startLocal.setHours(0, 0, 0, 0);
    startMs = startLocal.getTime();
    const endLocal = new Date(endMs);
    endLocal.setHours(23, 59, 59, 999);
    endMs = endLocal.getTime();
  }
  if (isNaN(startMs) || isNaN(endMs)) return null;
  return {
    id: event.id,
    title: event.title,
    start_ms: startMs,
    end_ms: endMs,
    all_day: event.allDay ? 1 : 0,
    notes: event.notes ?? undefined,
    cached_at: new Date().toISOString(),
  };
}

// ─── queryCalendarEvidence ───────────────────────────────────────────────────
//
// Generic, ON-DEMAND, bounded calendar-evidence range reader (Android
// Calendar Range V1). Sibling to findUpcomingEventsMatchingTerm (which only
// reads the 14-day cache) -- this one queries the device calendar DIRECTLY,
// for a caller-supplied [startDate, endDate) window of ANY size (bounded by
// the caller, never unbounded). Read-only: no SQL write, no calendar_cache
// mutation, no persistence of any kind. Reuses the SAME namesake-fence
// matcher (normalizedTokens / tokenSequenceContained) as the 14-day-cache
// reader -- one matching rule, two sources.
//
// PROVIDER-NEUTRAL SEAM: the actual device fetch is a swappable module-level
// function (see setCalendarEventFetcher below), the same pattern this
// codebase already uses for setDB/getDB and calendarWrite.ts's injectable
// CalendarWriteFn. A future non-Android calendar source (e.g. Outlook) would
// be a different fetcher behind this SAME queryCalendarEvidence signature --
// no new abstraction is built here, this injectability point already IS the
// seam. Not built or wired to anything in this session.
//
// Called rarely by design: only on a DOUBLE miss (medical authority AND the
// fast 14-day cache both empty), so this on-demand OS call is paid rarely,
// never on every turn.
//
// RESULT SHAPE: mirrors this codebase's own EphemeralResult convention
// (ephemeralConversation.ts: `{status:'ok', text}` / `{status:'unavailable',
// reason}`) rather than inventing a new pattern. This distinguishes three
// genuinely different outcomes that a bare array collapses into one:
//   - a successful query with matches
//   - a successful query with zero matches (real evidence of absence)
//   - the source being unavailable (permission denied, provider error --
//     NOT evidence of absence, and must never be spoken as if it were).
// Collapsing "unavailable" into an empty array would let a permission
// failure silently become a confident "I don't have another visit..." --
// a wrong answer stated with the same confidence as a real honest miss,
// which is exactly the failure class CLAUDE.md's Trust First principle
// exists to prevent. `reason` is for logging only, never spoken to the
// user (see call sites in conversationalSubject.ts).
//
// TYPE NOTE: expo-calendar does not export a standalone `Calendar.Event`
// type. Derive the raw element type from the actual function's return type
// instead of guessing an export name -- this is the established, correct
// form (confirmed against this project's actual compilation, not assumed).
type RawCalendarEvent = Awaited<ReturnType<typeof Calendar.getEventsAsync>>[number];

export type RawCalendarFetchResult =
  | { status: 'ok'; events: RawCalendarEvent[] }
  | { status: 'unavailable'; reason: 'permission-denied' | 'error' };

async function fetchRawDeviceEvents(startDate: Date, endDate: Date): Promise<RawCalendarFetchResult> {
  try {
    let { status } = await Calendar.getCalendarPermissionsAsync();
    if (status !== 'granted') {
      const result = await Calendar.requestCalendarPermissionsAsync();
      status = result.status;
    }
    if (status !== 'granted') return { status: 'unavailable', reason: 'permission-denied' };
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const events = await Calendar.getEventsAsync(calendars.map((c) => c.id), startDate, endDate);
    return { status: 'ok', events };
  } catch {
    return { status: 'unavailable', reason: 'error' };
  }
}

// Module-level swappable fetcher -- mirrors setDB/getDB (schema.ts) and
// CalendarWriteFn (calendarWrite.ts)'s existing injectability convention.
// Real callers never touch this; the test gate swaps it because expo-calendar
// has no native bridge inside the Node/tsx test runner. Tests can now supply
// either an {status:'ok', events} fake (evidence tests) or an
// {status:'unavailable', reason} fake (the new trust-boundary tests below).
let _eventFetcher: (start: Date, end: Date) => Promise<RawCalendarFetchResult> = fetchRawDeviceEvents;
export function setCalendarEventFetcher(fn: (start: Date, end: Date) => Promise<RawCalendarFetchResult>): void {
  _eventFetcher = fn;
}
export function resetCalendarEventFetcher(): void {
  _eventFetcher = fetchRawDeviceEvents;
}

export type CalendarEvidenceResult =
  | { status: 'ok'; events: CachedEvent[] }
  | { status: 'unavailable'; reason: 'permission-denied' | 'error' };

async function fetchMappedCalendarRange(
  startDate: Date,
  endDate: Date,
): Promise<CalendarEvidenceResult> {
  const startMsBound = startDate.getTime();
  const endMsBound = endDate.getTime();
  try {
    const raw = await _eventFetcher(startDate, endDate);
    if (raw.status === 'unavailable') return raw;
    const now = Date.now();
    const mapped: CachedEvent[] = [];
    for (const event of raw.events) {
      if (!event.startDate) continue;
      const parsed = parseRawCalendarEvent(event, now);
      if (!parsed) continue;
      mapped.push(parsed);
    }
    const events = mapped
      .filter((e) => e.start_ms >= startMsBound && e.start_ms < endMsBound)
      .sort((a, b) => a.start_ms - b.start_ms);
    return { status: 'ok', events };
  } catch {
    return { status: 'unavailable', reason: 'error' };
  }
}

export async function queryCalendarRange(
  startDate: Date,
  endDate: Date,
): Promise<CalendarEvidenceResult> {
  return fetchMappedCalendarRange(startDate, endDate);
}

export async function queryCalendarEvidence(
  rawTerm: string,
  normalize: (s: string) => string,
  startDate: Date,
  endDate: Date,
  opts?: { matchTitle?: (title: string) => boolean },
): Promise<CalendarEvidenceResult> {
  const needle = normalizedTokens(rawTerm, normalize);
  // Empty/degenerate search term is a caller-input condition, not a
  // calendar-availability problem -- stays 'ok' with zero events and does
  // NOT fetch. Generic doctor discovery must call queryCalendarRange instead.
  if (needle.length === 0) return { status: 'ok', events: [] };
  const range = await fetchMappedCalendarRange(startDate, endDate);
  if (range.status === 'unavailable') return range;
  const titleMatches = opts?.matchTitle
    ?? ((title: string) => tokenSequenceContained(normalizedTokens(title, normalize), needle));
  return {
    status: 'ok',
    events: range.events.filter((e) => titleMatches(e.title)),
  };
}
