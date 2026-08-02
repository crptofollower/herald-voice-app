// scripts/heraldTest/turnStartGate.test.ts
// createTurnStartGate — single-flight / stale-generation / reset contract.
//
// Runner: npx tsx scripts/heraldTest/turnStartGate.test.ts

import { createTurnStartGate } from '../../src/hooks/turnStartGate.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTurnStartGateTests() {
  const failures: string[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- createTurnStartGate Contract Tests --${RESET}\n`);

  // TSG1: single-flight -- two concurrent ensure() calls share one suspend() invocation
  {
    let release: (v: { confirmed: boolean }) => void;
    const gateP = new Promise<{ confirmed: boolean }>((r) => { release = r; });
    let suspendCalls = 0;
    const suspend = async () => { suspendCalls++; return gateP; };
    const gate = createTurnStartGate();
    const p1 = gate.ensure(0, () => 0, suspend);
    const p2 = gate.ensure(0, () => 0, suspend);
    assert('TSG1 concurrent calls share the exact same promise', p1 === p2, (v) => v === true, 'true');
    release!({ confirmed: true });
    await p1;
    assert('TSG1b suspend() invoked exactly once', suspendCalls, (v) => v === 1, '1');
  }

  // TSG2: resolves to suspend()'s confirmed value when gen hasn't changed
  {
    const gate = createTurnStartGate();
    const got = await gate.ensure(0, () => 0, async () => ({ confirmed: true }));
    assert('TSG2 resolves confirmed=true when gen unchanged', got, (v) => v === true, 'true');
  }
  {
    const gate = createTurnStartGate();
    const got = await gate.ensure(0, () => 0, async () => ({ confirmed: false }));
    assert('TSG2b resolves confirmed=false when suspend() reports false', got, (v) => v === false, 'false');
  }

  // TSG3: stale resolution -- gen changed while suspend() was pending -> false, regardless of suspend()'s answer
  {
    let currentGen = 0;
    let release: (v: { confirmed: boolean }) => void;
    const gateP = new Promise<{ confirmed: boolean }>((r) => { release = r; });
    const gate = createTurnStartGate();
    const p = gate.ensure(0, () => currentGen, async () => gateP);
    currentGen = 1; // simulates stop() bumping genRef while we were awaiting
    release!({ confirmed: true }); // suspend itself says yes...
    const got = await p;
    assert('TSG3 stale generation forces false even though suspend() confirmed true',
      got, (v) => v === false, 'false');
  }

  // TSG4: reset() clears the single-flight cache -- a call after reset() re-invokes suspend()
  {
    let suspendCalls = 0;
    const suspend = async () => { suspendCalls++; return { confirmed: true }; };
    const gate = createTurnStartGate();
    await gate.ensure(0, () => 0, suspend);
    gate.reset();
    await gate.ensure(1, () => 1, suspend);
    assert('TSG4 reset() causes a fresh suspend() call for the next turn',
      suspendCalls, (v) => v === 2, '2');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}turnStartGate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('turnStartGate.test.ts')) {
  runTurnStartGateTests().catch(console.error);
}
