// useSpeech.ts -- Herald TTS hook
// FIXES APPLIED (May 12 2026):
//
//   Bug 9: cleanForTTS produced double-periods.
//     Root cause: replace(/\n{2,}/g, ". ") was applied unconditionally.
//     If the text before the paragraph break already ends with a sentence
//     terminator (. ! ? …), the result is "Hello world.. Next paragraph"
//     or "Question?. Answer." — both read aloud as a stutter.
//     Also: replace(/\n/g, " ") converts numbered lists to run-on strings
//     where TTS says "1. First item 2. Second item" — confusing.
//     Fix: check for trailing punctuation before inserting the period;
//     handle list prefixes explicitly.

import { useCallback, useRef, useState } from "react";
import * as Speech from "expo-speech";
import { TTS_PITCH, TTS_RATE } from "../constants/api";
import { useStore } from "../store/useStore";

interface UseSpeechReturn {
  speak: (text: string) => void;
  stop: () => void;
  isSpeaking: boolean;
}

// Characters that are already sentence terminators — don't add a period after them.
const SENTENCE_END = /[.!?…]$/;

// Strip markdown and prepare text for natural TTS reading.
export function cleanForTTS(text: string): string {
  return text
    // Remove bold and italic markers, keep text.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    // Remove inline code backticks, keep text.
    .replace(/`(.*?)`/g, "$1")
    // Remove ATX headings (#, ##, etc.) at the start of a line.
    .replace(/^#{1,6}\s+/gm, "")
    // Convert markdown links to just their label text.
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Convert numbered and bulleted list items to a speakable form.
    // "1. Item\n2. Item" → "Item. Item."  (strip the number/bullet)
    .replace(/^[\s]*(?:\d+\.|[-*+])\s+/gm, "")
    // BUG 9 FIX: paragraph breaks → sentence separator.
    // Only insert a period if the preceding text doesn't already end with
    // sentence-terminal punctuation. Prevents "Hello world.. Next." pattern.
    .replace(/([^\n])\n{2,}/g, (_, preceding) =>
      SENTENCE_END.test(preceding.trimEnd())
        ? `${preceding} `
        : `${preceding}. `
    )
    // Remaining single newlines → space (within a paragraph).
    .replace(/\n/g, " ")
    // Collapse multiple spaces (can appear after stripping markers).
    .replace(/  +/g, " ")
    .trim();
}

export function useSpeech(): UseSpeechReturn {
  const ttsEnabled = useStore((s) => s.ttsEnabled);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const utteranceRef = useRef<string | null>(null);

  const speak = useCallback(
    (text: string) => {
      if (!ttsEnabled) return;

      const cleaned = cleanForTTS(text);
      if (!cleaned) return;

      // Cancel any speech currently in progress before starting new.
      Speech.stop();

      utteranceRef.current = cleaned;
      setIsSpeaking(true);

      Speech.speak(cleaned, {
        rate: TTS_RATE,
        pitch: TTS_PITCH,
        onDone:    () => setIsSpeaking(false),
        onError:   () => setIsSpeaking(false),
        onStopped: () => setIsSpeaking(false),
      });
    },
    [ttsEnabled]
  );

  const stop = useCallback(() => {
    Speech.stop();
    setIsSpeaking(false);
  }, []);

  return { speak, stop, isSpeaking };
}
