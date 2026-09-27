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
  | 'tts_state_unbound'
  | 'tts_not_idle';

export type SpeechLivenessBreadcrumb = {
  step: SpeechLivenessStep;
  speechInjectBinding?: 'present' | 'missing';
  classifierBinding?: 'present' | 'missing';
  ttsBinding?: 'present' | 'missing';
  ttsIdle?: boolean;
  emitResult?: 'succeeded' | 'native_missing' | 'threw';
};

export type SpeechHandlerStage =
  | 'before_proof_completed'
  | 'after_proof_completed'
  | 'legacy_satisfier'
  | 'result_envelope'
  | 'before_emit';

export type SpeechHandlerExceptionDiagnostic = {
  isError: boolean;
  errorClass: string;
  message: string;
  topFrame: string | null;
  stage: SpeechHandlerStage;
};

const MESSAGE_LIMIT = 120;
const FRAME_LIMIT = 180;
const crumbs: SpeechLivenessBreadcrumb[] = [];
let handlerStage: SpeechHandlerStage = 'before_proof_completed';
let handlerException: SpeechHandlerExceptionDiagnostic | null = null;

function boundText(value: string, limit: number): string {
  const flat = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : flat.slice(0, limit);
}

function errorClassOf(thrown: unknown): string {
  if (thrown instanceof Error) {
    const name = thrown.constructor?.name;
    return name ? boundText(name, 80) : 'Error';
  }
  if (thrown === null) return 'null';
  if (typeof thrown === 'object') {
    const name = (thrown as { constructor?: { name?: string } }).constructor?.name;
    return name ? boundText(name, 80) : 'Object';
  }
  return typeof thrown;
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return boundText(thrown.message, MESSAGE_LIMIT);
  if (typeof thrown === 'string') return boundText(thrown, MESSAGE_LIMIT);
  if (typeof thrown === 'number' || typeof thrown === 'boolean' || typeof thrown === 'bigint') {
    return boundText(String(thrown), MESSAGE_LIMIT);
  }
  if (typeof thrown === 'symbol') return boundText(thrown.toString(), MESSAGE_LIMIT);
  if (thrown == null) return String(thrown);
  const name = (thrown as { constructor?: { name?: string } }).constructor?.name;
  return name ? `non_error_${boundText(name, 60)}` : 'non_error_object';
}

function topFrameOf(thrown: unknown): string | null {
  if (!(thrown instanceof Error) || typeof thrown.stack !== 'string') return null;
  const frame = thrown.stack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at '));
  if (!frame) return null;
  const shortened = frame.replace(
    /(?:[A-Za-z]:)?(?:[/\\][^/\\:)]+)+(?=:)/g,
    (pathText) => {
      const parts = pathText.split(/[/\\]/);
      return parts[parts.length - 1] ?? pathText;
    },
  );
  return boundText(shortened, FRAME_LIMIT);
}

export function setSpeechHandlerStage(stage: SpeechHandlerStage): void {
  handlerStage = stage;
}

export function resetSpeechHandlerExceptionForTests(): void {
  handlerStage = 'before_proof_completed';
  handlerException = null;
}

export function snapshotSpeechHandlerException(): SpeechHandlerExceptionDiagnostic | null {
  return handlerException ? { ...handlerException } : null;
}

function noteSpeechHandlerException(thrown: unknown): void {
  const diagnostic: SpeechHandlerExceptionDiagnostic = {
    isError: thrown instanceof Error,
    errorClass: errorClassOf(thrown),
    message: messageOf(thrown),
    topFrame: topFrameOf(thrown),
    stage: handlerStage,
  };
  handlerException = diagnostic;
  console.log(`[JOURNEY-SPEECH-LIVENESS] ${JSON.stringify({
    step: 'handler_exception_observed',
    isError: diagnostic.isError,
    errorClass: diagnostic.errorClass,
    message: diagnostic.message,
    topFrame: diagnostic.topFrame,
    stage: diagnostic.stage,
  })}`);
}

export function resetSpeechJourneyLivenessForTests(): void {
  crumbs.length = 0;
  resetSpeechHandlerExceptionForTests();
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
  ttsBound: boolean;
  speaking: boolean;
}): SpeechPreconditionFailure | null {
  noteSpeechJourneyLiveness({
    step: 'runtime_binding',
    speechInjectBinding: input.injectBound ? 'present' : 'missing',
    ttsBinding: input.ttsBound ? 'present' : 'missing',
  });
  if (!input.injectBound) return 'speech_inject_unbound';
  if (!input.ttsBound) return 'tts_state_unbound';
  const ttsIdle = !input.speaking;
  noteSpeechJourneyLiveness({ step: 'tts_idle_checked', ttsIdle });
  if (!ttsIdle) return 'tts_not_idle';
  return null;
}

export async function receiveSpeechProductionCommand(
  execute: () => Promise<void>,
  emitHandlerException: () => void,
): Promise<void> {
  handlerStage = 'before_proof_completed';
  handlerException = null;
  noteSpeechJourneyLiveness({ step: 'listener_received' });
  noteSpeechJourneyLiveness({ step: 'handler_entered' });
  try {
    await execute();
  } catch (thrown) {
    noteSpeechHandlerException(thrown);
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
