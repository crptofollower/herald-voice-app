import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { createSuspendCoordinator } from './suspendCoordinator';
import { evaluateEmptySessionRecovery, shouldCancelEmptySessionRecovery, shouldCancelEmptySessionRecoveryOnSpeechStart } from './emptySessionRecoveryDecision';
import { decideOneShotNoSpeech } from './oneShotEndDecision';
import { buildStartConfig } from './recognitionModeConfig';
import type { RecognitionMode } from './recognitionModeConfig';
import {
  OPEN_SPEECH_CONTINUATION_GAP_MS,
  OPEN_SPEECH_MAX_TURN_MS,
  applyReopenedNativeSession,
  createIdleOpenSpeechTurnState,
  reduceOpenSpeechTurn,
  type OpenSpeechEffect,
  type OpenSpeechEvent,
  type OpenSpeechTurnState,
} from './openSpeechTurnBoundary';
import { beginTurn, getActiveTurnId, log as latLog, mono as latMono } from '../utils/latencyInstrument';
import {
  LISTENING_READY_TIMEOUT_MS,
  applyListeningReadyTimeout,
  speechLifecycleLog,
} from './speechLifecycleInvariants';

export { evaluateEmptySessionRecovery } from './emptySessionRecoveryDecision';

const SUSPEND_TIMEOUT_MS = 1200;

