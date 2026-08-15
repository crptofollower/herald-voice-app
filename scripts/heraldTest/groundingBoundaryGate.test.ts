// scripts/heraldTest/groundingBoundaryGate.test.ts
// KITT wall grounding correction, 2026-08-15. Full adversarial matrix from
// design review: substring-collision false positives that must be rejected,
// legitimate captures that must still ground, structured-token/numeric
// safety (dosage truncation), Unicode boundary correctness (combining
// marks, typographic apostrophes, Unicode dashes), and verifyVerbatim-level
// proof that a fabricated IntentRecord cannot acquire authority through
// this mechanism -- reproducing the actual device-observed "song"/"son"
// defect directly.

import { findStandardSpan, verifyVerbatim, UNICODE_BOUNDARY_SUPPORTED } from '../../src/hooks/llmLayers.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runGroundingBoundaryGateTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assertSpan(label: string, candidate: string, utterance: string, expectMatch: boolean) {
    const got = findStandardSpan(utterance, candidate);
    const gotMatch = got !== null;
    if (gotMatch === expectMatch) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       candidate: ${DIM}"${candidate}"${RESET} utterance: ${DIM}"${utterance}"${RESET}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected match: ${DIM}${expectMatch}${RESET}`);
      failures.push({ label, got, expected: String(expectMatch) });
    }
  }

  function assertRecordRejected(label: string, rec: IntentRecord, utterance: string) {
    const got = verifyVerbatim(rec, utterance);
    if (got === null) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: null (rejected)`);
      failures.push({ label, got, expected: 'null (rejected)' });
    }
  }

  function assertRecordAccepted(label: string, rec: IntentRecord, utterance: string) {
    const got = verifyVerbatim(rec, utterance);
    if (got !== null) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: null (rejected)\n       expected: non-null (accepted)`);
      failures.push({ label, got, expected: 'non-null (accepted)' });
    }
  }

  console.log(`\n${BOLD}-- Grounding Boundary Gate Tests --------------------------${RESET}`);

  // Feature-support smoke test (Node/V8 proxy -- NOT a substitute for
  // on-device Hermes confirmation, disclosed explicitly).
  console.log(`${DIM}(UNICODE_BOUNDARY_SUPPORTED in this test runtime: ${UNICODE_BOUNDARY_SUPPORTED})${RESET}`);
  if (UNICODE_BOUNDARY_SUPPORTED) { passed++; console.log(`${GREEN}✓ PASS${RESET}  0: feature check reports supported in Node/V8`); }
  else { failures.push({ label: '0', got: false, expected: 'true' }); console.log(`${RED}✗ FAIL${RESET}  0: feature check reports supported in Node/V8`); }

  // Substring-collision false positives -- MUST NOT match
  assertSpan('1: son vs song', 'son', 'My song called this morning', false);
  assertSpan('2: son vs person', 'son', 'My person is nice', false);
  assertSpan('3: son vs reason', 'son', 'good reason to go', false);
  assertSpan('4: son vs season', 'son', 'this season is cold', false);
  assertSpan('5: son vs sonic', 'son', "that's sonic speed", false);
  assertSpan('6: cat vs vacation', 'cat', 'my vacation was nice', false);
  assertSpan('7: cat vs category', 'cat', 'the category is wrong', false);
  assertSpan('8: cat vs delicate', 'cat', 'a delicate matter', false);
  assertSpan('9: cort vs cortisone', 'cort', 'I take cortisone', false);

  // Legitimate grounding -- MUST still match
  assertSpan('10: genuine son', 'son', 'My son called this morning', true);
  assertSpan('11: father-in-law exact', 'father-in-law', 'my father-in-law visited', true);
  assertSpan('12: Dr. Smith multi-word', 'Dr. Smith', 'I saw Dr. Smith yesterday', true);
  assertSpan('13: O\'Connor exact', "O'Connor", "call O'Connor please", true);
  assertSpan('14: Little Elm Texas multi-word', 'Little Elm Texas', 'moved to Little Elm Texas last year', true);
  assertSpan('15: dosage 20 mg', '20 mg', 'I take 20 mg daily', true);
  assertSpan('16: son before comma', 'son', "My son, he's great", true);
  assertSpan('17: son in quotes', 'son', '"son" is what she said', true);
  assertSpan('18: Jose ASCII exact', 'Jose', 'my neighbor Jose helped', true);

  // Numeric structured-token safety
  assertSpan('19: 20 vs 20.5 (dosage truncation)', '20', 'I take 20.5 mg', false);
  assertSpan('20: 20 vs 20 mg', '20', 'I take 20 mg', true);

  // Hyphen/apostrophe token-internal
  assertSpan('23: Smith vs Smith-Jones', 'Smith', 'call Smith-Jones please', false);
  assertSpan('24: Connor vs O\'Connor (ASCII apostrophe)', 'Connor', "call O'Connor please", false);
  assertSpan('25: law vs father-in-law', 'law', 'my father-in-law visited', false);
  assertSpan('26: in vs father-in-law', 'in', 'my father-in-law visited', false);

  // Unicode: combining marks, curly apostrophe, Unicode dash
  const joseDecomposed = 'Jose\u0301'; // e + combining acute accent
  assertSpan('27: Jose vs decomposed Jose-accent', 'Jose', `my neighbor ${joseDecomposed} helped`, false);
  assertSpan('28: Connor vs curly-apostrophe O\u2019Connor', 'Connor', 'call O\u2019Connor please', false);
  assertSpan('29: Smith vs en-dash Smith\u2013Jones', 'Smith', 'call Smith\u2013Jones please', false);
  assertSpan('30: exact decomposed Jose-accent matches itself', joseDecomposed, `my neighbor ${joseDecomposed} helped`, true);
  assertSpan('31: exact curly-apostrophe O\u2019Connor matches itself', 'O\u2019Connor', 'call O\u2019Connor please', true);
  assertSpan('32: exact en-dash Smith\u2013Jones matches itself', 'Smith\u2013Jones', 'call Smith\u2013Jones please', true);

  // Possessive-clitic trailing exception (2026-08-15 revision)
  assertSpan('34: son before possessive son\'s', 'son', "My son's name is Hunter.", true);
  assertSpan('35: daughter before possessive daughter\'s', 'daughter', "My daughter's name is Susan.", true);
  assertSpan('36: wife before possessive wife\'s', 'wife', "My wife's doctor called.", true);
  assertSpan('37: husband before possessive husband\'s', 'husband', "My husband's appointment is tomorrow.", true);
  assertSpan('38: doctor before possessive doctor\'s', 'doctor', "My doctor's name is Smith.", true);
  assertSpan('39: son before curly-apostrophe possessive', 'son', 'My son\u2019s name is Hunter.', true);
  assertSpan('40: Connor still rejected inside ASCII O\'Connor', 'Connor', "O'Connor", false);
  assertSpan('41: Connor still rejected inside curly O\u2019Connor', 'Connor', 'O\u2019Connor', false);
  assertSpan('42: Angelo still rejected inside ASCII D\'Angelo', 'Angelo', "D'Angelo", false);
  assertSpan('43: Angelo still rejected inside curly D\u2019Angelo', 'Angelo', 'D\u2019Angelo', false);
  assertSpan('44: son vs song unaffected', 'son', 'song', false);
  assertSpan('45: son vs sonic unaffected', 'son', 'sonic', false);
  assertSpan('46: law vs father-in-law unaffected', 'law', 'father-in-law', false);
  assertSpan('47: Smith vs Smith-Jones unaffected', 'Smith', 'Smith-Jones', false);
  assertSpan('48: Smith vs Smith\u2013Jones (en dash) unaffected', 'Smith', 'Smith\u2013Jones', false);

  // Plural-suffix trailing exception (2026-08-15 revision, closes the
  // "two sons" classifierParse regression)
  assertSpan('49: son before plural sons', 'son', 'I have sons in college.', true);
  assertSpan('50: son before plural sons (comma-separated names)', 'son', 'two sons, Grant and Hunter', true);
  assertSpan('51: daughter before plural daughters', 'daughter', 'I have two daughters.', true);
  assertSpan('52: cat before plural cats (non-family domain check)', 'cat', 'the cats are hungry', true);
  assertSpan('53: son vs sonics -- plural exception must not overreach', 'son', 'sonics', false);

  // verifyVerbatim-level: the actual reproduced device defect
  assertRecordRejected(
    'V1: reproduced device defect -- relation=son/name=song must be rejected as a whole record',
    { type: 'family_capture', relation: 'son', name: 'song' } as IntentRecord,
    'My song called this morning and he might come over this weekend to help me around the house',
  );

  // verifyVerbatim-level: genuine capture must remain accepted
  assertRecordAccepted(
    'V2: genuinely grounded capture remains accepted',
    { type: 'family_capture', relation: 'son', name: 'Hunter' } as IntentRecord,
    "My son's name is Hunter",
  );

  assertRecordAccepted(
    'V3: possessive-form genuine capture accepted end-to-end (regression fix confirmation)',
    { type: 'family_capture', relation: 'son', name: 'Hunter' } as IntentRecord,
    "My son's name is Hunter",
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}GroundingBoundaryGate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groundingBoundaryGate.test.ts')) {
  runGroundingBoundaryGateTests().catch(console.error);
}
