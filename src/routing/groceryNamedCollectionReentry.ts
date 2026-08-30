// F2 grocery named-collection re-entry — grocery-owned speech act.
// Not OPR/F1 intake. Positional grammar here does not grant authority
// unless the utterance also names the grocery collection.

import {
  cardinalWordToNumber,
  ordinalWordToNumber,
  parseNumericOrdinal,
} from './orderedPresentation';

export type GroceryNamedCollectionRead =
  | { kind: 'not_this_act' }
  | { kind: 'ambiguous' }
  | { kind: 'position'; n: number };

/** Same fence as OPR read-back. Duplicated so F2 does not reopen the OPR cue table. */
const POSITION_MUTATION_RE =
  /\b(?:remove|delete|cross(?:\s+off)?|take\s+off|got|picked\s+up|grabbed|bought|completed?|finished|done\s+with)\b/i;

const GROCERY_NAMED_CUE_RE = /\bon\s+(?:my|the)\s+grocery\s+list\b/i;

function positiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseSlotValue(raw: string): number | null {
  return positiveInt(raw.trim()) ?? cardinalWordToNumber(raw);
}

function parseOrdinalOrNth(raw: string): number | null {
  return ordinalWordToNumber(raw) ?? parseNumericOrdinal(raw);
}

/**
 * Position hits for F2 only. Includes grocery-local `thing`/`item` after an
 * ordinal, plus the same operator shapes OPR uses — without changing OPR intake.
 */
function collectNamedCollectionPositionHits(text: string): number[] {
  const hits: number[] = [];

  for (const m of text.matchAll(/#\s*(\d+)/g)) {
    const n = positiveInt(m[1]);
    if (n != null) hits.push(n);
  }

  for (const m of text.matchAll(/\b(?:number|item)\s+(\d+|[a-z]+(?:[-\s][a-z]+)?)\b/gi)) {
    const raw = m[1];
    const n = parseSlotValue(raw) ?? parseSlotValue(raw.trim().split(/[-\s]/)[0] ?? '');
    if (n != null) hits.push(n);
  }

  for (const m of text.matchAll(/\b(?:the|that)\s+(.+?)\s+one\b/gi)) {
    const n = parseOrdinalOrNth(m[1]);
    if (n != null) hits.push(n);
  }

  for (const m of text.matchAll(/\b(?:the|that)\s+(.+?)\s+(?:thing|item)\b/gi)) {
    const n = parseOrdinalOrNth(m[1]);
    if (n != null) hits.push(n);
  }

  return hits;
}

function uniquePositions(hits: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of hits) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function parseGroceryNamedCollectionRead(text: string): GroceryNamedCollectionRead {
  if (POSITION_MUTATION_RE.test(text)) return { kind: 'not_this_act' };
  if (!GROCERY_NAMED_CUE_RE.test(text)) return { kind: 'not_this_act' };
  const unique = uniquePositions(collectNamedCollectionPositionHits(text));
  if (unique.length === 0) return { kind: 'not_this_act' };
  if (unique.length > 1) return { kind: 'ambiguous' };
  return { kind: 'position', n: unique[0] };
}
