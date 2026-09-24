// Slice 7 — recognition commitment is not conversational admission.
// The open-speech boundary remains the lifecycle owner. This record
// only names that distinction. It does not inspect wording.

import {
  stitchOpenSpeechSegments,
  type OpenSpeechTurnState,
} from './openSpeechTurnBoundary';

export type SpeechConversationalStatus = 'provisional' | 'admitted' | 'abandoned';

export type SpeechTurnEnvelope = {
  text: string;
  speechSessionId: number;
  recognitionCommitted: boolean;
  conversationalStatus: SpeechConversationalStatus;
  admissionSource: string | null;
};

export function projectSpeechTurnEnvelope(
  state: OpenSpeechTurnState,
  admissionSource: string | null = null,
): SpeechTurnEnvelope {
  const text = stitchOpenSpeechSegments(state.segments);
  const conversationalStatus: SpeechConversationalStatus =
    state.phase === 'abandoned'
      ? 'abandoned'
      : state.phase === 'finalized' && state.delivered
        ? 'admitted'
        : 'provisional';
  return {
    text: conversationalStatus === 'abandoned' ? '' : text,
    speechSessionId: state.heraldTurnId,
    recognitionCommitted: state.segments.length > 0,
    conversationalStatus,
    admissionSource: conversationalStatus === 'admitted' ? admissionSource : null,
  };
}

/** Only an already-finalized boundary delivery may be spoken as a user turn. */
export function admittedTurnText(
  state: OpenSpeechTurnState,
  utterance: string,
  source: string,
): string | null {
  const envelope = projectSpeechTurnEnvelope(state, source);
  if (envelope.conversationalStatus !== 'admitted') return null;
  const text = utterance.trim();
  return text.length > 0 ? text : null;
}
