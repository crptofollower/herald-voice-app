// scripts/heraldTest/domainWritersCoverage.test.ts
// PRE-B F2 structural invariant: every classifier-surviving non-pass
// IntentRecord type that may enter capture has a DOMAIN_WRITERS entry —
// so allConverted() is true for any valid classifier output array and the
// ChatScreen !allConverted → dispatchLocalIntent branch stays dead.
//
// Keep CLASSIFIER_CAPTURE_TYPES in sync with llmLayers.ts KNOWN_TYPES minus 'pass'.
//
// Runner: npx tsx scripts/heraldTest/domainWritersCoverage.test.ts

import { allConverted, DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

/** Mirrors llmLayers.ts KNOWN_TYPES with 'pass' excluded. */
const CLASSIFIER_CAPTURE_TYPES = [
  'list_add',
  'insurance_capture',
  'medical_capture',
  'medical_visit',
  'medical_visit_upcoming',
  'doctor_intro_capture',
  'service_capture',
  'family_capture',
  'phone_capture',
  'address_capture',
  'emergency_contact',
  'diagnosis_capture',
  'contact_call',
  'todo_add',
] as const satisfies readonly IntentRecord['type'][];

export async function runDomainWritersCoverageTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- DOMAIN_WRITERS coverage (PRE-B F2 invariant) ---------${RESET}\n`);

  for (const type of CLASSIFIER_CAPTURE_TYPES) {
    assert(
      `DW1 ${type} → DOMAIN_WRITERS entry`,
      type in DOMAIN_WRITERS,
      (v) => v === true,
      'registered writer',
    );
    assert(
      `DW2 ${type} → allConverted([{type}])`,
      allConverted([{ type } as IntentRecord]),
      (v) => v === true,
      'allConverted true',
    );
  }

  assert(
    'DW3 pass has no DOMAIN_WRITERS entry',
    'pass' in DOMAIN_WRITERS,
    (v) => v === false,
    'no writer for pass',
  );

  assert(
    'DW4 pass-only array → allConverted false',
    allConverted([{ type: 'pass' }]),
    (v) => v === false,
    'allConverted false',
  );

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ domainWritersCoverage: ${failures.length} failed\x1b[0m`);
    for (const f of failures) {
      console.log(`  ${f.label}: got ${JSON.stringify(f.got)}, expected ${f.expected}`);
    }
  } else {
    console.log(`\x1b[32m✅ domainWritersCoverage: ${passed}/${total} passed\x1b[0m`);
  }

  return { passed, failed: failures.length, total };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runDomainWritersCoverageTests().then((r) => process.exit(r.failed ? 1 : 0));
}
