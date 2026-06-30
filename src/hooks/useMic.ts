import { useCallback, useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

export function useMic(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferRef = useRef<string>('');
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnActiveRef = useRef(false);
  const BUFFER_WINDOW = 2500;

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
      ExpoSpeechRecognitionModule.start(START_CONFIG);
    } catch (e) {
      console.error('[useMic] restart failed:', e);
    }
  };

  useSpeechRecognitionEvent('result', (event) => {
    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) return; // noise segment - keep the mic hot, don't end the turn

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
        // Turn over: close the mic BEFORE handoff so Herald's spoken reply
        // isn't captured as the next utterance (continuous-mode feedback loop).
        try { ExpoSpeechRecognitionModule.stop(); } catch {}
        if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
        setIsRecording(false);
        if (final) onTranscript(final);
      }, delay);

      // NOTE: do NOT setIsRecording(false) here — between pause segments the
      // user is still mid-utterance; the mic stays hot until the window closes.
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
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

  // ── stopRecording memoized — onTranscript is its only external dep ─────────
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
      try { ExpoSpeechRecognitionModule.stop(); } catch (e) { console.error('[useMic] stop failed:', e); }
      setIsRecording(false);
      onTranscript(final);
      return;
    }
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      console.error('[useMic] stop failed:', e);
    }
    setIsRecording(false);
  }, [onTranscript]);

  // ── startRecording memoized — stopRecording is its only dep ───────────────
  // Previously a plain async function → new reference every render →
  // ChatScreen's hands-free useEffect ([..., startRecording]) fired on every
  // render → called startRecording() → triggered re-render → loop.
  const startRecording = useCallback(async () => {
    try {
      const { granted } =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) { console.error('[useMic] Mic permission denied'); return; }
      turnActiveRef.current = false; // clean slate for a new turn
      ExpoSpeechRecognitionModule.start(START_CONFIG);
      setIsRecording(true);
      maxTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording };
}
