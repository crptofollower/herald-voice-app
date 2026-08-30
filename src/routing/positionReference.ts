// Bounded position-reference interpretation — meaning only.
// Does not grant authority. Does not select IDs or item bodies.

import {
  cardinalWordToNumber,
  ordinalWordToNumber,
  parseNumericOrdinal,
} from './orderedPresentation';

export type PositionObjectNoun = 'one' | 'thing' | 'item' | 'omitted';
export type PositionSurface =
  | 'anaphor'
  | 'number_slot'
  | 'item_slot'
  | 'hash'
  | 'ellipsis';

export type PositionInterpretation =
  | { kind: 'none' }
  | { kind: 'unsafe'; reason: 'mutation' | 'descriptive' | 'date_like' | 'dose' | 'time' }
  | {
      kind: 'ambiguous';
      reason: 'competing_positions' | 'relative' | 'other_anaphor';
      positions: number[];
    }
  | {
      kind: 'position_reference';
      positions: number[];
      surface: PositionSurface;
      objectNoun: PositionObjectNoun | null;
    };

const POSITION_MUTATION_RE =
  /\b(?:remove|delete|cross(?:\s+off)?|take\s+off|got|picked\s+up|grabbed|bought|completed?|finished|done\s+with)\b/i;

const DOSE_RE = /\b\d+\s*mg\b/i;
const TIME_RE = /\bat\s+\d{1,2}(?::\d{2})?\b|\b\d{1,2}:\d{2}\b/i;
const DATE_ON_ORDINAL_RE =
  /\bon\s+the\s+(\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)\b/i;

const RELATIVE_RE =
  /\b(?:the|that)\s+(?:next|previous|last)\s+(?:one|thing|item)?\b|\b(?:next|previous)\s+(?:one|thing|item)\b/i;
const OTHER_ANAPHOR_RE =
  /\bthe\s+other\s+(?:one|thing|item)\b|\banother(?:\s+(?:one|thing|item))?\b|\bany\s+others?\b/i;

const LEADING_FILLER_RE =
  /^(?:(?:okay|ok|yeah|yep|yes|alright|all right|so|wait|um|uh)[,.]?\s+)+/i;

type Hit = {
  n: number;
  surface: PositionSurface;
  objectNoun: PositionObjectNoun | null;
};

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

function uniquePositions(ns: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of ns) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function stripFiller(text: string): string {
  return text.trim().replace(LEADING_FILLER_RE, '');
}

