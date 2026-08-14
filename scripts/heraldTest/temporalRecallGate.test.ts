// scripts/heraldTest/temporalRecallGate.test.ts
// Targeted regression test for the Rung-4 temporal-recall gate, added
// 2026-08-14 fixing the son/weekend -> grocery false-positive. Tests the
// pure predicate only (isTemporalRecallRequest) -- no SQLite dependency,
// no classifyQuery invocation, matching this codebase's established
// pattern for isolating decision logic from side-effecting reads.

import { isTemporalRecallRequest } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTemporalRecallGateTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, input: string, expected: boolean) {
    const got = isTemporalRecallRequest(input);
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       input: ${DIM}"${input}"${RESET}\n       got: ${DIM}${got}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  console.log(`\n${BOLD}-- Temporal Recall Gate Tests --------------------------${RESET}`);

  // MUST NOT trigger -- ordinary reported speech inside personal narrative.
  assert('A: third-person "he said" must not trigger recall',
    "He said he might come over this morning.", false);
  assert('B: third-person "she told me" must not trigger recall',
    "She told me yesterday that she's moving.", false);
  assert('C: elided-subject "and said" must not trigger recall',
    "My son called today and said he's doing well.", false);
  assert('D: "talked to" (no reported-speech verb match) must not trigger recall',
    "I talked to my grandson yesterday.", false);
  assert('E: doctor already excluded via RECALL_UNCOVERED_DOMAIN, must not trigger',
    "My doctor said today that everything looks good.", false);
  assert('F: the original founding failure case must not trigger',
    "I talked to my son this morning and he said he might come over this weekend and help me with a few things around the house.", false);

  // MUST preserve -- legitimate first-person recall-shaped requests.
  assert('G: "what did I mention" must still trigger recall',
    "What did I mention earlier?", true);
  assert('H: "did I mention" must still trigger recall',
    "Did I mention that earlier?", true);
  assert('I: "I mentioned" must still trigger recall',
    "I mentioned something about this earlier.", true);
  assert('J: "remind me what I told" must still trigger recall',
    "Remind me what I told you earlier.", true);

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TemporalRecallGate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('temporalRecallGate.test.ts')) {
  runTemporalRecallGateTests().catch(console.error);
}
