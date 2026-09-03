// Calendar Continuation V1/V2 — bounded RAM holder for narrow temporal follow-ups
// after an authoritative tier-1 calendar read. No answer text. No transcript.
// V2 adds deictic "what's on there for tomorrow" shapes — valid ONLY when
// CalendarContinuationHolder.canContinue() is already true (processUtterance gate).
// Sibling to OrderedPresentationHolder / MedicationPresentationHolder.

export type CalendarScopeWindow = 'today' | 'tomorrow' | 'this week' | 'next week';

export type CalendarContinuationState = {
  /** Tier-1 calendar read reason that authorized continuation (e.g. calendar:week). */
  authorizedReason: string;
  establishedAtTurn: number;
};

const TEMPORAL_SCOPE =
  '(today|tomorrow|this(?:\\s+coming)?\\s+week|coming\\s+week|next\\s+week)';

/** V1 — "What about tomorrow?" / "How about today?" */
const FOLLOW_UP_RE = new RegExp(
  `^\\s*(?:what|how)\\s+about\\s+${TEMPORAL_SCOPE}\\s*[?.!]*\\s*$`,
  'i',
);

/** V2 — bounded deictic temporal follow-up after an authoritative calendar read. */
const DEICTIC_FOLLOW_UP_RE = new RegExp(
  `^\\s*what(?:'s| is)\\s+on\\s+there(?:\\s+for)?\\s+${TEMPORAL_SCOPE}\\s*[?.!]*\\s*$`,
  'i',
);

function scopeFromCapture(raw: string): CalendarScopeWindow | null {
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  if (normalized === 'today') return 'today';
  if (normalized === 'tomorrow') return 'tomorrow';
  if (normalized === 'next week') return 'next week';
  if (normalized === 'this week' || normalized === 'coming week') return 'this week';
  return null;
}

/** Narrow temporal follow-up — not a full calendar-read utterance. */
export function parseCalendarTemporalFollowUp(text: string): CalendarScopeWindow | null {
  const trimmed = text.trim();
  const m = trimmed.match(FOLLOW_UP_RE) ?? trimmed.match(DEICTIC_FOLLOW_UP_RE);
  if (!m) return null;
  return scopeFromCapture(m[1]);
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
