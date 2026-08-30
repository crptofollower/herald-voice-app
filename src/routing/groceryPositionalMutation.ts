// Grocery positional mutation V1 — speech-act + named-grant cue only.
// Does not select IDs or bodies. Authority and writes live in processUtterance.

import { interpretPositionReference, isPositionMutationLanguage, hasBoundedPositionEvidence } from './positionReference';
import type { PresentedListItem } from '../db/listRead';

export type GroceryPositionalMutationParse =
  | { kind: 'not_this_act' }
  | { kind: 'ambiguous'; reason: 'competing_positions' | 'relative' | 'other_anaphor' }
  | { kind: 'unresolved' }
  | { kind: 'position'; n: number };

const GROCERY_NAMED_MUTATION_CUE_RE =
  /\b(?:from|off|on)\s+(?:my\s+|the\s+)?grocery\s+list\b/i;

const DOMAIN_BLOCK_RE = /\b(?:medication|medications|medicine|medicines|pills?)\b/i;
const PRONOUN_IT_RE = /\bit\b/i;

export function hasGroceryNamedMutationCue(text: string): boolean {
  return GROCERY_NAMED_MUTATION_CUE_RE.test(text);
}

export function isGroceryMutationDomainBlocked(text: string): boolean {
  return DOMAIN_BLOCK_RE.test(text) || PRONOUN_IT_RE.test(text);
}

export function parseGroceryPositionalMutation(text: string): GroceryPositionalMutationParse {
  if (!isPositionMutationLanguage(text)) return { kind: 'not_this_act' };
  if (isGroceryMutationDomainBlocked(text)) {
    return { kind: 'not_this_act' };
  }
  const interpreted = interpretPositionReference(text, { allowMutationLanguage: true });
  if (interpreted.kind === 'unsafe') return { kind: 'not_this_act' };
  if (interpreted.kind === 'ambiguous') {
    return { kind: 'ambiguous', reason: interpreted.reason };
  }
  if (interpreted.kind === 'position_reference' && interpreted.positions.length === 1) {
    return { kind: 'position', n: interpreted.positions[0] };
  }
  if (hasBoundedPositionEvidence(text)) {
    return { kind: 'unresolved' };
  }
  return { kind: 'not_this_act' };
}

export function formatGroceryRemovalAck(
  removedBody: string,
  remaining: PresentedListItem[],
): string {
  if (remaining.length === 0) {
    return `Done — ${removedBody} is off your grocery list. That clears it.`;
  }
  return `Done — ${removedBody} is off. Still on your grocery list: ${remaining.map((r) => r.body).join(', ')}.`;
}
