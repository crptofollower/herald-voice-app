import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { createSuspendCoordinator } from './suspendCoordinator';

const SUSPEND_TIMEOUT_MS = 1200;

export function useMic(
  onTranscript: (text: string) => void,
  ttsActiveRef?: { current: boolean },
) {
  const [isRecording, setIsRecording] = useState(false);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferRef = useRef<string>('');
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnActiveRef = useRef(false);
  // Engine session guard: start() on an already-active session wedges the
  // Android recognizer (Listening shown, no results delivered) or fires a
  // non-no-speech error that kills a live turn. One session at a time, always.
  const engineActiveRef = useRef(false);
  const BUFFER_WINDOW = 2500;

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

  const START_CONFIG = {
    lang: 'en-US',
    interimResults: false,
    continuous: true,
    requiresOnDeviceRecognition: true,
  } as const;

  // On-device STT endpoints after ~1-1.5s of silence and stops delivering
  // speech even with continuous:true. A mid-sentence pause makes it fire
  // 'end'/'no-speech' before the user is done. While a turn is in progress
  // (buffered words present) that is a segment boundary, not turn-over:
  // re-arm and keep accumulating. The 2500ms timer is the ONLY turn-over judge.
  const restartListening = () => {
    try {
      micSessionRef.current += 1;
      ExpoSpeechRecognitionModule.start(START_CONFIG);
      engineActiveRef.current = true;
      rlog('NATIVE_START_REQUESTED', { restart: true });
    } catch (e) {
      console.error('[useMic] restart failed:', e);
      rlog('NATIVE_START_FAILED', { error: String(e), restart: true });
    }
  };

  useSpeechRecognitionEvent('start', () => {
    log('NATIVE_START_EVENT');
    rlog('NATIVE_ACTIVE');
  });

  useSpeechRecognitionEvent('result', (event) => {
    log('NATIVE_RESULT', { isFinal: event.isFinal, transcript: event.results[0]?.transcript });
    rlog('NATIVE_RESULT', { isFinal: !!event.isFinal, contentPresent: !!event.results[0]?.transcript?.trim() });
    // Half-duplex: never transcribe while Herald is speaking -- Herald's own
    // voice buffered into an utterance is a fabrication-class failure.
    if (ttsActiveRef?.current) { log('NATIVE_RESULT_DROPPED_TTS_ACTIVE'); return; }
    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) { log('NATIVE_RESULT_EMPTY_NOISE'); return; } // noise segment - keep the mic hot, don't end the turn

      turnActiveRef.current = true; // a turn is in progress; protect it from premature end

      bufferRef.current = bufferRef.current
        ? bufferRef.current + ' ' + text
        : text;

      if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);

      const wordCount = bufferRef.current.split(' ').length;
      const delay = wordCount > 12 ? 1500 : BUFFER_WINDOW;

      bufferTimerRef.current = setTimeout(() => {
        const final = bufferRef.current.trim();
        bufferRef.current = '';
        bufferTimerRef.current = null;
        turnActiveRef.current = false; // genuine turn-over: the next 'end' must NOT restart
        log('STOP_REQUEST', { source: 'bufferTimer_turnOver' });
        rlog('TEARDOWN_REQUESTED', { reason: 'turn_over' });
        // Turn over: close the mic BEFORE handoff so Herald's spoken reply
        // isn't captured as the next utterance (continuous-mode feedback loop).
        try { ExpoSpeechRecognitionModule.stop(); } catch {}
        if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
        setIsRecording(false);
        if (final) onTranscript(final);
      }, delay);

      // NOTE: do NOT setIsRecording(false) here -- between pause segments the
      // user is still mid-utterance; the mic stays hot until the window closes.
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    log('NATIVE_ERROR', { error: event.error, message: (event as any).message });
    rlog('NATIVE_ERROR', { code: event.error });
    engineActiveRef.current = false;
    // no-speech mid-turn = engine timed out on a pause; re-arm, keep the buffer
    if (event.error === 'no-speech' && turnActiveRef.current && bufferRef.current.trim()) {
      restartListening();
      return;
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
    // Per the library's own contract, 'end' is always the last event
    // dispatched, including after errors -- the one reliable confirmation
    // point that a suspend request actually completed.
    suspendCoordinatorRef.current.onNativeEnd();
    // Engine ended its segment. If a turn is in progress with buffered words,
    // this is a mid-utterance pause, not turn-over: re-arm and keep the buffer.
    if (turnActiveRef.current && bufferRef.current.trim()) {
      restartListening();
      return; // do NOT setIsRecording(false), do NOT clear the buffer or its timer
    }
    setIsRecording(false);
    turnActiveRef.current = false;
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
  });

  // Unmount: never leave a caller awaiting a suspend that will never resolve.
  useEffect(() => {
    return () => {
      suspendCoordinatorRef.current.cancel();
    };
  }, []);

  // ── stopRecording memoized -- onTranscript is its only external dep ─────────
  const stopRecording = useCallback(async () => {
    turnActiveRef.current = false; // manual stop: the resulting 'end' must NOT restart
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (bufferRef.current.trim()) {
      const final = bufferRef.current.trim();
      bufferRef.current = '';
      if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
      rlog('TEARDOWN_REQUESTED', { reason: 'manual_stop' });
      try { ExpoSpeechRecognitionModule.stop(); } catch (e) { console.error('[useMic] stop failed:', e); }
      setIsRecording(false);
      onTranscript(final);
      return;
    }
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
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
    entryPoint: 'manual_button' | 'post_tts_handoff' | 'unknown_entry' = 'unknown_entry'
  ) => {
    entryPointRef.current = entryPoint;
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

      let stateBefore: string = 'unknown';
      try { stateBefore = await ExpoSpeechRecognitionModule.getStateAsync(); } catch (e) { stateBefore = `error:${String(e)}`; }
      log('STATE_BEFORE_START', { state: stateBefore });

      micSessionRef.current += 1;
      ExpoSpeechRecognitionModule.start(START_CONFIG);
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
