// src/hooks/useSpeech.ts
// TTS hook -- Nova (OpenAI neural voice) via /tts + progressive sentence queue.
//
// CHANGES May 17 2026:
//   speed: 0.85  -- Nova was reading fast (especially long Freddie responses).
//                   0.85 sounds natural, not rushed, still crisp.
//   200ms pause  -- Small breath between sentences. Without it sentences
//                   played back-to-back and sounded like one run-on.
//
// CHANGES May 19 2026:
//   Short-circuit in speak() -- text under 100 chars or a single sentence
//   goes straight to expo-speech with zero network round-trip. Eliminates
//   the 4-5s delay on greetings and short one-shot replies.
//
// WHY THIS DESIGN:
//   The backend streams sentences (the [S] markers in /ask/stream).
//   Instead of waiting for the full response, we speak each sentence the
//   moment it completes. Herald starts talking ~2s in, while the rest is
//   still being written. Words on screen + voice flow together.
//
//   Audio is decoupled into two stages:
//     PRODUCER: enqueueSentence(text) -> fetch /tts MP3 -> push to audioQueue
//     CONSUMER: drain audioQueue, play each clip back-to-back (with 200ms breath)
//   Fetching the next clip happens while the current one plays.
//
// API:
//   speak(text)            one-shot: greeting, direct replies
//   enqueueSentence(text)  streaming: call per [S] sentence marker
//   resetSpeech()          clear queue + stop (call on new send)
//   stop()                 hard stop everything
//   isSpeaking             true while audio is playing

import { useState, useRef, useCallback } from "react";
import { Audio } from "expo-av";
import * as ExpoSpeech from "expo-speech";
import { API_BASE } from "../constants/api";

// ON_DEVICE_TTS: true = expo-speech for all responses (instant, no network)
// false = Nova primary with expo-speech fallback (higher quality, 3-5s delay)
const ON_DEVICE_TTS = true;

const TTS_ENDPOINT = `${API_BASE}/tts`;
const TTS_SPEED = 0.88; // v8.7: bumped from 0.85 -- slightly more energy, less "low key"
const SENTENCE_PAUSE_MS = 200; // breath between sentences

function cleanForSpeech(text: string): string {
  return text
    .replace(/CALENDAR:[^\n]*/g, "")
    .replace(/MAPS:[^\n]*/g, "")
    .replace(/SMS:[^\n]*/g, "")
    .replace(/FLIGHTS:[^\n]*/g, "")
    .replace(/SEARCH:[^\n]*/g, "")
    .replace(/LAUNCH:[^\n]*/g, "")
    .replace(/MUSIC:[^\n]*/g, "")
    .replace(/RADIO:[^\n]*/g, "")
    .replace(/PHONE:[^\n]*/g, "")
    .replace(/ALARM:[^\n]*/g, "")
    .replace(/\[S\]/g, "")
    .trim();
}

// True when the text is short enough to skip the Nova network round-trip.
// Under 100 chars: definitely short. Otherwise, single sentence: no mid-text
// sentence boundary means nothing to queue -- expo-speech is instant.
function isShortOrOneSentence(text: string): boolean {
  if (text.length < 100) return true;
  const sentences = text
    .split(/[.!?]+(?:\s|$)/)
    .filter((s) => s.trim().length > 0);
  return sentences.length <= 3;
}

