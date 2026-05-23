import { useState, useRef } from 'react';
import { Audio } from 'expo-av';
import { API_BASE } from '../constants/api';

export function useMic(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function startRecording() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });

      recordingRef.current = recording;
      setIsRecording(true);

      const SILENCE_THRESHOLD = -50;
      const SILENCE_DURATION  = 1500;
      let   silentMs = 0;

      meteringIntervalRef.current = setInterval(async () => {
        if (!recordingRef.current) return clearInterval(meteringIntervalRef.current!);
        const status = await recordingRef.current.getStatusAsync();
        if (!status.isRecording) return clearInterval(meteringIntervalRef.current!);
        const db = status.metering ?? -160;
        if (db < SILENCE_THRESHOLD) {
          silentMs += 100;
          if (silentMs >= SILENCE_DURATION) {
            clearInterval(meteringIntervalRef.current!);
            meteringIntervalRef.current = null;
            stopRecording();
          }
        } else {
          silentMs = 0;
        }
      }, 100);

      silenceTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      console.error('Mic start failed:', e);
    }
  }

  async function stopRecording() {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    if (meteringIntervalRef.current) {
      clearInterval(meteringIntervalRef.current);
      meteringIntervalRef.current = null;
    }
    if (!recordingRef.current) return;

    try {
      setIsRecording(false);
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

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