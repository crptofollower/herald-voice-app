import { SPEECH_PROVIDER_AB_GOOGLE_TTS } from '../constants/features';

export type RecognitionMode = 'open' | 'control_confirmation';

// M1 short-utterance follow-on, 2026-08-13: STT biasing only -- the
// recognizer still performs real recognition against these words; this
// never fabricates a transcript, it only weights candidates already in
// the acoustic model's consideration set toward Herald's known confirm
// vocabulary (CONFIRM_YES_RE / CONFIRM_NO_RE / CANCEL_RE in
// conversationSession.ts). Requires Android API 33+ for EXTRA_BIASING_STRINGS
// (expo-speech-recognition contextualStrings) -- silently ignored on older
// devices, not a crash, not a regression; does not retire the failure
// class universally, only where the API is available.
export const CONTROL_CONFIRMATION_STRINGS = ['yes', 'no', 'yep', 'nope', 'cancel', 'stop', 'never mind'];

/**
 * Pure function: given the current recognition mode, return the
 * contextualStrings array to merge into start() options, or undefined
 * for open/dictation capture -- undefined means "omit the key entirely",
 * preserving the exact prior config shape for open capture.
 */
export function getContextualStringsForMode(mode: RecognitionMode): string[] | undefined {
  return mode === 'control_confirmation' ? CONTROL_CONFIRMATION_STRINGS : undefined;
}

export type SpeechRecognitionStartConfig = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  /** Omitted entirely (not false) by the SPEECH_PROVIDER_AB_GOOGLE_TTS branch
   *  below -- see that branch's comment for why omission, not `false`, is
   *  required. */
  requiresOnDeviceRecognition?: boolean;
  contextualStrings?: string[];
  androidRecognitionServicePackage?: string;
};

/**
 * Pure function: builds the exact options object passed to
 * ExpoSpeechRecognitionModule.start() for a given recognition mode.
 *
 * 2026-08-13, July-behavior restoration experiment: no EXTRA_LANGUAGE_MODEL
 * override -- native default (free_form) restored, matching the July 17/18
 * device-proven config that successfully transcribed a bare "No". The
 * web_search override (commit a0a5bd70, Aug 5) is removed as the sole
 * changed variable; contextualStrings behavior (control_confirmation mode)
 * is unaffected and layers on top independently.
 */
export function buildStartConfig(mode: RecognitionMode): SpeechRecognitionStartConfig {
  const contextualStrings = getContextualStringsForMode(mode);
  const base = {
    lang: 'en-US',
    interimResults: false,
    // 2026-08-13, AMBIENT_CONTINUOUS short-utterance experiment: continuous:true
    // put SODA in an ambient-continuous session mode. Device A/B evidence
    // (same S24+, keyboard voice typing vs Herald, identical short words)
    // showed Herald selectively failing on "No"/"Mom"/"Dad"/"One" while
    // succeeding on "Yes"/"Yep"/"Stop" -- a pattern consistent with
    // AMBIENT_CONTINUOUS treating certain short utterances as non-speech.
    // false restores a single-utterance recognition session per turn,
    // matching how keyboard voice typing (and, per SODA's log tag, a
    // non-ambient domain) behaves. See state doc for the full archaeology.
    continuous: false,
    ...(contextualStrings ? { contextualStrings } : {}),
  };

  // SPEECH_PROVIDER_AB_GOOGLE_TTS (bounded device-validation diagnostic,
  // 2026-09-xx): applies to BOTH modes uniformly -- confirmation biasing
  // (contextualStrings, already merged into `base` above) is unaffected
  // either way. expo-speech-recognition@56.0.0's native
  // createSpeechRecognizer() branches first on requiresOnDeviceRecognition
  // (Android 13+): that branch always wins and silently ignores
  // androidRecognitionServicePackage if both are set, so selecting the
  // Google provider REQUIRES omitting requiresOnDeviceRecognition entirely
  // here, not setting it false. See features.ts for the full rationale.
  if (SPEECH_PROVIDER_AB_GOOGLE_TTS) {
    return {
      ...base,
      androidRecognitionServicePackage: 'com.google.android.tts',
    };
  }

  return {
    ...base,
    requiresOnDeviceRecognition: true,
  };
}
