// Speech admission convergence. A committed stitch gets one incomplete
// extension, then deterministic admission. Caps and provider failure admit.

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

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function drive(events: OpenSpeechEvent[]) {
  resetOpenSpeechTurnIdsForTests();
  let state = createIdleOpenSpeechTurnState();
  const deliveries: string[] = [];
  const effects: OpenSpeechEffect[] = [];
  let reopenCount = 0;
  for (const event of events) {
    const out = reduceOpenSpeechTurn(state, event);
    state = out.state;
    effects.push(...out.effects);
    for (const fx of out.effects) {
      if (fx.type === 'deliver') deliveries.push(fx.utterance);
      if (fx.type === 'reopen_native') {
        reopenCount += 1;
        state = applyReopenedNativeSession(state, state.nativeSessionId + 1);
      }
    }
  }
  return { state, deliveries, effects, reopenCount };
}

function gap(text: string, proposal: 'complete' | 'incomplete' | 'uncertain' | null, epoch: number, session = 1): OpenSpeechEvent[] {
  return [
    { type: 'native_end', nativeSessionId: session, speechStarted: true, partial: '', nowMs: 300 + epoch * 400 },
    { type: 'native_listening_ready', nativeSessionId: session + 1, nowMs: 320 + epoch * 400 },
    { type: 'continuation_gap_elapsed', generation: epoch },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal, text, epoch, heraldTurnId: 1 },
  ];
}

