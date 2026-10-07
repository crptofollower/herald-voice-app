// src/utils/familyCapture.ts
// Herald family memory CAPTURE — the write twin of familyRead.ts.
// Pure deterministic detector: no LLM, no DB write here. Emits IntentRecord[];
// DOMAIN_WRITERS.family_capture owns the commit + confirm gate.
// Mirrors detectServiceCapture (householdCapture.ts) and detectDiagnosisCapture
// (detectMedicalEvent.ts): read-guard, closed relation vocabulary, high-precision
// single-member patterns, bias to NOT capture on ambiguity.
//
// SCOPE (Build 50, Path B — single member, relation + name ONLY):
//   - LOCATION: a single "lives/moved/stays in <Place>" city is attached when
//     the place is in the utterance. Occupation and other predicates are not
//     family_capture fields and are left unstored.
//   - COMPOUND DEFERRED (50b): "two sons", name-lists, and two-relation
//     utterances BAIL (return []) rather than half-capture one member — a
//     recoverable miss, never a silent drop (Spine §5). Compound also needs the
//     all-members reader (familyRead.ts) wired live first.

import type { IntentRecord } from '../hooks/llmLayers';

// Closed relation vocabulary — aligned with familyRead.ts FAMILY_RELATION_WORD and
// the tierRouter inline read branch so a captured relation is read-backable live.
// Stored verbatim-lowercased; readers expand synonyms on their side.
const FAMILY_RELATIONS = [
  'wife', 'husband', 'spouse', 'partner',
  'son', 'daughter', 'child',
  'mom', 'mother', 'dad', 'father',
  'brother', 'sister',
  'grandson', 'granddaughter', 'grandmother', 'grandfather', 'grandma', 'grandpa',
  'mother-in-law', 'father-in-law', 'son-in-law', 'daughter-in-law',
];
const REL = FAMILY_RELATIONS.map(r => r.replace(/-/g, '\\-')).join('|');

// Filler / hesitation words that can sit between the connector ("is" / "name is")
// and the real name in ordinary speech: "my wife's name is ALSO Shannon",
// "my son is JUST David". Skipped inline in the name patterns below so the real
// name is captured, never the filler. Closed set — mirrors detectMedicalEvent's
// DRUG_FILLER_WORDS lookahead. Defers (never mis-captures) when nothing real
// follows; PLACEHOLDER_NAMES is the backstop for that case.
const NAME_FILLER = 'also|actually|really|just|now|uh|um|named';
const SKIP = `(?:(?:${NAME_FILLER})\\s+)*`;

