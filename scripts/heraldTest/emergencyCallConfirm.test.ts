// scripts/heraldTest/emergencyCallConfirm.test.ts
// Emergency-call confirm classifier — regression for the confirm_call
// pending used by ChatScreen dispatchEmergency() when no emergency
// contact is configured. The proven defect: a leading no/cancel with
// trailing conversational content was treated as a bounded decline and
// answered with "who were you trying to reach?" — fabricating an
// alternate call target.
//
// Scope: classifyEmergencyCallReply only. ChatScreen reply-string
// branches are not exercised here — phoneConfirm.test.ts likewise tests
// the helper, not the screen (EEC-10 skipped; no ChatScreen harness).
//
// Runner: npx tsx --tsconfig ./tsconfig.json ./emergencyCallConfirm.test.ts

import { classifyEmergencyCallReply } from '../../src/utils/emergencyCallConfirm.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runEmergencyCallConfirmTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Emergency-call Confirm --------------------------------${RESET}\n`);

  assert('EEC-1 "No I was talking to someone else" → reject_with_content',
    classifyEmergencyCallReply('No I was talking to someone else'),
    v => v === 'reject_with_content', 'reject_with_content');

  assert('EEC-2 "No" → no',
    classifyEmergencyCallReply('No'),
    v => v === 'no', 'no');

  assert('EEC-3 "Cancel" → no',
    classifyEmergencyCallReply('Cancel'),
    v => v === 'no', 'no');

  assert('EEC-4 "Never mind" → no',
    classifyEmergencyCallReply('Never mind'),
    v => v === 'no', 'no');

  assert('EEC-5 "Yes" → yes',
    classifyEmergencyCallReply('Yes'),
    v => v === 'yes', 'yes');

  assert('EEC-6 "Yeah" → yes',
    classifyEmergencyCallReply('Yeah'),
    v => v === 'yes', 'yes');

  assert('EEC-7 "maybe" → unresolved',
    classifyEmergencyCallReply('maybe'),
    v => v === 'unresolved', 'unresolved');

  assert('EEC-8 "Nope, that\'s not right" → reject_with_content',
    classifyEmergencyCallReply("Nope, that's not right"),
    v => v === 'reject_with_content', 'reject_with_content');

  assert('EEC-9 "Yes but don\'t call" is unresolved, not yes',
    classifyEmergencyCallReply("Yes but don't call"),
    v => v === 'unresolved', 'unresolved');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Emergency-call Confirm: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('emergencyCallConfirm.test.ts')) {
  runEmergencyCallConfirmTests().catch(console.error);
}
