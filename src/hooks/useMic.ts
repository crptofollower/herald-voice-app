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
  const BUFFER_WINDOW = 3500;

  useSpeechRecognitionEvent('result', (event) => {
    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) return; // noise segment — keep the mic hot, don't end the turn

      bufferRef.current = bufferRef.current
        ? bufferRef.current + ' ' + text
        : text;

      if (bufferTimerRef.current) clearTimeout(bufferTimerRef.current);

      const wordCount = bufferRef.current.split(' ').length;
      const delay = wordCount > 12 ? 1800 : BUFFER_WINDOW;

      bufferTimerRef.current = setTimeout(() => {
        const final = bufferRef.current.trim();
        bufferRef.current = '';
        bufferTimerRef.current = null;
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
    if (event.error !== 'no-speech') {
      console.error('[useMic] Speech recognition error:', event.error);
    }
    setIsRecording(false);
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
  });

  useSpeechRecognitionEvent('end', () => {
    setIsRecording(false);
    if (maxTimer.current) { clearTimeout(maxTimer.current); maxTimer.current = null; }
  });

  // ── stopRecording memoized — onTranscript is its only external dep ─────────
  const stopRecording = useCallback(async () => {
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
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: false,
        continuous: true,
        requiresOnDeviceRecognition: true,
      });
      setIsRecording(true);
      maxTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }, [stopRecording]);

  return { isRecording, startRecording, stopRecording };
}
