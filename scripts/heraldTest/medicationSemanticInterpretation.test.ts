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
import { detectMedicalEvent, hasMedicationDomainEvidence } from '../../src/utils/detectMedicalEvent.ts';
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
    act: 'assert',
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

  // ── Existing positives — deterministic floor already claims these; the
  //    seam must DEFER regardless of what any proposal says (Invariant 2). ──
  const existingPositives: [string, string][] = [
    ['EP1', 'I take metformin.'],
    ['EP2', "I'm taking Lipitor."],
    ['EP3', 'I started taking lisinopril.'],
    ['EP4', 'My doctor prescribed metformin.'],
    ['EP5', 'I started taking metformin 500 milligrams twice a day.'],
  ];
  for (const [id, text] of existingPositives) {
    const floor = detectMedicalEvent(text);
    assert(`${id} deterministic floor already claims "${text}"`, floor, (v) => v !== null, 'non-null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: floor?.drug_name ?? 'x', mentions: [{ text: floor?.drug_name ?? 'x' }] }), { hasPending: false });
    assert(`${id} seam DEFERs to existing deterministic authority`, decision.decision, (v) => v === 'DEFER', 'DEFER');
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
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [{ text: focus }] }), { hasPending: false });
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
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'walks', mentions: [{ text: 'walks' }] }), { hasPending: false });
    assert('FP6 seam independently declines via insufficient evidence, never ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }
  {
    const text = "I've started using my new camera.";
    const floor = detectMedicalEvent(text);
    assert('FP7 repaired floor correctly declines "camera" today', floor, (v) => v === null, 'null (2026-09-06 floor repair)');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'camera', mentions: [{ text: 'camera' }] }), { hasPending: false });
    assert('FP7 seam independently declines via insufficient evidence, never ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Known deliberate unresolved cases — must stay unresolved under the
  //    new primitive too (no loosening). ──────────────────────────────────
  {
    const text = "I'm using an inhaler.";
    const floor = detectMedicalEvent(text);
    assert('DU1 deterministic floor declines "inhaler" today', floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'inhaler', mentions: [{ text: 'inhaler' }] }), { hasPending: false });
    assert('DU1 seam also does not ADMIT "inhaler"', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (insufficient evidence)');
  }
  {
    const text = "I'm on metformin.";
    const floor = detectMedicalEvent(text);
    assert('DU2 deterministic floor declines bare "metformin" today', floor, (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'metformin', mentions: [{ text: 'metformin' }] }), { hasPending: false });
    assert('DU2 seam also does not ADMIT bare lowercase "metformin"', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (insufficient evidence)');
  }

  // ── Semantic capability-delta cases — real, present-day misses with real
  //    independent evidence, recoverable ONLY via hasIndependentMedicationEvidence. ──
  const capabilityDelta: { id: string; text: string; focus: string; dosage?: string; frequency?: string }[] = [
    { id: 'CD1', text: 'My cardiologist put me on Eliquis.', focus: 'Eliquis' },
    { id: 'CD2', text: 'The pharmacy filled my Lisinopril 10mg refill today.', focus: 'Lisinopril', dosage: '10mg' },
    { id: 'CD3', text: "I've been on 20 milligrams of Prozac for a month.", focus: 'Prozac', dosage: '20milligrams' },
    { id: 'CD4', text: "I'm switching to a new dose of Synthroid, 75 micrograms.", focus: 'Synthroid', dosage: '75micrograms' },
    { id: 'CD5', text: 'Metformin 500 mg, twice daily — that is my prescription.', focus: 'Metformin', dosage: '500mg', frequency: 'twice daily' },
    { id: 'CD6', text: 'Every morning I swallow my Metformin.', focus: 'Metformin' },
    { id: 'CD7', text: 'I picked up my Amoxicillin prescription this afternoon.', focus: 'Amoxicillin' },
    { id: 'CD8', text: 'The doctor has me on Warfarin now.', focus: 'Warfarin' },
    { id: 'CD9', text: "I'm taking my new blood thinner, Xarelto.", focus: 'Xarelto' },
    { id: 'CD10', text: 'The doctor has me on 40 milligrams of Lipitor.', focus: 'Lipitor', dosage: '40milligrams' },
  ];
  for (const { id, text, focus, dosage, frequency } of capabilityDelta) {
    const floor = detectMedicalEvent(text);
    assert(`${id} deterministic floor misses "${text}" today`, floor, (v) => v === null, 'null (real, present-day miss)');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus, mentions: [{ text: focus }] }), { hasPending: false });
    assert(`${id} seam ADMITs "${text}"`, decision.decision, (v) => v === 'ADMIT', 'ADMIT');
    if (decision.decision === 'ADMIT') {
      assert(`${id} drug is literal focus "${focus}"`, decision.drug, (v) => v === focus, focus);
      if (dosage) assert(`${id} dosage "${dosage}" derived from raw`, decision.dosage, (v) => v === dosage, dosage);
      if (frequency) assert(`${id} frequency "${frequency}" derived from raw`, decision.frequency, (v) => v === frequency, frequency);
    }
  }

  // ── Filler/category focus must never become a stored medication name
  //    (Invariant 7), even with real surrounding evidence. ─────────────────
  {
    const text = "I'm off my blood pressure medicine as of today.";
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'medicine', mentions: [{ text: 'medicine' }] }), { hasPending: false });
    assert('FILLER1 "medicine" focus never ADMITs', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (filler/category word)');
  }
  {
    const text = 'Metformin 500 mg, twice daily — that is my prescription.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'prescription', mentions: [{ text: 'prescription' }] }), { hasPending: false });
    assert('FILLER2 "prescription" focus never ADMITs even with real dosage nearby', decision.decision, (v) => v !== 'ADMIT', 'CLARIFY (filler/category word)');
  }

  // ── Malformed proposal — strict parse, no coercion. ──────────────────────
  assert('MALFORMED1 non-JSON', parseSemanticProposal('I cannot help with that.'), (v) => v === null, 'null');
  assert('MALFORMED2 missing focus field', parseSemanticProposal(JSON.stringify({ act: 'assert', mentions: [], predicate: 'take', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED3 confidence as string, not coerced', parseSemanticProposal(JSON.stringify({ act: 'assert', mentions: [], predicate: 'take', focus: 'x', confidence: '0.9' })), (v) => v === null, 'null');
  assert('MALFORMED4 confidence out of range', parseSemanticProposal(JSON.stringify({ act: 'assert', mentions: [], predicate: 'take', focus: 'x', confidence: 1.5 })), (v) => v === null, 'null');
  assert('MALFORMED5 invalid act value', parseSemanticProposal(JSON.stringify({ act: 'diagnose', mentions: [], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED6 mention missing text field', parseSemanticProposal(JSON.stringify({ act: 'assert', mentions: [{ kind: 'thing' }], predicate: 'take', focus: 'x', confidence: 0.9 })), (v) => v === null, 'null');
  assert('MALFORMED7 valid, extracted from surrounding prose', parseSemanticProposal(`Here you go: ${JSON.stringify({ act: 'assert', mentions: [{ text: 'Eliquis' }], predicate: 'take', focus: 'Eliquis', confidence: 0.9 })} done.`), (v) => v !== null, 'parsed SemanticProposal');

  // ── Hallucinated focus not present in raw. Raw text deliberately contains
  //    no MEDICATION trigger word (take/taking/i'm on/prescribed/started/
  //    using/use) so the deterministic floor genuinely does not claim it —
  //    isolating the provenance check under test from Invariant 2's DEFER. ──
  {
    const text = 'My heart medicine keeps my blood pressure steady.';
    assert('HALLUC-fixture floor does not claim this text', detectMedicalEvent(text), (v) => v === null, 'null');
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Ozempic', mentions: [{ text: 'Ozempic' }] }), { hasPending: false });
    assert('HALLUC1 focus not in raw → REJECT', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }
  {
    const text = 'My heart medicine keeps my blood pressure steady.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'medicine', mentions: [{ text: 'Ozempic' }] }), { hasPending: false });
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
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Lisinopril', mentions: [{ text: 'Lisinopril' }] }), { hasPending: false });
    assert('NORMALIZED1 model-inferred name not literally in raw → REJECT', decision.decision, (v) => v === 'REJECT', 'REJECT');
  }

  // ── Low confidence — may cause clarification, never grants admission
  //    (Invariant 6), even with otherwise-perfect evidence. ────────────────
  {
    const text = 'My cardiologist put me on Eliquis.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Eliquis', mentions: [{ text: 'Eliquis' }], confidence: 0.1 }), { hasPending: false });
    assert('LOWCONF1 low confidence with valid evidence → CLARIFY, not ADMIT', decision.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  // ── Pending ownership — pending state owns the turn (Invariant 1). ───────
  {
    const text = 'My cardiologist put me on Eliquis.';
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'Eliquis', mentions: [{ text: 'Eliquis' }] }), { hasPending: true });
    assert('PENDING1 pending owns the turn → DEFER regardless of proposal quality', decision.decision, (v) => v === 'DEFER', 'DEFER');
  }

  // ── Deterministic-floor DEFER — direct check (Invariant 2). ──────────────
  assert('FLOORDEFER1 detectMedicalEvent still claims "I take metformin."', detectMedicalEvent('I take metformin.'), (v) => v !== null, 'non-null');
  {
    const decision = admitMedicationSemanticProposal('I take metformin.', proposal({ focus: 'metformin', mentions: [{ text: 'metformin' }] }), { hasPending: false });
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
    const decision = admitMedicationSemanticProposal(text, proposal({ focus: 'metformin', mentions: [{ text: 'metformin' }] }), { hasPending: false });
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

  // ── Confirmation that hasMedicationDomainEvidence / detectMedicalEvent
  //    remain byte-for-byte unchanged (spot-check against the same fixed
  //    assertions medicationDomainAdmission.test.ts already locks). ────────
  assert('UNCHANGED1 hasMedicationDomainEvidence determiner override intact', hasMedicationDomainEvidence("I'm using a new router", 'router'), (v) => v === false, 'false');
  assert('UNCHANGED2 hasMedicationDomainEvidence lenient trigger intact', hasMedicationDomainEvidence("I'm taking metformin", 'metformin'), (v) => v === true, 'true');
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
