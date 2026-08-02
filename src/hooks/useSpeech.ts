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
// CHANGES 2026-08-02 (audio session lifecycle fix):
//   speak() and enqueueSentence() now share ONE queue/state authority.
//   speak() = enqueueSentence(text, { isLast: true }) -- marks the turn
//   done immediately since nothing more is coming. enqueueSentence() alone
//   leaves the turn open until the caller calls finishStream().
//   ensureTurnStarted() awaits an injected ensureMicSuspended() (via a ref,
//   to break a circular hook dependency with useMic) before any audio of a
//   turn is allowed to queue. Single-flight via createTurnStartGate --
//   concurrent callers within one turn share the same promise. Fails
//   closed: if the mic can't be confirmed suspended, no audio plays.
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
//   finishStream()         call when the backend stream has fully completed
//   resetSpeech()          clear queue + stop (call on new send)
//   stop()                 hard stop everything
//   isSpeaking             true while audio is playing

import { useState, useRef, useCallback, useEffect } from "react";
import { Audio } from "expo-av";
import * as ExpoSpeech from "expo-speech";
import { API_BASE } from "../constants/api";
import { createTurnStartGate } from "./turnStartGate";

const ON_DEVICE_TTS = true;

const TTS_ENDPOINT = `${API_BASE}/tts`;
const TTS_SPEED = 0.88;
const SENTENCE_PAUSE_MS = 200;

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

type EnsureMicSuspended = () => Promise<{ confirmed: boolean }>;
type EnsureMicSuspendedRef = { current: EnsureMicSuspended | null };

