// Ordered Presentation Reference V1 — RAM ordered IDs + deterministic positions.
// Sibling to MedicationPresentationHolder and ConversationalSubjectHolder.
// Identity/reference only. No item bodies. No domain truth. RAM only.

import { interpretPositionReference, isPositionMutationLanguage } from './positionReference';

export type OrderedPresentationOwner = 'grocery';

export type OrderedPresentationState = {
  owner: OrderedPresentationOwner;
  presentedIds: string[];
  establishedAtTurn: number;
  repairAvailable: boolean;
};

export const ORDERED_PRESENTATION_CONFUSION = `I'm not sure which one you mean.`;
export const GROCERY_POSITION_STALE =
  `I don't see that on your grocery list right now.`;

const ONES_ORDINAL: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
};

const TEENS_ORDINAL: Record<string, number> = {
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
};

const TENS_ORDINAL: Record<string, number> = {
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
};

const TENS_CARDINAL: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const ONES_CARDINAL: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const TEENS_CARDINAL: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

/** Spoken cardinal → 1-based position. Not ordinals (`third`). Not `last`. */
export function cardinalWordToNumber(raw: string): number | null {
  const phrase = raw.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (!phrase || phrase === 'last') return null;
  if (phrase === 'hundred' || phrase === 'one hundred') return 100;

  const simple = ONES_CARDINAL[phrase] ?? TEENS_CARDINAL[phrase] ?? TENS_CARDINAL[phrase];
  if (simple != null) return simple;

  const parts = phrase.split(' ');
  if (parts.length === 2) {
    const tens = TENS_CARDINAL[parts[0]];
    const ones = ONES_CARDINAL[parts[1]];
    if (tens != null && ones != null) return tens + ones;
  }
  return null;
}

/** Word ordinal → 1-based position. `last` is never a position. */
export function ordinalWordToNumber(raw: string): number | null {
  const phrase = raw.trim().toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
  if (!phrase || phrase === 'last') return null;
  if (phrase === 'hundredth' || phrase === 'one hundredth') return 100;

  const simple = ONES_ORDINAL[phrase] ?? TEENS_ORDINAL[phrase] ?? TENS_ORDINAL[phrase];
  if (simple != null) return simple;

  const parts = phrase.split(' ');
  if (parts.length === 2) {
    const tens = TENS_CARDINAL[parts[0]];
    const ones = ONES_ORDINAL[parts[1]];
    if (tens != null && ones != null) return tens + ones;
  }
  return null;
}

export function parseNumericOrdinal(raw: string): number | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)(st|nd|rd|th)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  if (!ordinalSuffixOk(n, m[2])) return null;
  return n;
}

function ordinalSuffixOk(n: number, suffix: string): boolean {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 13) return suffix === 'th';
  if (mod10 === 1) return suffix === 'st';
  if (mod10 === 2) return suffix === 'nd';
  if (mod10 === 3) return suffix === 'rd';
  return suffix === 'th';
}

/**
 * Cued list-position parse. When a single operator is present anywhere in
 * the utterance, returns that position. Whole-utterance `numbers 2, 4, and 5`
 * remains the reserved multi-position form.
 */
export function parseCuedListPositions(text: string): number[] | null {
  if (isPositionMutationLanguage(text)) return null;
  const interpreted = interpretPositionReference(text);
  if (interpreted.kind === 'position_reference') return interpreted.positions;
  if (
    interpreted.kind === 'ambiguous' &&
    interpreted.reason === 'competing_positions' &&
    interpreted.positions.length > 0
  ) {
    return interpreted.positions;
  }
  return null;
}

/** Exact grocery read/select continuation. Single unambiguous position only. */
export function parseGroceryReadPosition(text: string): number | null {
  if (isPositionMutationLanguage(text)) return null;
  const interpreted = interpretPositionReference(text);
  if (interpreted.kind !== 'position_reference') return null;
  if (interpreted.positions.length !== 1) return null;
  return interpreted.positions[0];
}

/**
 * Position-shaped but not a single safe grocery read-back.
 * Competing operators and unsupported relatives stay here. Mutation is never a near-miss.
 */
export function isGroceryPositionNearMiss(text: string): boolean {
  if (isPositionMutationLanguage(text)) return false;
  const interpreted = interpretPositionReference(text);
  return interpreted.kind === 'ambiguous';
}

export type ResolvePositionsResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: 'invalid_position' | 'out_of_range' };

/**
 * Map all 1-based positions onto one frozen ID array before any mutation.
 * Fail closed if any position is invalid. Dedupe IDs, first-seen order.
 */
export function resolvePositions(
  presentedIds: readonly string[],
  positions: readonly number[],
): ResolvePositionsResult {
  if (positions.length === 0) {
    return { ok: false, reason: 'invalid_position' };
  }
  const mapped: string[] = [];
  const seen = new Set<string>();
  for (const n of positions) {
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, reason: 'invalid_position' };
    }
    if (n > presentedIds.length) {
      return { ok: false, reason: 'out_of_range' };
    }
    const id = presentedIds[n - 1];
    if (!seen.has(id)) {
      seen.add(id);
      mapped.push(id);
    }
  }
  return { ok: true, ids: mapped };
}

export class OrderedPresentationHolder {
  private presentation: OrderedPresentationState | null = null;
  private turn = 0;

  beginUserTurn(): void {
    this.turn += 1;
  }

  peek(): OrderedPresentationState | null {
    return this.presentation;
  }

  hasLive(): boolean {
    return this.presentation !== null;
  }

  clear(): void {
    this.presentation = null;
  }

  establish(owner: OrderedPresentationOwner, presentedIds: string[]): void {
    this.presentation = {
      owner,
      presentedIds: [...presentedIds],
      establishedAtTurn: this.turn,
      repairAvailable: true,
    };
  }

  renew(): void {
    if (!this.presentation) return;
    this.presentation = {
      owner: this.presentation.owner,
      presentedIds: this.presentation.presentedIds,
      establishedAtTurn: this.turn,
      repairAvailable: true,
    };
  }

  consumeRepair(): void {
    if (!this.presentation) return;
    this.presentation = {
      ...this.presentation,
      repairAvailable: false,
    };
  }
}
