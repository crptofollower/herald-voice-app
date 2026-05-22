import { useState, useRef } from 'react';
import { Audio } from 'expo-av';
import { API_BASE } from '../constants/api';

export function useMic(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function startRecording() {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setIsRecording(true);

      // Auto-stop after 30 seconds max
      silenceTimer.current = setTimeout(() => stopRecording(), 30000);
    } catch (e) {
      console.error('Mic start failed:', e);
    }
  }

  async function stopRecording() {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
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