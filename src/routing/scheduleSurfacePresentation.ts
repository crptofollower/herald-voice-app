// Schedule capability-surface presentation. Rows are a calendar_cache
// projection of presentedCalendarEventIds. Overlay/completion do not exist.

import { getCacheAge, getCachedEventById, type CachedEvent } from '../db/calendarCacheDB';
import type { UtteranceOutcome } from './processUtterance';

export type ScheduleScope = 'today' | 'tomorrow' | 'this week' | 'next week' | 'day';
export type ScheduleIconKind = 'flight' | 'birthday' | 'dining' | 'doctor' | 'generic';

export type ScheduleSurfaceRow = {
  id: string;
  title: string;
  startMs: number;
  allDay: boolean;
  icon: ScheduleIconKind;
};

export function calendarCacheIsUnloaded(): boolean {
  return getCacheAge() === null;
}

export function scheduleScopeFromReason(reason: string): ScheduleScope {
  if (reason === 'calendar:tomorrow') return 'tomorrow';
  if (reason === 'calendar:week') return 'this week';
  if (reason === 'calendar:next_week') return 'next week';
  if (reason === 'calendar:specific_day') return 'day';
  return 'today';
}

export function classifyScheduleTitleIcon(title: string): ScheduleIconKind {
  if (/\bflights?\b/i.test(title) || /\bairport\b/i.test(title)) return 'flight';
  if (/\bbirthdays?\b/i.test(title)) return 'birthday';
  if (/\b(breakfast|lunch|dinner)\b/i.test(title)) return 'dining';
  if (/\bDr\.?\s+\p{L}/u.test(title) || /\bDoctor\s+\p{L}/u.test(title)) return 'doctor';
  return 'generic';
}

function toRow(event: CachedEvent): ScheduleSurfaceRow {
  return {
    id: event.id,
    title: event.title,
    startMs: event.start_ms,
    allDay: event.all_day === 1,
    icon: classifyScheduleTitleIcon(event.title),
  };
}

export function projectScheduleRowsFromPresentedIds(ids: readonly string[]): ScheduleSurfaceRow[] {
  const rows: ScheduleSurfaceRow[] = [];
  for (const id of ids) {
    const event = getCachedEventById(id);
    if (!event) continue;
    rows.push(toRow(event));
  }
  rows.sort((a, b) => a.startMs - b.startMs);
  return rows;
}

const CALENDAR_READ_REASONS = new Set([
  'calendar:today',
  'calendar:tomorrow',
  'calendar:week',
  'calendar:next_week',
  'calendar:specific_day',
]);

export function scheduleOutcomeIdentifiesSurface(outcome: UtteranceOutcome): boolean {
  if (outcome.handled) {
    if (outcome.source === 'emergency') return false;
    if (outcome.capabilitySurface === 'schedule') return true;
    return false;
  }
  const decision = outcome.routeDecision;
  if (decision.kind !== 'device_read') return false;
  if (decision.presentedCalendarEventIds === undefined) return false;
  return CALENDAR_READ_REASONS.has(decision.reason);
}

export function scheduleScopeLabel(scope: ScheduleScope): string {
  if (scope === 'tomorrow') return 'TOMORROW';
  if (scope === 'this week') return 'THIS WEEK';
  if (scope === 'next week') return 'NEXT WEEK';
  if (scope === 'day') return 'SCHEDULE';
  return 'TODAY';
}