export function useSpeech(ensureMicSuspendedRef: EnsureMicSuspendedRef) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  // Half-duplex authority: a ref mirror of isSpeaking, readable synchronously
  // at the moment the mic tries to open. State alone races (stale by the time
  // a timer fires); the ref is the truth the mic checks.
  const isSpeakingRef = useRef(false);
  const setSpeaking = useCallback((v: boolean) => {
    isSpeakingRef.current = v;
    setIsSpeaking(v);
  }, []);

  const textQueueRef  = useRef<string[]>([]);
  const audioQueueRef = useRef<string[]>([]);
  const fetchingRef   = useRef(false);
  const playingRef    = useRef(false);
  const soundRef         = useRef<Audio.Sound | null>(null);
  const genRef           = useRef(0); // incremented on reset/unmount to abandon stale loops
  const expoQueueRef = useRef<string[]>([]);
  const expoSpeakingRef  = useRef(false); // guards overlapping expo-speech fallbacks

  const streamEndedRef = useRef(true);      // true = no stream currently open
  const turnSuppressedRef = useRef(false);  // true = mic suspend failed, stay silent this turn
  const turnStartGateRef = useRef(createTurnStartGate());

  // ── TEMP DIAGNOSTIC — recovery-contract evidence gathering, 2026-08-02 ──
  // Additive only. No control-flow dependency.
  const rlog = (event: string, gen: number, extra: Record<string, unknown> = {}) => {
    console.log(
      `[RECOVERY-INSTRUMENT] ts=${Date.now()} turn=tts:${gen} gen=tts:${gen} ` +
      `entry=tts_turn_start event=${event} ${JSON.stringify(extra)}`
    );
  };
  // ── END NEW DIAGNOSTIC HEADER ────────────────────────────────────────────

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

  const ensureTurnStarted = useCallback((): Promise<boolean> => {
    const gen = genRef.current;
    rlog('ENSURE_TURN_STARTED_CALLED', gen);
    const p = turnStartGateRef.current.ensure(
      gen,
      () => genRef.current,
      async () => {
        await configureAudio();
        const suspend = ensureMicSuspendedRef.current;
        if (!suspend) return { confirmed: true };
        return suspend();
      },
    );
    p.then((result) => {
      rlog('ENSURE_TURN_STARTED_RESOLVED', gen, { resolution: result ? 'granted' : 'rejected' });
    });
    return p;
  }, [configureAudio, ensureMicSuspendedRef]);

  // ── Hard stop ──────────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    genRef.current += 1;
    textQueueRef.current  = [];
    audioQueueRef.current = [];
    fetchingRef.current   = false;
    playingRef.current    = false;
    expoSpeakingRef.current = false;
    setSpeaking(false);

    streamEndedRef.current = true;
    turnSuppressedRef.current = false;
    turnStartGateRef.current.reset();

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

  // Unmount: abandon any in-flight turn-start/playback work. The gen check
  // inside ensureTurnStarted/enqueueSentence makes a late resolution after
  // unmount a safe no-op, not a stray state update.
  useEffect(() => {
    return () => {
      genRef.current += 1;
    };
  }, []);

  // ── Playback loop (Nova path -- currently dead code, ON_DEVICE_TTS is always true) ──
  const runPlaybackLoop = useCallback(async (gen: number) => {
    if (playingRef.current) return;
    playingRef.current = true;
    setSpeaking(true);

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

        if (gen === genRef.current && audioQueueRef.current.length > 0) {
          await new Promise((r) => setTimeout(r, SENTENCE_PAUSE_MS));
        }
      } catch {
        // Skip a bad clip, keep going
      }
    }

    playingRef.current = false;
    if (gen === genRef.current && !expoSpeakingRef.current) setSpeaking(false);
  }, []);

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
        if (gen !== genRef.current || expoSpeakingRef.current) continue;
        expoSpeakingRef.current = true;
        ExpoSpeech.stop();
        setSpeaking(true);
        ExpoSpeech.speak(clean, {
          rate: 0.9,
          pitch: 1.0,
          onDone: () => {
            expoSpeakingRef.current = false;
            if (!playingRef.current) setSpeaking(false);
          },
          onError: () => {
            expoSpeakingRef.current = false;
            if (!playingRef.current) setSpeaking(false);
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
      if (streamEndedRef.current) {
        setSpeaking(false);
      }
      // else: queue empty but more sentences are still expected -- stay
      // "speaking" and wait for the next enqueueSentence/finishStream call.
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

  // ── enqueueSentence -- the single TTS-turn authority. Called directly
  // for streamed sentences, and internally by speak() for one-shot replies.
  const enqueueSentence = useCallback(
    (text: string, opts?: { isLast?: boolean }) => {
      const clean = cleanForSpeech(text);
      if (!clean) return;
      const gen = genRef.current;

      (async () => {
        if (turnSuppressedRef.current) return;

        const started = await ensureTurnStarted();
        if (gen !== genRef.current) {
          rlog('STALE_CALLBACK', gen, { context: 'enqueueSentence_post_turnStart', currentGen: genRef.current });
          return; // a new turn began while we waited
        }

        if (!started) {
          turnSuppressedRef.current = true;
          console.warn('[useSpeech] turn suppressed -- mic suspend not confirmed, no audio this turn');
          return;
        }

        if (opts?.isLast) streamEndedRef.current = true;

        if (ON_DEVICE_TTS || isShortOrOneSentence(clean)) {
          setSpeaking(true);
          expoQueueRef.current.push(clean);
          drainExpoQueue();
          return;
        }

        textQueueRef.current.push(clean);
        runFetchLoop(gen);
        runPlaybackLoop(gen);
      })();
    },
    [ensureTurnStarted, drainExpoQueue, runFetchLoop, runPlaybackLoop]
  );

  // ── speak -- one-shot (greeting / non-streamed / deterministic replies) ────
  const speak = useCallback(
    async (text: string) => {
      await stop();
      enqueueSentence(text, { isLast: true });
    },
    [stop, enqueueSentence]
  );

  // ── finishStream -- caller (ChatScreen) calls this exactly when the
  // backend stream has completed, on every path (success/error/early-exit).
  const finishStream = useCallback(() => {
    streamEndedRef.current = true;
    drainExpoQueue();
  }, [drainExpoQueue]);

  return { speak, enqueueSentence, finishStream, resetSpeech, stop, isSpeaking, isSpeakingRef };
}
