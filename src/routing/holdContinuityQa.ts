// Hold Continuity Q&A V1 — read-only preference answers from live interpretation holds.
// Explicit my <kin> wins. Unique she/he bind is a read-side fallback over live
// preference-hold subjects only. No SQLite, pending, writer, promotion, or TTL refresh.

import { FAMILY_SYNONYMS } from '../utils/familyRead';
import type { InterpretationHoldSlot } from './discourseContinuity';
import type { AdmittedMultiFactCandidate } from './naturalMultiFactInterpretation';

export type HoldContinuityQuestion =
  | { kind: 'not_question' }
  | { kind: 'preference'; subject: string; category?: string }
  | { kind: 'preference_pronoun'; gender: 'feminine' | 'masculine'; category?: string };

export type HoldContinuityMatch =
  | { kind: 'not_question' }
  | { kind: 'no_match' }
  | { kind: 'ambiguous' }
  | { kind: 'answer'; subject: string; value: string; response: string };

const FAMILY_KEYS = Object.keys(FAMILY_SYNONYMS).sort((a, b) => b.length - a.length);
const REL_ALT = FAMILY_KEYS.map((k) => k.replace(/-/g, '[- ]')).join('|');

const FEMININE_FAMILY = new Set([
  'wife', 'mother', 'mom', 'sister', 'daughter', 'grandmother', 'grandma',
  'mother-in-law', 'daughter-in-law', 'granddaughter',
]);
const MASCULINE_FAMILY = new Set([
  'husband', 'father', 'dad', 'brother', 'son', 'grandfather', 'grandpa',
  'father-in-law', 'son-in-law', 'grandson',
]);

const DOES_LIKE_RE = new RegExp(
  `^\\s*what(?:\\s+([A-Za-z]+))?\\s+does\\s+my\\s+(${REL_ALT})\\s+(?:like|love|prefer)\\b`,
  'i',
);
const FAVORITE_RE = new RegExp(
  `^\\s*what(?:'s|\\s+is)\\s+my\\s+(${REL_ALT})'?s\\s+favorite(?:\\s+([A-Za-z]+))?\\b`,
  'i',
);
const DOES_LIKE_PRONOUN_RE = new RegExp(
  `^\\s*what(?:\\s+([A-Za-z]+))?\\s+does\\s+(she|he)\\s+(?:like|love|prefer)\\b`,
  'i',
);
const FAVORITE_PRONOUN_RE = new RegExp(
  `^\\s*what(?:'s|\\s+is)\\s+(her|his)\\s+favorite(?:\\s+([A-Za-z]+))?\\b`,
  'i',
);

const CLOSED_CATEGORY = new Set([
  'name', 'names', 'number', 'phone', 'address', 'age', 'birthday',
]);

function canonicalFamilyKey(raw: string): string | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return FAMILY_KEYS.find((k) => k === t);
}

function inspectablePreferences(hold: InterpretationHoldSlot | null): AdmittedMultiFactCandidate[] {
  if (!hold) return [];
  return hold.candidates.filter(
    (c) =>
      c.kind === 'preference'
      && c.disposition === 'hold'
      && typeof c.subject === 'string'
      && c.subject.trim().length > 0
      && typeof c.value === 'string'
      && c.value.trim().length > 0,
  );
}

function pronounGenderOf(token: string): 'feminine' | 'masculine' | undefined {
  const t = token.trim().toLowerCase();
  if (t === 'she' || t === 'her') return 'feminine';
  if (t === 'he' || t === 'his') return 'masculine';
  return undefined;
}

function uniqueCompatibleHoldSubjects(
  candidates: AdmittedMultiFactCandidate[],
  gender: 'feminine' | 'masculine',
): string[] {
  const allowed = gender === 'feminine' ? FEMININE_FAMILY : MASCULINE_FAMILY;
  const seen = new Set<string>();
  const subjects: string[] = [];
  for (const c of candidates) {
    const subject = (c.subject ?? '').trim().toLowerCase();
    if (!allowed.has(subject) || seen.has(subject)) continue;
    seen.add(subject);
    subjects.push(subject);
  }
  return subjects;
}

function pronounFor(subject: string): { pronoun: string; verb: string } {
  if (FEMININE_FAMILY.has(subject)) return { pronoun: 'she', verb: 'likes' };
  if (MASCULINE_FAMILY.has(subject)) return { pronoun: 'he', verb: 'likes' };
  return { pronoun: 'they', verb: 'like' };
}

function formatPreferenceAnswer(subject: string, value: string): string {
  const { pronoun, verb } = pronounFor(subject);
  return `You said ${pronoun} ${verb} ${value}.`;
}

