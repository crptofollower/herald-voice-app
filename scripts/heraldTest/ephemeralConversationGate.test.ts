// scripts/heraldTest/ephemeralConversationGate.test.ts
// Authority-gate regression tests for the ephemeral-conversation seam,
// added 2026-08-14. Tests canRunEphemeralConversation() only -- the pure
// predicate, no ctx/native dependency, no ChatScreen simulation. Proves
// every previously-ratified authority owner still declines-first.

import { canRunEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const BASE = {
  rdTier: 3 as const,
  hasStructuredCaptures: false,
  isPersonalCaptureRisk: false,
  hasPending: false,
  llmStatus: 'ready' as const,
  classifierBusy: false,
  ephemeralBusy: false,
};

export async function runEphemeralConversationGateTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: boolean, expected: boolean) {
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${got}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  console.log(`\n${BOLD}-- Ephemeral Conversation Gate Tests --------------------------${RESET}`);

  assert('A: all conditions satisfied → may run', canRunEphemeralConversation(BASE), true);
  assert('B: rdTier 1 (deterministic owns it) → must not run', canRunEphemeralConversation({ ...BASE, rdTier: 1 }), false);
  assert('C: rdTier 2 (memory probe owns it) → must not run', canRunEphemeralConversation({ ...BASE, rdTier: 2 }), false);
  assert('D: structured capture found → must not run', canRunEphemeralConversation({ ...BASE, hasStructuredCaptures: true }), false);
  assert('E: personal-capture-risk fence active → must not run', canRunEphemeralConversation({ ...BASE, isPersonalCaptureRisk: true }), false);
  assert('F: a pending workflow owns the reply → must not run', canRunEphemeralConversation({ ...BASE, hasPending: true }), false);
  assert('G: llmStatus not ready → must not run', canRunEphemeralConversation({ ...BASE, llmStatus: 'loading' }), false);
  assert('H: llmStatus unavailable → must not run', canRunEphemeralConversation({ ...BASE, llmStatus: 'unavailable' }), false);
  assert('I: llmStatus error → must not run', canRunEphemeralConversation({ ...BASE, llmStatus: 'error' }), false);
  assert('J: classifier mid-generation (warmup or classify in flight) → must not run', canRunEphemeralConversation({ ...BASE, classifierBusy: true }), false);
  assert('K: ephemeral generation already in flight → must not run', canRunEphemeralConversation({ ...BASE, ephemeralBusy: true }), false);

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EphemeralConversationGate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('ephemeralConversationGate.test.ts')) {
  runEphemeralConversationGateTests().catch(console.error);
}
