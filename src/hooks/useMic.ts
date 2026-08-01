import { useCallback, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

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

  // ── TEMP DIAGNOSTIC — audio lifecycle investigation, 2026-08-01 ──────────
  // Remove entirely before final commit. Logging only, no behavior change.
  const sessionIdRef = useRef(0);
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    console.log(
      `[MICLOG] t=${Date.now()} evt=${event} sid=${sessionIdRef.current} ` +
      `isRecording=${isRecording} engineActive=${engineActiveRef.current} ` +
      `turnActive=${turnActiveRef.current} bufferHasText=${!!bufferRef.current.trim()} ` +
      `ttsActive=${!!ttsActiveRef?.current} ${JSON.stringify(extra)}`
    );
  };
  // ── END TEMP DIAGNOSTIC HEADER ────────────────────────────────────────────

  const START_CONFIG = {
    lang: 'en-US',
    interimResults: false,
    continuous: true,
    requiresOnDeviceRecognition: true,
  } as const;

  const restartListening = () => {
    sessionIdRef.current += 1;
    log('RESTART_REQUEST');
    try {
      ExpoSpeechRecognitionModule.start(START_CONFIG);
      engineActiveRef.current = true;
      log('RESTART_STARTED');
    } catch (e) {
      log('RESTART_FAILED', { error: String(e) });
      console.error('[useMic] restart failed:', e);
    }
  };

  useSpeechRecognitionEvent('result', (event) => {
    log('NATIVE_RESULT', { isFinal: event.isFinal, transcript: event.results[0]?.transcript });
    if (ttsActiveRef?.current) { log('NATIVE_RESULT_DROPPED_TTS_ACTIVE'); return; }
    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) { log('NATIVE_RESULT_EMPTY_NOISE'); return; }

      turnActiveRef.current = true;

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
        turnActiveRef.current = false;
        log('STOP_REQUEST', { source: 'bufferTimer_turnOver' });
        try { ExpoSpeechRecognitionModule.stop(); } catch {}
        if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
        setIsRecording(false);
        if (final) onTranscript(final);
      }, delay);
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    log('NATIVE_ERROR', { error: event.error });
    engineActiveRef.current = false;
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
    log('ERROR_HANDLER_CLOSED');
  });

  useSpeechRecognitionEvent('end', () => {
    log('NATIVE_END');
    engineActiveRef.current = false;
    if (turnActiveRef.current && bufferRef.current.trim()) {
      restartListening();
      return;
    }
    setIsRecording(false);
    turnActiveRef.current = false;
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    if (bufferTimerRef.current) { clearTimeout(bufferTimerRef.current); bufferTimerRef.current = null; }
    bufferRef.current = '';
    log('END_HANDLER_CLOSED');
  });

  const stopRecording = useCallback(async () => {
    turnActiveRef.current = false;
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (bufferRef.current.trim()) {
      const final = bufferRef.current.trim();
      bufferRef.current = '';
      if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
      log('STOP_REQUEST', { source: 'stopRecording_withBuffer' });
      try { ExpoSpeechRecognitionModule.stop(); } catch (e) { console.error('[useMic] stop failed:', e); }
      setIsRecording(false);
      onTranscript(final);
      return;
    }
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    log('STOP_REQUEST', { source: 'stopRecording_empty' });
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      console.error('[useMic] stop failed:', e);
    }
    setIsRecording(false);
  }, [onTranscript]);

  const startRecording = useCallback(async () => {
    try {
      if (engineActiveRef.current) { log('START_REQUEST_BLOCKED', { reason: 'engineActive' }); return; }
      if (ttsActiveRef?.current) { log('START_REQUEST_BLOCKED', { reason: 'ttsActive' }); return; }
      const { granted } =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) { console.error('[useMic] Mic permission denied'); return; }
      turnActiveRef.current = false;
      sessionIdRef.current += 1;
      log('START_REQUEST');
      ExpoSpeechRecognitionModule.start(START_CONFIG);
      engineActiveRef.current = true;
      setIsRecording(true);
      log('START_STARTED');
      maxTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      log('START_FAILED', { error: String(e) });
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording };
}
