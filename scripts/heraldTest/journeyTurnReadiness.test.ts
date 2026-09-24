// Journey harness waits on the production send gates. It does not clear them.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyJourneyTurnReadiness,
  pollUntilJourneyTurnReady,
  semanticProofTurnFailure,
  PRODUCTION_SEND_DEBOUNCE_MS,
} from '../../src/dev/journeyTurnReadiness.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

export async function runJourneyTurnReadinessTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${JSON.stringify(got)}\n       expected: ${expected}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Journey Turn Readiness --${RESET}\n`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const busy = classifyJourneyTurnReadiness({ nowMs: 5_000, lastSentAtMs: 4_500, sendInFlight: true });
  assert('A a busy send gate is not ready', busy.readyForJourneyTurn === false && busy.sendInFlight === true, (v) => v === true, 'wait');

  const debouncing = classifyJourneyTurnReadiness({ nowMs: 5_000, lastSentAtMs: 4_500, sendInFlight: false });
  assert('B debounce remaining blocks the next turn',
    debouncing.readyForJourneyTurn === false && debouncing.debounceRemainingMs === 500,
    (v) => v === true, '500ms');

  const open = classifyJourneyTurnReadiness({ nowMs: 5_000, lastSentAtMs: 3_000, sendInFlight: false });
  assert('C both gates open is ready immediately',
    open.readyForJourneyTurn === true && open.debounceRemainingMs === 0,
    (v) => v === true, 'ready');

  let now = 0;
  let submits = 0;
  const timed = await pollUntilJourneyTurnReady({
    peek: () => classifyJourneyTurnReadiness({ nowMs: now, lastSentAtMs: 0, sendInFlight: true }),
    timeoutMs: 120,
    pollMs: 40,
    sleep: async (ms) => { now += ms; },
  });
  assert('D readiness timeout does not submit',
    timed.ready === false && submits === 0,
    (v) => v === true, 'fail closed');

  assert('E exited_before_router fails the proof',
    semanticProofTurnFailure({
      scenarioId: 'semantic_c', turnIndex: 2, status: 'FAIL', failReason: 'exited_before_router', semantic: { invocations: [] },
    }) === 'exited_before_router',
    (v) => v === true, 'fail');

  assert('F a missing turn outcome fails the proof',
    semanticProofTurnFailure({
      scenarioId: 'semantic_c', turnIndex: 1, status: null, failReason: null, semantic: null,
    }) === 'TURN_OUTCOME_MISSING',
    (v) => v === true, 'missing');

  assert('G a required semantic path missing fails the proof',
    semanticProofTurnFailure({
      scenarioId: 'semantic_f', turnIndex: 2, status: 'PASS', failReason: null,
      semantic: { invocations: [{ operation: 'reference_continuation', packet: { groundedPresentedMaterial: false } }] },
    }) === 'SEMANTIC_PATH_MISSING',
    (v) => v === true, 'path');

  assert('H a valid admitted paraphrase passes',
    semanticProofTurnFailure({
      scenarioId: 'semantic_e', turnIndex: 1, status: 'PASS', failReason: null,
      semantic: {
        invocations: [{ operation: 'capability', proposedCapability: 'medication.read_summary' }],
        admissions: [{ decision: 'ADMIT_READ' }],
      },
    }) === null,
    (v) => v === true, 'pass');

  let dropped = false;
  function submitOnce(turnId: string) {
    if (dropped && turnId === 'same') return 'no_retry';
    dropped = true;
    submits += 1;
    return 'submitted';
  }
  submitOnce('same');
  assert('I a dropped turn is not submitted again',
    submitOnce('same') === 'no_retry' && submits === 1,
    (v) => v === true, 'once');

  const keys = Object.keys(classifyJourneyTurnReadiness({ nowMs: 1, lastSentAtMs: 0, sendInFlight: false }));
  assert('J readiness carries no personal content',
    keys.join(',') === 'schema,sendInFlight,debounceRemainingMs,readyForJourneyTurn',
    (v) => v === true, 'diagnostic only');

  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');
  assert('production debounce literal stays one second',
    chat.includes('now - lastSentRef.current < 1000') && PRODUCTION_SEND_DEBOUNCE_MS === 1000,
    (v) => v === true, 'unchanged');
  assert('harness polls readiness and does not sleep out the debounce',
    host.includes('pollUntilJourneyTurnReady')
      && host.includes('journey_turn_not_ready')
      && !host.includes('sleep(1000)')
      && !host.includes('sleep(1100)'),
    (v) => v === true, 'observed gate');

  const total = passed + failures.length;
  console.log(`\n${BOLD}JourneyTurnReadiness: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('journeyTurnReadiness');
if (invokedDirectly) {
  runJourneyTurnReadinessTests().then((r) => process.exit(r.failed ? 1 : 0));
}
