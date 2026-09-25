import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_SPEECH_CONTINUATION_GAP_MS,
  applyReopenedNativeSession,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  resetOpenSpeechTurnIdsForTests,
} from '../../src/hooks/openSpeechTurnBoundary.ts';
import { proposeSpeechCompletion } from '../../src/routing/semanticProvider.ts';
import {
  armSpeechProductionPathProof,
  journeyCommittedSegmentEvents,
  noteClassifierContext,
  noteSpeechAdmissionRequested,
  noteSpeechSemanticInvoked,
  noteSpeechSemanticSettled,
  noteSpeechSendStarted,
  noteSpeechTranscriptDelivered,
  resetSpeechProductionPathProof,
  snapshotSpeechProductionPathProof,
  SPEECH_PRODUCTION_PATH_FIXTURE,
} from '../../src/dev/speechProductionPathProof.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const failures: { label: string; expected: string; got: string }[] = [];
let passed = 0;

function assert(label: string, cond: boolean, expected: string, got: string): void {
  if (cond) passed += 1;
  else failures.push({ label, expected, got });
}

export async function runSpeechProductionPathJourneyTests(): Promise<{
  passed: number;
  failed: number;
  total: number;
  failures: { label: string; expected: string; got: string }[];
}> {
  resetOpenSpeechTurnIdsForTests();
  resetSpeechProductionPathProof();
  let state = createIdleOpenSpeechTurnState();
  const events = journeyCommittedSegmentEvents(1, SPEECH_PRODUCTION_PATH_FIXTURE, 1_000);
  let reopen = false;
  for (const event of events) {
    const step = reduceOpenSpeechTurn(state, event);
    state = step.state;
    if (step.effects.some((fx) => fx.type === 'reopen_native')) reopen = true;
    assert(
      'committed segment does not deliver before the reducer requests admission',
      !step.effects.some((fx) => fx.type === 'deliver' || fx.type === 'evaluate_admission'),
      'no deliver or admission yet',
      step.effects.map((fx) => fx.type).join(','),
    );
  }
  assert('production native end reopens', reopen && state.phase === 'awaiting_continuation', 'reopen', String(state.phase));
  state = applyReopenedNativeSession(state, 2);
  const ready = reduceOpenSpeechTurn(state, { type: 'native_listening_ready', nativeSessionId: 2, nowMs: 1_100 });
  state = ready.state;
  assert(
    'production listening-ready arms the continuation gap',
    ready.effects.some((fx) => fx.type === 'arm_continuation_gap'),
    'arm_continuation_gap',
    ready.effects.map((fx) => fx.type).join(','),
  );
  const gap = reduceOpenSpeechTurn(state, { type: 'continuation_gap_elapsed', generation: state.continuationGeneration });
  state = gap.state;
  const admission = gap.effects.find((fx) => fx.type === 'evaluate_admission');
  assert('reducer reaches exactly one evaluate_admission', admission?.type === 'evaluate_admission', 'evaluate_admission', gap.effects.map((fx) => fx.type).join(','));
  let calls = 0;
  const ctx = {
    id: 11,
    completion: async () => {
      calls += 1;
      return { text: 'complete', timings: { prompt_ms: 1, predicted_ms: 1, prompt_n: 4, cache_n: 4 } };
    },
  };
  armSpeechProductionPathProof();
  noteSpeechAdmissionRequested();
  noteSpeechSemanticInvoked(ctx.id);
  const proposal = admission && admission.type === 'evaluate_admission'
    ? await proposeSpeechCompletion(admission.text, ctx as never)
    : 'uncertain';
  noteSpeechSemanticSettled();
  assert('production proposeSpeechCompletion returns complete', proposal === 'complete', 'complete', String(proposal));
  assert('exactly one speech completion call', calls === 1, '1', String(calls));
  const admitted = reduceOpenSpeechTurn(state, {
    type: 'admission_evaluated',
    trigger: 'continuation_gap',
    proposal,
    text: admission && admission.type === 'evaluate_admission' ? admission.text : '',
    epoch: admission && admission.type === 'evaluate_admission' ? admission.epoch : 0,
    heraldTurnId: admission && admission.type === 'evaluate_admission' ? admission.heraldTurnId : 0,
  });
  assert(
    'production admission delivers once',
    admitted.effects.filter((fx) => fx.type === 'deliver').length === 1,
    'one deliver',
    admitted.effects.map((fx) => fx.type).join(','),
  );
  noteSpeechTranscriptDelivered();
  noteSpeechSendStarted();
  noteClassifierContext(ctx.id);
  const snap = snapshotSpeechProductionPathProof();
  assert('speech settles before classifier', snap.speechSemanticSettled && snap.classifierInvokedAfterSpeech, 'ordered', JSON.stringify({
    settled: snap.speechSemanticSettled,
    classifier: snap.classifierInvokedAfterSpeech,
  }));
  assert('same classifier context id', snap.sameClassifierContext && snap.speechClassifierContextId === 11, '11', String(snap.classifyClassifierContextId));
  assert('proof envelope has no fixture text', !JSON.stringify(snap).includes(SPEECH_PRODUCTION_PATH_FIXTURE), 'absent', 'present');
  assert('continuation gap constant unchanged', OPEN_SPEECH_CONTINUATION_GAP_MS === 1200, '1200', String(OPEN_SPEECH_CONTINUATION_GAP_MS));

  const useMic = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'src/dev/androidJourneyHost.ts'), 'utf8');
  const probe = host.slice(host.indexOf('async function runSpeechProductionPathProof'), host.indexOf('export function bindJourneySendMessage'));
  assert(
    'useMic injects through the production boundary',
    useMic.includes('journeyCommittedSegmentEvents') && useMic.includes('executeBoundaryEffects(applyBoundary(event))'),
    'production dispatch',
    'missing',
  );
  assert(
    'journey probe does not use typed submit or transcript injection',
    !probe.includes('submitTurn') && !probe.includes('injectHeardTranscript') && !probe.includes("sendMessage"),
    'no shortcut',
    probe.includes('submitTurn') || probe.includes('injectHeardTranscript') ? 'shortcut' : 'sendMessage',
  );
  assert(
    'ChatScreen keeps production delivery and classification',
    chat.includes('injectCommittedOpenSpeechSegment(text)') &&
      chat.includes("sendMessage(trimmed, 'speech')") &&
      chat.includes('proposeSpeechCompletion(text, ctx)') &&
      chat.includes('proposeLocalClassification(t, ctx'),
    'production chain',
    'missing',
  );

  console.log(`SpeechProductionPathJourney: ${passed} passed, ${failures.length} failed`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('speechProductionPathJourney');
if (isDirect) {
  runSpeechProductionPathJourneyTests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
