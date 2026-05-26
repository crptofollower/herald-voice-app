import { useRef, useState } from 'react';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

export function useMic(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufferRef = useRef<string>('');
  const bufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const BUFFER_WINDOW = 2400; // ms to wait for follow-up speech

  useSpeechRecognitionEvent('result', (event) => {
    if (event.isFinal) {
      const text = event.results[0]?.transcript?.trim();
      if (!text) { setIsRecording(false); return; }

      // Accumulate into buffer
      bufferRef.current = bufferRef.current
        ? bufferRef.current + ' ' + text
        : text;

      // Clear any existing timer
      if (bufferTimerRef.current) {
        clearTimeout(bufferTimerRef.current);
      }

      // Short confident statements send faster
      const wordCount = bufferRef.current.split(' ').length;
      const delay = wordCount > 8 ? 1200 : BUFFER_WINDOW;

      bufferTimerRef.current = setTimeout(() => {
        const final = bufferRef.current.trim();
        bufferRef.current = '';
        bufferTimerRef.current = null;
        if (final) onTranscript(final);
      }, delay);

      setIsRecording(false);
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (event.error !== 'no-speech') {
      console.error('[useMic] Speech recognition error:', event.error);
    }
    setIsRecording(false);
    if (maxTimer.current) {
      clearTimeout(maxTimer.current);
      maxTimer.current = null;
    }
  });

  useSpeechRecognitionEvent('end', () => {
    setIsRecording(false);
    if (maxTimer.current) {
      clearTimeout(maxTimer.current);
      maxTimer.current = null;
    }
  });

  async function startRecording() {
    try {
      const { granted } =
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) {
        console.error('[useMic] Mic permission denied');
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: false,
        continuous: false,
      });
      setIsRecording(true);
      maxTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      console.error('[useMic] start failed:', e);
      setIsRecording(false);
    }
  }

  async function stopRecording() {
    // Flush buffer immediately on manual stop
    if (bufferTimerRef.current) {
      clearTimeout(bufferTimerRef.current);
      bufferTimerRef.current = null;
    }
    if (bufferRef.current.trim()) {
      const final = bufferRef.current.trim();
      bufferRef.current = '';
      onTranscript(final);
      return;
    }
    if (maxTimer.current) {
      clearTimeout(maxTimer.current);
      maxTimer.current = null;
    }
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      console.error('[useMic] stop failed:', e);
    }
    setIsRecording(false);
  }

  return { isRecording, startRecording, stopRecording };
}
