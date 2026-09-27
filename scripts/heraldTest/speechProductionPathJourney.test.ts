import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_SPEECH_CONTINUATION_GAP_MS,
  applyReopenedNativeSession,
  classifyNativeListeningReady,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  resetOpenSpeechTurnIdsForTests,
} from '../../src/hooks/openSpeechTurnBoundary.ts';
import { proposeSpeechCompletion } from '../../src/routing/semanticProvider.ts';
import {
  logGapTimerClear,
  logMaxTurnTimerClear,
  resetSpeechLifecycleRing,
  scheduleOpenSpeechGapTimerProbes,
  snapshotSpeechLifecycleRing,
} from '../../src/hooks/speechLifecycleInvariants.ts';
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
  armDeterministicSpeechPathProof,
  deterministicSpeechPathSatisfied,
  noteDeterministicAdmissionRequested,
  noteDeterministicContinuationGapElapsed,
  noteDeterministicResolverReturned,
  noteDeterministicSendProcessingReturned,
  noteDeterministicSpeechBoundaryEntered,
  noteDeterministicSpeechSendStarted,
  noteDeterministicTranscriptDelivered,
  resetDeterministicSpeechPathProof,
  snapshotDeterministicSpeechPathProof,
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
      ttsBound: true,
      speaking: false,
    }) === 'speech_inject_unbound',
    'speech_inject_unbound',
    'other',
  );
  resetSpeechJourneyLivenessForTests();
  assert(
    'classifier readiness is not required',
    classifySpeechProductionPreconditions({
      injectBound: true,
      ttsBound: true,
      speaking: false,
    }) === null,
    'null',
    'blocked',
  );
  resetSpeechJourneyLivenessForTests();
  assert(
    'TTS-active condition still fails',
    classifySpeechProductionPreconditions({
      injectBound: true,
      ttsBound: true,
      speaking: true,
    }) === 'tts_not_idle',
    'tts_not_idle',
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
  const ttsAt = speechTest.indexOf('probeSpeechPreconditions');
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
  const enableAt = speechTest.indexOf('JourneyLocationPreflight.enableBeforeLaunch');
  const launchAt = speechTest.indexOf('ActivityScenario.launch');
  const finishAt = speechTest.indexOf('JourneyLocationPreflight.finishAfterLaunch');
  assert(
    'location preflight finishes before the speech proof starts',
    enableAt >= 0 && launchAt > enableAt && finishAt > launchAt && probeAt > finishAt,
    'preflight then proof',
    `${enableAt},${launchAt},${finishAt},${probeAt}`,
  );
  const useLocation = fs.readFileSync(path.join(root, 'src/hooks/useLocation.ts'), 'utf8');
  const useMicSource = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const boundary = fs.readFileSync(path.join(root, 'src/hooks/openSpeechTurnBoundary.ts'), 'utf8');
  assert(
    'production location and speech files do not run the location shell',
    !useLocation.includes('set-location-enabled')
      && !useMicSource.includes('set-location-enabled')
      && !boundary.includes('set-location-enabled')
      && boundary.includes('OPEN_SPEECH_CONTINUATION_GAP_MS = 1200')
      && boundary.includes('OPEN_SPEECH_MAX_TURN_MS = 20_000'),
    'production untouched',
    'shell or timer drift',
  );
  const policy = fs.readFileSync(path.join(root, 'android/app/src/journeyPreflight/java/ai/apexempire/herald/journey/JourneyLocationPreflightPolicy.kt'), 'utf8');
  assert(
    'preflight blocks proof on shell, resolution, and resume failures',
    ['shell_enable_failed', 'resolution_failed', 'main_activity_not_resumed', 'location_overlay_present']
      .every((reason) => policy.includes(reason)),
    'fail closed',
    'missing reason',
  );
  assert(
    'TTS idle is checked before the speech probe without a classifier wait',
    ttsAt > 0 && probeAt > ttsAt
      && speechTest.includes('TTS_PROBE_TIMEOUT_MS = 5_000L')
      && !speechTest.includes('classifier_not_ready')
      && !speechTest.includes('25L * 60L * 1000L'),
    'tts then probe',
    `tts=${ttsAt} probe=${probeAt}`,
  );
  assert(
    'speech probe no longer waits out model readiness',
    !probe.includes('SEMANTIC_ENGINE_READINESS_TIMEOUT_MS') && probe.includes('classifySpeechProductionPreconditions'),
    'immediate precondition',
    'still waiting',
  );
  const oracle = fs.readFileSync(path.join(root, 'src/dev/speechProductionPathProof.ts'), 'utf8');
  assert(
    'legacy native oracle still requires speech and classifier completions',
    oracle.includes("snap.speechNativeOutcome === 'ok'")
      && oracle.includes("snap.classifierNativeOutcome === 'ok'")
      && oracle.includes('function speechProductionPathSatisfied')
      && oracle.includes('function deterministicSpeechPathSatisfied'),
    'both oracles',
    'missing',
  );
  const useMicProd = fs.readFileSync(path.join(root, 'src/hooks/useMic.ts'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/routing/semanticProvider.ts'), 'utf8');
  assert(
    'ordinary production behavior remains inert',
    !useMicProd.includes('speechJourneyLiveness') && !provider.includes('speechJourneyLiveness') && !chat.includes('speechJourneyLiveness'),
    'journey-only',
    'production import',
  );

  const nullProposal = await proposeSpeechCompletion('turn the lamp on', null);
  assert('production resolver returns uncertain for a null classifier context', nullProposal === 'uncertain', 'uncertain', String(nullProposal));
  resetOpenSpeechTurnIdsForTests();
  let detState = createIdleOpenSpeechTurnState();
  for (const event of journeyCommittedSegmentEvents(3, SPEECH_PRODUCTION_PATH_FIXTURE, 5_000)) {
    detState = reduceOpenSpeechTurn(detState, event).state;
  }
  detState = applyReopenedNativeSession(detState, 4);
  detState = reduceOpenSpeechTurn(detState, { type: 'native_listening_ready', nativeSessionId: 4, nowMs: 5_100 }).state;
  const detGap = reduceOpenSpeechTurn(detState, { type: 'continuation_gap_elapsed', generation: detState.continuationGeneration });
  const detAdmission = detGap.effects.find((fx) => fx.type === 'evaluate_admission');
  const detAdmitted = reduceOpenSpeechTurn(detGap.state, {
    type: 'admission_evaluated',
    trigger: 'continuation_gap',
    proposal: nullProposal,
    text: detAdmission && detAdmission.type === 'evaluate_admission' ? detAdmission.text : '',
    epoch: detAdmission && detAdmission.type === 'evaluate_admission' ? detAdmission.epoch : 0,
    heraldTurnId: detAdmission && detAdmission.type === 'evaluate_admission' ? detAdmission.heraldTurnId : 0,
  });
  assert(
    'uncertain proposal admits once and does not extend',
    detAdmitted.effects.filter((fx) => fx.type === 'deliver').length === 1
      && !detAdmitted.effects.some((fx) => fx.type === 'reopen_native'),
    'one deliver',
    detAdmitted.effects.map((fx) => fx.type).join(','),
  );

  function passDeterministic(): void {
    resetDeterministicSpeechPathProof();
    armDeterministicSpeechPathProof();
    noteDeterministicSpeechBoundaryEntered();
    noteDeterministicContinuationGapElapsed();
    noteDeterministicAdmissionRequested();
    noteDeterministicResolverReturned({
      proposal: 'uncertain',
      classifierContextNull: true,
      speechNativeCompletionObserved: false,
    });
    noteDeterministicTranscriptDelivered();
    noteDeterministicSpeechSendStarted();
    noteDeterministicSendProcessingReturned();
  }
  passDeterministic();
  assert(
    'deterministic production path satisfies the new oracle',
    deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()),
    'satisfied',
    JSON.stringify(snapshotDeterministicSpeechPathProof()),
  );
  assert(
    'deterministic envelope has no fixture text',
    !JSON.stringify(snapshotDeterministicSpeechPathProof()).includes(SPEECH_PRODUCTION_PATH_FIXTURE),
    'absent',
    'present',
  );
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({
    proposal: 'uncertain',
    classifierContextNull: true,
    speechNativeCompletionObserved: true,
  });
  noteDeterministicTranscriptDelivered();
  noteDeterministicSpeechSendStarted();
  noteDeterministicSendProcessingReturned();
  assert('unexpected speech native completion fails', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({ proposal: 'complete', classifierContextNull: true, speechNativeCompletionObserved: false });
  noteDeterministicTranscriptDelivered();
  noteDeterministicSpeechSendStarted();
  noteDeterministicSendProcessingReturned();
  assert('complete proposal fails the production contract', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({ proposal: 'incomplete', classifierContextNull: true, speechNativeCompletionObserved: false });
  noteDeterministicTranscriptDelivered();
  noteDeterministicSpeechSendStarted();
  noteDeterministicSendProcessingReturned();
  assert('incomplete proposal fails the production contract', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({ proposal: 'uncertain', classifierContextNull: true, speechNativeCompletionObserved: false });
  noteDeterministicSpeechSendStarted();
  noteDeterministicSendProcessingReturned();
  assert('no delivery fails', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  passDeterministic();
  noteDeterministicTranscriptDelivered();
  assert('duplicate delivery fails', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({ proposal: 'uncertain', classifierContextNull: true, speechNativeCompletionObserved: false });
  noteDeterministicTranscriptDelivered();
  noteDeterministicSpeechSendStarted();
  assert('missing sendProcessingReturned fails', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  resetDeterministicSpeechPathProof();
  armDeterministicSpeechPathProof();
  noteDeterministicSpeechSendStarted();
  noteDeterministicSpeechBoundaryEntered();
  noteDeterministicContinuationGapElapsed();
  noteDeterministicAdmissionRequested();
  noteDeterministicResolverReturned({ proposal: 'uncertain', classifierContextNull: true, speechNativeCompletionObserved: false });
  noteDeterministicTranscriptDelivered();
  noteDeterministicSendProcessingReturned();
  assert('out-of-order deterministic notes fail', deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');
  passDeterministic();
  noteDeterministicAdmissionRequested();
  assert('a second admission is an incomplete extension and fails', snapshotDeterministicSpeechPathProof().incompleteExtensionTaken === true && deterministicSpeechPathSatisfied(snapshotDeterministicSpeechPathProof()) === false, 'false', 'true');

  resetOpenSpeechTurnIdsForTests();
  let readyState = createIdleOpenSpeechTurnState();
  for (const event of journeyCommittedSegmentEvents(7, SPEECH_PRODUCTION_PATH_FIXTURE, 8_000)) {
    readyState = reduceOpenSpeechTurn(readyState, event).state;
  }
  readyState = applyReopenedNativeSession(readyState, 8);
  const readyDisposition = classifyNativeListeningReady(readyState, 8);
  const readyStep = reduceOpenSpeechTurn(readyState, { type: 'native_listening_ready', nativeSessionId: 8, nowMs: 8_100 });
  assert(
    'listening-ready acceptance arms the continuation gap',
    readyDisposition === 'accepted' && readyStep.effects.some((fx) => fx.type === 'arm_continuation_gap'),
    'accepted+arm',
    `${readyDisposition}:${readyStep.effects.map((fx) => fx.type).join(',')}`,
  );
  const staleDisposition = classifyNativeListeningReady(readyState, 99);
  const staleStep = reduceOpenSpeechTurn(readyState, { type: 'native_listening_ready', nativeSessionId: 99, nowMs: 8_100 });
  assert(
    'a stale session is ignored and does not arm the gap',
    staleDisposition === 'ignored_stale_session' && staleStep.effects.length === 0 && staleStep.state === readyState,
    'ignored_stale_session',
    staleDisposition,
  );
  const idleDisposition = classifyNativeListeningReady(createIdleOpenSpeechTurnState(), 1);
  assert('idle listening-ready is ignored_wrong_state', idleDisposition === 'ignored_wrong_state', 'ignored_wrong_state', idleDisposition);
  const armed = readyStep.state;
  const cleared = reduceOpenSpeechTurn(armed, { type: 'speechstart', nativeSessionId: 8 });
  assert(
    'an armed gap clears on speechstart without another decision',
    armed.continuationGapArmed === true && cleared.effects.some((fx) => fx.type === 'clear_continuation_gap'),
    'clear_continuation_gap',
    cleared.effects.map((fx) => fx.type).join(','),
  );
  const elapsed = reduceOpenSpeechTurn(armed, { type: 'continuation_gap_elapsed', generation: armed.continuationGeneration });
  const evalFx = elapsed.effects.find((fx) => fx.type === 'evaluate_admission');
  assert('elapsed gap emits admission evaluation', evalFx?.type === 'evaluate_admission', 'evaluate_admission', elapsed.effects.map((fx) => fx.type).join(','));
  const applied = evalFx && evalFx.type === 'evaluate_admission'
    ? reduceOpenSpeechTurn(elapsed.state, {
      type: 'admission_evaluated',
      trigger: evalFx.trigger,
      proposal: 'uncertain',
      text: evalFx.text,
      epoch: evalFx.epoch,
      heraldTurnId: evalFx.heraldTurnId,
    })
    : null;
  assert(
    'admission result applies a single deliver',
    applied?.effects.filter((fx) => fx.type === 'deliver').length === 1,
    'one deliver',
    applied?.effects.map((fx) => fx.type).join(',') ?? 'missing',
  );
  const journeyBranch = useMic.slice(useMic.indexOf('if (journeyProofActiveRef.current)'), useMic.indexOf('speechLifecycleLog(\'RECOGNITION_REQUESTED\''));
  assert(
    'journey ready dispatch is logged before the synthetic event and not on the real recognizer path',
    journeyBranch.includes('OPEN_SPEECH_JOURNEY_READY_DISPATCH')
      && journeyBranch.indexOf('OPEN_SPEECH_JOURNEY_READY_DISPATCH') < journeyBranch.indexOf("type: 'native_listening_ready'")
      && !useMic.slice(useMic.indexOf('speechLifecycleLog(\'RECOGNITION_REQUESTED\'')).includes('OPEN_SPEECH_JOURNEY_READY_DISPATCH'),
    'dispatch then event',
    'missing',
  );
  const gapArm = useMic.slice(useMic.indexOf("fx.type === 'arm_continuation_gap'"), useMic.indexOf("fx.type === 'arm_max_turn'"));
  assert(
    'gap elapsed is the production timer callback and the delay is unchanged',
    gapArm.includes('OPEN_SPEECH_GAP_ELAPSED')
      && gapArm.includes('OPEN_SPEECH_GAP_ARMED')
      && gapArm.includes('OPEN_SPEECH_CONTINUATION_GAP_MS')
      && gapArm.indexOf('OPEN_SPEECH_GAP_ELAPSED') < gapArm.indexOf('continuation_gap_elapsed'),
    'production timer',
    'missing',
  );
  const boundarySrc = fs.readFileSync(path.join(root, 'src/hooks/openSpeechTurnBoundary.ts'), 'utf8');
  assert(
    'diagnostic classification does not change the reducer',
    boundarySrc.includes('export function classifyNativeListeningReady')
      && !boundarySrc.slice(boundarySrc.indexOf('export function reduceOpenSpeechTurn')).includes('speechLifecycleLog'),
    'reducer untouched',
    'logged inside reducer',
  );

  resetSpeechLifecycleRing();
  const timerFields = { generation: 2, heraldTurnId: 1, nativeSessionId: 2 };
  for (const reason of ['reducer_clear', 'suspend_preclear', 'deliver_cleanup', 'unmount_cleanup', 'rearm_replace'] as const) {
    logGapTimerClear({ reason, hadHandle: true, ...timerFields });
  }
  logGapTimerClear({ reason: 'reducer_clear', hadHandle: false, ...timerFields });
  const gapClears = snapshotSpeechLifecycleRing().filter((row) => row.event === 'OPEN_SPEECH_GAP_TIMER_CLEAR');
  assert(
    'each continuation clear reason is logged only when a handle existed',
    gapClears.map((row) => row.extra.reason).join(',') === 'reducer_clear,suspend_preclear,deliver_cleanup,unmount_cleanup,rearm_replace',
    'five reasons',
    gapClears.map((row) => String(row.extra.reason)).join(','),
  );
  resetSpeechLifecycleRing();
  logMaxTurnTimerClear({ reason: 'reducer_clear', hadHandle: true, heraldTurnId: 1 });
  logMaxTurnTimerClear({ reason: 'reducer_clear', hadHandle: false, heraldTurnId: 1 });
  assert(
    'max-turn clear is logged only when a handle existed',
    snapshotSpeechLifecycleRing().filter((row) => row.event === 'OPEN_SPEECH_MAX_TURN_TIMER_CLEAR').length === 1,
    'one clear',
    String(snapshotSpeechLifecycleRing().length),
  );
  resetSpeechLifecycleRing();
  let handlePresent = true;
  const scheduled: Array<{ ms: number; fn: () => void }> = [];
  scheduleOpenSpeechGapTimerProbes({
    proofActive: false,
    generation: 2,
    heraldTurnId: 1,
    nativeSessionId: 2,
    readHadHandle: () => handlePresent,
    schedule: (fn, ms) => { scheduled.push({ ms, fn }); },
  });
  scheduleOpenSpeechGapTimerProbes({
    proofActive: true,
    generation: 2,
    heraldTurnId: 1,
    nativeSessionId: 2,
    readHadHandle: () => handlePresent,
    schedule: (fn, ms) => { scheduled.push({ ms, fn }); },
  });
  assert('proof-inactive arm schedules no handle probes', scheduled.length === 2 && scheduled[0].ms === 500 && scheduled[1].ms === 1500, '500,1500', scheduled.map((row) => row.ms).join(','));
  scheduled[0].fn();
  handlePresent = false;
  scheduled[1].fn();
  const probes = snapshotSpeechLifecycleRing().filter((row) => row.event === 'OPEN_SPEECH_GAP_TIMER_PROBE');
  assert(
    'T+500 probe reports the handle present and T+1500 reports it absent',
    probes[0]?.extra.offsetMs === 500 && probes[0]?.extra.hadHandle === true
      && probes[1]?.extra.offsetMs === 1500 && probes[1]?.extra.hadHandle === false,
    '500 present, 1500 absent',
    probes.map((row) => `${row.extra.offsetMs}:${row.extra.hadHandle}`).join(','),
  );
  const continuationCallback = useMic.slice(useMic.indexOf('continuationTimerRef.current = setTimeout'), useMic.indexOf('OPEN_SPEECH_GAP_ARMED'));
  const beforeElapsed = continuationCallback.slice(0, continuationCallback.indexOf('OPEN_SPEECH_GAP_ELAPSED'));
  assert(
    'continuation callback still begins its speech log with GAP_ELAPSED and keeps 1200 ms',
    continuationCallback.indexOf('OPEN_SPEECH_GAP_ELAPSED') < continuationCallback.indexOf('continuation_gap_elapsed')
      && continuationCallback.includes('OPEN_SPEECH_CONTINUATION_GAP_MS')
      && beforeElapsed.trimEnd().endsWith("speechLifecycleLog('"),
    'elapsed first',
    'moved',
  );
  const maxTurnStart = useMic.indexOf('heraldMaxTurnTimerRef.current = setTimeout');
  const maxTurnCallback = useMic.slice(maxTurnStart, useMic.indexOf('OPEN_SPEECH_MAX_TURN_MS', maxTurnStart) + 'OPEN_SPEECH_MAX_TURN_MS'.length);
  assert(
    'max-turn callback logs entry before finalize and keeps the 20s delay',
    maxTurnCallback.includes('OPEN_SPEECH_MAX_TURN_ELAPSED')
      && maxTurnCallback.includes('OPEN_SPEECH_MAX_TURN_MS')
      && maxTurnCallback.indexOf('OPEN_SPEECH_MAX_TURN_ELAPSED') < maxTurnCallback.indexOf('heraldMaxTurnTimerRef.current = null'),
    'entry first',
    'missing',
  );
  assert(
    'every continuation clear path names a fixed reason',
    ["'suspend_preclear'", "'reducer_clear'", "'rearm_replace'", "'deliver_cleanup'", "'unmount_cleanup'"]
      .every((reason) => useMic.includes(`clearContinuationTimer(${reason})`)),
    'all reasons',
    'missing path',
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
