// scripts/heraldTest/evidenceGate.test.ts
// ROUTING_FIELD_GROUNDING_DESIGN_SPEC.md — Commit 2 contract tests (§6,
// amended per Commit-1 execution audit: specialty descoped, D7 superseded,
// listName out per C5). Tests verifyVerbatim's evidence-gate integration
// directly — the live wiring, not the inert registry (that's Commit 1's
// evidenceRegistry.test.ts).
//
// T7 substitution note: the spec's illustrative insType-positive example
// ("Medicare supplement") was not tested literally — its exact canonical
// vocabulary string was not available at test-authoring time and guessing
// it risked a false result. Substituted the already-confirmed-safe
// insType=auto / "my auto insurance is Geico" pair (same utterance
// classifierParse.test.ts check #49 already exercises via the vocab path;
// here it is tested directly against verifyVerbatim's evidence gate).
// Correct this to the literal spec wording if/when INSURANCE_SYNONYMS'
// medicare-supplement canonical key is confirmed.
import { verifyVerbatim, type IntentRecord } from '../../src/hooks/llmLayers.ts';
export async function runEvidenceGateTests() {
  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    if (cond) passed++;
    else failures.push(label);
  };
  const vv = (rec: IntentRecord, utt: string) => verifyVerbatim(rec, utt);
  check('T1 relation + "my wife\'s mother is visiting" → mother-in-law PASSES',
    !!vv({ type: 'family_capture', relation: 'mother-in-law' }, "my wife's mother is visiting"));
  check('T2 relation + "my son Hunter" → son PASSES (identity)',
    !!vv({ type: 'family_capture', relation: 'son' }, 'my son Hunter'));
  check('T3 relation − "who is Shannon" → any relation REJECTED',
    vv({ type: 'family_capture', relation: 'mother-in-law' }, 'who is Shannon') === null);
  check('T4 relation − "my family member Shannon" → any specific relation REJECTED (per-value, D2)',
    vv({ type: 'family_capture', relation: 'mother-in-law' }, 'my family member Shannon') === null);
  check('T5 category + "my air conditioning guy is Ed" → hvac PASSES',
    !!vv({ type: 'service_capture', category: 'hvac' }, 'my air conditioning guy is Ed'));
  check('T6 category − "tell me about Joe" → any category REJECTED',
    vv({ type: 'service_capture', category: 'hvac' }, 'tell me about Joe') === null);
  check('T7 insType + "my auto insurance is Geico" → auto PASSES [substituted pair, see header]',
    !!vv({ type: 'insurance_capture', insType: 'auto' }, 'my auto insurance is Geico'));
  check('T8 insType − "what about David" → any insType REJECTED',
    vv({ type: 'insurance_capture', insType: 'auto' }, 'what about David') === null);
  {
    const evidenceGateFailure = vv({ type: 'family_capture', relation: 'mother-in-law' }, 'who is Shannon');
    const substringGateFailure = vv({ type: 'medical_capture', drug: 'ibuprofen', raw: 'x' }, 'I take lisinopril');
    check('T12 evidence-gate and substring-gate rejections produce the identical (null) result',
      evidenceGateFailure === null && substringGateFailure === null);
  }
  check('T14a relation ± "my wife\'s brother is visiting" → mother-in-law REJECTED',
    vv({ type: 'family_capture', relation: 'mother-in-law' }, "my wife's brother is visiting") === null);
  check('T14b relation ± "my wife\'s brother is visiting" → brother-in-law PASSES (same utterance)',
    !!vv({ type: 'family_capture', relation: 'brother-in-law' }, "my wife's brother is visiting"));
  check('T15 category − "my air conditioning guy is Ed" → plumber REJECTED (wrong-value)',
    vv({ type: 'service_capture', category: 'plumber' }, 'my air conditioning guy is Ed') === null);
  check('T9 [substring-gate regression] specialty "my dentist is Dr Smith" → dentist PASSES',
    !!vv({ type: 'medical_visit', specialty: 'dentist' }, 'my dentist is Dr Smith'));
  check('T10 [substring-gate regression] specialty "who\'s Linda" → any specialty REJECTED',
    vv({ type: 'medical_visit', specialty: 'dentist' }, "who's Linda") === null);
  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ evidenceGate: ${failures.length} failed\x1b[0m`);
    for (const f of failures) console.log(`   \x1b[31m✗ ${f}\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ evidenceGate: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}
