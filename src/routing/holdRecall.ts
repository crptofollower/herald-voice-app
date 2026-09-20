// Hold Recall / Inspection V1 — read-only view of live WCS interpretation holds.
// No SQLite, pending, IntentRecord, writer, or device-action authority.

import type { AdmittedMultiFactCandidate } from './naturalMultiFactInterpretation';
import type { InterpretationHoldSlot } from './discourseContinuity';

export type HoldRecallResult =
  | { kind: 'not_recall' }
  | { kind: 'empty' }
  | { kind: 'whole_set'; candidates: AdmittedMultiFactCandidate[] }
  | { kind: 'filtered'; filter: string; candidates: AdmittedMultiFactCandidate[] }
  | { kind: 'no_match'; filter: string };

const WHOLE_SET_RE =
  /^\s*(?:what\s+did\s+i\s+(?:just\s+)?(?:tell\s+you|mention|say)|what\s+were\s+(?:the\s+)?things\s+i\s+(?:just\s+)?(?:mentioned|tell\s+you|said)|what\s+have\s+i\s+(?:just\s+)?(?:told\s+you|mentioned|said))\s*\??\s*$/i;

const FILTERED_RE =
  /^\s*what\s+did\s+i\s+(?:just\s+)?(?:say|mention|tell\s+you)\s+about\s+(.+?)\s*\??\s*$/i;

const ARTICLE_PREFIX_RE = /^(?:the|my|a|an)\s+/i;

export const HOLD_RECALL_EMPTY_REPLY =
  "I don't have anything from a moment ago in this conversation.";

export const HOLD_RECALL_NO_MATCH_REPLY =
  "You didn't mention that a moment ago.";

function inspectableCandidates(
  hold: InterpretationHoldSlot | null,
): AdmittedMultiFactCandidate[] {
  if (!hold) return [];
  return hold.candidates.filter((c) => c.kind !== 'emotion_drop' && c.disposition === 'hold');
}

function groundedBlob(c: AdmittedMultiFactCandidate): string {
  return [c.value, c.subject, c.attribution, c.hedge, c.temporal]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .join('\n')
    .toLowerCase();
}

function normalizeFilter(raw: string): string {
  return raw.trim().replace(ARTICLE_PREFIX_RE, '').trim().toLowerCase();
}

export function classifyHoldRecallUtterance(
  utterance: string,
): { mode: 'whole_set' } | { mode: 'filtered'; filter: string } | { mode: 'not_recall' } {
  const t = utterance.trim();
  if (!t) return { mode: 'not_recall' };
  if (WHOLE_SET_RE.test(t)) return { mode: 'whole_set' };
  const filtered = t.match(FILTERED_RE);
  if (filtered?.[1]?.trim()) {
    const filter = normalizeFilter(filtered[1]);
    if (filter) return { mode: 'filtered', filter };
  }
  return { mode: 'not_recall' };
}

export function inspectHolds(
  utterance: string,
  holdSet: InterpretationHoldSlot | null,
): HoldRecallResult {
  const classified = classifyHoldRecallUtterance(utterance);
  if (classified.mode === 'not_recall') return { kind: 'not_recall' };
  const candidates = inspectableCandidates(holdSet);
  // Filtered recall with no live hold must not steal existing named-store
  // reads (e.g. S17 "What did I tell you about Eliquis?"). Whole-set with
  // no live hold still answers from conversation state only.
  if (candidates.length === 0) {
    return classified.mode === 'filtered' ? { kind: 'not_recall' } : { kind: 'empty' };
  }
  if (classified.mode === 'whole_set') {
    return { kind: 'whole_set', candidates: [...candidates] };
  }
  const matches = candidates.filter((c) => groundedBlob(c).includes(classified.filter));
  if (matches.length === 0) return { kind: 'no_match', filter: classified.filter };
  return { kind: 'filtered', filter: classified.filter, candidates: matches };
}

export function formatHoldRecall(result: HoldRecallResult): string | null {
  if (result.kind === 'not_recall') return null;
  if (result.kind === 'empty') return HOLD_RECALL_EMPTY_REPLY;
  if (result.kind === 'no_match') return HOLD_RECALL_NO_MATCH_REPLY;
  const values = result.candidates.map((c) => c.value);
  if (values.length === 1) return `A moment ago you said ${values[0]}.`;
  return `You just mentioned ${values.join('; ')}.`;
}
