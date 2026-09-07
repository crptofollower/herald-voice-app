// scripts/heraldTest/medicationDomainAdmission.test.ts
// Locks the medication domain-evidence admission repair. History:
//   2026-09-06: closed the "bare trigger + arbitrary noun" false-positive
//     class (vacation/trip/class/router/camera/walks/...) — see
//     HERALD_MEDICATION_DOMAIN_EVIDENCE_ADMISSION_REPAIR_2026-09-06.md.
//   2026-09-07: Tier-2 mechanism-tier closure. The 2026-09-06 repair still
//     admitted a bare candidate via two syntactic-shape proxies that are not
//     themselves medication evidence — candidate capitalization, and
//     unconditional trust of five "lenient" trigger verbs. A bounded 3B
//     semantic-discrimination experiment proved neither proxy discriminates
//     medication from ordinary proper nouns/activities ("I started
//     CrossFit."/"I started Toastmasters." satisfied both; "I started
//     skydiving." — lowercase, unambiguous — proved the lenient-trigger
//     fallback was never really about capitalization at all). Both proxies
//     are removed. hasMedicationDomainEvidence now recognizes ONLY Tier-H
//     evidence: dosage, explicit terminology, doctor attribution, specialty
//     attribution, discontinuation shape. Disclosed, accepted consequence:
//     bare medication statements relying SOLELY on the removed proxies
//     (P1/P2/P4/P7/P9 below) no longer receive deterministic authority —
//     the floor abstains and the utterance becomes eligible for the
//     Semantic Interpretation V1 seam, exactly as it already does for
//     "I started CrossFit." This file's old-green expectations for those
//     cases are updated below, not preserved — an old test staying green
//     is not evidence the removed behavior was safe.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import { detectMedicalEvent, hasMedicationDomainEvidence } from '../../src/utils/detectMedicalEvent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runMedicationDomainAdmissionTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medication Domain-Evidence Admission --${RESET}\n`);

  // ── NEGATIVES — ordinary narrative must NOT become medication capture ──
  // Structurally varied across every trigger family named in the task:
  // take/taking, on, use/using, started.
  const negatives: [string, string][] = [
    ['N1', "We're taking a vacation next month."],
    ['N2', "We're taking a trip to the mountains."],
    ['N3', "I'm taking a class this semester."],
    ['N4', "I'm using a new router at home."],
    ['N5', "I'm on vacation next week."],
    ['N6', "I'm taking my car to the shop."],
    ['N7', "I'm using a new phone."],
    ['N8', "I'm on a plane."],
    ['N9', "I started a new job."],
    ['N10', "I take the train to work."],
    // Additional structural variety beyond the required minimum, per the
    // generalization-proof requirement (same trigger families, different
    // ordinary objects).
    ['N11', "I'm using a new laptop."],
    ['N12', "I started a new hobby."],
    ['N13', "I'm on a diet."],
    ['N14', "I take my dog for a walk every morning."],
    // Tier-2 generalization — capitalized ordinary proper nouns/activities,
    // the exact class the 3B experiment proved indistinguishable from
    // medication under the removed proxies. Not a blacklist: these are
    // ordinary NEGATIVE examples in the same structural families as N1-N14,
    // simply capitalized, proving the floor no longer treats capitalization
    // as evidence at all, in either direction.
    ['N19', 'I started CrossFit.'],
    ['N20', 'I started Toastmasters.'],
    ['N21', "I'm on LinkedIn."],
    ['N22', "I'm on the PTA."],
    ['N23', "I'm taking the SATs tomorrow."],
    ['N24', 'I started Peloton.'],
  ];
  for (const [id, text] of negatives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} not a medical event — "${text}"`, ev, (v) => v === null, 'null');
  }

  // ── TIER-H POSITIVES — genuine, evidenced medication statements remain
  //    fully capturable, unchanged by the Tier-2 closure. ─────────────────
  const positives: [string, string, string][] = [
    ['P3', 'My doctor told me to start taking Eliquis', 'Eliquis'],   // specialty evidence
    ['P5', 'I take Metformin 500 mg twice a day.', 'Metformin'],       // dosage evidence
    ['P6', "I'm on Eliquis 5 mg.", 'Eliquis'],                          // dosage evidence
    ['P8', 'I was prescribed lisinopril.', 'lisinopril'],               // terminology evidence
  ];
  for (const [id, text, drug] of positives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} type medication — "${text}"`, ev?.type, (v) => v === 'medication', 'medication');
    assert(`${id} drug_name "${drug}"`, ev?.drug_name, (v) => v === drug, drug);
  }

  // ── TIER-2 CLOSURE — bare medication statements with NO Tier-H evidence
  //    no longer receive deterministic authority (disclosed, accepted
  //    consequence, verified by direct execution). Structurally
  //    indistinguishable, by grammar alone, from N19-N24 above — that
  //    identity is the whole point of the closure, not an oversight. These
  //    utterances remain eligible for the Semantic Interpretation V1 seam
  //    (flag OFF; observable behavior today is silent fallthrough, same as
  //    any other undetected utterance). ───────────────────────────────────
  const abstainedBareCases: [string, string][] = [
    ['P1', 'I take Eliquis'],
    ['P2', "I'm taking metformin"],
    ['P4', 'I stopped taking Eliquis'],
    ['P7', "I'm using insulin."],
    ['P9', 'I started metformin yesterday.'],
  ];
  for (const [id, text] of abstainedBareCases) {
    const ev = detectMedicalEvent(text);
    assert(`${id} floor now abstains (Tier-2 closure) — "${text}"`, ev, (v) => v === null, 'null');
  }

  // ── Discontinuation shape unaffected (separate, already-narrow pattern) ──
  {
    const ev = detectMedicalEvent('My doctor told me to take me off Eliquis');
    assert('P10 discontinuation shape still admits', ev?.type, (v) => v === 'medication', 'medication');
    assert('P10 discontinuation drug_name', ev?.drug_name, (v) => v === 'Eliquis', 'Eliquis');
  }
  {
    const ev = detectMedicalEvent("I'm off Eliquis now");
    assert('P11 bare "off" ack stays non-medical (unchanged, unrelated path)', ev, (v) => v === null, 'null');
  }

  // ── Direct unit coverage of the evidence function (Tier-H only) ────────
  assert('U1 dosage alone is sufficient evidence',
    hasMedicationDomainEvidence('I take 10mg of something', 'something'),
    (v) => v === true, 'true');
  assert('U2 explicit terminology alone is sufficient evidence',
    hasMedicationDomainEvidence('I need to refill my prescription', undefined),
    (v) => v === true, 'true');
  // U3 (Tier-2 closure): capitalized bare candidate is NO LONGER sufficient
  // by itself — capitalization was never medication evidence, only a proxy
  // for "looks like a proper noun," proven non-discriminating by direct
  // execution (identical shape to "I started CrossFit."/"I'm on LinkedIn.").
  assert('U3 capitalized bare candidate is NO LONGER sufficient evidence (Tier-2 closure)',
    hasMedicationDomainEvidence("I'm on Eliquis", 'Eliquis'),
    (v) => v === false, 'false');
  assert('U4 lowercase bare candidate after a determiner is NOT sufficient',
    hasMedicationDomainEvidence("I'm using a new router", 'router'),
    (v) => v === false, 'false');
  // U5 (Tier-2 closure): the lenient-trigger fallback is removed entirely —
  // a bare lowercase candidate with no other evidence is no longer
  // sufficient either. Case-blind: this was never really about
  // capitalization (see U3) — it was unconditional trust of the trigger
  // verb, proven unsafe by "I started skydiving." satisfying the identical
  // rule while being unambiguously non-medical.
  assert('U5 lowercase bare candidate, lenient trigger, is NO LONGER sufficient (Tier-2 closure)',
    hasMedicationDomainEvidence("I'm taking metformin", 'metformin'),
    (v) => v === false, 'false');
  assert('U6 lowercase bare candidate with no determiner, non-lenient "on" trigger, is NOT sufficient',
    hasMedicationDomainEvidence("I'm on vacation next week", 'vacation'),
    (v) => v === false, 'false');

  // ── Pre-Tier-2 positional guards (determiner-scan, trailing-content
  //    allowance) are now dead code within hasMedicationDomainEvidence,
  //    removed along with the lenient-trigger fallback they gated. These
  //    negatives remain correctly null — now via the simpler, blunter rule
  //    "no Tier-H evidence at all" rather than the removed positional
  //    machinery — proving the collapse doesn't reopen anything the
  //    2026-09-06 repair closed. ──────────────────────────────────────────
  const residualNegatives: [string, string][] = [
    ['N15', 'We used to take long walks.'],
    ['N16', "I've started using my new camera."],
    ['N17', 'I take short naps.'],
    ['N18', "I've started using new software at work."],
  ];
  for (const [id, text] of residualNegatives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} not a medical event — "${text}"`, ev, (v) => v === null, 'null');
  }

  // U7/U8 previously exercised the now-removed positional determiner/
  // trailing-content machinery by name; both outcomes stay correctly false,
  // now simply because no Tier-H evidence is present at all — the blunter,
  // post-collapse reason, re-asserted directly for continued function-level
  // coverage (not just via detectMedicalEvent above).
  assert('U7 no Tier-H evidence → false (was: determiner-scan mechanism, now removed)',
    hasMedicationDomainEvidence("I've started using my new camera.", 'using'),
    (v) => v === false, 'false');
  assert('U8 no Tier-H evidence → false (was: trailing-content mechanism, now removed)',
    hasMedicationDomainEvidence('We used to take long walks.', 'long'),
    (v) => v === false, 'false');
  // U9 previously asserted a bare candidate with a trailing temporal token
  // was "sufficient" — that was true only via the now-removed lenient-
  // trigger fallback, and is no longer true (Tier-2 closure).
  assert('U9 determiner-less bare candidate, no Tier-H evidence, is NO LONGER sufficient (Tier-2 closure)',
    hasMedicationDomainEvidence('I started metformin yesterday.', 'metformin'),
    (v) => v === false, 'false');
  assert('U10 determiner-less bare candidate followed by a recognized dosage span remains sufficient (Tier-H, unaffected)',
    hasMedicationDomainEvidence('I take metformin 500 mg.', 'metformin'),
    (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicationDomainAdmission: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicationDomainAdmission.test.ts')) {
  runMedicationDomainAdmissionTests().catch(console.error);
}
