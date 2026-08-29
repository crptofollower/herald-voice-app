// Ordered Presentation Reference V1 — RAM ordered IDs + deterministic positions.
// Sibling to MedicationPresentationHolder and ConversationalSubjectHolder.
// Identity/reference only. No item bodies. No domain truth. RAM only.

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

// Mutation/action language — grocery read-back must not consume these.
const POSITION_MUTATION_RE =
  /\b(?:remove|delete|cross(?:\s+off)?|take\s+off|got|picked\s+up|grabbed|bought|completed?|finished|done\s+with)\b/i;

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

function parseOrdinalOrNth(raw: string): number | null {
  return ordinalWordToNumber(raw) ?? parseNumericOrdinal(raw);
}

function positiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Full-utterance cued list-position parse. Requires a slot cue
 * (one / item / number / #). Does not steal bare dates, doses, or times.
 */
export function parseCuedListPositions(text: string): number[] | null {
  if (POSITION_MUTATION_RE.test(text)) return null;
  const t = text.trim();
  if (!t) return null;

  const hash = t.match(/^\s*#\s*(\d+)\s*[?.!]?\s*$/i);
  if (hash) {
    const n = positiveInt(hash[1]);
    return n == null ? null : [n];
  }

  const numbered = t.match(
    /^\s*(?:(?:the|that)\s+)?(?:number|item)\s+(\d+)\s*[?.!]?\s*$/i,
  );
  if (numbered) {
    const n = positiveInt(numbered[1]);
    return n == null ? null : [n];
  }

  const numbersList = t.match(
    /^\s*numbers?\s+(\d+(?:\s*,\s*\d+)*(?:\s*,?\s*and\s+\d+)?)\s*[?.!]?\s*$/i,
  );
  if (numbersList) {
    const out: number[] = [];
    for (const piece of numbersList[1].match(/\d+/g) ?? []) {
      const n = positiveInt(piece);
      if (n == null) return null;
      out.push(n);
    }
    return out.length > 0 ? out : null;
  }

  const stripped = t.replace(/^\s*(?:tell\s+me(?:\s+about)?\s+)/i, '');
  const oneCue = stripped.match(
    /^\s*(?:(?:the|that)\s+)?(.+?)\s+one\s*[?.!]?\s*$/i,
  );
  if (oneCue) {
    const n = parseOrdinalOrNth(oneCue[1]);
    return n == null ? null : [n];
  }

  return null;
}

function extractLooseCuedPosition(text: string): number | null {
  const hash = text.match(/#\s*(\d+)/);
  if (hash) return positiveInt(hash[1]);

  const numbered = text.match(/\b(?:number|item)\s+(\d+)\b/i);
  if (numbered) return positiveInt(numbered[1]);

  const oneCue = text.match(/\b(?:the|that)\s+(.+?)\s+one\b/i);
  if (oneCue) return parseOrdinalOrNth(oneCue[1]);

  return null;
}

/** Exact grocery read/select continuation. Single position only. */
export function parseGroceryReadPosition(text: string): number | null {
  const positions = parseCuedListPositions(text);
  if (positions == null || positions.length !== 1) return null;
  return positions[0];
}

/**
 * Position-shaped but not an exact grocery read-back.
 * Requires a real slot cue and a parseable ordinal/number — not "the red one"
 * and not bare "the 23rd".
 */
export function isGroceryPositionNearMiss(text: string): boolean {
  if (parseGroceryReadPosition(text) != null) return false;
  if (POSITION_MUTATION_RE.test(text)) return false;
  return extractLooseCuedPosition(text) != null;
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