export function classifyHoldContinuityPreferenceQuestion(utterance: string): HoldContinuityQuestion {
  const t = utterance.trim();
  if (!t) return { kind: 'not_question' };
  if (/\blooks?\s+like\b/i.test(t)) return { kind: 'not_question' };
  if (/\bwhat\s+did\s+i\b/i.test(t)) return { kind: 'not_question' };

  const doesLike = t.match(DOES_LIKE_RE);
  if (doesLike) {
    const subject = canonicalFamilyKey(doesLike[2] ?? '');
    if (!subject) return { kind: 'not_question' };
    const categoryRaw = doesLike[1]?.trim().toLowerCase();
    if (categoryRaw && CLOSED_CATEGORY.has(categoryRaw)) return { kind: 'not_question' };
    return categoryRaw
      ? { kind: 'preference', subject, category: categoryRaw }
      : { kind: 'preference', subject };
  }

  const favorite = t.match(FAVORITE_RE);
  if (favorite) {
    const subject = canonicalFamilyKey(favorite[1] ?? '');
    if (!subject) return { kind: 'not_question' };
    const categoryRaw = favorite[2]?.trim().toLowerCase();
    if (categoryRaw && CLOSED_CATEGORY.has(categoryRaw)) return { kind: 'not_question' };
    return categoryRaw
      ? { kind: 'preference', subject, category: categoryRaw }
      : { kind: 'preference', subject };
  }

  const doesPronoun = t.match(DOES_LIKE_PRONOUN_RE);
  if (doesPronoun) {
    const gender = pronounGenderOf(doesPronoun[2] ?? '');
    if (!gender) return { kind: 'not_question' };
    const categoryRaw = doesPronoun[1]?.trim().toLowerCase();
    if (categoryRaw && CLOSED_CATEGORY.has(categoryRaw)) return { kind: 'not_question' };
    return categoryRaw
      ? { kind: 'preference_pronoun', gender, category: categoryRaw }
      : { kind: 'preference_pronoun', gender };
  }

  const favoritePronoun = t.match(FAVORITE_PRONOUN_RE);
  if (favoritePronoun) {
    const gender = pronounGenderOf(favoritePronoun[1] ?? '');
    if (!gender) return { kind: 'not_question' };
    const categoryRaw = favoritePronoun[2]?.trim().toLowerCase();
    if (categoryRaw && CLOSED_CATEGORY.has(categoryRaw)) return { kind: 'not_question' };
    return categoryRaw
      ? { kind: 'preference_pronoun', gender, category: categoryRaw }
      : { kind: 'preference_pronoun', gender };
  }

  return { kind: 'not_question' };
}

function uniqueValues(candidates: AdmittedMultiFactCandidate[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const c of candidates) {
    const key = c.value.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(c.value.trim());
  }
  return values;
}

function matchesCategory(value: string, category: string | undefined): boolean {
  if (!category) return true;
  return value.toLowerCase().includes(category.toLowerCase());
}

export function matchHoldContinuityQa(
  utterance: string,
  holdSet: InterpretationHoldSlot | null,
): HoldContinuityMatch {
  const question = classifyHoldContinuityPreferenceQuestion(utterance);
  if (question.kind === 'not_question') return { kind: 'not_question' };

  const inspectable = inspectablePreferences(holdSet);
  let subject: string | undefined;
  if (question.kind === 'preference') {
    subject = question.subject;
  } else {
    const compatible = uniqueCompatibleHoldSubjects(inspectable, question.gender);
    if (compatible.length !== 1) return { kind: 'no_match' };
    subject = compatible[0];
  }

  const prefs = inspectable.filter(
    (c) => (c.subject ?? '').trim().toLowerCase() === subject,
  );
  if (prefs.length === 0) return { kind: 'no_match' };

  const values = uniqueValues(prefs);
  if (values.length === 1) {
    const value = values[0];
    return {
      kind: 'answer',
      subject,
      value,
      response: formatPreferenceAnswer(subject, value),
    };
  }

  if (question.category) {
    const categoryHits = prefs.filter((c) => matchesCategory(c.value, question.category));
    const categoryValues = uniqueValues(categoryHits);
    if (categoryValues.length === 1) {
      const value = categoryValues[0];
      return {
        kind: 'answer',
        subject,
        value,
        response: formatPreferenceAnswer(subject, value),
      };
    }
  }

  return { kind: 'ambiguous' };
}

export function answerHoldContinuityQa(
  utterance: string,
  holdSet: InterpretationHoldSlot | null,
): string | null {
  const match = matchHoldContinuityQa(utterance, holdSet);
  return match.kind === 'answer' ? match.response : null;
}
