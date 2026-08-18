// scripts/heraldTest/llmClassificationOwnership.test.ts
// LAT-ARC-B (2026-08-18) — alreadyClassifiedByRouteIntent contract.
// Answers "has this utterance already passed through a real local-LLM
// classification this turn?" for every RouteDecision kind. ChatScreen's
// two classifyWithLLM sites skip when this returns true.
//
// Runner: npx tsx --tsconfig ./tsconfig.json ./llmClassificationOwnership.test.ts

import { alreadyClassifiedByRouteIntent } from '../../src/utils/llmClassificationOwnership.ts';
import type { RouteDecision } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const dummyPending: Extract<CommitResult, { status: 'pending' }> = {
  status: 'pending',
  prompt: '',
  pendingKey: '',
  resume: async () => ({ status: 'noop', ack: '' }),
};

export async function runLlmClassificationOwnershipTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- LLM Classification Ownership (LAT-ARC-B) --------------${RESET}\n`);

  function check(label: string, decision: RouteDecision, expected: boolean) {
    assert(label, alreadyClassifiedByRouteIntent(decision), v => v === expected, String(expected));
  }

  check("LCO-1 capture + source:'llm' → true",
    { kind: 'capture', intents: [], source: 'llm', reason: '' }, true);

  check("LCO-2 capture + source:'deterministic' → false",
    { kind: 'capture', intents: [], source: 'deterministic', reason: '' }, false);

  check('LCO-3 backend + llmAlreadyClassified:true → true',
    { kind: 'backend', tier: 3, reason: '', llmAlreadyClassified: true }, true);

  check('LCO-4 backend + llmAlreadyClassified:false → false',
    { kind: 'backend', tier: 3, reason: '', llmAlreadyClassified: false }, false);

  check('LCO-5 backend + llmAlreadyClassified omitted → false',
    { kind: 'backend', tier: 3, reason: '' }, false);

  check('LCO-6 device_read → false',
    { kind: 'device_read', tier: 1, response: '', reason: '' }, false);

  check('LCO-7 device_action → false',
    { kind: 'device_action', tier: 1, actionIntent: { type: 'time' }, reason: '' }, false);

  check('LCO-8 memory_probe → false',
    { kind: 'memory_probe', tier: 2, context: {}, reason: '' }, false);

  check('LCO-9 not_ready → false',
    { kind: 'not_ready', reason: '' }, false);

  check('LCO-10 needs_clarification → false',
    { kind: 'needs_clarification', reason: '' }, false);

  check('LCO-11 phone_repair_needed → false',
    { kind: 'phone_repair_needed', pending: dummyPending, reason: '' }, false);

  check('LCO-12 medical_read_pending → false',
    { kind: 'medical_read_pending', pending: dummyPending, reason: '' }, false);

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LLM Classification Ownership: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('llmClassificationOwnership.test.ts')) {
  runLlmClassificationOwnershipTests().catch(console.error);
}
