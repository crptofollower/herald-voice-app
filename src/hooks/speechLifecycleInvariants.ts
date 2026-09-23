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

export type SpeechLifecycleRingEvent = {
  ts: number;
  event: string;
  extra: Record<string, unknown>;
};

const SPEECH_LIFECYCLE_RING_LIMIT = 80;
const speechLifecycleRing: SpeechLifecycleRingEvent[] = [];

/** Last Herald open-speech turn only. No transcripts. Not memory / R / T. */
export type OpenSpeechTurnDeviceEvidence = {
  heraldTurnId: number;
  nativeSessionIds: number[];
  terminalDeliverySource: string | null;
  segmentCount: number;
  turnElapsedMs: number | null;
  priorNativeEndAtMs: number | null;
  continuationStartRequestedAtMs: number | null;
  nativeListeningReadyAtMs: number | null;
  speechstartAtMs: number | null;
  emptyOrNoSpeech: string | null;
  reopenSkippedReason: string | null;
};

function emptyOpenSpeechTurnEvidence(): OpenSpeechTurnDeviceEvidence {
  return {
    heraldTurnId: 0,
    nativeSessionIds: [],
    terminalDeliverySource: null,
    segmentCount: 0,
    turnElapsedMs: null,
    priorNativeEndAtMs: null,
    continuationStartRequestedAtMs: null,
    nativeListeningReadyAtMs: null,
    speechstartAtMs: null,
    emptyOrNoSpeech: null,
    reopenSkippedReason: null,
  };
}

let lastOpenSpeechTurnEvidence: OpenSpeechTurnDeviceEvidence = emptyOpenSpeechTurnEvidence();

export function peekOpenSpeechTurnDeviceEvidence(): OpenSpeechTurnDeviceEvidence {
  return {
    ...lastOpenSpeechTurnEvidence,
    nativeSessionIds: [...lastOpenSpeechTurnEvidence.nativeSessionIds],
  };
}

export function resetOpenSpeechTurnDeviceEvidence(): void {
  lastOpenSpeechTurnEvidence = emptyOpenSpeechTurnEvidence();
}

export function noteOpenSpeechTurnDeviceEvidence(
  patch: Partial<OpenSpeechTurnDeviceEvidence> & {
    resetTurn?: boolean;
    nativeSessionId?: number;
  } = {},
): void {
  if (patch.resetTurn) {
    lastOpenSpeechTurnEvidence = emptyOpenSpeechTurnEvidence();
  }
  const nativeSessionIds = [...lastOpenSpeechTurnEvidence.nativeSessionIds];
  if (typeof patch.nativeSessionId === 'number' && !nativeSessionIds.includes(patch.nativeSessionId)) {
    nativeSessionIds.push(patch.nativeSessionId);
  }
  lastOpenSpeechTurnEvidence = {
    ...lastOpenSpeechTurnEvidence,
    heraldTurnId: patch.heraldTurnId ?? lastOpenSpeechTurnEvidence.heraldTurnId,
    terminalDeliverySource: patch.terminalDeliverySource !== undefined
      ? patch.terminalDeliverySource
      : lastOpenSpeechTurnEvidence.terminalDeliverySource,
    segmentCount: patch.segmentCount ?? lastOpenSpeechTurnEvidence.segmentCount,
    turnElapsedMs: patch.turnElapsedMs !== undefined
      ? patch.turnElapsedMs
      : lastOpenSpeechTurnEvidence.turnElapsedMs,
    priorNativeEndAtMs: patch.priorNativeEndAtMs !== undefined
      ? patch.priorNativeEndAtMs
      : lastOpenSpeechTurnEvidence.priorNativeEndAtMs,
    continuationStartRequestedAtMs: patch.continuationStartRequestedAtMs !== undefined
      ? patch.continuationStartRequestedAtMs
      : lastOpenSpeechTurnEvidence.continuationStartRequestedAtMs,
    nativeListeningReadyAtMs: patch.nativeListeningReadyAtMs !== undefined
      ? patch.nativeListeningReadyAtMs
      : lastOpenSpeechTurnEvidence.nativeListeningReadyAtMs,
    speechstartAtMs: patch.speechstartAtMs !== undefined
      ? patch.speechstartAtMs
      : lastOpenSpeechTurnEvidence.speechstartAtMs,
    emptyOrNoSpeech: patch.emptyOrNoSpeech !== undefined
      ? patch.emptyOrNoSpeech
      : lastOpenSpeechTurnEvidence.emptyOrNoSpeech,
    reopenSkippedReason: patch.reopenSkippedReason !== undefined
      ? patch.reopenSkippedReason
      : lastOpenSpeechTurnEvidence.reopenSkippedReason,
    nativeSessionIds: patch.nativeSessionIds ?? nativeSessionIds,
  };
}

export function speechLifecycleLog(event: string, extra: Record<string, unknown> = {}): void {
  const ts = Date.now();
  speechLifecycleRing.push({ ts, event, extra: { ...extra } });
  if (speechLifecycleRing.length > SPEECH_LIFECYCLE_RING_LIMIT) speechLifecycleRing.shift();
  console.log(`[SPEECH-LIFECYCLE] ts=${ts} event=${event} ${JSON.stringify(extra)}`);
}

export function snapshotSpeechLifecycleRing(): SpeechLifecycleRingEvent[] {
  return speechLifecycleRing.map((row) => ({ ts: row.ts, event: row.event, extra: { ...row.extra } }));
}

export function resetSpeechLifecycleRing(): void {
  speechLifecycleRing.length = 0;
  resetOpenSpeechTurnDeviceEvidence();
}