export async function runSpeechAdmissionConvergenceTests() {
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

  console.log(`\n${BOLD}-- Speech Admission Convergence --${RESET}\n`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  const complete = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Hello there' },
    ...gap('Hello there', 'complete', 1),
  ]);
  assert('A complete admits the committed stitch once',
    complete.deliveries.length === 1 && complete.deliveries[0] === 'Hello there',
    (v) => v === true, 'one delivery');

  const continued = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'I was talking to' },
    ...gap('I was talking to', 'incomplete', 1),
    { type: 'native_result_final', nativeSessionId: 3, text: 'Martin' },
    { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 900 },
    { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 920 },
    { type: 'continuation_gap_elapsed', generation: 2 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'complete', text: 'I was talking to Martin', epoch: 2, heraldTurnId: 1 },
  ]);
  assert('B a new segment stitches and delivers once',
    continued.deliveries.length === 1 && continued.deliveries[0] === 'I was talking to Martin' && continued.reopenCount === 3,
    (v) => v === true, 'one combined turn');

  const same = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Still talking' },
    ...gap('Still talking', 'incomplete', 1),
    ...gap('Still talking', 'incomplete', 2, 3),
    ...gap('Still talking', 'incomplete', 3, 5),
  ]);
  assert('C a second incomplete for the same stitch admits once',
    same.deliveries.length === 1 && same.deliveries[0] === 'Still talking' && same.reopenCount === 3,
    (v) => v === true, 'no third reopen');

  for (const proposal of ['uncertain', null] as const) {
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Committed' },
      ...gap('Committed', proposal, 1),
    ]);
    assert(`D ${proposal ?? 'null'} admits once`,
      run.deliveries.length === 1 && run.deliveries[0] === 'Committed' && run.reopenCount === 1,
      (v) => v === true, 'one delivery');
  }

  const micSrc = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  assert('E useMic maps a thrown admission resolver to null',
    micSrc.includes('.catch(() => null)') && micSrc.includes('proposal: proposal ?? null'),
    (v) => v === true, 'failure becomes null');
  for (const label of ['unavailable', 'timeout', 'parse failure'] as const) {
    const run = drive([
      { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
      { type: 'native_result_final', nativeSessionId: 1, text: 'Keep this' },
      ...gap('Keep this', null, 1),
    ]);
    assert(`E ${label} converges to one delivery`,
      run.deliveries.length === 1 && run.deliveries[0] === 'Keep this' && run.reopenCount === 1,
      (v) => v === true, 'admit');
  }

  const repeatedEnd = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Once' },
    ...gap('Once', 'complete', 1),
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 2000 },
    { type: 'native_end', nativeSessionId: 2, speechStarted: true, partial: '', nowMs: 2100 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'complete', text: 'Once', epoch: 1, heraldTurnId: 1 },
  ]);
  assert('F repeated native ends do not duplicate delivery',
    repeatedEnd.deliveries.length === 1,
    (v) => v === true, 'exactly one');

  const stale = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Hello' },
    ...gap('Hello', 'incomplete', 1),
    { type: 'native_result_final', nativeSessionId: 3, text: 'again' },
    { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 900 },
    { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 920 },
    { type: 'continuation_gap_elapsed', generation: 2 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'complete', text: 'Hello', epoch: 1, heraldTurnId: 1 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'incomplete', text: 'Hello', epoch: 1, heraldTurnId: 9 },
  ]);
  assert('G a stale admission result does not reopen, deliver, or cancel',
    stale.deliveries.length === 0
      && stale.state.phase === 'awaiting_continuation'
      && stale.reopenCount === 3
      && !stale.effects.some((e) => e.type === 'bounded_recovery'),
    (v) => v === true, 'current episode untouched');

  const maxSegments = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    ...[1, 2, 3, 4, 5].flatMap((n) => ([
      { type: 'native_result_final' as const, nativeSessionId: n, text: `s${n}` },
      { type: 'native_end' as const, nativeSessionId: n, speechStarted: true, partial: '', nowMs: n * 100 },
    ])),
  ]);
  assert('H max segments with content delivers once',
    maxSegments.deliveries.length === 1
      && maxSegments.deliveries[0] === 's1 s2 s3 s4 s5'
      && !maxSegments.effects.some((e) => e.type === 'bounded_recovery'),
    (v) => v === true, 'no discard');

  const maxTurn = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Long story' },
    { type: 'max_turn_elapsed' },
    { type: 'admission_evaluated', trigger: 'max_turn', proposal: 'incomplete', text: 'Long story', epoch: 1, heraldTurnId: 1 },
  ]);
  assert('H max duration with content delivers once',
    maxTurn.deliveries.length === 1 && maxTurn.deliveries[0] === 'Long story',
    (v) => v === true, 'no discard');

  const empty = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_end', nativeSessionId: 1, speechStarted: false, partial: '', nowMs: 400 },
  ]);
  assert('I an empty episode keeps no-recognizable-speech and fabricates nothing',
    empty.deliveries.length === 0
      && empty.effects.some((e) => e.type === 'no_recognizable_speech' && e.reason === 'silence'),
    (v) => v === true, 'silence');

  const early = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Not yet' },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
  ]);
  assert('J contentful native end alone does not deliver',
    early.deliveries.length === 0 && early.reopenCount === 1 && early.state.phase !== 'finalized',
    (v) => v === true, 'continuation remains');

  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  assert('K post-TTS handoff starts open speech and does not admit',
    chatSrc.includes("startRecording('post_tts_handoff')") && !chatSrc.includes('decideSpeechAdmission'),
    (v) => v === true, 'entry only');

  const adversarial = drive([
    { type: 'herald_start', mode: 'open', nativeSessionId: 1, nowMs: 0 },
    { type: 'native_result_final', nativeSessionId: 1, text: 'Hold then cap' },
    { type: 'native_end', nativeSessionId: 1, speechStarted: true, partial: '', nowMs: 200 },
    { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 220 },
    { type: 'continuation_gap_elapsed', generation: 1 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'incomplete', text: 'Hold then cap', epoch: 1, heraldTurnId: 1 },
    { type: 'admission_evaluated', trigger: 'continuation_gap', proposal: 'incomplete', text: 'Hold then cap', epoch: 1, heraldTurnId: 1 },
    { type: 'max_turn_elapsed' },
    { type: 'native_end', nativeSessionId: 3, speechStarted: true, partial: '', nowMs: 30000 },
  ]);
  assert('L native end, stale evaluation, reopen, and cap deliver at most once',
    adversarial.deliveries.length === 1 && adversarial.deliveries[0] === 'Hold then cap' && adversarial.reopenCount === 2,
    (v) => v === true, 'at most once');

  const total = passed + failures.length;
  console.log(`\n${BOLD}SpeechAdmissionConvergence: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('speechAdmissionConvergence');
if (invokedDirectly) {
  runSpeechAdmissionConvergenceTests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