function collectHits(text: string): Hit[] {
  const hits: Hit[] = [];

  for (const m of text.matchAll(/#\s*(\d+)/g)) {
    const n = positiveInt(m[1]);
    if (n != null) hits.push({ n, surface: 'hash', objectNoun: null });
  }

  for (const m of text.matchAll(/\bnumber\s+(\d+|[a-z]+(?:[-\s][a-z]+)?)\b/gi)) {
    const raw = m[1];
    const n = parseSlotValue(raw) ?? parseSlotValue(raw.trim().split(/[-\s]/)[0] ?? '');
    if (n != null) hits.push({ n, surface: 'number_slot', objectNoun: null });
  }

  for (const m of text.matchAll(/\bitem\s+(\d+|[a-z]+(?:[-\s][a-z]+)?)\b/gi)) {
    const raw = m[1];
    const n = parseSlotValue(raw) ?? parseSlotValue(raw.trim().split(/[-\s]/)[0] ?? '');
    if (n != null) hits.push({ n, surface: 'item_slot', objectNoun: 'item' });
  }

  for (const m of text.matchAll(/\b(?:the|that)\s+(.+?)\s+(one|thing|item)\b/gi)) {
    const n = parseOrdinalOrNth(m[1]);
    if (n == null) continue;
    const noun = m[2].toLowerCase() as 'one' | 'thing' | 'item';
    hits.push({ n, surface: 'anaphor', objectNoun: noun });
  }

  const inversion = text.match(
    /\bwhich\s+(?:(one|thing|item)\s+)?was\s+(?:the\s+)?(.+?)\s*[?.!]?\s*$/i,
  );
  if (inversion) {
    const n = parseOrdinalOrNth(inversion[2]);
    if (n != null) {
      const nounRaw = inversion[1]?.toLowerCase();
      const objectNoun: PositionObjectNoun | null =
        nounRaw === 'one' || nounRaw === 'thing' || nounRaw === 'item' ? nounRaw : 'omitted';
      hits.push({ n, surface: 'anaphor', objectNoun });
    }
  }

  const ellipsis = text.match(
    /\b(?:and|how\s+about|what\s+about|what(?:'s|\s+is|\s+was))\s+(?:the|that)\s+(.+?)(?:\s+(?:one|thing|item))?(?:\s+again)?\s*[?.!]?\s*$/i,
  );
  if (ellipsis) {
    const span = ellipsis[1].trim();
    const withNoun = span.match(/^(.*?)\s+(one|thing|item)$/i);
    const ordinalSpan = withNoun ? withNoun[1] : span;
    const n = parseOrdinalOrNth(ordinalSpan);
    if (n != null) {
      const nounRaw = withNoun?.[2]?.toLowerCase();
      const objectNoun: PositionObjectNoun =
        nounRaw === 'one' || nounRaw === 'thing' || nounRaw === 'item' ? nounRaw : 'omitted';
      hits.push({
        n,
        surface: objectNoun === 'omitted' ? 'ellipsis' : 'anaphor',
        objectNoun,
      });
    }
  }

  return hits;
}

function parseWholeUtteranceNumberList(t: string): number[] | null {
  const numbersList = t.match(
    /^\s*numbers?\s+(\d+(?:\s*,\s*\d+)*(?:\s*,?\s*and\s+\d+)?)\s*[?.!]?\s*$/i,
  );
  if (!numbersList) return null;
  const out: number[] = [];
  for (const piece of numbersList[1].match(/\d+/g) ?? []) {
    const n = positiveInt(piece);
    if (n == null) return null;
    out.push(n);
  }
  return out.length > 0 ? out : null;
}

/**
 * Bounded position meaning. Authority grant is decided by the caller.
 */
export function interpretPositionReference(text: string): PositionInterpretation {
  const raw = text.trim();
  if (!raw) return { kind: 'none' };
  if (POSITION_MUTATION_RE.test(raw)) return { kind: 'unsafe', reason: 'mutation' };
  if (DOSE_RE.test(raw)) return { kind: 'unsafe', reason: 'dose' };
  if (TIME_RE.test(raw)) return { kind: 'unsafe', reason: 'time' };

  const t = stripFiller(raw);

  if (RELATIVE_RE.test(t)) {
    return { kind: 'ambiguous', reason: 'relative', positions: [] };
  }
  if (OTHER_ANAPHOR_RE.test(t)) {
    return { kind: 'ambiguous', reason: 'other_anaphor', positions: [] };
  }

  if (DATE_ON_ORDINAL_RE.test(t) && !/\b(?:one|thing|item|number)\b/i.test(t)) {
    return { kind: 'unsafe', reason: 'date_like' };
  }

  const hits = collectHits(t);
  const positions = uniquePositions(hits.map((h) => h.n));

  if (positions.length > 1) {
    return { kind: 'ambiguous', reason: 'competing_positions', positions };
  }

  if (positions.length === 1) {
    const hit = hits.find((h) => h.n === positions[0]) ?? hits[0];
    return {
      kind: 'position_reference',
      positions,
      surface: hit.surface,
      objectNoun: hit.objectNoun,
    };
  }

  const listed = parseWholeUtteranceNumberList(t);
  if (listed && listed.length > 1) {
    return { kind: 'ambiguous', reason: 'competing_positions', positions: uniquePositions(listed) };
  }
  if (listed && listed.length === 1) {
    return {
      kind: 'position_reference',
      positions: listed,
      surface: 'number_slot',
      objectNoun: null,
    };
  }

  return { kind: 'none' };
}