export function useMic(
  onTranscript: (text: string) => void,
  ttsActiveRef?: { current: boolean },
  // Voice-recognition state-leak repair, 2026-09-xx: fires ONLY for a
  // genuine content-free recognition outcome -- no transcript, no partial,
  // no fabricated text -- exactly the two branches below that previously
  // did nothing at all. Never carries any text; never itself decides
  // whether a pending confirmation exists (that is the caller's authority,
  // via the SAME sessionRef.current.hasPending() check ChatScreen already
  // uses for mic-mode selection). This is what lets a caller feed silence
  // into the existing ConversationSession re-ask/budget/release ladder
  // instead of a pending state leaking indefinitely -- see oneShotEndDecision.ts.
  onNoRecognizableSpeech?: () => void,
) {
  const [isRecording, setIsRecording] = useState(false);
  // Read-only mirror of latestPartialRef for presentation (live STT partial).
  const [partialText, setPartialText] = useState('');
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferRef = useRef<string>('');
  // STT partial-only recovery (2026-08-18): tracks the latest CONTENTFUL
  // non-final transcript. Overwrite only, never concatenate. Consulted
  // ONLY at the 'end' handler, and ONLY when bufferRef (a genuine final)
  // is empty -- a real final always wins. Cleared inside
  // deliverBufferWithoutNativeStop, in suspendForSpeech (cancellation
  // boundary -- see that function below), and in startRecording/
  // stopRecording, so it can never leak between turns or survive a
  // TTS-preemption cancellation. Deliberately NOT cleared in the error
  // handler's no-speech/teardown fallthrough -- it must survive into the
  // guaranteed subsequent 'end' event, exactly like speechStartedRef
  // already does today.
  const latestPartialRef = useRef<string>('');
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnActiveRef = useRef(false);
  const emptySessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptySessionTokenRef = useRef<number | null>(null);
  const speechStartedRef = useRef(false);
  const boundaryRef = useRef<OpenSpeechTurnState>(createIdleOpenSpeechTurnState());
  const continuationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heraldMaxTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancels/clears the empty-session recovery timer + its captured token.
  // Called on every path that means "this session is no longer a candidate
  // for empty-session recovery" -- contentful result, stop, end, error,
  // new session start, unmount. Never call clearTimeout without also
  // nulling both refs -- a stale non-null ref blocks a later empty-final
  // period in the SAME session from ever arming recovery again.
  const clearEmptySessionRecovery = () => {
    if (emptySessionTimerRef.current) {
      clearTimeout(emptySessionTimerRef.current);
    }
    emptySessionTimerRef.current = null;
    emptySessionTokenRef.current = null;
  };
  // Engine session guard: start() on an already-active session wedges the
  // Android recognizer (Listening shown, no results delivered) or fires a
  // non-no-speech error that kills a live turn. One session at a time, always.
  const engineActiveRef = useRef(false);
  const listeningReadyRef = useRef(false);
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReadyTimeout = () => {
    if (readyTimeoutRef.current) {
      clearTimeout(readyTimeoutRef.current);
      readyTimeoutRef.current = null;
    }
  };

  // ── TEMP DIAGNOSTIC — recovery-contract evidence gathering, 2026-08-02 ──
  // Additive only. No control flow depends on micSessionRef or entryPointRef.
  // Remove entirely once one failing trace is captured and analyzed.
  const micSessionRef = useRef(0);
  const entryPointRef = useRef<'manual_button' | 'post_tts_handoff' | 'unknown_entry'>('unknown_entry');
  const rlog = (event: string, extra: Record<string, unknown> = {}) => {
    console.log(
      `[RECOVERY-INSTRUMENT] ts=${Date.now()} turn=mic:${micSessionRef.current} gen=mic:${micSessionRef.current} ` +
      `entry=${entryPointRef.current} event=${event} ${JSON.stringify(extra)}`
    );
  };
  // ── END NEW DIAGNOSTIC HEADER ────────────────────────────────────────────

  // ── TEMP DIAGNOSTIC — post-TTS voice input failure, 2026-08-02 ──────────
  // Remove entirely before any fix for THIS issue is committed. Logging
  // only, no behavior change. Separate from the (already committed and
  // accepted) self-hearing fix -- this instruments what happens AFTER
  // suspendForSpeech resolves and startRecording() is called again.
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    console.log(
      `[MICLOG2] t=${Date.now()} evt=${event} ` +
      `isRecording=${isRecording} engineActive=${engineActiveRef.current} ` +
      `turnActive=${turnActiveRef.current} ttsActive=${!!ttsActiveRef?.current} ${JSON.stringify(extra)}`
    );
  };
  // ── END TEMP DIAGNOSTIC HEADER ────────────────────────────────────────────

  const suspendCoordinatorRef = useRef(createSuspendCoordinator(SUSPEND_TIMEOUT_MS));

  const suspendForSpeech = useCallback((): Promise<{ confirmed: boolean }> => {
    const suspendT0 = latMono();
    latLog('mic suspension START', { turnId: getActiveTurnId(), source: 'suspendForSpeech' });
    rlog('SUSPEND_CALLED');

    if (!engineActiveRef.current) {
      // Mic already idle -- the common case. Nothing to wait for.
      rlog('SUSPEND_RESOLVED', { resolution: 'already_idle' });
      return Promise.resolve({ confirmed: true });
    }

    turnActiveRef.current = false;
    speechStartedRef.current = false;
    // suspendForSpeech is cancellation, not pause-and-resume -- Herald is
    // taking the audio channel to speak (ensureTurnStarted in useSpeech.ts
    // fails closed on this exact call before any TTS audio plays). No code
    // path anywhere delivers a transcript from a suspended-for-TTS session
    // -- startRecording() after resolve always begins a brand-new session.
    // A retained partial must be abandoned here exactly like bufferRef, or
    // the native 'end' this function's own stop() call triggers could
    // incorrectly flush_partial a fragment from a turn Herald just cancelled.
    latestPartialRef.current = '';
    setPartialText('');
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    clearContinuationTimer();
    clearHeraldMaxTurnTimer();
    executeBoundaryEffects(applyBoundary({ type: 'tts_preempt' }));
    clearReadyTimeout();
    listeningReadyRef.current = false;

    const promise = suspendCoordinatorRef.current.beginSuspend(() => {
      rlog('TEARDOWN_REQUESTED', { reason: 'suspend_for_speech' });
      ExpoSpeechRecognitionModule.stop();
    });
    promise.then((result) => {
      latLog('mic suspension END', {
        turnId: getActiveTurnId(),
        source: 'suspendForSpeech',
        durationMs: Math.round((latMono() - suspendT0) * 100) / 100,
        confirmed: result.confirmed,
      });
      rlog('SUSPEND_RESOLVED', { resolution: result.confirmed ? 'confirmed_end' : 'timeout_fail_closed' });
      rlog('TEARDOWN_COMPLETED', { reason: 'suspend_for_speech', outcome: result.confirmed ? 'confirmed' : 'forced_timeout' });
    });
    setIsRecording(false);
    return promise;
  }, []);

  // M1 short-utterance follow-on, 2026-08-13: recognitionModeRef lets a
  // caller (ChatScreen, via startRecording's new mode param) bias STT
  // toward the closed confirm vocabulary during a pending confirmation,
  // without useMic depending on ConversationSession or session state
  // directly -- it only ever receives the plain mode string. Default
  // 'open' preserves the exact prior config shape byte-for-byte: when
  // getContextualStringsForMode returns undefined, the spread below adds
  // no key at all.
  const recognitionModeRef = useRef<RecognitionMode>('open');
  const getStartConfig = () => buildStartConfig(recognitionModeRef.current);

  // One-shot (continuous:false): native 'end' is the provider session
  // boundary. Open mode may reopen inside a Herald turn; control_confirmation
  // still flushes the Herald turn on native end.
  const clearContinuationTimer = () => {
    if (continuationTimerRef.current) {
      clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
  };
  const clearHeraldMaxTurnTimer = () => {
    if (heraldMaxTurnTimerRef.current) {
      clearTimeout(heraldMaxTurnTimerRef.current);
      heraldMaxTurnTimerRef.current = null;
    }
  };

  const applyBoundary = (event: OpenSpeechEvent): OpenSpeechEffect[] => {
    const out = reduceOpenSpeechTurn(boundaryRef.current, event);
    boundaryRef.current = out.state;
    return out.effects;
  };

  const requestNativeStart = (session: number) => {
    ExpoSpeechRecognitionModule.start(getStartConfig());
    engineActiveRef.current = true;
    readyTimeoutRef.current = setTimeout(() => {
      readyTimeoutRef.current = null;
      const decision = applyListeningReadyTimeout({
        timeoutSession: session,
        currentSession: micSessionRef.current,
        requested: engineActiveRef.current,
        nativeReady: listeningReadyRef.current,
      });
      if (decision !== 'fail_closed') return;
      speechLifecycleLog('RECOGNITION_READY_TIMEOUT', { session });
      log('READINESS_TIMEOUT');
      rlog('READINESS_TIMEOUT', { session });
      engineActiveRef.current = false;
      listeningReadyRef.current = false;
      setIsRecording(false);
      try { ExpoSpeechRecognitionModule.abort(); } catch (e) {
        console.error('[useMic] readiness abort failed:', e);
      }
      if (boundaryRef.current.phase === 'listening' || boundaryRef.current.phase === 'awaiting_continuation') {
        executeBoundaryEffects(applyBoundary({
          type: 'recognition_error',
          nativeSessionId: session,
        }));
      }
    }, LISTENING_READY_TIMEOUT_MS);
  };

  const startContinuationNative = () => {
    if (boundaryRef.current.delivered) return;
    if (engineActiveRef.current) return;
    if (ttsActiveRef?.current) return;
    recognitionModeRef.current = 'open';
    micSessionRef.current += 1;
    const session = micSessionRef.current;
    boundaryRef.current = applyReopenedNativeSession(boundaryRef.current, session);
    if (boundaryRef.current.nativeSessionId !== session) return;
    latestPartialRef.current = '';
    speechStartedRef.current = false;
    clearReadyTimeout();
    listeningReadyRef.current = false;
    try {
      speechLifecycleLog('RECOGNITION_REQUESTED', {
        session,
        mode: recognitionModeRef.current,
        entryPoint: 'open_speech_continuation',
      });
      requestNativeStart(session);
    } catch (e) {
      engineActiveRef.current = false;
      executeBoundaryEffects(applyBoundary({
        type: 'recognition_error',
        nativeSessionId: session,
      }));
    }
  };

  const executeBoundaryEffects = (effects: OpenSpeechEffect[]) => {
    for (const fx of effects) {
      if (fx.type === 'clear_continuation_gap') clearContinuationTimer();
      if (fx.type === 'clear_max_turn') clearHeraldMaxTurnTimer();
      if (fx.type === 'arm_continuation_gap') {
        clearContinuationTimer();
        const generation = fx.generation;
        continuationTimerRef.current = setTimeout(() => {
          continuationTimerRef.current = null;
          executeBoundaryEffects(applyBoundary({ type: 'continuation_gap_elapsed', generation }));
        }, OPEN_SPEECH_CONTINUATION_GAP_MS);
      }
      if (fx.type === 'arm_max_turn') {
        clearHeraldMaxTurnTimer();
        heraldMaxTurnTimerRef.current = setTimeout(() => {
          heraldMaxTurnTimerRef.current = null;
          executeBoundaryEffects(applyBoundary({ type: 'max_turn_elapsed' }));
        }, OPEN_SPEECH_MAX_TURN_MS);
      }
      if (fx.type === 'reopen_native') {
        startContinuationNative();
      }
      if (fx.type === 'abort_native') {
        engineActiveRef.current = false;
        try { ExpoSpeechRecognitionModule.abort(); } catch { /* already idle */ }
      }
      if (fx.type === 'deliver') {
        deliverBufferWithoutNativeStop(fx.source, fx.utterance);
      }
    }
  };

  const deliverBufferWithoutNativeStop = (source: string, forcedText?: string) => {
    const final = (forcedText ?? bufferRef.current).trim();
    bufferRef.current = '';
    // Any delivery (final OR partial-recovered) supersedes any retained
    // partial for this turn -- clear here so a guaranteed follow-up 'end'
    // event (e.g. after an error-path flush) can never re-deliver stale
    // partial content as a duplicate turn.
    latestPartialRef.current = '';
    setPartialText('');
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    turnActiveRef.current = false;
    speechStartedRef.current = false;
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    clearContinuationTimer();
    clearHeraldMaxTurnTimer();
    setIsRecording(false);
    if (final) {
      log('TRANSCRIPT_SELECTED', {
        digitCount: (final.match(/\d/g) || []).length,
        charCount: final.length,
        source,
      });
      const turnId = beginTurn();
      latLog('STT FINAL available', {
        turnId,
        charLen: final.length,
        source,
      });
      onTranscript(final);
    }
  };

  const haltNativeMicAfterBoundary = (reason: 'user_talk_stop' | 'automated_teardown') => {
    clearEmptySessionRecovery();
    clearReadyTimeout();
    listeningReadyRef.current = false;
    turnActiveRef.current = false;
    speechStartedRef.current = false;
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    latestPartialRef.current = '';
    setPartialText('');
    rlog('TEARDOWN_REQUESTED', { reason });
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      console.error('[useMic] stop failed:', e);
    }
    setIsRecording(false);
  };

  // Empty-session recovery and 30s mic safety: abandon. Never submit buffer.
  const abandonRecordingForAutomatedTeardown = () => {
    executeBoundaryEffects(applyBoundary({ type: 'automated_teardown' }));
    haltNativeMicAfterBoundary('automated_teardown');
  };

  useSpeechRecognitionEvent('start', () => {
    log('NATIVE_START_EVENT');
    rlog('NATIVE_ACTIVE');
    if (!engineActiveRef.current) {
      speechLifecycleLog('RECOGNITION_NATIVE_READY_IGNORED', { session: micSessionRef.current, reason: 'not_requested' });
      return;
    }
    clearReadyTimeout();
    listeningReadyRef.current = true;
    setIsRecording(true);
    speechLifecycleLog('RECOGNITION_NATIVE_READY', { session: micSessionRef.current });
  });

  // Empty-session recovery gap, 2026-08-13: onset alone (before any
  // transcript exists) is stronger evidence a session is live than
  // silence -- yet nothing previously cancelled an armed recovery timer
  // on speech start, only on content arriving via 'result'. Short
  // utterances ("No", "Yes") lose that race by construction: on-device
  // transcription of one word rarely beats a timer already seconds into
  // its countdown from a prior empty-final segment. Reuses the identical
  // teardown path already proven safe for content-cancellation --
  // idempotent, so ordering relative to 'result' (unguaranteed per the
  // library's own types) is safe either way. Decision logic lives in
  // shouldCancelEmptySessionRecoveryOnSpeechStart (gate-tested); this
  // call site only wires it to the ref/timer side, same pattern as the
  // existing content-cancel call site above.
  useSpeechRecognitionEvent('speechstart', () => {
    rlog('NATIVE_SPEECH_START');
    speechStartedRef.current = true;
    executeBoundaryEffects(applyBoundary({
      type: 'speechstart',
      nativeSessionId: micSessionRef.current,
    }));
    if (shouldCancelEmptySessionRecoveryOnSpeechStart({ timerArmed: !!emptySessionTimerRef.current })) {
      log('EMPTY_SESSION_TIMER_CANCELLED_SPEECH_START');
      clearEmptySessionRecovery();
    }
  });

  useSpeechRecognitionEvent('result', (event) => {
    log('NATIVE_RESULT', { isFinal: event.isFinal, transcript: event.results[0]?.transcript });
    rlog('NATIVE_RESULT', { isFinal: !!event.isFinal, contentPresent: !!event.results[0]?.transcript?.trim() });
    // Half-duplex: never transcribe while Herald is speaking -- Herald's own
    // voice buffered into an utterance is a fabrication-class failure.
    if (ttsActiveRef?.current) { log('NATIVE_RESULT_DROPPED_TTS_ACTIVE'); return; }

    // Any result carrying real transcript content -- final OR partial --
    // proves this session is not empty/stalled. Cancel a pending empty-
    // session recovery timer here, unconditionally, BEFORE the isFinal
    // branch below. This recognizer delivers genuine mid-utterance speech
    // as a stream of isFinal:false partials (even with interimResults:
    // false requested) and, once an early spurious empty final has armed
    // recovery, may not emit a second final until the turn ends on its
    // own -- the previous clear-on-content path only ran inside the
    // isFinal branch, so it was structurally unreachable for exactly the
    // partial-only content stream this recognizer produces, leaving the
    // timer to fire on schedule regardless of active speech. Decision
    // logic lives in shouldCancelEmptySessionRecovery (gate-tested); this
    // call site only wires it to the ref/timer side.
    if (shouldCancelEmptySessionRecovery({
      timerArmed: !!emptySessionTimerRef.current,
      transcript: event.results[0]?.transcript,
    })) {
      log('EMPTY_SESSION_TIMER_CANCELLED_CONTENT');
      clearEmptySessionRecovery();
    }

    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) {
        log('NATIVE_RESULT_EMPTY_NOISE');
        if (!emptySessionTimerRef.current) {
          const armedToken = micSessionRef.current;
          emptySessionTokenRef.current = armedToken;
          log('EMPTY_SESSION_TIMER_ARMED');
          emptySessionTimerRef.current = setTimeout(() => {
            emptySessionTimerRef.current = null; // this timeout has now fired
            const decision = evaluateEmptySessionRecovery({
              armedToken,
              currentToken: micSessionRef.current,
              engineActive: engineActiveRef.current,
              turnActive: turnActiveRef.current,
              bufferHasContent: !!bufferRef.current.trim(),
            });
            if (decision === 'stale_session') {
              log('EMPTY_SESSION_RECOVERY_STALE_SESSION');
              emptySessionTokenRef.current = null;
              return;
            }
            if (decision === 'state_changed') {
              log('EMPTY_SESSION_RECOVERY_STATE_CHANGED');
              emptySessionTokenRef.current = null;
              return;
            }
            log('EMPTY_SESSION_RECOVERY_FIRED');
            emptySessionTokenRef.current = null;
            abandonRecordingForAutomatedTeardown();
          }, 5000);
        }
        return; // noise segment - keep the mic hot, don't end the turn
      }

      if (emptySessionTimerRef.current) {
        log('EMPTY_SESSION_TIMER_CANCELLED_CONTENT');
      }
      clearEmptySessionRecovery();

      turnActiveRef.current = true; // a turn is in progress; protect it from premature end

      bufferRef.current = bufferRef.current
        ? bufferRef.current + ' ' + text
        : text;
      executeBoundaryEffects(applyBoundary({
        type: 'native_result_final',
        nativeSessionId: micSessionRef.current,
        text,
      }));

      if (bufferTimerRef.current) {
        clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = null;
      }
      // One-shot: do not arm BUFFER_WINDOW. Native 'end' flushes once.
    } else {
      // Non-final partial carrying real content -- retain for terminal-
      // event recovery only. Overwrite, never concatenate.
      const partial = event.results[0]?.transcript?.trim();
      if (partial) {
        latestPartialRef.current = partial;
        setPartialText(partial);
      }
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    log('NATIVE_ERROR', { error: event.error, message: (event as any).message });
    rlog('NATIVE_ERROR', { code: event.error });
    speechLifecycleLog('RECOGNITION_ERROR', { session: micSessionRef.current, error: event.error });
    engineActiveRef.current = false;
    listeningReadyRef.current = false;
    clearReadyTimeout();
    clearEmptySessionRecovery();
    // no-speech with a buffered transcript = the one-shot utterance completed
    // and the engine timed out; flush once. Do not restart.
    if (event.error === 'no-speech') {
      if (decideOneShotNoSpeech({ bufferHasContent: !!bufferRef.current.trim() }) === 'flush') {
        log('ONE_SHOT_FLUSH', { source: 'no_speech' });
        executeBoundaryEffects(applyBoundary({ type: 'no_speech_error', nativeSessionId: micSessionRef.current }));
        return;
      }
      // Genuine content-free no-speech (teardown, not flush): no transcript
      // exists to deliver. Never fabricate one -- surface the outcome only,
      // so a caller with an active pending confirmation can advance its own
      // re-ask/budget ladder instead of this silently disappearing.
      log('NO_RECOGNIZABLE_SPEECH', { source: 'no_speech_error' });
      executeBoundaryEffects(applyBoundary({
        type: 'no_speech_error',
        nativeSessionId: micSessionRef.current,
      }));
      onNoRecognizableSpeech?.();
      return;
    }
    if (event.error !== 'no-speech') {
      console.error('[useMic] Speech recognition error:', event.error);
    }
    executeBoundaryEffects(applyBoundary({
      type: 'recognition_error',
      nativeSessionId: micSessionRef.current,
    }));
    if (boundaryRef.current.phase === 'finalized' || boundaryRef.current.phase === 'abandoned') {
      setIsRecording(false);
      turnActiveRef.current = false;
      if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
      if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
      if (boundaryRef.current.delivered && !bufferRef.current.trim()) bufferRef.current = '';
    }
  });

  useSpeechRecognitionEvent('end', () => {
    log('NATIVE_END');
    rlog('NATIVE_END');
    speechLifecycleLog('RECOGNITION_END', { session: micSessionRef.current, nativeReady: listeningReadyRef.current });
    engineActiveRef.current = false;
    listeningReadyRef.current = false;
    clearReadyTimeout();
    clearEmptySessionRecovery();
    // Per the library's own contract, 'end' is always the last event
    // dispatched, including after errors -- the one reliable confirmation
    // point that a suspend request actually completed.
    suspendCoordinatorRef.current.onNativeEnd();
    const effects = applyBoundary({
      type: 'native_end',
      nativeSessionId: micSessionRef.current,
      speechStarted: speechStartedRef.current,
      partial: latestPartialRef.current,
      nowMs: Date.now(),
    });
    const willReopen = effects.some((e) => e.type === 'reopen_native');
    const noSpeech = effects.find((e) => e.type === 'no_recognizable_speech');
    if (effects.some((e) => e.type === 'deliver')) {
      log('ONE_SHOT_FLUSH', { source: 'native_end' });
      rlog('TEARDOWN_COMPLETED', { reason: 'one_shot_flush' });
    }
    executeBoundaryEffects(effects);
    if (noSpeech) {
      if (noSpeech.reason === 'heard_unrecognized') {
        log('HEARD_UNRECOGNIZED');
        rlog('HEARD_UNRECOGNIZED');
      }
      log('NO_RECOGNIZABLE_SPEECH', { source: 'native_end', decision: noSpeech.reason });
      onNoRecognizableSpeech?.();
    }
    if (willReopen || boundaryRef.current.phase === 'awaiting_continuation' || boundaryRef.current.phase === 'listening') {
      if (boundaryRef.current.delivered) {
        setIsRecording(false);
        turnActiveRef.current = false;
      }
      return;
    }
    setIsRecording(false);
    turnActiveRef.current = false;
    speechStartedRef.current = false;
    latestPartialRef.current = '';
    setPartialText('');
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    if (boundaryRef.current.delivered) bufferRef.current = '';
  });

  // Unmount: never leave a caller awaiting a suspend that will never resolve.
  useEffect(() => {
    return () => {
      suspendCoordinatorRef.current.cancel();
      clearEmptySessionRecovery();
      clearReadyTimeout();
      clearContinuationTimer();
      clearHeraldMaxTurnTimer();
    };
  }, []);

  // Explicit Talk-button stop: may finalize a stitched utterance once.
  const stopRecording = useCallback(async () => {
    executeBoundaryEffects(applyBoundary({ type: 'user_stop' }));
    haltNativeMicAfterBoundary('user_talk_stop');
  }, [onTranscript]);

  // ── startRecording memoized -- stopRecording is its only dep ───────────────
  const startRecording = useCallback(async (
    entryPoint: 'manual_button' | 'post_tts_handoff' | 'unknown_entry' = 'unknown_entry',
    mode: RecognitionMode = 'open'
  ) => {
    entryPointRef.current = entryPoint;
    recognitionModeRef.current = mode;
    rlog(
      entryPoint === 'manual_button' ? 'ENTRY_MANUAL_MIC_PRESS' :
      entryPoint === 'post_tts_handoff' ? 'ENTRY_AUTO_POST_TTS' :
      'ENTRY_UNKNOWN'
    );
    try {
      log('START_REQUEST');
      if (engineActiveRef.current) {
        log('START_BLOCKED', { reason: 'engineActive' });
        rlog('NATIVE_START_BLOCKED', { reason: 'engineActive' });
        speechLifecycleLog('TALK_BLOCKED', { reason: 'engineActive' });
        return;
      }
      if (ttsActiveRef?.current) {
        log('START_BLOCKED', { reason: 'ttsActive' });
        rlog('NATIVE_START_BLOCKED', { reason: 'ttsActive' });
        speechLifecycleLog('TALK_BLOCKED', { reason: 'ttsActive' });
        return;
      }
      const { granted } =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) { console.error('[useMic] Mic permission denied'); return; }
      turnActiveRef.current = false; // clean slate for a new turn
      speechStartedRef.current = false;
      latestPartialRef.current = '';
      setPartialText('');
      clearEmptySessionRecovery();
      clearReadyTimeout();
      listeningReadyRef.current = false;

      let stateBefore: string = 'unknown';
      try { stateBefore = await ExpoSpeechRecognitionModule.getStateAsync(); } catch (e) { stateBefore = `error:${String(e)}`; }
      log('STATE_BEFORE_START', { state: stateBefore });

      micSessionRef.current += 1;
      const session = micSessionRef.current;
      speechLifecycleLog('RECOGNITION_REQUESTED', {
        session,
        mode: recognitionModeRef.current,
        entryPoint,
      });
      executeBoundaryEffects(applyBoundary({
        type: 'herald_start',
        mode: recognitionModeRef.current,
        nativeSessionId: session,
        nowMs: Date.now(),
      }));
      requestNativeStart(session);
      log('NATIVE_START_CALLED');
      rlog('NATIVE_START_REQUESTED', { restart: false });

      let stateAfter: string = 'unknown';
      try { stateAfter = await ExpoSpeechRecognitionModule.getStateAsync(); } catch (e) { stateAfter = `error:${String(e)}`; }
      log('STATE_AFTER_START', { state: stateAfter });

      maxTimer.current = setTimeout(() => abandonRecordingForAutomatedTeardown(), 30000);
    } catch (e) {
      log('START_FAILED', { error: String(e) });
      rlog('NATIVE_START_FAILED', { error: String(e), restart: false });
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording, suspendForSpeech, partialText };
}
