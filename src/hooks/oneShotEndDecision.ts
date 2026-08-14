export type OneShotEndDecision = 'flush' | 'silence' | 'heard_unrecognized';
export type OneShotNoSpeechDecision = 'flush' | 'teardown';

/**
 * Pure function: what should a one-shot (continuous:false) recognition
 * session do when native 'end' fires?
 *
 * 2026-08-14: useMic previously treated 'end' as a mid-utterance pause
 * and called restartListening() whenever a buffer existed -- that was
 * correct for continuous:true segmented sessions, and wrong once
 * buildStartConfig made every useMic start a single-utterance session.
 * Native 'end' is now the flush boundary. This seam never returns a
 * restart action.
 *
 * - buffer has text → flush once, do not restart
 * - speech onset but no transcript → heard_unrecognized (never invent text)
 * - no onset, no transcript → true silence (no turn)
 */
export function decideOneShotEnd(snapshot: {
  bufferHasContent: boolean;
  speechStarted: boolean;
}): OneShotEndDecision {
  if (snapshot.bufferHasContent) return 'flush';
  if (snapshot.speechStarted) return 'heard_unrecognized';
  return 'silence';
}

/**
 * Pure function: what should a one-shot session do on native 'no-speech'
 * error? A buffered transcript is a completed utterance whose engine
 * timed out; flush it. An empty buffer is not a turn.
 */
export function decideOneShotNoSpeech(snapshot: {
  bufferHasContent: boolean;
}): OneShotNoSpeechDecision {
  return snapshot.bufferHasContent ? 'flush' : 'teardown';
}