// Read-guard: never fire on a question (defense-in-depth; the live read branch
// catches these upstream). Mirrors detectServiceCapture's guard.
const READ_GUARD =
  /\b(who('s| is| are)|what('s| is)|where('s| is)|do you (know|have)|tell me|show me|when)\b/i;

// Placeholder / non-name tokens — mirrors householdCapture's name guard.
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'unnamed', 'none', 'n/a', 'someone', 'somebody',
  'that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them',
  'lives', 'live', 'lived', 'living', 'works', 'work', 'working',
  'is', 'was', 'in', 'name', 'named', 'and',
  'also', 'actually', 'really', 'just', 'now', 'uh', 'um',
]);
function isRealName(v: string | undefined | null): v is string {
  if (!v) return false;
  const t = v.trim();
  if (t.length < 2) return false;
  if (PLACEHOLDER_NAMES.has(t.toLowerCase())) return false;
  if (!/^[A-Za-z][A-Za-z'\-]*$/.test(t)) return false; // single name-shaped token
  return true;
}

/** Residence only. "works in advertising" is not a place and is not captured.
 *  A trailing sentence mark is not part of the place. An internal period stays. */
/** A trailing period stays when it completes an initialism (L.A., D.C.). A period after a full word is a sentence mark. */
function spokenPlace(rawPlace: string): string {
  const place = rawPlace.trim();
  if (!/[.!?]$/.test(place)) return place;
  const stripped = place.replace(/[.!?]+$/g, '').trim();
  const last = stripped.split(/\s+/).pop() ?? '';
  const runs = last.split(/[^A-Za-z]+/).filter(Boolean);
  if (/\.$/.test(place) && runs.length > 0 && runs.every((run) => run.length <= 2) && last.includes('.')) {
    return `${stripped}.`;
  }
  return stripped;
}

export function extractResidence(raw: string): string | undefined {
  const m = raw.match(/\b(?:lives?|moved|stays?)\s+in\s+([A-Z][A-Za-z.'’-]*(?:\s+[A-Z][A-Za-z.'’-]*){0,3})/);
  const place = m?.[1] ? spokenPlace(m[1]) : undefined;
  if (!place) return undefined;
  if (FAMILY_RELATIONS.includes(place.toLowerCase())) return undefined;
  if (PLACEHOLDER_NAMES.has(place.toLowerCase())) return undefined;
  return place;
}

export function detectFamilyCapture(text: string): IntentRecord[] {
  const raw = text.trim();
  if (!raw) return [];
  if (READ_GUARD.test(raw)) return [];

  // Compound → defer to 50b. Never half-capture.
  const countCompound = new RegExp(`\\b(two|three|four|five|both|couple of|a couple of)\\s+(?:${REL})s?\\b`, 'i');
  const dualRelation  = new RegExp(`\\bmy\\s+(?:${REL})\\b[^.?]*\\band\\s+my\\s+(?:${REL})\\b`, 'i');
  const nameListPair = raw.match(
    new RegExp(`\\bmy\\s+(?:${REL})s?\\b[^.?]*\\b([A-Za-z][A-Za-z'\\-]+)\\s+and\\s+([A-Za-z][A-Za-z'\\-]+)`, 'i'),
  );
  const nameList = !!(
    nameListPair
    && isRealName(nameListPair[1])
    && isRealName(nameListPair[2])
    && !FAMILY_RELATIONS.includes(nameListPair[1].toLowerCase())
    && !FAMILY_RELATIONS.includes(nameListPair[2].toLowerCase())
  );
  // Have-form compound: "I have a son named Hunter and another son named Grant"
  // — none of the three guards above catch this shape (no "my", no count word).
  // Two relation words joined by "and" inside one have-sentence → bail, never
  // half-capture (Spine §5: a recoverable miss, never a silent drop).
  const haveCompound = new RegExp(`\\bI\\s+have\\b[^.?]*\\b(?:${REL})\\b[^.?]*\\band\\b[^.?]*\\b(?:${REL})\\b`, 'i');
  // Same-relation named list: "I have two sons named Grant and Hunter"
  // and "I have two sons, one named Grant and one named Hunter".
  const haveNamedMany = raw.match(
    new RegExp(
      `\\bI\\s+have\\s+(?:(?:a|another|two|three|four|five|both|couple of|a couple of)\\s+)?(${REL})s?(?:\\s*,\\s*one\\s+named\\s+|\\s+named\\s+)(.+)`,
      'i',
    ),
  );
  if (haveNamedMany) {
    const relation = haveNamedMany[1].trim().toLowerCase();
    const names = haveNamedMany[2]
      .split(/\s*,\s*|\s+and\s+/i)
      .map((s) => s.replace(/^(?:one\s+named\s+)/i, '').trim())
      .filter((s) => isRealName(s) && !FAMILY_RELATIONS.includes(s.toLowerCase()));
    if (names.length >= 2) {
      return names.map((name) => ({ type: 'family_capture' as const, relation, name }));
    }
  }
  if (countCompound.test(raw) || dualRelation.test(raw) || nameList) return [];
  if (haveCompound.test(raw)) return [];

  // Single-member patterns — most specific first. Name is one token.
  const patterns: Array<{ re: RegExp; rel: number; name: number }> = [
    { re: new RegExp(`\\bmy\\s+(${REL})'?s\\s+name\\s+is\\s+${SKIP}([A-Za-z][A-Za-z'\\-]+)`, 'i'), rel: 1, name: 2 },
    { re: new RegExp(`\\bI\\s+have\\s+(?:a|another)\\s+(${REL})\\s+named\\s+${SKIP}([A-Za-z][A-Za-z'\\-]+)`, 'i'), rel: 1, name: 2 },
    { re: new RegExp(`\\bmy\\s+(${REL})\\s+is\\s+${SKIP}([A-Za-z][A-Za-z'\\-]+)`, 'i'), rel: 1, name: 2 },
    { re: new RegExp(`\\bmy\\s+(${REL})\\s+([A-Za-z][A-Za-z'\\-]+)\\s+(?:lives?|is|works|moved|stays?)\\b`, 'i'), rel: 1, name: 2 },
    { re: new RegExp(`\\bmy\\s+(${REL})\\b[^.?]*\\bname\\s+is\\s+${SKIP}([A-Za-z][A-Za-z'\\-]+)`, 'i'), rel: 1, name: 2 },
    { re: new RegExp(`\\bmy\\s+(${REL})\\s+([A-Za-z][A-Za-z'\\-]+)\\s*[.!?]?$`, 'i'), rel: 1, name: 2 },
  ];

  for (const { re, rel, name } of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const relation = m[rel]?.trim().toLowerCase();
    const nm = m[name]?.trim();
    if (!relation) continue;
    if (!isRealName(nm)) continue;
    if (FAMILY_RELATIONS.includes(nm.toLowerCase())) continue; // "my son daughter" → skip
    const location = extractResidence(raw);
    return [{ type: 'family_capture', relation, name: nm, ...(location ? { location } : {}) }];
  }
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sameFamilyToken(a: string | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A period ends the clause only when it starts the next sentence.
 *  A period glued to the next letter (L.A., D.C.) or after a 1–2 letter token (Ft. Worth, St. Louis) stays inside the place. */
function periodEndsClause(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next && /[A-Za-z]/.test(next)) return false;
  const word = text.slice(0, index).match(/[A-Za-z]+$/);
  if (word && word[0].length <= 2) return false;
  return true;
}

/** The member's own clause. Stops at the next sentence boundary or "and". */
function clauseForMember(raw: string, relation: string, name: string): string | undefined {
  const re = new RegExp(`\\bmy\\s+${escapeRegExp(relation)}\\s+${escapeRegExp(name)}\\b`, 'i');
  const found = re.exec(raw);
  if (!found) return undefined;
  const rest = raw.slice(found.index);
  const boundary = /[;?!]|\band\b|\./gi;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(rest)) !== null) {
    if (match[0] === '.' && !periodEndsClause(rest, match.index)) continue;
    end = match.index;
    break;
  }
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Residence is accepted only when deterministic capture yields exactly one
 * member, that member is the person being confirmed, and the place sits in
 * that member's own clause. A city later in the sentence is not theirs.
 */
export function residenceForCapturedMember(rawPhrase: string, name: string, relation: string): string | undefined {
  const captures = detectFamilyCapture(rawPhrase);
  if (captures.length !== 1) return undefined;
  const only = captures[0];
  if (only.type !== 'family_capture') return undefined;
  if (!sameFamilyToken(only.name, name) || !sameFamilyToken(only.relation, relation)) return undefined;
  const clause = clauseForMember(rawPhrase, only.relation, only.name);
  if (!clause) return undefined;
  return extractResidence(clause);
}
