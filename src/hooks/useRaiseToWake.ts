// src/hooks/useRaiseToWake.ts
// Herald raise-to-wake — two-stage activation.
//
// Stage 1: Accelerometer detects phone movement (tilt > 30° from flat).
//          Enters silent name-listening mode. No UI change.
//
// Stage 2: useMic listens for the AI name ("Obi", "Herald", "Maya" etc).
//          If name heard within LISTEN_WINDOW_MS → fires onWake().
//          If no name heard → returns to sleep silently.
//
// This is NOT always-on. The accelerometer only runs when the app is
// in the foreground. Battery impact is minimal — accelerometer is
// one of the lowest-power sensors on the device.

import { useEffect, useRef, useCallback } from 'react';
import { Accelerometer } from 'expo-sensors';

const TILT_THRESHOLD = 0.3;       // Z-axis delta from flat (0=flat, 1=vertical)
const LISTEN_WINDOW_MS = 10_000;  // 10 seconds to say the name after movement
const COOLDOWN_MS = 3_000;        // 3 seconds before re-triggering after sleep

interface UseRaiseToWakeOptions {
  aiName: string;          // "Obi", "Herald", "Maya" — the name to listen for
  onWake: () => void;      // called when name is detected after movement
  enabled: boolean;        // false when Herald is speaking (prevents feedback)
}

export function useRaiseToWake({ aiName, onWake, enabled }: UseRaiseToWakeOptions) {
  const listeningForNameRef = useRef(false);  // Stage 2 active
  const listenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const lastZRef = useRef(1); // flat = Z ~1.0 (gravity)
  const motionHistoryRef = useRef<number[]>([]);
  const isIdleRef = useRef(false);

  const stopListeningForName = useCallback(() => {
    listeningForNameRef.current = false;
    if (listenTimerRef.current) {
      clearTimeout(listenTimerRef.current);
      listenTimerRef.current = null;
    }
    try {
      recognitionRef.current?.removeAllListeners?.('result');
      recognitionRef.current?.stop?.();
    } catch {}
    recognitionRef.current = null;
  }, []);

  const startListeningForName = useCallback(() => {
    if (listeningForNameRef.current || cooldownRef.current || !enabled) return;
    listeningForNameRef.current = true;

    // 10-second window to say the name — then go back to sleep
    listenTimerRef.current = setTimeout(() => {
      stopListeningForName();
      cooldownRef.current = true;
      setTimeout(() => { cooldownRef.current = false; }, COOLDOWN_MS);
    }, LISTEN_WINDOW_MS);

    // Use expo-speech-recognition for name detection
    // Import dynamically to avoid circular dep issues
    import('expo-speech-recognition').then(({ ExpoSpeechRecognitionModule }) => {
      if (!listeningForNameRef.current) return;

      const nameLower = aiName.toLowerCase();
      // Require the name to appear as a whole word, not mid-sentence substring
      const namePattern = new RegExp(`\\b${nameLower}\\b`, 'i');

      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        continuous: true,
        interimResults: true,
        requiresOnDeviceRecognition: true,
      });

      ExpoSpeechRecognitionModule.addListener('result', (event: any) => {
        const transcript = (event?.results?.[0]?.transcript ?? '').toLowerCase();
        const nameHeard = namePattern.test(transcript);
        if (nameHeard && listeningForNameRef.current) {
          stopListeningForName(); // stops recognition BEFORE onWake starts mic
          cooldownRef.current = true;
          setTimeout(() => { cooldownRef.current = false; }, COOLDOWN_MS);
          // Small delay to let recognition fully stop before mic starts
          setTimeout(() => { onWake(); }, 150);
        }
      });

      recognitionRef.current = ExpoSpeechRecognitionModule;
    }).catch(() => {
      // expo-speech-recognition not available — stop silently
      stopListeningForName();
    });
  }, [aiName, enabled, onWake, stopListeningForName]);

  useEffect(() => {
    if (!enabled) {
      stopListeningForName();
      return;
    }

    // Accelerometer subscription — Stage 1
    Accelerometer.setUpdateInterval(500); // check every 500ms — power efficient
    const subscription = Accelerometer.addListener(({ z }) => {
      // Z ~1.0 = phone flat on table (gravity pointing down through screen)
      // Z < 0.7 = phone tilted/lifted — user is holding it
      const delta = Math.abs(z - lastZRef.current);
      lastZRef.current = z;

      motionHistoryRef.current.push(delta);
      if (motionHistoryRef.current.length > 10) motionHistoryRef.current.shift();
      const avgMotion = motionHistoryRef.current.reduce((a, b) => a + b, 0)
                        / Math.max(1, motionHistoryRef.current.length);
      // Sustained motion = driving/walking = skip activation
      if (avgMotion > 0.12 && motionHistoryRef.current.length >= 5) return;

      // If phone has been flat and stationary for 5+ readings, mark idle
      const isFlat = Math.abs(z) > 0.92;
      if (isFlat && delta < 0.02) {
        isIdleRef.current = true;
      } else if (delta > 0.08) {
        isIdleRef.current = false;
      }
      // Skip processing when confirmed idle (phone on table)
      if (isIdleRef.current && isFlat) return;

      const isTilted = Math.abs(z) < (1 - TILT_THRESHOLD);
      const isMoving = delta > 0.15;

      if ((isTilted || isMoving) && !listeningForNameRef.current && !cooldownRef.current) {
        startListeningForName();
      }

      // Phone goes flat again — cancel name listening
      if (Math.abs(z) > 0.9 && listeningForNameRef.current) {
        stopListeningForName();
      }
    });

    return () => {
      subscription.remove();
      stopListeningForName();
    };
  }, [enabled, startListeningForName, stopListeningForName]);
}
