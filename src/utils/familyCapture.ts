// src/utils/familyCapture.ts
// Herald family memory CAPTURE — the write twin of familyRead.ts.
// Pure deterministic detector: no LLM, no DB write here. Emits IntentRecord[];
// DOMAIN_WRITERS.family_capture owns the commit + confirm gate.
// Mirrors detectServiceCapture (householdCapture.ts) and detectDiagnosisCapture
// (detectMedicalEvent.ts): read-guard, closed relation vocabulary, high-precision
// single-member patterns, bias to NOT capture on ambiguity.
//
// SCOPE (Build 50, Path B — single member, relation + name ONLY):
//   - LOCATION DEFERRED: no live reader surfaces a captured city today
//     (tierRouter inline branch reads no location; contacts.location has no
//     writer; capturePerson's fact-string location is parsed by no reader).
//     Capturing a city would be a write with no honest read-back, so the
//     detector drops it. The writer's location branch is left intact but unfed.
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
  'lives', 'live', 'is', 'in', 'name', 'named', 'and',
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

export function detectFamilyCapture(text: string): IntentRecord[] {
  const raw = text.trim();
  if (!raw) return [];
  if (READ_GUARD.test(raw)) return [];

  // Compound → defer to 50b. Never half-capture.
  const countCompound = new RegExp(`\\b(two|three|four|five|both|couple of|a couple of)\\s+(?:${REL})s?\\b`, 'i');
  const dualRelation  = new RegExp(`\\bmy\\s+(?:${REL})\\b[^.?]*\\band\\s+my\\s+(?:${REL})\\b`, 'i');
  const nameList      = new RegExp(`\\bmy\\s+(?:${REL})s?\\b[^.?]*\\b[A-Za-z][A-Za-z'\\-]+\\s+and\\s+[A-Za-z][A-Za-z'\\-]+`, 'i');
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
  if (countCompound.test(raw) || dualRelation.test(raw) || nameList.test(raw)) return [];
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
    // Location intentionally omitted (deferred). Relation + name only.
    return [{ type: 'family_capture', relation, name: nm }];
  }
  return [];
}
