// Slice 7 — a committed recognition fragment is not yet a user turn.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  applyReopenedNativeSession,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  resetOpenSpeechTurnIdsForTests,
  type OpenSpeechEffect,
  type OpenSpeechEvent,
  type OpenSpeechTurnState,
} from '../../src/hooks/openSpeechTurnBoundary.ts';
import { projectSpeechTurnEnvelope } from '../../src/hooks/speechTurnEnvelope.ts';
import { decideSpeechAdmission } from '../../src/hooks/speechAdmission.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function drive(events: OpenSpeechEvent[]) {
  let state = createIdleOpenSpeechTurnState();
  const deliveries: string[] = [];
  for (const event of events) {
    const out = reduceOpenSpeechTurn(state, event);
    state = out.state;
    for (const fx of out.effects) {
      if (fx.type === 'deliver') deliveries.push(fx.utterance);
      if (fx.type === 'reopen_native') {
        state = applyReopenedNativeSession(state, state.nativeSessionId + 1);
      }
    }
  }
  return { state, deliveries };
}

export async function runConversationOrchestratorSlice7Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 7 --${RESET}\n`);
  resetOpenSpeechTurnIdsForTests();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const envelopeSrc = fs.readFileSync(path.join(root, 'src/hooks/speechTurnEnvelope.ts'), 'utf8');
  const boundarySrc = fs.readFileSync(path.join(root, 'src/hooks/openSpeechTurnBoundary.ts'), 'utf8');
  assert('admission does not parse wording',
    !envelopeSrc.includes('.test(') && !envelopeSrc.includes('RegExp') && !envelopeSrc.includes('semanticProvider'),
    (v) => v === true, 'no grammar');
  assert('the speech boundary does not call conversation processing',
    !boundarySrc.includes('processUtterance') && !boundarySrc.includes('applyIntents'),
    (v) => v === true, 'no turn');

  const held = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'I was talking to' },
  ]);
  const provisional = projectSpeechTurnEnvelope(held.state);
  assert('a committed fragment stays provisional',
    held.deliveries.length === 0 && provisional.conversationalStatus === 'provisional' && provisional.recognitionCommitted === true,
    (v) => v === true, 'held');
  assert('provisional text is not an admitted turn',
    provisional.text === 'I was talking to' && provisional.admissionSource === null,
    (v) => v === true, 'not admitted');

  const gapped = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'I was talking to' },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 300 },
    { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 320 },
    { type: 'continuation_gap_elapsed', generation: 1 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'incomplete', text: 'I was talking to', epoch: 1, heraldTurnId: 2 },
  ]);
  assert('an ordinary continuation gap does not admit',
    gapped.deliveries.length === 0 && projectSpeechTurnEnvelope(gapped.state).conversationalStatus === 'provisional',
    (v) => v === true, 'held after gap');
  assert('only the first incomplete may hold; failure and completion admit',
    decideSpeechAdmission({ trigger: 'continuation_gap', proposal: 'incomplete' }) === 'hold'
      && decideSpeechAdmission({ trigger: 'continuation_gap', proposal: 'incomplete', extensionConsumed: true }) === 'admit'
      && decideSpeechAdmission({ trigger: 'continuation_gap', proposal: null }) === 'admit'
      && decideSpeechAdmission({ trigger: 'continuation_gap', proposal: 'uncertain' }) === 'admit'
      && decideSpeechAdmission({ trigger: 'continuation_gap', proposal: 'complete' }) === 'admit'
      && decideSpeechAdmission({ trigger: 'max_turn', proposal: 'uncertain' }) === 'admit',
    (v) => v === true, 'convergence');

  const continued = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'I was talking to' },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 300 },
    { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 320 },
    { type: 'continuation_gap_elapsed', generation: 1 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'incomplete', text: 'I was talking to', epoch: 1, heraldTurnId: 3 },
    { type: 'native_result_final', nativeSessionId: 3, text: 'Martin about Ireland' },
    { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 900 },
    { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 920 },
    { type: 'continuation_gap_elapsed', generation: 2 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'complete', text: 'I was talking to Martin about Ireland', epoch: 2, heraldTurnId: 3 },
  ]);
  const admitted = projectSpeechTurnEnvelope(continued.state, 'continuation_gap');
  assert('the same session continues in order and admits once',
    continued.deliveries.length === 1 && continued.deliveries[0] === 'I was talking to Martin about Ireland' && admitted.conversationalStatus === 'admitted',
    (v) => v === true, 'once');

  resetOpenSpeechTurnIdsForTests();
  const first = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'alpha' },
    { type: 'automated_teardown' },
  ]);
  const second = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 9, nowMs: 5000 },
    { type: 'native_result_final', nativeSessionId: 9, text: 'beta' },
  ]);
  assert('an abandoned fragment does not join the next session',
    projectSpeechTurnEnvelope(first.state).conversationalStatus === 'abandoned'
      && projectSpeechTurnEnvelope(first.state).text === ''
      && projectSpeechTurnEnvelope(second.state).text === 'beta'
      && second.state.heraldTurnId !== first.state.heraldTurnId,
    (v) => v === true, 'isolated');

  resetOpenSpeechTurnIdsForTests();
  const confirm = drive([
    { type: 'herald_start', mode: 'control_confirmation', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'yes' },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
  ]);
  const deadline = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'I was talking to' },
    { type: 'max_turn_elapsed' },
  ]);
  assert('a contentful duration cap delivers the stitch once',
    deadline.deliveries.length === 1
      && deadline.deliveries[0] === 'I was talking to'
      && projectSpeechTurnEnvelope(deadline.state).conversationalStatus === 'admitted',
    (v) => v === true, 'admit at cap');

  assert('control confirmation still admits on the provider end',
    confirm.deliveries.length === 1 && confirm.deliveries[0] === 'yes' && projectSpeechTurnEnvelope(confirm.state, 'control_confirmation_native_end').conversationalStatus === 'admitted',
    (v) => v === true, 'pending path');

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice7: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice7');
if (invokedDirectly) {
  runConversationOrchestratorSlice7Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
