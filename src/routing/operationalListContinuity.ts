// Bounded unmarked acquisition shape + structural list continuation.
// Reuses the existing acquisition/grocery-marker split. Not a grocery dictionary.
// Shape is not semantic domain evidence.

import { detectMedicalEvent } from '../utils/detectMedicalEvent';
import { boundCapturedTail, LIST_ADD_SIGNALS } from '../utils/instructionSignals';

/** Same acquisition family as the existing grocery-marker grocery path. */
/** Modal/obligation family already embedded in OPERATIONAL_ACQUISITION_SHAPE. */
export const OBLIGATION_MODAL_FAMILY =
  /\b(?:need\s+to|have\s+to|gotta|got\s+to|going\s+to|gonna|want\s+to|wanna)\b/i;

export const OPERATIONAL_ACQUISITION_SHAPE =
  /\b(?:need\s+to|have\s+to|gotta|got\s+to|going\s+to|gonna|want\s+to|wanna)\s+(?:go\s+(?:to\s+(?:the\s+)?(?:grocery\s+store|supermarket|grocery|store|shop|market)\s+(?:and\s+)?)?)?(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\b/i;

/** Clause-initial pick up/get/buy/grab. Same verbs as the modal family; no new inventory. */
export const IMPERATIVE_ACQUISITION_SHAPE =
  /^\s*(?:please\s+)?(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\b/i;

const CAMERA_GRAB_RE = /\b(?:take|snap|grab)\s+a\s+(?:picture|photo|photograph|pic)\b/i;

/** Closed clarification pending key. Not confirmation (`llm_confirm:*`). */
export const CLARIFY_OPERATIONAL_LIST_KEY = 'clarify:operational_list';

export function isClarificationPendingKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith('clarify:');
}

export const GROCERY_CONTEXT_MARKER =
  /\b(?:grocery|groceries|grocery\s+store|supermarket|shopping\s+list)\b/i;

export function isUnmarkedAcquisitionShape(text: string): boolean {
  if (GROCERY_CONTEXT_MARKER.test(text) || CAMERA_GRAB_RE.test(text)) return false;
  return OPERATIONAL_ACQUISITION_SHAPE.test(text) || IMPERATIVE_ACQUISITION_SHAPE.test(text);
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

function normalizeAcquisitionTail(rawInput: string): string {
  let raw = boundCapturedTail(rawInput.trim());
  raw = raw
    .replace(/\s+(?:from|at)\s+(?:the\s+)?(?:grocery\s+store|grocery|groceries|supermarket|store|market|shopping)\b.*$/i, '')
    .replace(/\s+(?:today|tonight|tomorrow|later|this\s+(?:morning|afternoon|evening|week)|next\s+week|at\s+\d.*|by\s+\d.*|\d+\s*(?:am|pm))\b.*$/i, '')
    .trim();
  return raw;
}

function captureUnmarkedAcquisitionTail(text: string): string | null {
  if (!isUnmarkedAcquisitionShape(text)) return null;
  const m = text.match(/\b(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\s+(.+)/i);
  const raw = normalizeAcquisitionTail(m?.[1] ?? '');
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
  if (!/^[A-Za-z0-9%][A-Za-z0-9%'\s-]*$/.test(s)) return false;
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

/** Locative/wrapper-initial items are not actionable list bodies. */
const LOCATIVE_WRAPPER_RE = /^(?:at|from|on|in|to|by|near)\b/i;

export function isOperationalListItemShape(item: string): boolean {
  const s = item.trim().replace(/[.!?]+$/g, '');
  if (!s) return false;
  if (LOCATIVE_WRAPPER_RE.test(s)) return false;
  return isSimpleBareNounPhrase(s);
}

export function filterOperationalListItems(items: readonly string[]): string[] {
  return items.map((i) => i.trim()).filter(isOperationalListItemShape);
}

// Grocery Integrity V1 — canonical grocery/list item delimiter normalizer.
//
// This is NOT a general natural-language or conjunction parser. It corrects the
// proven segmentation defects at the writer convergence point using COMMA
// STRUCTURE as the only split evidence:
//
//   1. Oxford comma: ", and " is one delimiter, not a comma delimiter that
//      leaves "and X" glued to the next item — so "milk, bread, and bananas"
//      yields ["milk","bread","bananas"], never ["milk","bread","and bananas"].
//   2. A single element that itself carries a comma-delimited compound
//      (classifier output like ["milk, bread, and bananas"]) becomes independent
//      candidates before persistence.
//
// TRUST BOUND — a BARE embedded "and" is NOT split. Only a comma re-segments an
// incoming item; an "and" is absorbed ONLY when it immediately follows a comma
// (the Oxford case). So a legitimate single item like "peanut butter and jelly"
// or "macaroni and cheese" is preserved intact — user trust outranks symmetry
// with the deterministic upstream path, which is left unchanged. This is a
// structural rule (comma vs. no comma), never a food dictionary or exception list.
//
// A residual LEADING conjunction on a candidate is still stripped, so an
// already-separated pre-split array (["milk","bread","and bananas"]) normalizes
// to ["milk","bread","bananas"] — that leading "and " is an artifact of prior
// segmentation, not an embedded conjunction. Trailing sentence punctuation is
// left intact here — the existing shape filter owns that, unchanged.
const GROCERY_ITEM_DELIMITER_RE = /\s*,\s*(?:and\s+)?/i;
const LEADING_CONJUNCTION_RE = /^(?:and|&)\s+/i;

export function segmentGroceryListItems(items: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    for (const piece of raw.split(GROCERY_ITEM_DELIMITER_RE)) {
      const cleaned = piece.replace(LEADING_CONJUNCTION_RE, '').trim();
      if (cleaned.length > 0) out.push(cleaned);
    }
  }
  return out;
}

/** Writer-boundary normalization: Oxford-safe segmentation FIRST, then the
 *  existing operational shape filter — so deterministic- and classifier-
 *  produced intents reach commit through one identical final normalization. */
export function normalizeGroceryListItems(items: readonly string[]): string[] {
  return filterOperationalListItems(segmentGroceryListItems(items));
}

/** Bounded grocery vs todo resolution. List-type words, not item vocabulary. */
export function parseOperationalDomainResolution(text: string): 'grocery' | 'todo' | 'decline' | null {
  const t = text.trim();
  if (!t) return null;
  const grocery = GROCERY_CONTEXT_MARKER.test(t);
  const todo = /\b(?:to-?do|todos?|tasks?)\b/i.test(t);
  if (grocery && !todo) return 'grocery';
  if (todo && !grocery) return 'todo';
  return null;
}

const CLARIFICATION_QUESTION_OPEN_RE =
  /^(?:what|what's|whats|how|when|where|who|why|is|are|do|does|did|can|could)\b/i;

/**
 * Answer-only grocery/todo fill for clarify:operational_list.
 * Questions and read shapes must not authorize the missing domain input.
 */
export function parseClarificationDomainAnswer(text: string): 'grocery' | 'todo' | null {
  const t = text.trim();
  if (!t) return null;
  if (CLARIFICATION_QUESTION_OPEN_RE.test(t) || /[?]$/.test(t)) return null;
  const resolution = parseOperationalDomainResolution(t);
  if (resolution === 'grocery' || resolution === 'todo') return resolution;
  return null;
}

/** Structural trailing-addition: too / also / as well. Optional can-you / to-that. */
export function parseOperationalListContinuationAdd(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return null;
  const additive = '(?:too|also|as well)';
  const m =
    t.match(new RegExp(
      `^\\s*(?:(?:can|could)\\s+you\\s+)?(?:please\\s+)?add\\s+(.+?)(?:\\s+to\\s+(?:that|it))?\\s+${additive}\\s*[.!?]*\\s*$`,
      'i',
    ))
    ?? t.match(new RegExp(
      `^\\s*(?:(?:can|could)\\s+you\\s+)?(?:please\\s+)?${additive}\\s+add\\s+(.+?)\\s*[.!?]*\\s*$`,
      'i',
    ));
  const item = boundCapturedTail((m?.[1] ?? '').trim());
  return item.length > 0 ? item : null;
}

export function extractNarrativeOperationalCandidates(text: string): string[] | null {
  const t = text.trim();
  if (!t) return null;
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return null;
  if (detectMedicalEvent(t)) return null;
  const span =
    extractAmbiguousAcquisitionObject(t)
    ?? extractNeedWithoutInfinitiveSpan(t)
    ?? extractBareCoordinatedSpan(t);
  if (!span) return null;
  const items = splitCapturedTailSegments(span).filter(isOperationalListItemShape);
  if (items.length < 2 || items.length > 5) return null;
  return items;
}

/** First-person need/want of items, including embedded I/we need — not infinitive `need to`. */
function extractNeedWithoutInfinitiveSpan(text: string): string | null {
  const m = boundCapturedTail(text).match(/\b(?:I|we)\s+(?:need|want)\s+(?!to\b)(.+)$/i);
  const span = m?.[1]?.trim();
  return span && span.length > 0 ? span : null;
}

function extractBareCoordinatedSpan(text: string): string | null {
  const t = boundCapturedTail(text.trim().replace(/[.!?]+$/g, ''));
  const items = splitCapturedTailSegments(t);
  if (items.length >= 2 && items.length <= 5 && items.every(isOperationalListItemShape)) return t;
  return null;
}

export type CandidateSetReferentResult =
  | { kind: 'none' }
  | { kind: 'unsafe' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; items: string[] };

const CANDIDATE_DEMONSTRATIVE_RE = /\b(?:these|those|them|that|this)\b/i;
const CANDIDATE_COUNT_RE = /\b(two|three|four|five|2|3|4|5)\b/i;
const ADD_SHAPED_DEMONSTRATIVE_RE =
  /^\s*(?:(?:can|could)\s+you\s+)?(?:please\s+)?add\b/i;

function parseSmallCount(raw: string): number | null {
  const t = raw.toLowerCase();
  if (t === 'two' || t === '2') return 2;
  if (t === 'three' || t === '3') return 3;
  if (t === 'four' || t === '4') return 4;
  if (t === 'five' || t === '5') return 5;
  return null;
}

export function isAddShapedOperationalDemonstrative(text: string): boolean {
  return ADD_SHAPED_DEMONSTRATIVE_RE.test(text.trim());
}

/** Closed unresolved pro-forms that cannot themselves be a durable list value. */
const BARE_UNRESOLVED_LIST_REFERENT_RE = /^(?:this|that|these|those|them|it)$/i;

export const UNRESOLVED_LIST_REFERENT_REASON = 'unresolved_list_referent';

export function isBareUnresolvedListReferent(item: string): boolean {
  const s = item.trim().replace(/[.!?]+$/g, '');
  return s.length > 0 && BARE_UNRESOLVED_LIST_REFERENT_RE.test(s);
}

export function unresolvedListReferentPrompt(listName?: string): string {
  const n = (listName ?? 'grocery').trim().toLowerCase();
  const label = n === 'todo' || n === 'todos' || n === 'to-do' ? 'to-do' : 'grocery';
  return `What did you want to add to your ${label} list?`;
}

export type ListAddItemAdmission =
  | { kind: 'empty' }
  | { kind: 'unresolved_referent' }
  | { kind: 'grounded'; items: string[] };

/** Admission for list_add candidates. Any bare unresolved referent vetoes the whole set. */
export function admitListAddItemCandidates(items: readonly string[]): ListAddItemAdmission {
  const cleaned = items.map((i) => i.trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return { kind: 'empty' };
  if (cleaned.some(isBareUnresolvedListReferent)) return { kind: 'unresolved_referent' };
  return { kind: 'grounded', items: cleaned };
}

/** Demonstrative against a live candidate set. Count agreement when a count is present. Never guesses. */
export function interpretCandidateSetDemonstrative(
  text: string,
  candidateSet: { items: readonly string[] } | null,
): CandidateSetReferentResult {
  const t = text.trim();
  if (!t) return { kind: 'none' };
  if (!CANDIDATE_DEMONSTRATIVE_RE.test(t)) return { kind: 'none' };
  const items = candidateSet?.items ?? [];
  if (items.length === 0) return { kind: 'none' };
  const countRaw = t.match(CANDIDATE_COUNT_RE)?.[1];
  if (countRaw) {
    const n = parseSmallCount(countRaw);
    if (n == null || n !== items.length) return { kind: 'ambiguous' };
    return { kind: 'resolved', items: [...items] };
  }
  const plural = /\b(?:these|those|them)\b/i.test(t);
  const singular = /\b(?:that|this)\b/i.test(t);
  if (plural && items.length < 2) return { kind: 'ambiguous' };
  if (singular && !plural && items.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'resolved', items: [...items] };
}
