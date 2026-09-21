/**
 * Speech Lifecycle Invariants V1 — decision helpers for existing
 * useMic / useSpeech ownership. Not a second speech authority.
 */

export const LISTENING_READY_TIMEOUT_MS = 4000;
export const TTS_TERMINAL_FAILSAFE_MS = 12000;

export type ListeningReadySource =
  | 'native_start'
  | 'start_called'
  | 'audiostart'
  | 'speechstart'
  | 'state_after_start'
  | 'js_start_return';

/** Android Expo `start` event (onReadyForSpeech) is the only ready authority. */
export function claimsListeningReady(source: ListeningReadySource): boolean {
  return source === 'native_start';
}

export function applyListeningReadyTimeout(opts: {
  timeoutSession: number;
  currentSession: number;
  requested: boolean;
  nativeReady: boolean;
}): 'fail_closed' | 'stale' | 'already_ready' {
  if (opts.timeoutSession !== opts.currentSession) return 'stale';
  if (opts.nativeReady) return 'already_ready';
  if (!opts.requested) return 'stale';
  return 'fail_closed';
}

export type TalkBlockReason = 'streaming' | 'waiting' | 'ttsActive';

export function talkAttemptAdmission(input: {
  isStreaming: boolean;
  isWaiting: boolean;
  isSpeaking: boolean;
}): { admitted: true } | { admitted: false; reason: TalkBlockReason } {
  if (input.isStreaming) return { admitted: false, reason: 'streaming' };
  if (input.isWaiting) return { admitted: false, reason: 'waiting' };
  if (input.isSpeaking) return { admitted: false, reason: 'ttsActive' };
  return { admitted: true };
}

/** Live-generation gate for ExpoSpeech onDone / onError / onStopped / failsafe. */
export function applyExpoSpeechTerminal(opts: {
  callbackGen: number;
  currentGen: number;
  markNativeIdle: () => void;
  continueDrain: () => void;
}): 'applied' | 'stale' {
  if (opts.callbackGen !== opts.currentGen) return 'stale';
  opts.markNativeIdle();
  opts.continueDrain();
  return 'applied';
}

export function applyTtsTerminalFailsafe(opts: {
  failsafeGen: number;
  currentGen: number;
  markNativeIdle: () => void;
  releaseSpeaking: () => void;
}): 'applied' | 'stale' {
  return applyExpoSpeechTerminal({
    callbackGen: opts.failsafeGen,
    currentGen: opts.currentGen,
    markNativeIdle: opts.markNativeIdle,
    continueDrain: opts.releaseSpeaking,
  });
}

export function speechLifecycleLog(event: string, extra: Record<string, unknown> = {}): void {
  console.log(`[SPEECH-LIFECYCLE] ts=${Date.now()} event=${event} ${JSON.stringify(extra)}`);
}
