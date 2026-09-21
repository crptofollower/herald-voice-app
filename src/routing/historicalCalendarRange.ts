// Historical Calendar Range Recall V1 — bounded local range resolution
// and calendar-provenance speech for ordinary past schedule reads.
// Device events come from queryCalendarRange; this module does not
// query the OS itself.

import type { CachedEvent } from '../db/calendarCacheDB';
import { now } from '../utils/heraldClock';

export type HistoricalScheduleScope = 'yesterday' | 'last week' | 'last month';

export type HistoricalCalendarRange = {
  reason: 'calendar:yesterday' | 'calendar:last_week' | 'calendar:last_month';
  scheduleScope: HistoricalScheduleScope;
  speechLabel: string;
  includeWeekday: boolean;
  start: Date;
  end: Date;
};

const MONTHS_AGO_WORDS: Record<string, number> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function startOfLocalDay(instant: Date): Date {
  const d = new Date(instant.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday of the Herald week containing `instant` (same Monday rule as next-week). */
export function thisWeekMonday(instant: Date): Date {
  const today = startOfLocalDay(instant);
  const day = today.getDay();
  const daysUntilNextMonday = day === 0 ? 1 : 8 - day;
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + daysUntilNextMonday);
  const monday = new Date(nextMonday);
  monday.setDate(nextMonday.getDate() - 7);
  return monday;
}

function firstOfMonth(instant: Date): Date {
  return new Date(instant.getFullYear(), instant.getMonth(), 1);
}

function monthsAgoCount(msg: string): number | null {
  const m = msg.match(
    /\b(a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+months?\s+ago\b/i,
  );
  if (!m) return null;
  const token = m[1].toLowerCase();
  const n = MONTHS_AGO_WORDS[token] ?? Number(token);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}

export function resolveHistoricalCalendarRange(
  msg: string,
  instant: Date = now(),
): HistoricalCalendarRange | null {
  const today = startOfLocalDay(instant);

  if (/\byesterday\b/i.test(msg)) {
    const start = new Date(today);
    start.setDate(today.getDate() - 1);
    return {
      reason: 'calendar:yesterday',
      scheduleScope: 'yesterday',
      speechLabel: 'yesterday',
      includeWeekday: false,
      start,
      end: today,
    };
  }

  if (/\blast week\b/i.test(msg)) {
    const thisMonday = thisWeekMonday(instant);
    const start = new Date(thisMonday);
    start.setDate(thisMonday.getDate() - 7);
    return {
      reason: 'calendar:last_week',
      scheduleScope: 'last week',
      speechLabel: 'last week',
      includeWeekday: true,
      start,
      end: thisMonday,
    };
  }

  if (/\blast month\b/i.test(msg)) {
    const end = firstOfMonth(today);
    const start = new Date(end.getFullYear(), end.getMonth() - 1, 1);
    return {
      reason: 'calendar:last_month',
      scheduleScope: 'last month',
      speechLabel: 'last month',
      includeWeekday: true,
      start,
      end,
    };
  }

  const ago = monthsAgoCount(msg);
  if (ago !== null) {
    const thisMonth = firstOfMonth(today);
    const start = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - ago, 1);
    const end = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - ago + 1, 1);
    return {
      reason: 'calendar:last_month',
      scheduleScope: 'last month',
      speechLabel: ago === 1 ? 'last month' : `${ago} months ago`,
      includeWeekday: true,
      start,
      end,
    };
  }

  return null;
}

function eventLine(event: CachedEvent, includeWeekday: boolean): string {
  const start = new Date(event.start_ms);
  const weekday = start.toLocaleDateString([], { weekday: 'long' });
  if (event.all_day) {
    return includeWeekday ? `${event.title} on ${weekday}` : event.title;
  }
  const timeStr = start.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return includeWeekday
    ? `${event.title} on ${weekday} at ${timeStr}`
    : `${event.title} at ${timeStr}`;
}

export function formatHistoricalCalendarRangeForSpeech(
  events: CachedEvent[],
  range: Pick<HistoricalCalendarRange, 'speechLabel' | 'includeWeekday'>,
): string {
  if (events.length === 0) {
    return `Your calendar is clear ${range.speechLabel}.`;
  }
  const lines = events.map((e) => eventLine(e, range.includeWeekday));
  if (lines.length === 1) {
    return `Your calendar shows ${lines[0]}.`;
  }
  const last = lines.pop()!;
  return `Your calendar shows: ${lines.join(', ')}, and ${last}.`;
}

export function toPresentedCalendarSnapshot(
  events: CachedEvent[],
): Array<Pick<CachedEvent, 'id' | 'title' | 'start_ms' | 'all_day'>> {
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    start_ms: e.start_ms,
    all_day: e.all_day,
  }));
}
