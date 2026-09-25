/**
 * Journey-only liveness breadcrumbs for the speech production-path probe.
 * Fixed enums only. Never stores utterance, prompt, or model text.
 */

export const SPEECH_PRODUCTION_PROBE_TIMEOUT_MS = 180_000;
export const FORMER_SPEECH_PRODUCTION_PROBE_TIMEOUT_MS = 1_680_000;
export const SPEECH_PRODUCTION_PROOF_WINDOW_MS = 170_000;

export type SpeechLivenessStep =
  | 'listener_received'
  | 'handler_entered'
  | 'runtime_binding'
  | 'classifier_ready_wait_entered'
  | 'classifier_ready_achieved'
  | 'classifier_ready_failed'
  | 'tts_idle_checked'
  | 'proof_armed'
  | 'proof_started'
  | 'proof_completed'
  | 'emit_complete_attempted'
  | 'emit_complete_succeeded'
  | 'emit_complete_failed';

export type SpeechPreconditionFailure =
  | 'speech_inject_unbound'
  | 'classifier_ready_unbound'
  | 'tts_state_unbound'
  | 'classifier_not_ready'
  | 'tts_not_idle';

export type SpeechLivenessBreadcrumb = {
  step: SpeechLivenessStep;
  speechInjectBinding?: 'present' | 'missing';
  classifierBinding?: 'present' | 'missing';
  ttsBinding?: 'present' | 'missing';
  ttsIdle?: boolean;
  emitResult?: 'succeeded' | 'native_missing' | 'threw';
};

const crumbs: SpeechLivenessBreadcrumb[] = [];

export function resetSpeechJourneyLivenessForTests(): void {
  crumbs.length = 0;
}

export function snapshotSpeechJourneyLiveness(): SpeechLivenessBreadcrumb[] {
  return crumbs.map((crumb) => ({ ...crumb }));
}

export function noteSpeechJourneyLiveness(crumb: SpeechLivenessBreadcrumb): void {
  crumbs.push({ ...crumb });
  console.log(`[JOURNEY-SPEECH-LIVENESS] ${JSON.stringify(crumb)}`);
}

export function classifySpeechProductionPreconditions(input: {
  injectBound: boolean;
  classifierBound: boolean;
  ttsBound: boolean;
  classifierReady: boolean;
  speaking: boolean;
}): SpeechPreconditionFailure | null {
  noteSpeechJourneyLiveness({
    step: 'runtime_binding',
    speechInjectBinding: input.injectBound ? 'present' : 'missing',
    classifierBinding: input.classifierBound ? 'present' : 'missing',
    ttsBinding: input.ttsBound ? 'present' : 'missing',
  });
  if (!input.injectBound) return 'speech_inject_unbound';
  if (!input.classifierBound) return 'classifier_ready_unbound';
  if (!input.ttsBound) return 'tts_state_unbound';
  noteSpeechJourneyLiveness({ step: 'classifier_ready_wait_entered' });
  if (!input.classifierReady) {
    noteSpeechJourneyLiveness({ step: 'classifier_ready_failed' });
    return 'classifier_not_ready';
  }
  noteSpeechJourneyLiveness({ step: 'classifier_ready_achieved' });
  const ttsIdle = !input.speaking;
  noteSpeechJourneyLiveness({ step: 'tts_idle_checked', ttsIdle });
  if (!ttsIdle) return 'tts_not_idle';
  return null;
}

export async function receiveSpeechProductionCommand(
  execute: () => Promise<void>,
  emitHandlerException: () => void,
): Promise<void> {
  noteSpeechJourneyLiveness({ step: 'listener_received' });
  noteSpeechJourneyLiveness({ step: 'handler_entered' });
  try {
    await execute();
  } catch {
    emitHandlerException();
  }
}

export function noteSpeechEmitComplete(nativePresent: boolean, threw: boolean): void {
  noteSpeechJourneyLiveness({ step: 'emit_complete_attempted' });
  if (!nativePresent) {
    noteSpeechJourneyLiveness({ step: 'emit_complete_failed', emitResult: 'native_missing' });
    console.log('[JOURNEY-BRIDGE] {"step":"emit_complete_failed","reason":"native_missing"}');
    return;
  }
  if (threw) {
    noteSpeechJourneyLiveness({ step: 'emit_complete_failed', emitResult: 'threw' });
    console.log('[JOURNEY-BRIDGE] {"step":"emit_complete_failed","reason":"threw"}');
    return;
  }
  noteSpeechJourneyLiveness({ step: 'emit_complete_succeeded' });
}
