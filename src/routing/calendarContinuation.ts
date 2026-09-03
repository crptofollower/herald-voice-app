// Calendar Continuation V1 — bounded RAM holder for narrow temporal follow-ups
// after an authoritative tier-1 calendar read. No answer text. No transcript.
// Sibling to OrderedPresentationHolder / MedicationPresentationHolder.

export type CalendarScopeWindow = 'today' | 'tomorrow' | 'this week' | 'next week';

export type CalendarContinuationState = {
  /** Tier-1 calendar read reason that authorized continuation (e.g. calendar:week). */
  authorizedReason: string;
  establishedAtTurn: number;
};

const FOLLOW_UP_RE =
  /^\s*(?:what|how)\s+about\s+(today|tomorrow|this(?:\s+coming)?\s+week|coming\s+week|next\s+week)\s*[?.!]*\s*$/i;

/** Narrow temporal follow-up — not a full calendar-read utterance. */
export function parseCalendarTemporalFollowUp(text: string): CalendarScopeWindow | null {
  const m = text.trim().match(FOLLOW_UP_RE);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (raw === 'today') return 'today';
  if (raw === 'tomorrow') return 'tomorrow';
  if (raw === 'next week') return 'next week';
  if (raw === 'this week' || raw === 'coming week') return 'this week';
  return null;
}

export class CalendarContinuationHolder {
  private state: CalendarContinuationState | null = null;
  private turn = 0;

  beginUserTurn(): void {
    this.turn += 1;
  }

  peek(): CalendarContinuationState | null {
    return this.state;
  }

  /** True only on the single turn immediately after establishment. */
  canContinue(): boolean {
    if (!this.state) return false;
    return this.state.establishedAtTurn === this.turn - 1;
  }

  hasLive(): boolean {
    return this.canContinue();
  }

  clear(): void {
    this.state = null;
  }

  establish(reason: string): void {
    if (!reason.startsWith('calendar:')) return;
    this.state = {
      authorizedReason: reason,
      establishedAtTurn: this.turn,
    };
  }
}
