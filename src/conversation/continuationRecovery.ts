// Bounded non-authoritative continuation recovery.
// Captured immediately before unused-clear. Never live holder authority.
// Never IDs, phones, pending slots, or mutation targets.

import { THIRD_PERSON_REFERENT_RE } from '../utils/instructionSignals';
import { hasBoundedPositionEvidence } from '../routing/positionReference';

export type ContinuationRecoveryDomain = 'person' | 'medication' | 'grocery' | 'calendar';

export type ContinuationRecoveryCandidate = {
  domain: ContinuationRecoveryDomain;
  spokenReferent: string;
  status: 'expired_this_turn';
};

export const CONTINUATION_RECOVERY_SAFE_LABEL = {
  medication: 'your medications',
  grocery: 'your grocery list',
  calendar: 'your calendar',
} as const;

/** First candidate per domain only — never last-wins overwrite. */
export function recordContinuationRecoveryCandidate(
  into: ContinuationRecoveryCandidate[],
  domain: ContinuationRecoveryDomain,
  spokenReferent: string,
): void {
  if (into.some((c) => c.domain === domain)) return;
  const label = spokenReferent.trim();
  if (!label) return;
  into.push({ domain, spokenReferent: label, status: 'expired_this_turn' });
}

/**
 * Adoption is separate from capture. Reuses existing shared referent/position
 * signals (THIRD_PERSON_REFERENT_RE, hasBoundedPositionEvidence). Not a new
 * phrase list or classifier. Unrelated default talk does not inherit expiry.
 */
export function adoptContinuationRecoveryCandidates(
  text: string,
  candidates: readonly ContinuationRecoveryCandidate[],
): ContinuationRecoveryCandidate[] {
  const adopted: ContinuationRecoveryCandidate[] = [];
  for (const c of candidates) {
    if (c.domain === 'person' && THIRD_PERSON_REFERENT_RE.test(text)) {
      adopted.push(c);
    } else if (c.domain === 'grocery' && hasBoundedPositionEvidence(text)) {
      adopted.push(c);
    }
    // medication/calendar unused-clear already means the closed follow-up
    // grammars missed; those same grammars cannot also adopt.
  }
  return adopted;
}
