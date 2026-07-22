// scripts/heraldTest/isUnresolvedPersonalCapture.test.ts
// Law 5 (Spine §3a) fail-closed predicate — isUnresolvedPersonalCapture.
//
// Runner: npx tsx scripts/heraldTest/isUnresolvedPersonalCapture.test.ts

import {
  isUnresolvedPersonalCapture,
  type RouteDecision,
} from '../../src/routing/routeIntent.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

export async function runIsUnresolvedPersonalCaptureTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- isUnresolvedPersonalCapture Contract Tests --------------${RESET}\n`);

  {
    const decision: RouteDecision = {
      kind: 'capture',
      intents: [],
      source: 'llm',
      reason: 'test',
    };
    assert(
      'IPC1 kind: capture → true',
      isUnresolvedPersonalCapture(decision),
      (v) => v === true,
      'true',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'backend',
      tier: 3,
      reason: 'live:data',
    };
    assert(
      'IPC2 kind: backend → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'device_read',
      tier: 1,
      response: 'test',
      reason: 'test',
    };
    assert(
      'IPC3 kind: device_read → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'device_action',
      tier: 1,
      actionIntent: { type: 'time' },
      reason: 'test',
    };
    assert(
      'IPC4 kind: device_action → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'not_ready',
      reason: 'test',
    };
    assert(
      'IPC5 kind: not_ready → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'memory_probe',
      tier: 2,
      context: {},
      reason: 'test',
    };
    assert(
      'IPC6 kind: memory_probe → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  {
    const decision: RouteDecision = {
      kind: 'needs_clarification',
      reason: 'test',
    };
    assert(
      'IPC7 kind: needs_clarification → false',
      isUnresolvedPersonalCapture(decision),
      (v) => v === false,
      'false',
    );
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}isUnresolvedPersonalCapture: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('isUnresolvedPersonalCapture.test.ts')) {
  runIsUnresolvedPersonalCaptureTests().catch(console.error);
}
