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
  requiresOnDeviceRecognition: boolean;
  contextualStrings?: string[];
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
  return {
    lang: 'en-US',
    interimResults: false,
    continuous: true,
    requiresOnDeviceRecognition: true,
    ...(contextualStrings ? { contextualStrings } : {}),
  };
}
