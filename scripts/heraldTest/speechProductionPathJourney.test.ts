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
  FORMER_SPEECH_PRODUCTION_PROBE_TIMEOUT_MS,
  SPEECH_PRODUCTION_PROBE_TIMEOUT_MS,
  classifySpeechProductionPreconditions,
  noteSpeechEmitComplete,
  receiveSpeechProductionCommand,
  resetSpeechJourneyLivenessForTests,
  snapshotSpeechJourneyLiveness,
} from '../../src/dev/speechJourneyLiveness.ts';
import {
  armSpeechProductionPathProof,
  journeyCommittedSegmentEvents,
  noteClassifierSettled,
  noteClassifierStarted,
  noteSendProcessingReturned,
  noteSpeechAdmissionRequested,
  noteSpeechBoundaryEntered,
  noteSpeechSemanticInvoked,
  noteSpeechSemanticSettled,
  noteSpeechSendStarted,
  noteSpeechTranscriptDelivered,
  resetSpeechProductionPathProof,
  snapshotSpeechProductionPathProof,
  speechProductionPathSatisfied,
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
  let early = false;
  for (const event of events) {
    const step = reduceOpenSpeechTurn(state, event);
    state = step.state;
    if (step.effects.some((fx) => fx.type === 'reopen_native')) reopen = true;
    if (step.effects.some((fx) => fx.type === 'deliver' || fx.type === 'evaluate_admission')) early = true;
  }
  assert(
    'committed segment does not deliver before the reducer requests admission',
    !early,
    'no deliver or admission yet',
    String(early),
  );
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
  noteSpeechBoundaryEntered();
  noteSpeechAdmissionRequested();
  noteSpeechSemanticInvoked(ctx.id);
  assert('unarmed proof notes are no-ops', snapshotSpeechProductionPathProof().speechSemanticInvoked === false, 'false', 'true');
  armSpeechProductionPathProof();
  noteSpeechBoundaryEntered();
  noteSpeechAdmissionRequested();
  noteSpeechSemanticInvoked(ctx.id);
  const proposal = admission && admission.type === 'evaluate_admission'
    ? await proposeSpeechCompletion(admission.text, ctx as never)
    : 'uncertain';
  noteSpeechSemanticSettled('ok', 7);
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
  noteClassifierStarted(ctx.id);
  noteClassifierSettled('ok', 8);
  noteSendProcessingReturned();
  const snap = snapshotSpeechProductionPathProof();
  assert('speech settles before classifier by proof sequence', speechProductionPathSatisfied(snap), 'satisfied', JSON.stringify({
    speech: snap.speechNativeOutcome,
    classifier: snap.classifierNativeOutcome,
    order: [snap.speechSemanticInvokedSeq, snap.classifierSettledSeq],
  }));
  assert('same classifier context id', snap.sameClassifierContext && snap.speechClassifierContextId === 11, '11', String(snap.classifyClassifierContextId));
  assert('proof envelope has no fixture text', !JSON.stringify(snap).includes(SPEECH_PRODUCTION_PATH_FIXTURE), 'absent', 'present');
  armSpeechProductionPathProof();
  noteSpeechSemanticInvoked(1);
  noteSpeechSemanticSettled('ok', 1);
  noteClassifierStarted(2);
  noteClassifierSettled('ok', 2);
  assert('different context ids are not the same context', snapshotSpeechProductionPathProof().sameClassifierContext === false, 'false', 'true');
  resetSpeechProductionPathProof();
  armSpeechProductionPathProof();
  noteClassifierStarted(11);
  noteClassifierSettled('ok', 3);
  assert('classifier before speech settlement does not count', snapshotSpeechProductionPathProof().classifierInvokedAfterSpeech === false, 'false', 'true');
  armSpeechProductionPathProof();
  noteSpeechSemanticInvoked(11);
  noteSpeechSemanticSettled('ok', 4);
  noteSpeechTranscriptDelivered();
  noteSpeechSendStarted();
  noteClassifierStarted(11);
  noteClassifierSettled('refused', null);
  noteSendProcessingReturned();
  assert('classifier refusal is not a pass', speechProductionPathSatisfied(snapshotSpeechProductionPathProof()) === false, 'false', 'true');
  armSpeechProductionPathProof();
  noteSpeechSemanticInvoked(11);
  noteSpeechSemanticSettled('error', null);
  noteSpeechTranscriptDelivered();
  noteSpeechSendStarted();
  noteClassifierStarted(11);
  noteClassifierSettled('ok', 5);
  noteSendProcessingReturned();
  assert('speech rejection is not a pass', speechProductionPathSatisfied(snapshotSpeechProductionPathProof()) === false, 'false', 'true');
  armSpeechProductionPathProof();
  noteSpeechSendStarted();
  noteSpeechSemanticInvoked(11);
  noteSpeechSemanticSettled('ok', 6);
  noteSpeechTranscriptDelivered();
  noteClassifierStarted(11);
  noteClassifierSettled('ok', 7);
  noteSendProcessingReturned();
  assert('out-of-order proof notes are not a pass', speechProductionPathSatisfied(snapshotSpeechProductionPathProof()) === false, 'false', 'true');
  assert('continuation gap constant unchanged', OPEN_SPEECH_CONTINUATION_GAP_MS === 1200, '1200', String(OPEN_SPEECH_CONTINUATION_GAP_MS));
  const statusRef = { current: 'loading' };
  const capturedReady = () => statusRef.current === 'ready';
  const staleReady = ((status: string) => () => status === 'ready')('loading');
  assert('captured readiness starts false', capturedReady() === false && staleReady() === false, 'false', 'true');
  statusRef.current = 'ready';
  assert(
    'ref-backed readiness becomes true without rebinding',
    capturedReady() === true && staleReady() === false,
    'live true, stale false',
    `live=${capturedReady()} stale=${staleReady()}`,
  );

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
      chat.includes('proposeLocalClassification(t, ctx') &&
      /peekClassifierReady: \(\) => llmStatusRef\.current === 'ready'/.test(chat) &&
      /llmStatusRef\.current = llmStatus/.test(chat),
    'production chain',
    'missing',
  );

  resetSpeechJourneyLivenessForTests();
  let handlerExceptionEmitted = false;
  await receiveSpeechProductionCommand(async () => {}, () => { handlerExceptionEmitted = true; });
  assert(
    'listener-entry breadcrumb appears when the command is received',
    snapshotSpeechJourneyLiveness().some((crumb) => crumb.step === 'listener_received'),
    'listener_received',
    snapshotSpeechJourneyLiveness().map((crumb) => crumb.step).join(','),
  );
  resetSpeechJourneyLivenessForTests();
  handlerExceptionEmitted = false;
  await receiveSpeechProductionCommand(async () => { throw new Error('hidden'); }, () => { handlerExceptionEmitted = true; });
  assert(
    'handler exception becomes an explicit Journey failure signal',
    handlerExceptionEmitted && snapshotSpeechJourneyLiveness().some((crumb) => crumb.step === 'handler_entered'),
    'handler_exception',
    String(handlerExceptionEmitted),
  );
  assert(
    'handler exception envelope reason is fixed',
    host.includes("speechProofEnvelope('FAIL', 'handler_exception')"),
    'handler_exception',
    'missing',
  );
  resetSpeechJourneyLivenessForTests();
  assert(
    'missing runtime becomes explicit FAIL',
    classifySpeechProductionPreconditions({
      injectBound: false,
      classifierBound: true,
      ttsBound: true,
      classifierReady: true,
      speaking: false,
    }) === 'speech_inject_unbound',
    'speech_inject_unbound',
    'other',
  );
  resetSpeechJourneyLivenessForTests();
  assert(
    'classifier readiness failure becomes explicit FAIL',
    classifySpeechProductionPreconditions({
      injectBound: true,
      classifierBound: true,
      ttsBound: true,
      classifierReady: false,
      speaking: false,
    }) === 'classifier_not_ready',
    'classifier_not_ready',
    'other',
  );
  resetSpeechJourneyLivenessForTests();
  noteSpeechEmitComplete(false, false);
  assert(
    'emitComplete native-missing failure is visible',
    snapshotSpeechJourneyLiveness().some((crumb) => crumb.step === 'emit_complete_failed' && crumb.emitResult === 'native_missing'),
    'native_missing',
    snapshotSpeechJourneyLiveness().map((crumb) => crumb.emitResult).join(','),
  );
  resetSpeechJourneyLivenessForTests();
  noteSpeechEmitComplete(true, true);
  assert(
    'emitComplete throw is visible and carries no exception text',
    snapshotSpeechJourneyLiveness().some((crumb) => crumb.step === 'emit_complete_failed' && crumb.emitResult === 'threw')
      && !JSON.stringify(snapshotSpeechJourneyLiveness()).includes('hidden'),
    'threw',
    JSON.stringify(snapshotSpeechJourneyLiveness()),
  );
  const speechTest = fs.readFileSync(path.join(root, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldSpeechProductionPathV1Test.kt'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'android/app/src/journey/java/ai/apexempire/herald/journey/HeraldJourneyBridge.kt'), 'utf8');
  const readyAt = speechTest.indexOf('awaitSpeechPreconditions');
  const probeAt = speechTest.indexOf('probeSpeechProductionPath');
  assert(
    'outer probe timeout is narrower than the former blind wait',
    SPEECH_PRODUCTION_PROBE_TIMEOUT_MS < FORMER_SPEECH_PRODUCTION_PROBE_TIMEOUT_MS
      && bridge.includes('fun probeSpeechProductionPath(timeoutMs: Long = 180_000L)')
      && !bridge.includes('1_680_000L')
      && speechTest.includes('PROBE_TIMEOUT_MS = 180_000L'),
    '180000',
    String(SPEECH_PRODUCTION_PROBE_TIMEOUT_MS),
  );
  assert(
    'prerequisite readiness is established before the speech probe',
    readyAt > 0 && probeAt > readyAt && speechTest.includes('READINESS_TIMEOUT_MS = 25L * 60L * 1000L'),
    'readiness then probe',
    `ready=${readyAt} probe=${probeAt}`,
  );
  assert(
    'speech probe no longer waits out model readiness',
    !probe.includes('SEMANTIC_ENGINE_READINESS_TIMEOUT_MS') && probe.includes('classifySpeechProductionPreconditions'),
    'immediate precondition',
    'still waiting',
  );
  const oracle = fs.readFileSync(path.join(root, 'src/dev/speechProductionPathProof.ts'), 'utf8');
  assert(
    'accepted proof oracle is unchanged by liveness repair',
    oracle.includes('function speechProductionPathSatisfied') && !oracle.includes('speechJourneyLiveness') && !oracle.includes('handler_exception'),
    'oracle untouched',
    'oracle drifted',
  );
  const useMicProd = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/routing/semanticProvider.ts'), 'utf8');
  assert(
    'ordinary production behavior remains inert',
    !useMicProd.includes('speechJourneyLiveness') && !provider.includes('speechJourneyLiveness') && !chat.includes('speechJourneyLiveness'),
    'journey-only',
    'production import',
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
