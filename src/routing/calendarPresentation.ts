// Calendar Presentation Holder V1 — RAM ordered event IDs after an authoritative
// calendar read. Supports bounded ordinal time follow-ups ("what time was the
// first thing?"). Sibling to CalendarContinuationHolder; orthogonal contracts.
// Identity/reference only. No transcript text. Fresh by-id reread for answers.

import { getCachedEventById, formatCalendarEventTimeForSpeech } from '../db/calendarCacheDB';
import { ordinalWordToNumber, resolvePositions } from './orderedPresentation';

export type CalendarPresentationState = {
  eventIds: string[];
  establishedAtTurn: number;
};

export const CALENDAR_PRESENTATION_CONFUSION = `I'm not sure which one you mean.`;
export const CALENDAR_PRESENTATION_STALE =
  `I don't see that on your calendar right now.`;

// V1 answers: first/second + thing|one. Parser accepts any word-ordinal so
// out-of-range ordinals (e.g. third with two events) fail closed, not fall through.
const TIME_INQUIRY_RE =
  /^\s*what\s+time\s+(?:was|is)\s+(?:(?:the|that)\s+)?(.+?)\s+(?:thing|one)\s*[?.!]?\s*$/i;

/** 1-based position for a bounded calendar time inquiry, or null. */
export function parseCalendarTimeInquiry(text: string): number | null {
  const m = text.trim().match(TIME_INQUIRY_RE);
  if (!m) return null;
  const pos = ordinalWordToNumber(m[1]);
  if (pos == null || pos < 1) return null;
  return pos;
}

export function answerCalendarTimeInquiry(
  presentation: CalendarPresentationState,
  position: number,
): { kind: 'ok' | 'oor' | 'stale'; responseText: string } {
  const resolved = resolvePositions(presentation.eventIds, [position]);
  if (!resolved.ok) {
    return { kind: 'oor', responseText: CALENDAR_PRESENTATION_CONFUSION };
  }
  const event = getCachedEventById(resolved.ids[0]);
  if (!event) {
    return { kind: 'stale', responseText: CALENDAR_PRESENTATION_STALE };
  }
  return { kind: 'ok', responseText: formatCalendarEventTimeForSpeech(event) };
}

export class CalendarPresentationHolder {
  private presentation: CalendarPresentationState | null = null;
  private turn = 0;

  beginUserTurn(): void {
    this.turn += 1;
  }

  peek(): CalendarPresentationState | null {
    return this.presentation;
  }

  /** True only on the single turn immediately after establishment. */
  canContinue(): boolean {
    if (!this.presentation) return false;
    return this.presentation.establishedAtTurn === this.turn - 1;
  }

  hasLive(): boolean {
    return this.canContinue();
  }

  clear(): void {
    this.presentation = null;
  }

  establish(eventIds: string[]): void {
    this.presentation = {
      eventIds: [...eventIds],
      establishedAtTurn: this.turn,
    };
  }
}
