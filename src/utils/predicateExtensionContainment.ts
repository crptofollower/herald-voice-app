// Predicate-Extension Containment V1 — ephemeral personal-event replies only.
// Pure predicates + bounded acknowledgments. No DB, no LLM.

import { utteranceHasInteractionReportShape } from '../routing/speechActAuthority';

/** First-person past personal event reports beyond family interaction shape. */
const FIRST_PERSON_PAST_EVENT_RE =
  /^\s*I\s+(?:already\s+)?(?:saw|visited|met|went to(?: see)?|had(?: an appointment with)?)\b/i;

export function utteranceRequiresBoundedPastEventAck(text: string): boolean {
  const t = text.trim();
  if (!t || /\?\s*$/.test(t)) return false;
  if (utteranceHasInteractionReportShape(t)) return true;
  return FIRST_PERSON_PAST_EVENT_RE.test(t);
}

/** Evidence-bounded acknowledgment — pronoun shift only, no new predicates. */
export function buildBoundedPastEventAcknowledgment(utterance: string): string {
  let t = utterance.trim().replace(/[.!?]+$/, '');
  t = t.replace(/\bmy\b/gi, (m) => (m[0] === 'M' ? 'Your' : 'your'));
  t = t.replace(/\bme\b/gi, 'you');
  t = t.replace(/\bI\b/gi, 'You');
  if (t.length === 0) return utterance.trim();
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}
