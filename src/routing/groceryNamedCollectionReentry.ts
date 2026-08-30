// F2 grocery named-collection re-entry — grocery-owned authority grant.
// Position meaning comes from the shared interpreter. This module only
// grants fresh grocery reread when the utterance names the grocery list.

import { interpretPositionReference, isPositionMutationLanguage } from './positionReference';

export type GroceryNamedCollectionRead =
  | { kind: 'not_this_act' }
  | { kind: 'ambiguous' }
  | { kind: 'position'; n: number };

const GROCERY_NAMED_CUE_RE = /\bon\s+(?:my|the)\s+grocery\s+list\b/i;

export function hasGroceryNamedCollectionCue(text: string): boolean {
  return GROCERY_NAMED_CUE_RE.test(text);
}

export function parseGroceryNamedCollectionRead(text: string): GroceryNamedCollectionRead {
  if (!hasGroceryNamedCollectionCue(text)) return { kind: 'not_this_act' };
  if (isPositionMutationLanguage(text)) return { kind: 'not_this_act' };
  const interpreted = interpretPositionReference(text);
  if (interpreted.kind === 'unsafe') return { kind: 'not_this_act' };
  if (interpreted.kind === 'ambiguous') return { kind: 'ambiguous' };
  if (interpreted.kind === 'position_reference' && interpreted.positions.length === 1) {
    return { kind: 'position', n: interpreted.positions[0] };
  }
  return { kind: 'not_this_act' };
}
