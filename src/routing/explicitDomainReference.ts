// Explicit Domain Reference V1 — pure observation.
// Names a Herald domain family from a grounded noun span. Grants no authority,
// creates no state, and is not a route owner.

export type ExplicitDomainFamily = 'calendar' | 'medications';

export type ExplicitDomainReference = {
  family: ExplicitDomainFamily;
  groundedSpan: string;
};

/** Production calendar-domain nouns (parseTime CALENDAR_WRITE_TRIGGER). */
const CALENDAR_NOUN_RE = /\b(?:calendar|schedule)\b/gi;

/**
 * Catalog medication-domain nouns only (detectMedicalEvent CATALOG_MED_NOUN
 * plus singular medicine / med / pill already listed beside that catalog).
 * Not dosage/doctor/prescribed operational evidence.
 */
const MEDICATION_NOUN_RE =
  /\b(?:medications|medication|medicines|medicine|prescriptions|meds|pills|med|pill)\b/gi;

function collectSpans(utterance: string, re: RegExp): Array<{ start: number; span: string }> {
  return [...utterance.matchAll(re)].map((m) => ({ start: m.index ?? 0, span: m[0] }));
}

/** Smallest fail-closed guard: "not (my )<noun>" or wasn't/was not in the prefix. */
function spanIsNegated(utterance: string, start: number): boolean {
  const prefix = utterance.slice(0, start);
  if (/\bnot\s+(?:my\s+)?$/i.test(prefix)) return true;
  if (/\b(?:wasn'?t|weren'?t|ain'?t|was\s+not|were\s+not)\b/i.test(prefix)) return true;
  return false;
}

export function detectExplicitDomainReference(utterance: string): ExplicitDomainReference | null {
  if (!utterance) return null;

  const calendarHits = collectSpans(utterance, CALENDAR_NOUN_RE);
  const medicationHits = collectSpans(utterance, MEDICATION_NOUN_RE);

  if (calendarHits.length > 0 && medicationHits.length > 0) return null;

  const calendar = calendarHits.filter((h) => !spanIsNegated(utterance, h.start));
  const medications = medicationHits.filter((h) => !spanIsNegated(utterance, h.start));

  if (calendar.length === 0 && medications.length === 0) return null;
  if (calendar.length > 0) {
    return { family: 'calendar', groundedSpan: calendar[0].span };
  }
  return { family: 'medications', groundedSpan: medications[0].span };
}
