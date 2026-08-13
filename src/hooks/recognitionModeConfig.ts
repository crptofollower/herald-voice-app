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
