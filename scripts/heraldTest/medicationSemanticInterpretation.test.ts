// scripts/heraldTest/medicationSemanticInterpretation.test.ts
// Medication Semantic Interpretation V1 — the probabilistic proposal +
// deterministic admission seam. Governing docs:
//   HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_IMPLEMENTATION_DESIGN.md
//   HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_CTO_REVIEW_RESOLUTION.md
//
// Imports the REAL, unmodified src/utils/detectMedicalEvent.ts and the real
// src/routing/medicationSemanticInterpretation.ts — tests can never drift
// from code. Also exercises the real routeIntent.ts (with better-sqlite3 +
// mocked classifyLLM) to prove the classifyLLM medication-bypass closure at
// the RouteDecision level, not merely at the helper-function level.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent, llmMedicationCaptureLacksEvidence } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { detectMedicalEvent, hasMedicationDomainEvidence, isFirstPersonAuxiliaryQuestionShape, isMedicationQuestionShape, isMedicationInquirySpeechAct } from '../../src/utils/detectMedicalEvent.ts';
import {
  admitMedicationSemanticProposal,
  parseSemanticProposal,
  generateMedicationSemanticProposal,
  isProvenanceVerified,
  type SemanticProposal,
} from '../../src/routing/medicationSemanticInterpretation.ts';
import type { ClassifyOutcome, IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function freshDB() {
  const db = new Database(':memory:');
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

function mockClassify(intents: IntentRecord[]): ClassifyOutcome {
  return { status: 'ok', intents };
}

function proposal(over: Partial<SemanticProposal>): SemanticProposal {
  return {
    mentions: [],
    predicate: 'take',
    focus: '',
    confidence: 0.9,
    ...over,
  };
}

export async function runMedicationSemanticInterpretationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medication Semantic Interpretation V1 --${RESET}\n`);

  // ── Existing positives, Tier-H evidenced — deterministic floor still
  //    claims these unchanged by the Tier-2 closure (dosage/terminology/
  //    specialty present); the seam must DEFER regardless of what any
  //    proposal says (Invariant 2). ──────────────────────────────────────
  const existingPositives: [string, string][] = [
    ['EP4', 'My doctor prescribed metformin.'],
    ['EP5', 'I started taking metformin 500 milligrams twice a day.'],
  ];
  for (const [id, text] of existingPositives) {
    const floor = detectMedicalEvent(text);
    assert(`${id} deterministic floor already claims "${text}"`, floor, (v) => v !== null, 'non-null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: floor?.drug_name ?? 'x', mentions: [floor?.drug_name ?? 'x'] }), { hasPending: false });
    assert(`${id} seam DEFERs to existing deterministic authority`, decision.decision, (v) => v === 'DEFER', 'DEFER');
  }

  // ── EP1-EP3 (Tier-2 closure, 2026-09-07): these previously relied on the
  //    now-removed capitalization/lenient-trigger proxies for floor
  //    admission. The floor now correctly ABSTAINS (no Tier-H evidence) —
  //    these are no longer DEFER cases; they are now genuinely seam-
  //    eligible, exactly like "I started CrossFit." A synthetic,
  //    evidence-free proposal correctly reaches CLARIFY, never ADMIT: the
  //    seam does not silently inherit the floor's old, now-rejected
  //    permissiveness — it applies its own, unchanged, Tier-H-only evidence
  //    bar (Part B closure removed capitalization here too). ─────────────
  const nowAbstainedBareCases: [string, string, string][] = [
    ['EP1', 'I take metformin.', 'metformin'],
    ['EP2', "I'm taking Lipitor.", 'Lipitor'],
    ['EP3', 'I started taking lisinopril.', 'lisinopril'],
  ];
  for (const [id, text, focus] of nowAbstainedBareCases) {
    const floor = detectMedicalEvent(text);
    assert(`${id} floor now abstains (Tier-2 closure) — "${text}"`, floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [focus], confidence: 0.9 }), { hasPending: false });
    assert(`${id} seam does not silently ADMIT a bare, evidence-free proposal`, decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (insufficient_domain_evidence), never ADMIT');
    assert(`${id} seam CLARIFYs specifically (not REJECT/DEFER) — evidence-insufficiency, not a shape/provenance failure`, decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Known false-positive controls — even a high-confidence, well-formed
  //    proposal naming the literal (wrong) object must not be ADMITted. ──
  const falsePositiveControls: [string, string][] = [
    ['FP1', 'I take my grandson fishing.', 'grandson'] as any,
    ['FP2', "I'm taking my wife to dinner.", 'wife'] as any,
    ['FP3', 'I use my phone every day.', 'phone'] as any,
    ['FP4', "I'm on vacation next week.", 'vacation'] as any,
    ['FP5', "I'm on my way.", 'way'] as any,
  ];
  for (const [id, text, focus] of falsePositiveControls as [string, string, string][]) {
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [focus] }), { hasPending: false });
    assert(`${id} "${text}" (focus "${focus}") → never ADMIT`, decision.decision, (v) => v !== 'ADMIT', 'CLARIFY or REJECT or DEFER, never ADMIT');
  }
  // FP6/FP7 — "We used to take long walks." and "I've started using my new
  // camera." were, before the 2026-09-06 residual floor repair
  // (HERALD_MEDICATION_FLOOR_ACCEPTANCE_CONTRADICTION_DIAGNOSTIC_2026-09-06.md),
  // both mis-claimed by the deterministic floor (drug_name "long"/"using").
  // That floor bug is now repaired — detectMedicalEvent correctly declines
  // both. Since the floor no longer claims them, the seam no longer DEFERs
  // (Invariant 2 only defers when the floor legitimately owns the
  // utterance); it independently evaluates the proposal and correctly
  // declines via insufficient domain evidence (CLARIFY, via
  // hasIndependentMedicationEvidence — "walks"/"camera" carry no dosage,
  // terminology, doctor/specialty, discontinuation, or capitalization
  // evidence). This demonstrates the two layers degrade gracefully and
  // independently: fixing the floor did not require touching the seam, and
  // the seam's own, separate evidence bar already declined these on its own
  // terms, not by inheriting the floor's (previously buggy) decision.
  {
    const text = 'We used to take long walks.';
    const floor = detectMedicalEvent(text);
    assert('FP6 repaired floor correctly declines "long walks" today', floor, (v) => v === null, 'null (2026-09-06 floor repair)');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'walks', mentions: ['walks'] }), { hasPending: false });
    assert('FP6 seam independently declines via insufficient evidence, never ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }
  {
    const text = "I've started using my new camera.";
    const floor = detectMedicalEvent(text);
    assert('FP7 repaired floor correctly declines "camera" today', floor, (v) => v === null, 'null (2026-09-06 floor repair)');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'camera', mentions: ['camera'] }), { hasPending: false });
    assert('FP7 seam independently declines via insufficient evidence, never ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Known deliberate unresolved cases — must stay unresolved under the
  //    new primitive too (no loosening). ──────────────────────────────────
  {
    const text = "I'm using an inhaler.";
    const floor = detectMedicalEvent(text);
    assert('DU1 deterministic floor declines "inhaler" today', floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'inhaler', mentions: ['inhaler'] }), { hasPending: false });
    assert('DU1 seam also does not ADMIT "inhaler"', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (insufficient evidence)');
  }
  {
    const text = "I'm on metformin.";
    const floor = detectMedicalEvent(text);
    assert('DU2 deterministic floor declines bare "metformin" today', floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'metformin', mentions: ['metformin'] }), { hasPending: false });
    assert('DU2 seam also does not ADMIT bare lowercase "metformin"', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (insufficient evidence)');
  }

  // ── Semantic capability-delta cases — real, present-day misses with real
  //    independent (Tier-H) evidence, recoverable via
  //    hasIndependentMedicationEvidence. CD6/CD8/CD9 removed from this
  //    ADMIT-expecting group (Part B closure, below) — they carried no
  //    evidence beyond capitalization. ──────────────────────────────────
  const capabilityDelta: { id: string; text: string; focus: string; dosage?: string; frequency?: string }[] = [
    { id: 'CD1', text: 'My cardiologist put me on Eliquis.', focus: 'Eliquis' },       // specialty
    { id: 'CD2', text: 'The pharmacy filled my Lisinopril 10mg refill today.', focus: 'Lisinopril', dosage: '10mg' },
    { id: 'CD3', text: "I've been on 20 milligrams of Prozac for a month.", focus: 'Prozac', dosage: '20milligrams' },
    { id: 'CD4', text: "I'm switching to a new dose of Synthroid, 75 micrograms.", focus: 'Synthroid', dosage: '75micrograms' },
    { id: 'CD5', text: 'Metformin 500 mg, twice daily — that is my prescription.', focus: 'Metformin', dosage: '500mg', frequency: 'twice daily' },
    { id: 'CD7', text: 'I picked up my Amoxicillin prescription this afternoon.', focus: 'Amoxicillin' },  // terminology
    { id: 'CD10', text: 'The doctor has me on 40 milligrams of Lipitor.', focus: 'Lipitor', dosage: '40milligrams' },
  ];
  for (const { id, text, focus, dosage, frequency } of capabilityDelta) {
    const floor = detectMedicalEvent(text);
    assert(`${id} deterministic floor misses "${text}" today`, floor, (v) => v === null, 'null (real, present-day miss)');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [focus] }), { hasPending: false });
    assert(`${id} seam ADMITs "${text}"`, decision.decision, (v) => v === 'ADMIT', 'ADMIT');
    if (decision.decision === 'ADMIT') {
      assert(`${id} drug is literal focus "${focus}"`, decision.drug, (v) => v === focus, focus);
      if (dosage) assert(`${id} dosage "${dosage}" derived from raw`, decision.dosage, (v) => v === dosage, dosage);
      if (frequency) assert(`${id} frequency "${frequency}" derived from raw`, decision.frequency, (v) => v === frequency, frequency);
    }
  }

  // ── CD6/CD8/CD9 (Part B closure, 2026-09-07): capitalization is no
  //    longer independent evidence in hasIndependentMedicationEvidence
  //    either — same failure-class closure as the floor, not a separate
  //    feature. These three previously ADMITted via capitalization alone;
  //    verified by direct execution that a hypothetical capitalized
  //    "CrossFit" focus satisfied the identical old branch just as readily
  //    as "Lipitor" did — a capitalized model focus must not independently
  //    authorize ADMIT. Now correctly CLARIFY (insufficient evidence),
  //    never REJECT (focus/provenance are still fine) and never silently
  //    dropped. ──────────────────────────────────────────────────────────
  const noLongerAdmitsOnCapitalizationAlone: { id: string; text: string; focus: string }[] = [
    { id: 'CD6', text: 'Every morning I swallow my Metformin.', focus: 'Metformin' },
    { id: 'CD8', text: 'The doctor has me on Warfarin now.', focus: 'Warfarin' },
    { id: 'CD9', text: "I'm taking my new blood thinner, Xarelto.", focus: 'Xarelto' },
  ];
  for (const { id, text, focus } of noLongerAdmitsOnCapitalizationAlone) {
    const floor = detectMedicalEvent(text);
    assert(`${id} deterministic floor misses "${text}" (unaffected by Part B)`, floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [focus] }), { hasPending: false });
    assert(`${id} seam no longer ADMITs on capitalization alone (Part B closure)`, decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Filler/category focus must never become a stored medication name
  //    (Invariant 7), even with real surrounding evidence. ─────────────────
  {
    const text = "I'm off my blood pressure medicine as of today.";
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'medicine', mentions: ['medicine'] }), { hasPending: false });
    assert('FILLER1 "medicine" focus never ADMITs', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (filler/category word)');
  }
  {
    const text = 'Metformin 500 mg, twice daily — that is my prescription.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'prescription', mentions: ['prescription'] }), { hasPending: false });
    assert('FILLER2 "prescription" focus never ADMITs even with real dosage nearby', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (filler/category word)');
  }

  // ── Malformed proposal — strict parse, no coercion. ──────────────────────
  assert('MALFORMED1 non-JSON', parseSemanticProposal('I cannot help with that.'), (v) => v === null, 'null');
  assert('MALFORMED2 missing focus field', parseSemanticProposal(JSON.stringify({ mentions: [], predicate: 'take', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED3 confidence as string, not coerced', parseSemanticProposal(JSON.stringify({ mentions: [], predicate: 'take', focus: 'x', confidence: '0.9' })), (v) => v === null, 'null');
  assert('MALFORMED4 confidence out of range', parseSemanticProposal(JSON.stringify({ mentions: [], predicate: 'take', focus: 'x', confidence: 1.5 })), (v) => v === null, 'null');
  // MALFORMED5 (contract correction, 2026-09-07): `act` is no longer part of
  // the contract, so an `act` value that would have failed the old closed
  // enum — even one entirely absent from any prior vocabulary — must have NO
  // effect on parsing: present-but-ignored, not validated, not required.
  // This is the direct, disclosed replacement for the old "invalid act value
  // → null" test, now asserting the opposite on purpose.
  assert('MALFORMED5 extra/unrecognized act field is ignored, not validated', parseSemanticProposal(JSON.stringify({ act: 'diagnose', mentions: [], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v !== null, 'parsed SemanticProposal (act ignored)');
  assert('MALFORMED5b proposal parses fine with no act field at all', parseSemanticProposal(JSON.stringify({ mentions: [], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v !== null, 'parsed SemanticProposal');
  // MALFORMED6 (contract correction): the OLD `{text}` mention-object shape
  // is now itself the invalid case — mentions must be `string[]`. This
  // deliberately tests the backward-incompatibility boundary: a model still
  // emitting the pre-correction object shape must not be silently coerced.
  assert('MALFORMED6 old {text}-object mention shape now rejected (mentions must be string[])', parseSemanticProposal(JSON.stringify({ mentions: [{ text: 'x' }], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED6b mention that is neither a string nor {text} rejected', parseSemanticProposal(JSON.stringify({ mentions: [{ kind: 'thing' }], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED7 valid, extracted from surrounding prose', parseSemanticProposal(`Here you go: ${JSON.stringify({ mentions: ['Eliquis'], predicate: 'take', focus: 'Eliquis', confidence: 0.9 })} done.`), (v) => v !== null, 'parsed SemanticProposal');

  // ── Corrected mentions:string[] parser contract — direct, explicit checks. ──
  assert('MENTIONS1 flat string[] mentions parses (the corrected, empirically-observed shape)',
    parseSemanticProposal(JSON.stringify({ mentions: ['Eliquis', 'Warfarin'], predicate: 'take', focus: 'Eliquis', confidence: 0.8 })),
    (v) => v !== null && (v as SemanticProposal).mentions.length === 2 && (v as SemanticProposal).mentions[0] === 'Eliquis',
    'parsed with mentions ["Eliquis","Warfarin"]');
  assert('MENTIONS2 empty mentions array parses (act-free, mentions-free content still valid)',
    parseSemanticProposal(JSON.stringify({ mentions: [], predicate: 'take', focus: '', confidence: 0.5 })),
    (v) => v !== null, 'parsed SemanticProposal');
  assert('MENTIONS3 non-array mentions rejected',
    parseSemanticProposal(JSON.stringify({ mentions: 'Eliquis', predicate: 'take', focus: 'Eliquis', confidence: 0.8 })),
    (v) => v === null, 'null');

  // ── Existing 84-generation replay — literal raw model output captured
  //    verbatim from the bounded 3B semantic-discrimination experiment
  //    (Llama-3.2-3B-Instruct Q4_K_M, production prompt/params), confirming
  //    the corrected parser succeeds on real generations without a rerun. ──
  {
    const rawEliquis = '```\n{\n  "act": "start",\n  "mentions": [\n    "Eliquis"\n  ],\n  "predicate": "started",\n  "focus": "Eliquis",\n  "confidence": 0.5\n}\n```';
    const p = parseSemanticProposal(rawEliquis);
    assert('REPLAY1 real "I started Eliquis." generation now parses (fenced code block, legacy act field)', p, (v) => v !== null, 'parsed SemanticProposal');
    assert('REPLAY1 focus extracted correctly', p?.focus, (v) => v === 'Eliquis', 'Eliquis');
    assert('REPLAY1 mentions extracted as string[]', p?.mentions, (v) => Array.isArray(v) && (v as string[])[0] === 'Eliquis', '["Eliquis"]');
  }
  {
    const rawCrossFit = '{\n  "act": "read",\n  "mentions": [\n    "CrossFit"\n  ],\n  "predicate": "started",\n  "focus": "",\n  "confidence": 0.5\n}';
    const p = parseSemanticProposal(rawCrossFit);
    assert('REPLAY2 real "I started CrossFit." generation parses', p, (v) => v !== null, 'parsed SemanticProposal');
    assert('REPLAY2 empty focus preserved (model correctly found no medication)', p?.focus, (v) => v === '', 'empty string');
    // Tier-2 closure (2026-09-07): the deterministic floor no longer claims
    // "I started CrossFit." either (previously the still-open gap this test
    // documented — now closed by Part A). DEFER no longer fires; admission
    // proceeds to the empty-focus REJECT path directly, on the ORIGINAL
    // text, never reaching ADMIT/CLARIFY regardless.
    assert('REPLAY2 floor now abstains too (Tier-2 closure closes the previously-open gap)', detectMedicalEvent('I started CrossFit.'), (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal('I started CrossFit.', p!, { hasPending: false });
    assert('REPLAY2 admission REJECTs on empty focus, never DEFER/ADMIT/CLARIFY', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }
  {
    const rawInsulin = '{\n  "act": "read",\n  "mentions": [\n    "insulin"\n  ],\n  "predicate": "taking",\n  "focus": "",\n  "confidence": 0.5\n}';
    const p = parseSemanticProposal(rawInsulin);
    assert('REPLAY3 real "I\'m taking insulin." generation parses (documented, not special-cased, follow-up evidence — see Semantic Interpretation follow-up)', p, (v) => v !== null, 'parsed SemanticProposal');
  }

  // ── Speech-act gate closure (contract correction, 2026-09-07) — the
  //    deterministic isReadShapedUtterance/isMedicationInquirySpeechAct
  //    pre-check now carries the safety property `act` used to carry. Fed a
  //    deliberately well-formed, high-confidence, evidenced proposal so the
  //    ONLY thing that could produce REJECT is the new guard itself — proves
  //    the guard fires on question shape, not on anything else. ──────────
  const questionShapes: [string, string][] = [
    ['Q1', 'Am I still supposed to take Eliquis?'],
    ['Q2', 'Should I take Eliquis?'],
    ['Q3', 'Am I taking Eliquis?'],
    // Generalization beyond the three named examples — different auxiliaries,
    // different medications, proving the guard is general sentence shape,
    // not a per-example patch.
    ['Q4', 'Was I supposed to take Eliquis today?'],
    ['Q5', 'Have I taken my Eliquis yet?'],
    ['Q6', 'Do I take Eliquis?'],
    ['Q7', 'Could I still be taking Eliquis?'],
    ['Q8', 'Will I need to keep taking Eliquis?'],
  ];
  for (const [id, text] of questionShapes) {
    assert(`${id} isFirstPersonAuxiliaryQuestionShape("${text}") → true`, isFirstPersonAuxiliaryQuestionShape(text), (v) => v === true, 'true');
    const decision = admitMedicationSemanticProposal(
      text,
      proposal({ focus: 'Eliquis', mentions: ['Eliquis'], confidence: 0.95 }),
      { hasPending: false },
    );
    assert(`${id} admission REJECTs a question-shaped utterance even with a perfect, evidenced proposal`, decision.decision, (v) => v === 'REJECT', 'REJECT');
    assert(`${id} REJECT reason is the new read-shape gate, not provenance/evidence`, (decision as any).reason, (v) => v === 'read_shaped_utterance', 'read_shaped_utterance');
  }

  // ── Existing medication question shapes (already-shipped guards) must
  //    still REJECT through the same new gate — proves the two reused
  //    guards (isReadShapedUtterance, isMedicationInquirySpeechAct) are
  //    correctly wired, not just the new auxiliary-inversion addition. ────
  const existingQuestionShapes: [string, string][] = [
    ['EQ1', 'What medications am I taking?'],
    ['EQ2', 'How often do I take Eliquis?'],
    ['EQ3', 'When do I take Eliquis?'],
    ['EQ4', "What's my Eliquis dosage?"],
  ];
  for (const [id, text] of existingQuestionShapes) {
    const decision = admitMedicationSemanticProposal(
      text,
      proposal({ focus: 'Eliquis', mentions: ['Eliquis'], confidence: 0.95 }),
      { hasPending: false },
    );
    assert(`${id} existing question-shape guard still REJECTs "${text}"`, decision.decision, (v) => v === 'REJECT', 'REJECT');
  }

  // ── Critical negative control: representative first-person ASSERTIONS
  //    must NOT be misclassified as questions by the new guard. Every one of
  //    these must reach past the read-shape gate (REJECT reason must never
  //    be 'read_shaped_utterance' for these) — verified against a genuinely
  //    unevidenced proposal so the assertion is free to land on CLARIFY,
  //    proving the new gate itself did not fire. ──────────────────────────
  const assertionsNotQuestions: [string, string][] = [
    ['NQ1', 'I started Eliquis.'],
    ['NQ2', "I'm on Eliquis."],
    ['NQ3', "I'm taking Lipitor."],
    ['NQ4', 'I started CrossFit.'],
    ['NQ5', "I'm on LinkedIn."],
    ['NQ6', "I'm taking the SATs tomorrow."],
    ['NQ7', "I've been taking Eliquis for years."],
    ['NQ8', "I'm not sure if I'm supposed to take Eliquis."], // does not open with inversion
    // NQ9/NQ10: regression lock for a real bug found and fixed during this
    // implementation. The seam's read-shape gate initially reused
    // isMedicationInquirySpeechAct verbatim (the floor's own function) —
    // direct execution against CD4 ('I'm switching to a new dose of
    // Synthroid, 75 micrograms.') showed it wrongly REJECTed a genuine
    // assertion, because that function's DOSE_INQUIRY branch requires no
    // interrogative marker at all (just "dose"/"dosage" co-occurring with
    // "of"/"my"/"take" anywhere in the sentence). Fixed by giving the seam
    // its own narrower isMedicationQuestionShape (see detectMedicalEvent.ts)
    // that excludes that branch. These two cases must never be misclassified.
    ['NQ9', "I'm switching to a new dose of Eliquis, 75 micrograms."],
    ['NQ10', 'This is my new dose of Eliquis.'],
  ];
  for (const [id, text] of assertionsNotQuestions) {
    assert(`${id} isFirstPersonAuxiliaryQuestionShape("${text}") → false`, isFirstPersonAuxiliaryQuestionShape(text), (v) => v === false, 'false');
    const decision = admitMedicationSemanticProposal(
      text,
      proposal({ focus: 'Eliquis', mentions: ['Eliquis'], confidence: 0.95 }),
      { hasPending: false },
    );
    assert(`${id} "${text}" never REJECTs via the new read-shape gate`, (decision as any).reason, (v) => v !== 'read_shaped_utterance', 'anything but read_shaped_utterance');
  }

  // ── Direct unit-level lock: isMedicationQuestionShape (seam) vs
  //    isMedicationInquirySpeechAct (floor) must DIVERGE exactly on the
  //    DOSE_INQUIRY co-occurrence case — proving the fix is real and the two
  //    functions are not accidentally identical again. ─────────────────────
  {
    const text = "I'm switching to a new dose of Synthroid, 75 micrograms.";
    assert('DIVERGE1 isMedicationQuestionShape(dose-assertion) → false (seam-safe)', isMedicationQuestionShape(text), (v) => v === false, 'false');
    assert('DIVERGE1 isMedicationInquirySpeechAct(dose-assertion) → true (pre-existing floor behavior, unmodified)', isMedicationInquirySpeechAct(text), (v) => v === true, 'true');
  }
  // Both functions must still AGREE on genuine question shapes.
  for (const text of ['Am I still supposed to take Eliquis?', 'How often do I take Eliquis?', 'When do I take Eliquis?']) {
    assert(`AGREE both functions → true for "${text}"`, isMedicationQuestionShape(text) === true && isMedicationInquirySpeechAct(text) === true, (v) => v === true, 'true');
  }

  // ── Floor-level regression: the SAME extension (isMedicationInquirySpeechAct)
  //    is consulted by detectMedicalEvent too. Confirms the deterministic
  //    floor itself now also declines the named question shapes — closing an
  //    identical, pre-existing floor-level gap as a byproduct of reusing the
  //    shared function, with zero separate floor code changes. ────────────
  const floorQuestionShapes: [string, string][] = [
    ['FQ1', 'Am I still supposed to take Eliquis?'],
    ['FQ2', 'Should I take Eliquis?'],
    ['FQ3', 'Am I taking Eliquis?'],
  ];
  for (const [id, text] of floorQuestionShapes) {
    assert(`${id} detectMedicalEvent("${text}") → null (floor also benefits)`, detectMedicalEvent(text), (v) => v === null, 'null');
  }
  // And floor-level, Tier-H-evidenced positives must remain completely
  // unaffected by the question-shape guard (bare cases like "I take
  // Eliquis" are no longer floor positives at all post Tier-2 closure —
  // see medicationDomainAdmission.test.ts P1/P2/P4/P7/P9 — so this check
  // now uses genuinely evidenced examples to isolate "does the question-
  // shape guard misfire" from "does Tier-2 evidence hold").
  const floorAssertionsUnaffected: [string, string][] = [
    ['FA1', 'I take Metformin 500 mg twice a day.'],
    ['FA2', 'My doctor prescribed Lipitor.'],
    ['FA3', 'I was prescribed metformin.'],
  ];
  for (const [id, text] of floorAssertionsUnaffected) {
    assert(`${id} detectMedicalEvent("${text}") still claims (floor unaffected by the new guard)`, detectMedicalEvent(text), (v) => v !== null, 'non-null');
  }

  // ── Hallucinated focus not present in raw. Raw text deliberately contains
  //    no MEDICATION trigger word (take/taking/i'm on/prescribed/started/
  //    using/use) so the deterministic floor genuinely does not claim it —
  //    isolating the provenance check under test from Invariant 2's DEFER. ──
  {
    const text = 'My heart medicine keeps my blood pressure steady.';
    assert('HALLUC-fixture floor does not claim this text', detectMedicalEvent(text), (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Ozempic', mentions: ['Ozempic'] }), { hasPending: false });
    assert('HALLUC1 focus not in raw → REJECT', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }
  {
    const text = 'My heart medicine keeps my blood pressure steady.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'medicine', mentions: ['Ozempic'] }), { hasPending: false });
    assert('HALLUC2 unverified mention rejects whole proposal even if focus is valid-shaped', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }
  assert('PROVENANCE1 literal substring verified', isProvenanceVerified('Eliquis', 'I take Eliquis.'), (v) => v === true, 'true');
  assert('PROVENANCE2 not present, not verified', isProvenanceVerified('Ozempic', 'I take Eliquis.'), (v) => v === false, 'false');
  assert('PROVENANCE3 spoken-dosage normalizer output permitted', isProvenanceVerified('500mg', 'I take five hundred milligrams of it.'), (v) => v === true, 'true');

  // ── Model-normalized/rephrased trust-critical value — not a registered
  //    normalizer output → cannot become authoritative (Invariant 4). ──────
  {
    const text = 'My blood pressure pill keeps me steady, the one that starts with L.';
    assert('NORMALIZED-fixture floor does not claim this text', detectMedicalEvent(text), (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Lisinopril', mentions: ['Lisinopril'] }), { hasPending: false });
    assert('NORMALIZED1 model-inferred name not literally in raw → REJECT', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }

  // ── Low confidence — may cause clarification, never grants admission
  //    (Invariant 6), even with otherwise-perfect evidence. ────────────────
  {
    const text = 'My cardiologist put me on Eliquis.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Eliquis', mentions: ['Eliquis'], confidence: 0.1 }), { hasPending: false });
    assert('LOWCONF1 low confidence with valid evidence → CLARIFY, not ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Pending ownership — pending state owns the turn (Invariant 1). ───────
  {
    const text = 'My cardiologist put me on Eliquis.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Eliquis', mentions: ['Eliquis'] }), { hasPending: true });
    assert('PENDING1 pending owns the turn → DEFER regardless of proposal quality', decision.decision, (v) => v === 'DEFER', 'DEFER');
  }

  // ── Deterministic-floor DEFER — direct check (Invariant 2). Uses a
  //    Tier-H-evidenced utterance ("I take metformin." is bare/Tier-M-only
  //    post Tier-2 closure — no longer a floor-claim case, see
  //    medicationDomainAdmission.test.ts P2). ──────────────────────────────
  assert('FLOORDEFER1 detectMedicalEvent still claims "I take metformin 500mg."', detectMedicalEvent('I take metformin 500mg.'), (v) => v !== null, 'non-null');
  {
    const decision = admitMedicationSemanticProposal('I take metformin 500mg.', proposal({ focus: 'metformin', mentions: ['metformin'] }), { hasPending: false });
    assert('FLOORDEFER1 seam DEFERs', decision.decision, (v) => v === 'DEFER', 'DEFER');
  }

  // ── Interpreter unavailable — treated identically to "no proposal." ──────
  {
    const result = await generateMedicationSemanticProposal('I take Eliquis.', () => null);
    assert('UNAVAILABLE1 no model context → status unavailable', result.status, (v) => v === 'unavailable', 'unavailable');
  }
  {
    const throwingCtx: any = { completion: async () => { throw new Error('device model crashed'); } };
    const result = await generateMedicationSemanticProposal('I take Eliquis.', () => throwingCtx);
    assert('UNAVAILABLE2 model throws → status unavailable, not an uncaught error', result.status, (v) => v === 'unavailable', 'unavailable');
  }
  {
    const junkCtx: any = { completion: async () => ({ content: 'not json at all' }) };
    const result = await generateMedicationSemanticProposal('I take Eliquis.', () => junkCtx);
    assert('UNAVAILABLE3 unparseable model output → status parse_fail (not thrown, not coerced)', result.status, (v) => v === 'parse_fail', 'parse_fail');
  }

  // ── Compound utterance V1 boundary — no clause segmentation added; the
  //    seam defers to whatever the deterministic floor already decided for
  //    the WHOLE utterance. ─────────────────────────────────────────────────
  {
    const text = 'I saw Dr. Reyes today and I started taking metformin.';
    const floor = detectMedicalEvent(text);
    assert('COMPOUND1 deterministic floor already claims the whole utterance (as a visit)', floor?.type, (v) => v === 'visit', 'visit');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'metformin', mentions: ['metformin'] }), { hasPending: false });
    assert('COMPOUND1 seam DEFERs — no clause segmentation attempted', decision.decision, (v) => v === 'DEFER', 'DEFER');
  }

  // ── Existing classifyLLM medication bypass closure ───────────────────────
  // Unit-level: the exact guard added at the sole llm-capture conversion site.
  assert(
    'BYPASS1 unevidenced classifyLLM medical_capture ("vacation") lacks evidence',
    llmMedicationCaptureLacksEvidence('We are taking a vacation next month.', [{ type: 'medical_capture', drug: 'vacation', raw: 'We are taking a vacation next month.' } as IntentRecord]),
    (v) => v === true,
    'true',
  );
  assert(
    'BYPASS2 evidenced classifyLLM medical_capture ("Eliquis" + prescription terminology) has evidence',
    llmMedicationCaptureLacksEvidence('My prescription for Eliquis needs a refill.', [{ type: 'medical_capture', drug: 'Eliquis', raw: 'My prescription for Eliquis needs a refill.' } as IntentRecord]),
    (v) => v === false,
    'false',
  );
  assert(
    'BYPASS3 non-medical_capture intents in the same batch are ignored by the guard',
    llmMedicationCaptureLacksEvidence('Add milk to my list.', [{ type: 'list_add', items: ['milk'], listName: 'grocery' } as IntentRecord]),
    (v) => v === false,
    'false',
  );
  // Route-level (integration): the same closure proven at the RouteDecision.
  {
    freshDB();
    const text = 'We are taking a vacation next month.';
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => mockClassify([{ type: 'medical_capture', drug: 'vacation', raw: text } as IntentRecord]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('BYPASS4 route-level: unevidenced classifyLLM medical_capture never becomes capture', decision.kind, (v) => v !== 'capture', 'not capture (needs_clarification)');
  }
  {
    freshDB();
    const text = 'My prescription for Eliquis needs a refill.';
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => mockClassify([{ type: 'medical_capture', drug: 'Eliquis', raw: text } as IntentRecord]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('BYPASS5 route-level: evidenced classifyLLM medical_capture still reaches capture', decision.kind, (v) => v === 'capture', 'capture');
  }

  // ── Spot-check against medicationDomainAdmission.test.ts's own locked
  //    assertions — UNCHANGED1/UNCHANGED3 are genuinely unaffected by the
  //    Tier-2 closure; UNCHANGED2 is deliberately renamed and flipped
  //    (Tier-2 closure removes the lenient-trigger fallback entirely, so
  //    this is no longer "unchanged" — kept here, updated, so this file's
  //    own spot-check doesn't silently drift from what the floor actually
  //    does). ─────────────────────────────────────────────────────────────
  assert('UNCHANGED1 hasMedicationDomainEvidence determiner override intact', hasMedicationDomainEvidence("I'm using a new router", 'router'), (v) => v === false, 'false');
  assert('CHANGED2 hasMedicationDomainEvidence lenient trigger REMOVED (Tier-2 closure)', hasMedicationDomainEvidence("I'm taking metformin", 'metformin'), (v) => v === false, 'false');
  assert('UNCHANGED3 detectMedicalEvent vacation-class still declines', detectMedicalEvent("I'm on vacation next week."), (v) => v === null, 'null');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicationSemanticInterpretation: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicationSemanticInterpretation.test.ts')) {
  runMedicationSemanticInterpretationTests().catch(console.error);
}
