// Journey-only speech production-path proof.
// Records booleans and opaque llama context ids. Never stores utterance text.

import type { OpenSpeechEvent } from '../hooks/openSpeechTurnBoundary';

export const SPEECH_PRODUCTION_PATH_FIXTURE = 'turn the lamp on';

export type SpeechProductionPathProof = {
  speechBoundaryEntered: boolean;
  speechAdmissionRequested: boolean;
  speechSemanticInvoked: boolean;
  speechSemanticSettled: boolean;
  speechTranscriptDelivered: boolean;
  speechSendStarted: boolean;
  classifierInvokedAfterSpeech: boolean;
  sameClassifierContext: boolean;
  turnCompleted: boolean;
  speechCompletionCount: number;
  speechClassifierContextId: number | null;
  classifyClassifierContextId: number | null;
};

let armed = false;
let speechBoundaryEntered = false;
let speechAdmissionRequested = false;
let speechSemanticInvoked = false;
let speechSemanticSettled = false;
let speechTranscriptDelivered = false;
let speechSendStarted = false;
let classifierInvokedAfterSpeech = false;
let turnCompleted = false;
let speechCompletionCount = 0;
let speechClassifierContextId: number | null = null;
let classifyClassifierContextId: number | null = null;

export function resetSpeechProductionPathProof(): void {
  armed = false;
  speechBoundaryEntered = false;
  speechAdmissionRequested = false;
  speechSemanticInvoked = false;
  speechSemanticSettled = false;
  speechTranscriptDelivered = false;
  speechSendStarted = false;
  classifierInvokedAfterSpeech = false;
  turnCompleted = false;
  speechCompletionCount = 0;
  speechClassifierContextId = null;
  classifyClassifierContextId = null;
}

export function armSpeechProductionPathProof(): void {
  resetSpeechProductionPathProof();
  armed = true;
}

export function isSpeechProductionPathProofArmed(): boolean {
  return armed;
}

function active(): boolean {
  return armed;
}

export function noteSpeechBoundaryEntered(): void {
  if (!active()) return;
  speechBoundaryEntered = true;
}

export function noteSpeechAdmissionRequested(): void {
  if (!active()) return;
  speechAdmissionRequested = true;
}

export function noteSpeechSemanticInvoked(contextId: number | null): void {
  if (!active()) return;
  speechSemanticInvoked = true;
  speechCompletionCount += 1;
  if (speechClassifierContextId == null && typeof contextId === 'number') {
    speechClassifierContextId = contextId;
  }
}

export function noteSpeechSemanticSettled(): void {
  if (!active()) return;
  speechSemanticSettled = true;
}

export function noteSpeechTranscriptDelivered(): void {
  if (!active()) return;
  speechTranscriptDelivered = true;
}

export function noteSpeechSendStarted(): void {
  if (!active()) return;
  speechSendStarted = true;
}

export function noteClassifierContext(contextId: number | null): void {
  if (!active() || !speechSemanticSettled) return;
  classifierInvokedAfterSpeech = true;
  if (typeof contextId === 'number') classifyClassifierContextId = contextId;
  turnCompleted = true;
}

export function snapshotSpeechProductionPathProof(): SpeechProductionPathProof {
  const sameClassifierContext =
    typeof speechClassifierContextId === 'number' &&
    speechClassifierContextId === classifyClassifierContextId;
  return {
    speechBoundaryEntered,
    speechAdmissionRequested,
    speechSemanticInvoked,
    speechSemanticSettled,
    speechTranscriptDelivered,
    speechSendStarted,
    classifierInvokedAfterSpeech,
    sameClassifierContext,
    turnCompleted,
    speechCompletionCount,
    speechClassifierContextId,
    classifyClassifierContextId,
  };
}

/** Production open-speech events for one committed segment. The reducer decides admission. */
export function journeyCommittedSegmentEvents(
  nativeSessionId: number,
  text: string,
  nowMs: number,
): OpenSpeechEvent[] {
  return [
    { type: 'herald_start', mode: 'open', nativeSessionId, nowMs },
    { type: 'speechstart', nativeSessionId },
    { type: 'native_result_final', nativeSessionId, text },
    {
      type: 'native_end',
      nativeSessionId,
      speechStarted: true,
      partial: '',
      nowMs,
    },
  ];
}
