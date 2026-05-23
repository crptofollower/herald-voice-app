import { useState, useRef } from 'react';
import { useAudioRecorder, RecordingPresets, AudioModule } from 'expo-audio';
import { API_BASE } from '../constants/api';

export function useMic(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  async function startRecording() {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        console.error('Mic permission denied');
        return;
      }
      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecording(true);

      const SILENCE_THRESHOLD = -50;
      const SILENCE_DURATION  = 1500;
      let silentMs = 0;

      meteringInterval.current = setInterval(() => {
        const db = recorder.currentMetering ?? -160;
        if (db < SILENCE_THRESHOLD) {
          silentMs += 100;
          if (silentMs >= SILENCE_DURATION) {
            clearInterval(meteringInterval.current!);
            meteringInterval.current = null;
            stopRecording();
          }
        } else {
          silentMs = 0;
        }
      }, 100);

      silenceTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      setIsRecording(false);
      console.error('Mic start failed:', e);
    }
  }

  async function stopRecording() {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
    if (meteringInterval.current) { clearInterval(meteringInterval.current); meteringInterval.current = null; }
    if (!isRecording) return;
    try {
      setIsRecording(false);
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) await transcribe(uri);
    } catch (e) {
      console.error('Mic stop failed:', e);
    }
  }

  async function transcribe(uri: string) {
    try {
      const formData = new FormData();
      formData.append('file', {
        uri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      } as any);
      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.text?.trim()) {
        onTranscript(data.text.trim());
      }
    } catch (e) {
      console.error('Transcribe failed:', e);
    }
  }

  return { isRecording, startRecording, stopRecording };
}
