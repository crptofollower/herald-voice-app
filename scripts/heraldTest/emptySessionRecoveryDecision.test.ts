// scripts/heraldTest/emptySessionRecoveryDecision.test.ts
// These tests verify only the pure recovery-decision logic in
// evaluateEmptySessionRecovery. They do NOT prove timer arming, timer
// cancellation, native event handling, or that stopRecording is actually
// invoked at runtime. Those remain device-proof-only.
//
// Runner: npx tsx scripts/heraldTest/emptySessionRecoveryDecision.test.ts
// Gate:   wired from run.mjs

// Pure module — useMic re-exports the same symbol, but importing the hook
// file under tsx pulls React Native / Expo and cannot run in this harness.
import { evaluateEmptySessionRecovery, shouldCancelEmptySessionRecovery } from '../../src/hooks/emptySessionRecoveryDecision.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runEmptySessionRecoveryDecisionTests() {
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

  console.log(`\n${BOLD}-- Empty-Session Recovery Decision Tests ----------------${RESET}`);

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 1, engineActive: true, turnActive: false, bufferHasContent: false,
    });
    assert('matched tokens + idle engine → fire', got, (v) => v === 'fire', 'fire');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 2, engineActive: true, turnActive: false, bufferHasContent: false,
    });
    assert('token mismatch → stale_session', got, (v) => v === 'stale_session', 'stale_session');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 1, engineActive: false, turnActive: false, bufferHasContent: false,
    });
    assert('engine inactive → state_changed', got, (v) => v === 'state_changed', 'state_changed');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 1, engineActive: true, turnActive: true, bufferHasContent: false,
    });
    assert('turn active → state_changed', got, (v) => v === 'state_changed', 'state_changed');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 1, engineActive: true, turnActive: false, bufferHasContent: true,
    });
    assert('buffer has content → state_changed', got, (v) => v === 'state_changed', 'state_changed');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 1, engineActive: false, turnActive: true, bufferHasContent: true,
    });
    assert('combined invalid state → state_changed (never fire)', got, (v) => v === 'state_changed', 'state_changed');
  }

  {
    const got = evaluateEmptySessionRecovery({
      armedToken: 1, currentToken: 2, engineActive: false, turnActive: true, bufferHasContent: true,
    });
    assert('token mismatch precedes invalid state → stale_session', got, (v) => v === 'stale_session', 'stale_session');
  }

  console.log(`\n${BOLD}-- shouldCancelEmptySessionRecovery Tests ----------------${RESET}`);

  {
    const got = shouldCancelEmptySessionRecovery({ timerArmed: true, transcript: 'Put' });
    assert('timer armed + non-empty partial content → cancel', got, (v) => v === true, 'true');
  }

  {
    const got = shouldCancelEmptySessionRecovery({ timerArmed: true, transcript: '' });
    assert('timer armed + empty transcript → do not cancel', got, (v) => v === false, 'false');
  }

  {
    const got = shouldCancelEmptySessionRecovery({ timerArmed: true, transcript: undefined });
    assert('timer armed + undefined transcript → do not cancel', got, (v) => v === false, 'false');
  }

  {
    const got = shouldCancelEmptySessionRecovery({ timerArmed: false, transcript: 'Put blue lantern' });
    assert('timer not armed + content present → do not cancel (nothing armed to cancel)', got, (v) => v === false, 'false');
  }

  {
    const got = shouldCancelEmptySessionRecovery({ timerArmed: true, transcript: '   ' });
    assert('timer armed + whitespace-only transcript → do not cancel', got, (v) => v === false, 'false');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EmptySessionRecoveryDecision: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('emptySessionRecoveryDecision.test.ts')) {
  runEmptySessionRecoveryDecisionTests().catch(console.error);
}