async function fetchAudioDataUri(text: string): Promise<string> {
  const response = await fetch(TTS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, speed: TTS_SPEED }),
  });
  if (!response.ok) throw new Error(`TTS ${response.status}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

export function useSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);

  const textQueueRef  = useRef<string[]>([]);
  const audioQueueRef = useRef<string[]>([]);
  const fetchingRef   = useRef(false);
  const playingRef    = useRef(false);
  const soundRef         = useRef<Audio.Sound | null>(null);
  const genRef           = useRef(0); // incremented on reset to abandon stale loops
  const expoQueueRef = useRef<string[]>([]);
  const expoSpeakingRef  = useRef(false); // guards overlapping expo-speech fallbacks

  const configureAudio = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
    } catch {}
  }, []);

  // ── Hard stop ──────────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    genRef.current += 1;
    textQueueRef.current  = [];
    audioQueueRef.current = [];
    fetchingRef.current   = false;
    playingRef.current    = false;
    expoSpeakingRef.current = false;
    setIsSpeaking(false);

    if (soundRef.current) {
      try {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
      } catch {}
      soundRef.current = null;
    }
    ExpoSpeech.stop();
    expoQueueRef.current = [];
    expoSpeakingRef.current = false;
  }, []);

  const resetSpeech = stop;

  // ── Playback loop ──────────────────────────────────────────────────────────
  const runPlaybackLoop = useCallback(async (gen: number) => {
    if (playingRef.current) return;
    playingRef.current = true;
    setIsSpeaking(true);

    while (gen === genRef.current) {
      const nextUri = audioQueueRef.current.shift();

      if (!nextUri) {
        if (!fetchingRef.current && textQueueRef.current.length === 0) break;
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }

      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri: nextUri },
          { shouldPlay: true, volume: 1.0 }
        );
        if (gen !== genRef.current) {
          try { await sound.unloadAsync(); } catch {}
          break;
        }
        soundRef.current = sound;

        await new Promise<void>((resolve) => {
          sound.setOnPlaybackStatusUpdate((status) => {
            if (!status.isLoaded) return;
            if (status.didJustFinish || (!status.isPlaying && status.positionMillis > 0)) {
              resolve();
            }
          });
        });

        try { await sound.unloadAsync(); } catch {}
        soundRef.current = null;

        // ── Breath between sentences ──────────────────────────────────────
        // Without this pause sentences run together and sound rushed.
        // 200ms is enough to feel like a natural speaking rhythm.
        if (gen === genRef.current && audioQueueRef.current.length > 0) {
          await new Promise((r) => setTimeout(r, SENTENCE_PAUSE_MS));
        }
      } catch {
        // Skip a bad clip, keep going
      }
    }

    playingRef.current = false;
    if (gen === genRef.current && !expoSpeakingRef.current) setIsSpeaking(false);
  }, []);

  // ── Fetch loop ─────────────────────────────────────────────────────────────
  const runFetchLoop = useCallback(async (gen: number) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    while (gen === genRef.current && textQueueRef.current.length > 0) {
      const next = textQueueRef.current.shift();
      if (!next) break;
      const clean = cleanForSpeech(next);
      if (!clean) continue;

      try {
        const uri = await fetchAudioDataUri(clean);
        if (gen !== genRef.current) break;
        audioQueueRef.current.push(uri);
      } catch {
        // Nova failed -- expo-speech fallback for this sentence
        if (gen !== genRef.current || expoSpeakingRef.current) continue;
        expoSpeakingRef.current = true;
        ExpoSpeech.stop();
        setIsSpeaking(true);
        ExpoSpeech.speak(clean, {
          rate: 0.9,
          pitch: 1.0,
          onDone: () => {
            expoSpeakingRef.current = false;
            if (!playingRef.current) setIsSpeaking(false);
          },
          onError: () => {
            expoSpeakingRef.current = false;
            if (!playingRef.current) setIsSpeaking(false);
          },
        });
      }
    }

    fetchingRef.current = false;
  }, []);

  const drainExpoQueue = useCallback(() => {
    if (expoSpeakingRef.current) return;
    const next = expoQueueRef.current.shift();
    if (!next) {
      setIsSpeaking(false);
      return;
    }
    expoSpeakingRef.current = true;
    ExpoSpeech.speak(next, {
      rate: 0.9,
      pitch: 1.0,
      onDone: () => {
        expoSpeakingRef.current = false;
        drainExpoQueue();
      },
      onError: () => {
        expoSpeakingRef.current = false;
        drainExpoQueue();
      },
    });
  }, []);

  // ── enqueueSentence -- streaming entry point ───────────────────────────────
  const enqueueSentence = useCallback(
    (text: string) => {
      const clean = cleanForSpeech(text);
      if (!clean) return;

      if (ON_DEVICE_TTS || isShortOrOneSentence(clean)) {
        setIsSpeaking(true);
        expoQueueRef.current.push(clean);
        drainExpoQueue();
        return;
      }

      const gen = genRef.current;

      textQueueRef.current.push(clean);
      configureAudio();
      runFetchLoop(gen);
      runPlaybackLoop(gen);
    },
    [configureAudio, runFetchLoop, runPlaybackLoop]
  );

  // ── speak -- one-shot (greeting / non-streamed) ────────────────────────────
  //
  // Fast path: short text or a single sentence speaks instantly via expo-speech,
  // bypassing the Nova fetch entirely. This is the common case for greetings
  // ("Good morning!") and brief replies ("Sure, done.") -- zero perceptible delay.
  //
  // Long multi-sentence responses fall through to the Nova pipeline so they
  // still get the higher-quality neural voice with the sentence queue.
  const speak = useCallback(
    async (text: string) => {
      await stop();
      const clean = cleanForSpeech(text);
      if (!clean) return;

      if (ON_DEVICE_TTS || isShortOrOneSentence(clean)) {
        setIsSpeaking(true);
        await configureAudio();
        ExpoSpeech.speak(clean, {
          rate: 0.9,
          pitch: 1.0,
          onDone: () => setIsSpeaking(false),
          onError: () => setIsSpeaking(false),
        });
        return;
      }

      enqueueSentence(clean);
    },
    [stop, enqueueSentence, configureAudio]
  );

  return { speak, enqueueSentence, resetSpeech, stop, isSpeaking };
}