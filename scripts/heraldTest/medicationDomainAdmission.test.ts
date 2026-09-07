// scripts/heraldTest/medicationDomainAdmission.test.ts
// Locks the medication domain-evidence admission repair (2026-09-06). Root
// cause: generic medication trigger verbs ("taking", "using", "on",
// "started") admitted hasMedication with zero medication-specific evidence,
// so ordinary narrative ("We're taking a vacation next month.") produced a
// false capture ("Want me to remember vacation as a medication?") — proven
// in HERALD_SEP6_DEVICE_ROUTE_DIAGNOSTIC_2026-09-06.md, repaired per
// HERALD_MEDICATION_DOMAIN_EVIDENCE_ADMISSION_REPAIR_2026-09-06.md.
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
  ];
  for (const [id, text] of negatives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} not a medical event — "${text}"`, ev, (v) => v === null, 'null');
  }

  // ── POSITIVES — genuine medication statements must remain capturable ───
  const positives: [string, string, string][] = [
    ['P1', 'I take Eliquis', 'Eliquis'],
    ['P2', "I'm taking metformin", 'metformin'],
    ['P3', 'My doctor told me to start taking Eliquis', 'Eliquis'],
    ['P4', 'I stopped taking Eliquis', 'Eliquis'],
    ['P5', 'I take Metformin 500 mg twice a day.', 'Metformin'],
    ['P6', "I'm on Eliquis 5 mg.", 'Eliquis'],
    ['P7', "I'm using insulin.", 'insulin'],
    ['P8', 'I was prescribed lisinopril.', 'lisinopril'],
    ['P9', 'I started metformin yesterday.', 'metformin'],
  ];
  for (const [id, text, drug] of positives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} type medication — "${text}"`, ev?.type, (v) => v === 'medication', 'medication');
    assert(`${id} drug_name "${drug}"`, ev?.drug_name, (v) => v === drug, drug);
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

  // ── Direct unit coverage of the new evidence function ──────────────────
  assert('U1 dosage alone is sufficient evidence',
    hasMedicationDomainEvidence('I take 10mg of something', 'something'),
    (v) => v === true, 'true');
  assert('U2 explicit terminology alone is sufficient evidence',
    hasMedicationDomainEvidence('I need to refill my prescription', undefined),
    (v) => v === true, 'true');
  assert('U3 capitalized bare candidate is sufficient evidence',
    hasMedicationDomainEvidence("I'm on Eliquis", 'Eliquis'),
    (v) => v === true, 'true');
  assert('U4 lowercase bare candidate after a determiner is NOT sufficient',
    hasMedicationDomainEvidence("I'm using a new router", 'router'),
    (v) => v === false, 'false');
  assert('U5 lowercase bare candidate with no determiner, lenient trigger, is sufficient',
    hasMedicationDomainEvidence("I'm taking metformin", 'metformin'),
    (v) => v === true, 'true');
  assert('U6 lowercase bare candidate with no determiner, non-lenient "on" trigger, is NOT sufficient',
    hasMedicationDomainEvidence("I'm on vacation next week", 'vacation'),
    (v) => v === false, 'false');

  // ── Residual floor repair (2026-09-06 follow-up) ────────────────────────
  // HERALD_MEDICATION_FLOOR_ACCEPTANCE_CONTRADICTION_DIAGNOSTIC_2026-09-06.md.
  // The original determiner override above only inspected the literal token
  // immediately after the trigger match — proven insufficient for two
  // distinct shapes it never covered (neither appears in the original N1-N14
  // set, nor in the September 6 diagnostic's own device evidence): a
  // determiner-less bare-object narrative continuation, and a repeated/
  // stacked trigger verb that hides a real determiner behind it.
  const residualNegatives: [string, string][] = [
    ['N15', 'We used to take long walks.'],
    ['N16', "I've started using my new camera."],
    // Generalization beyond the required minimum, per this file's own
    // established practice (N11-N14 above did the same for the original
    // repair): same two failure shapes, different objects/trigger verbs.
    ['N17', 'I take short naps.'],
    ['N18', "I've started using new software at work."],
  ];
  for (const [id, text] of residualNegatives) {
    const ev = detectMedicalEvent(text);
    assert(`${id} not a medical event — "${text}"`, ev, (v) => v === null, 'null');
  }

  // Direct unit coverage of the two new mechanisms, isolated from each other.
  assert('U7 determiner hidden behind a repeated trigger verb is found and required',
    hasMedicationDomainEvidence("I've started using my new camera.", 'using'),
    (v) => v === false, 'false');
  assert('U8 determiner-less bare candidate followed by ordinary content is NOT sufficient',
    hasMedicationDomainEvidence('We used to take long walks.', 'long'),
    (v) => v === false, 'false');
  assert('U9 determiner-less bare candidate followed by a recognized temporal token remains sufficient (unchanged true-positive shape)',
    hasMedicationDomainEvidence('I started metformin yesterday.', 'metformin'),
    (v) => v === true, 'true');
  assert('U10 determiner-less bare candidate followed by a recognized dosage span remains sufficient',
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
