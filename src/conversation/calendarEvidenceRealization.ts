// src/conversation/calendarEvidenceRealization.ts
// Conversational Response Realization V1 — Calendar Evidence.
//
// AUTHORIZED DETERMINISTIC RESULT -> BOUNDED RESPONSE ACT -> DETERMINISTIC
// REALIZATION -> existing transcript/TTS path. This module owns the LAST step
// only: it turns an already-decided calendar-evidence act into the sentence the
// user hears. It decides nothing.
//
// Pure, synchronous, local, zero imports. No LLM, no network, no I/O, no clock,
// no randomness. The `act -> string` signature is itself part of the guarantee:
// an async/model-backed implementation could not be substituted here without a
// visible signature change at every call site.
//
// PROVENANCE IS STRUCTURAL, NOT CONVENTIONAL:
// EVIDENCE_PREFIX is a const inside this module. It is never a parameter, never
// a field on CalendarEvidenceResponseAct, and never read from configuration —
// so no caller can supply, override, or omit it, and no branch below emits an
// asserting calendar sentence without it. That is what makes "calendar evidence
// spoken as confirmed real-world truth" structurally impossible here, rather
// than a discipline each call site has to remember. Wording that implies the
// event before qualifying its source ("Looks like you're seeing ...") is
// therefore not merely discouraged, it is unreachable.
//
// Realization may control sentence structure, list joining, and connective
// language. It may NOT choose facts, select entities, resolve ambiguity, assign
// authority, or invent information: every value it speaks arrives already
// resolved and already gated upstream, and is concatenated verbatim.
//
// No generic conversational closer is ever appended. The only kind that ends in
// a question is 'multi', where the disambiguation question is the act's own
// required content — there is no branch that could emit a 'multi' without it,
// and none that could add a question to any other kind.

/** Scope phrases the enrolled calendar-evidence call sites actually use. */
export type CalendarEvidenceScope =
  | { kind: 'relative_months'; direction: 'past' | 'next'; months: number }
  | { kind: 'year'; year: number };

/** Misses are only enrolled for relative-month windows — narrowed so a scope
 *  shape no enrolled site produces cannot be constructed for one. */
export type CalendarEvidenceRelativeScope = Extract<CalendarEvidenceScope, { kind: 'relative_months' }>;

export type CalendarEvidenceResponseAct =
  // One matched event. Fields mirror buildCalendarEvidenceParts' output, minus
  // its prefix — the prefix belongs to realization, not to the fact producer.
  | {
      kind: 'hit';
      displayName: string;
      weekday: string;
      dateLabel: string;
      timeStr: string | null;
      mode: 'weekday' | 'date';
    }
  // No matched events inside the searched window.
  | { kind: 'miss'; displayName: string; scope: CalendarEvidenceRelativeScope }
  // More than one candidate, never auto-selected. `dates` arrives already
  // formatted by the caller that owns those rows; realization only joins it.
  | { kind: 'multi'; displayName: string; scope: CalendarEvidenceScope; dates: string[] };

function scopePhrase(scope: CalendarEvidenceScope): string {
  return scope.kind === 'year'
    ? `in ${scope.year}`
    : `in the ${scope.direction} ${scope.months} months`;
}

export function realizeCalendarEvidenceAct(act: CalendarEvidenceResponseAct): string {
  const EVIDENCE_PREFIX = 'Your calendar shows';
  switch (act.kind) {
    case 'hit': {
      const when = act.mode === 'date' ? act.dateLabel : act.weekday;
      return act.timeStr === null
        ? `${EVIDENCE_PREFIX} ${act.displayName} on ${when}.`
        : `${EVIDENCE_PREFIX} ${act.displayName} on ${when} at ${act.timeStr}.`;
    }
    case 'miss':
      return `I don't see anything with ${act.displayName} on your calendar ${scopePhrase(act.scope)}.`;
    case 'multi':
      return (
        `${EVIDENCE_PREFIX} ${act.dates.length} things with ${act.displayName} ` +
        `${scopePhrase(act.scope)} — ${act.dates.join(', ')}. Which one did you mean?`
      );
  }
}
