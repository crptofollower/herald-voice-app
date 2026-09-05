// Bounded unmarked acquisition shape + structural list continuation.
// Reuses the existing acquisition/grocery-marker split. Not a grocery dictionary.
// Shape is not semantic domain evidence.

import { detectMedicalEvent } from '../utils/detectMedicalEvent';
import { boundCapturedTail, LIST_ADD_SIGNALS } from '../utils/instructionSignals';

/** Same acquisition family as the existing grocery-marker grocery path. */
export const OPERATIONAL_ACQUISITION_SHAPE =
  /\b(?:need\s+to|have\s+to|gotta|got\s+to|going\s+to|gonna|want\s+to|wanna)\s+(?:go\s+(?:to\s+(?:the\s+)?(?:grocery\s+store|supermarket|grocery|store|shop|market)\s+(?:and\s+)?)?)?(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\b/i;

export const GROCERY_CONTEXT_MARKER =
  /\b(?:grocery|groceries|grocery\s+store|supermarket|shopping\s+list)\b/i;

export function isUnmarkedAcquisitionShape(text: string): boolean {
  return OPERATIONAL_ACQUISITION_SHAPE.test(text) && !GROCERY_CONTEXT_MARKER.test(text);
}

/** Same comma/"and" splitter as existing list_add / grocery acquisition. */
const LIST_SEGMENT_SPLIT_RE = /\s*,\s*|\s+and\s+/i;

const FIRST_PERSON_CLAUSE_RE = /\b(?:I|we)\b/;
const EMBEDDED_CLAUSE_RE =
  /\b(?:that|which|who|whom|because|but|while|when|where|if|then)\b/i;
const INFINITIVE_OR_AUX_RE =
  /\b(?:to\s+[a-z]{2,}|is|are|was|were|be|been|being|has|have|had)\b/i;
const DATE_TIME_DOSE_RE =
  /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|this (?:morning|afternoon|evening)|at \d|by \d|\d+\s*(?:am|pm)|later)\b|\b\d+\s*(?:mg|mcg|ml)\b|\bat\s+\d{1,2}(?::\d{2})?\b|\b\d{1,2}:\d{2}\b/i;

function captureUnmarkedAcquisitionTail(text: string): string | null {
  if (!isUnmarkedAcquisitionShape(text)) return null;
  const m = text.match(/\b(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\s+(.+)/i);
  let raw = boundCapturedTail((m?.[1] ?? '').trim());
  raw = raw
    .replace(/\s+(?:from|at)\s+(?:the\s+)?(?:grocery\s+store|grocery|groceries|supermarket|store|market|shopping)\b.*$/i, '')
    .replace(/\s+(?:today|tonight|tomorrow|later|this\s+(?:morning|afternoon|evening|week)|next\s+week|at\s+\d.*|by\s+\d.*|\d+\s*(?:am|pm))\b.*$/i, '')
    .trim();
  return raw.length > 0 ? raw : null;
}

export function splitCapturedTailSegments(raw: string): string[] {
  return raw
    .split(LIST_SEGMENT_SPLIT_RE)
    .map((s) => s.replace(/[.!?]+$/g, '').trim())
    .filter((s) => s.length > 0);
}

/** Structural NP check. Not a grocery-word dictionary. */
export function isSimpleBareNounPhrase(segment: string): boolean {
  const s = segment.trim();
  if (!s || s.length > 48) return false;
  if (FIRST_PERSON_CLAUSE_RE.test(s)) return false;
  if (EMBEDDED_CLAUSE_RE.test(s)) return false;
  if (INFINITIVE_OR_AUX_RE.test(s)) return false;
  if (DATE_TIME_DOSE_RE.test(s)) return false;
  if (/\d/.test(s)) return false;
  if (!/^[A-Za-z][A-Za-z'\s-]*$/.test(s)) return false;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > 4) return false;
  const last = tokens[tokens.length - 1].toLowerCase();
  if (/(?:ed|en)$/.test(last) && last.length >= 5) return false;
  return true;
}

/**
 * Narrow deferral: unmarked acquisition whose captured tail is 2+ simple
 * bare noun phrases. Shape is not grocery meaning.
 */
export function isAmbiguousOperationalListAcquisition(text: string): boolean {
  if (detectMedicalEvent(text)) return false;
  const tail = captureUnmarkedAcquisitionTail(text);
  if (!tail) return false;
  const segments = splitCapturedTailSegments(tail);
  if (segments.length < 2) return false;
  return segments.every(isSimpleBareNounPhrase);
}

/** Object span already present after pick up/get/buy/grab. Not a domain guess. */
export function extractAmbiguousAcquisitionObject(text: string): string | null {
  return captureUnmarkedAcquisitionTail(text);
}

export function formatOperationalListClarification(extracted: string): string {
  const item = extracted.trim();
  if (!item) return 'Did you want that on your grocery list, or as a to-do?';
  return `Did you want ${item} on your grocery list, or as a to-do?`;
}

/** Structural "add X too/also" continuation. Does not name a list or item ID. */
export function parseOperationalListContinuationAdd(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return null;
  const m =
    t.match(/^\s*(?:please\s+)?add\s+(.+?)\s+(?:too|also)\s*[.!?]*\s*$/i)
    ?? t.match(/^\s*(?:please\s+)?(?:also|too)\s+add\s+(.+?)\s*[.!?]*\s*$/i);
  const item = boundCapturedTail((m?.[1] ?? '').trim());
  return item.length > 0 ? item : null;
}
