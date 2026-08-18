import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { createSuspendCoordinator } from './suspendCoordinator';
import { evaluateEmptySessionRecovery, shouldCancelEmptySessionRecovery, shouldCancelEmptySessionRecoveryOnSpeechStart } from './emptySessionRecoveryDecision';
import { decideOneShotEnd, decideOneShotNoSpeech } from './oneShotEndDecision';
import { buildStartConfig } from './recognitionModeConfig';
import type { RecognitionMode } from './recognitionModeConfig';

export { evaluateEmptySessionRecovery } from './emptySessionRecoveryDecision';

const SUSPEND_TIMEOUT_MS = 1200;

export function useMic(
  onTranscript: (text: string) => void,
  ttsActiveRef?: { current: boolean },
) {
  const [isRecording, setIsRecording] = useState(false);
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
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }

    const promise = suspendCoordinatorRef.current.beginSuspend(() => {
      rlog('TEARDOWN_REQUESTED', { reason: 'suspend_for_speech' });
      ExpoSpeechRecognitionModule.stop();
    });
    promise.then((result) => {
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

  // One-shot (continuous:false): native 'end' is the flush boundary.
  // Deliver the buffered transcript without calling native stop() -- the
  // session has already ended -- and without restartListening(), which
  // was continuous-mode pause-stitching and created a second recognition
  // session (and extra Android start/stop tones) per spoken turn.
  const deliverBufferWithoutNativeStop = (source: string) => {
    const final = bufferRef.current.trim();
    bufferRef.current = '';
    // Any delivery (final OR partial-recovered) supersedes any retained
    // partial for this turn -- clear here so a guaranteed follow-up 'end'
    // event (e.g. after an error-path flush) can never re-deliver stale
    // partial content as a duplicate turn.
    latestPartialRef.current = '';
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    turnActiveRef.current = false;
    speechStartedRef.current = false;
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    setIsRecording(false);
    if (final) {
      log('TRANSCRIPT_SELECTED', {
        digitCount: (final.match(/\d/g) || []).length,
        charCount: final.length,
        source,
      });
      onTranscript(final);
    }
  };

  useSpeechRecognitionEvent('start', () => {
    log('NATIVE_START_EVENT');
    rlog('NATIVE_ACTIVE');
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
            stopRecording();
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

      if (bufferTimerRef.current) {
        clearTimeout(bufferTimerRef.current);
        bufferTimerRef.current = null;
      }
      // One-shot: do not arm BUFFER_WINDOW. Native 'end' flushes once.
    } else {
      // Non-final partial carrying real content -- retain for terminal-
      // event recovery only. Overwrite, never concatenate.
      const partialText = event.results[0]?.transcript?.trim();
      if (partialText) {
        latestPartialRef.current = partialText;
      }
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    log('NATIVE_ERROR', { error: event.error, message: (event as any).message });
    rlog('NATIVE_ERROR', { code: event.error });
    engineActiveRef.current = false;
    clearEmptySessionRecovery();
    // no-speech with a buffered transcript = the one-shot utterance completed
    // and the engine timed out; flush once. Do not restart.
    if (event.error === 'no-speech') {
      if (decideOneShotNoSpeech({ bufferHasContent: !!bufferRef.current.trim() }) === 'flush') {
        log('ONE_SHOT_FLUSH', { source: 'no_speech' });
        deliverBufferWithoutNativeStop('no_speech');
        return;
      }
    }
    if (event.error !== 'no-speech') {
      console.error('[useMic] Speech recognition error:', event.error);
    }
    setIsRecording(false);
    turnActiveRef.current = false;
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
  });

  useSpeechRecognitionEvent('end', () => {
    log('NATIVE_END');
    rlog('NATIVE_END');
    engineActiveRef.current = false;
    clearEmptySessionRecovery();
    // Per the library's own contract, 'end' is always the last event
    // dispatched, including after errors -- the one reliable confirmation
    // point that a suspend request actually completed.
    suspendCoordinatorRef.current.onNativeEnd();
    // One-shot: native 'end' is turn-over, not a mid-utterance pause.
    const decision = decideOneShotEnd({
      bufferHasContent: !!bufferRef.current.trim(),
      speechStarted: speechStartedRef.current,
      bestPartialHasContent: !!latestPartialRef.current.trim(),
    });
    if (decision === 'flush') {
      log('ONE_SHOT_FLUSH', { source: 'native_end' });
      rlog('TEARDOWN_COMPLETED', { reason: 'one_shot_flush' });
      deliverBufferWithoutNativeStop('native_end');
      return;
    }
    if (decision === 'flush_partial') {
      // No genuine final ever arrived, but a contentful partial did --
      // recover it through the SAME delivery path as a real final (copy
      // into bufferRef, reuse deliverBufferWithoutNativeStop unchanged).
      // No second routing path.
      log('ONE_SHOT_FLUSH_PARTIAL', { source: 'native_end' });
      rlog('TEARDOWN_COMPLETED', { reason: 'one_shot_flush_partial' });
      bufferRef.current = latestPartialRef.current;
      deliverBufferWithoutNativeStop('native_end_partial');
      return;
    }
    if (decision === 'heard_unrecognized') {
      log('HEARD_UNRECOGNIZED');
      rlog('HEARD_UNRECOGNIZED');
    }
    setIsRecording(false);
    turnActiveRef.current = false;
    speechStartedRef.current = false;
    latestPartialRef.current = '';
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
  });

  // Unmount: never leave a caller awaiting a suspend that will never resolve.
  useEffect(() => {
    return () => {
      suspendCoordinatorRef.current.cancel();
      clearEmptySessionRecovery();
    };
  }, []);

  // ── stopRecording memoized -- onTranscript is its only external dep ─────────
  const stopRecording = useCallback(async () => {
    clearEmptySessionRecovery();
    turnActiveRef.current = false; // manual stop: the resulting 'end' must NOT restart
    speechStartedRef.current = false;
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (bufferRef.current.trim()) {
      const final = bufferRef.current.trim();
      bufferRef.current = '';
      latestPartialRef.current = '';
      if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
      rlog('TEARDOWN_REQUESTED', { reason: 'manual_stop' });
      try { ExpoSpeechRecognitionModule.stop(); } catch (e) { console.error('[useMic] stop failed:', e); }
      setIsRecording(false);
      // TEMP DIAGNOSTIC — D1 structured-speech integrity, 2026-08-12.
      // Metadata only, no transcript content. Remove after D1 is classified.
      log('TRANSCRIPT_SELECTED', {
        digitCount: (final.match(/\d/g) || []).length,
        charCount: final.length,
        source: 'manual_stop',
      });
      onTranscript(final);
      return;
    }
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    latestPartialRef.current = '';
    rlog('TEARDOWN_REQUESTED', { reason: 'manual_stop' });
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      console.error('[useMic] stop failed:', e);
    }
    setIsRecording(false);
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
      if (engineActiveRef.current) { log('START_BLOCKED', { reason: 'engineActive' }); rlog('NATIVE_START_BLOCKED', { reason: 'engineActive' }); return; }      // session already live -- never double-start
      if (ttsActiveRef?.current) { log('START_BLOCKED', { reason: 'ttsActive' }); rlog('NATIVE_START_BLOCKED', { reason: 'ttsActive' }); return; }        // Herald is audible -- mic stays closed
      const { granted } =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) { console.error('[useMic] Mic permission denied'); return; }
      turnActiveRef.current = false; // clean slate for a new turn
      speechStartedRef.current = false;
      latestPartialRef.current = '';
      clearEmptySessionRecovery();

      let stateBefore: string = 'unknown';
      try { stateBefore = await ExpoSpeechRecognitionModule.getStateAsync(); } catch (e) { stateBefore = `error:${String(e)}`; }
      log('STATE_BEFORE_START', { state: stateBefore });

      micSessionRef.current += 1;
      ExpoSpeechRecognitionModule.start(getStartConfig());
      engineActiveRef.current = true;
      setIsRecording(true);
      log('NATIVE_START_CALLED');
      rlog('NATIVE_START_REQUESTED', { restart: false });

      let stateAfter: string = 'unknown';
      try { stateAfter = await ExpoSpeechRecognitionModule.getStateAsync(); } catch (e) { stateAfter = `error:${String(e)}`; }
      log('STATE_AFTER_START', { state: stateAfter });

      maxTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      log('START_FAILED', { error: String(e) });
      rlog('NATIVE_START_FAILED', { error: String(e), restart: false });
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording, suspendForSpeech };
}
