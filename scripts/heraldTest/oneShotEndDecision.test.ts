// scripts/heraldTest/oneShotEndDecision.test.ts
// These tests verify only the pure one-shot end / no-speech decision.
// They do NOT prove native 'end' ordering, that useMic skips restart,
// or that onTranscript fires at runtime. Those remain device-proof-only.
//
// Runner: npx tsx scripts/heraldTest/oneShotEndDecision.test.ts
// Gate:   wired from run.mjs

import { decideOneShotEnd, decideOneShotNoSpeech } from '../../src/hooks/oneShotEndDecision.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runOneShotEndDecisionTests() {
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

  console.log(`\n${BOLD}-- One-Shot End Decision Tests --------------------------${RESET}`);

  {
    const got = decideOneShotEnd({ bufferHasContent: true, speechStarted: true });
    assert('A: buffered transcript + native end → flush (no restart)', got,
      (v) => v === 'flush', 'flush');
  }

  {
    const got = decideOneShotEnd({ bufferHasContent: true, speechStarted: false });
    assert('B: valid buffered transcript → flush exactly once (never restart)', got,
      (v) => v === 'flush', 'flush');
  }

  {
    const got = decideOneShotEnd({ bufferHasContent: false, speechStarted: false });
    assert('C: true silence + native end → no invented transcript', got,
      (v) => v === 'silence', 'silence');
  }

  {
    const got = decideOneShotEnd({ bufferHasContent: false, speechStarted: true });
    assert('D: speech onset + empty buffer + end → heard_unrecognized (no invented transcript)', got,
      (v) => v === 'heard_unrecognized', 'heard_unrecognized');
  }

  {
    const got = decideOneShotNoSpeech({ bufferHasContent: true });
    assert('E: no-speech + buffered transcript → flush (no restart)', got,
      (v) => v === 'flush', 'flush');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}OneShotEndDecision: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('oneShotEndDecision.test.ts')) {
  runOneShotEndDecisionTests().catch(console.error);
}
