// Journey-only speech production-path proof.
// Booleans, enums, and opaque context ids. Never stores utterance text.

import type { OpenSpeechEvent } from '../hooks/openSpeechTurnBoundary';

export const SPEECH_PRODUCTION_PATH_FIXTURE = 'turn the lamp on';

export type SpeechNativeOutcome = 'ok' | 'error' | null;
export type ClassifierNativeOutcome = 'ok' | 'error' | 'refused' | null;

export type SpeechProductionPathProof = {
  speechBoundaryEntered: boolean;
  speechAdmissionRequested: boolean;
  speechSemanticInvoked: boolean;
  speechSemanticSettled: boolean;
  speechTranscriptDelivered: boolean;
  speechSendStarted: boolean;
  classifierInvokedAfterSpeech: boolean;
  sameClassifierContext: boolean;
  sendProcessingReturned: boolean;
  speechCompletionCount: number;
  speechClassifierContextId: number | null;
  classifyClassifierContextId: number | null;
  speechNativeOutcome: SpeechNativeOutcome;
  speechCompletionSeq: number | null;
  classifierNativeOutcome: ClassifierNativeOutcome;
  classifierCompletionSeq: number | null;
  speechSemanticInvokedSeq: number | null;
  speechSemanticSettledSeq: number | null;
  speechTranscriptDeliveredSeq: number | null;
  speechSendStartedSeq: number | null;
  classifierStartedSeq: number | null;
  classifierSettledSeq: number | null;
};

let armed = false;
let proofTick = 0;
let speechBoundaryEntered = false;
let speechAdmissionRequested = false;
let speechSemanticInvoked = false;
let speechSemanticSettled = false;
let speechTranscriptDelivered = false;
let speechSendStarted = false;
let classifierInvokedAfterSpeech = false;
let sendProcessingReturned = false;
let speechCompletionCount = 0;
let speechClassifierContextId: number | null = null;
let classifyClassifierContextId: number | null = null;
let speechNativeOutcome: SpeechNativeOutcome = null;
let speechCompletionSeq: number | null = null;
let classifierNativeOutcome: ClassifierNativeOutcome = null;
let classifierCompletionSeq: number | null = null;
let speechSemanticInvokedSeq: number | null = null;
let speechSemanticSettledSeq: number | null = null;
let speechTranscriptDeliveredSeq: number | null = null;
let speechSendStartedSeq: number | null = null;
let classifierStartedSeq: number | null = null;
let classifierSettledSeq: number | null = null;

function stamp(): number {
  proofTick += 1;
  return proofTick;
}

export function resetSpeechProductionPathProof(): void {
  armed = false;
  proofTick = 0;
  speechBoundaryEntered = false;
  speechAdmissionRequested = false;
  speechSemanticInvoked = false;
  speechSemanticSettled = false;
  speechTranscriptDelivered = false;
  speechSendStarted = false;
  classifierInvokedAfterSpeech = false;
  sendProcessingReturned = false;
  speechCompletionCount = 0;
  speechClassifierContextId = null;
  classifyClassifierContextId = null;
  speechNativeOutcome = null;
  speechCompletionSeq = null;
  classifierNativeOutcome = null;
  classifierCompletionSeq = null;
  speechSemanticInvokedSeq = null;
  speechSemanticSettledSeq = null;
  speechTranscriptDeliveredSeq = null;
  speechSendStartedSeq = null;
  classifierStartedSeq = null;
  classifierSettledSeq = null;
}

export function armSpeechProductionPathProof(): void {
  resetSpeechProductionPathProof();
  armed = true;
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
  if (speechSemanticInvokedSeq == null) speechSemanticInvokedSeq = stamp();
  if (speechClassifierContextId == null && typeof contextId === 'number') {
    speechClassifierContextId = contextId;
  }
}

export function noteSpeechSemanticSettled(
  outcome: 'ok' | 'error',
  completionSeq: number | null,
): void {
  if (!active()) return;
  speechSemanticSettled = true;
  if (speechSemanticSettledSeq == null) speechSemanticSettledSeq = stamp();
  if (speechNativeOutcome !== 'error') speechNativeOutcome = outcome;
  if (outcome === 'ok' && typeof completionSeq === 'number' && speechNativeOutcome === 'ok') {
    speechCompletionSeq = completionSeq;
  }
}

export function noteSpeechTranscriptDelivered(): void {
  if (!active()) return;
  speechTranscriptDelivered = true;
  if (speechTranscriptDeliveredSeq == null) speechTranscriptDeliveredSeq = stamp();
}

export function noteSpeechSendStarted(): void {
  if (!active()) return;
  speechSendStarted = true;
  if (speechSendStartedSeq == null) speechSendStartedSeq = stamp();
}

export function noteClassifierStarted(contextId: number | null): void {
  if (!active() || !speechSemanticSettled) return;
  if (classifierStartedSeq == null) classifierStartedSeq = stamp();
  if (typeof contextId === 'number') classifyClassifierContextId = contextId;
}

export function noteClassifierSettled(
  outcome: 'ok' | 'error' | 'refused',
  completionSeq: number | null,
): void {
  if (!active() || classifierStartedSeq == null) return;
  classifierNativeOutcome = outcome;
  if (outcome === 'ok' && typeof completionSeq === 'number') {
    classifierInvokedAfterSpeech = true;
    classifierCompletionSeq = completionSeq;
  } else {
    classifierInvokedAfterSpeech = false;
    classifierCompletionSeq = null;
  }
  if (classifierSettledSeq == null) classifierSettledSeq = stamp();
}

/** Production send finished processUtterance. Not a claim that TTS finished. */
export function noteSendProcessingReturned(): void {
  if (!active()) return;
  sendProcessingReturned = true;
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
    sendProcessingReturned,
    speechCompletionCount,
    speechClassifierContextId,
    classifyClassifierContextId,
    speechNativeOutcome,
    speechCompletionSeq,
    classifierNativeOutcome,
    classifierCompletionSeq,
    speechSemanticInvokedSeq,
    speechSemanticSettledSeq,
    speechTranscriptDeliveredSeq,
    speechSendStartedSeq,
    classifierStartedSeq,
    classifierSettledSeq,
  };
}

function before(left: number | null, right: number | null): boolean {
  return typeof left === 'number' && typeof right === 'number' && left < right;
}

export function speechProductionPathSatisfied(snap: SpeechProductionPathProof): boolean {
  return snap.speechBoundaryEntered
    && snap.speechAdmissionRequested
    && snap.speechSemanticInvoked
    && snap.speechSemanticSettled
    && snap.speechNativeOutcome === 'ok'
    && typeof snap.speechCompletionSeq === 'number'
    && snap.speechTranscriptDelivered
    && snap.speechSendStarted
    && snap.classifierInvokedAfterSpeech
    && snap.classifierNativeOutcome === 'ok'
    && typeof snap.classifierCompletionSeq === 'number'
    && snap.sameClassifierContext
    && snap.sendProcessingReturned
    && before(snap.speechSemanticInvokedSeq, snap.speechSemanticSettledSeq)
    && before(snap.speechSemanticSettledSeq, snap.speechTranscriptDeliveredSeq)
    && before(snap.speechTranscriptDeliveredSeq, snap.speechSendStartedSeq)
    && before(snap.speechSendStartedSeq, snap.classifierStartedSeq)
    && before(snap.classifierStartedSeq, snap.classifierSettledSeq);
}

export type DeterministicSpeechProposal = 'uncertain' | 'complete' | 'incomplete' | 'other';

export type DeterministicSpeechPathProof = {
  speechBoundaryEntered: boolean;
  continuationGapElapsed: boolean;
  speechAdmissionRequested: boolean;
  speechResolverReturned: boolean;
  speechProposal: DeterministicSpeechProposal | null;
  classifierContextNull: boolean;
  speechNativeCompletionObserved: boolean;
  transcriptDeliveryCount: number;
  speechSendStarted: boolean;
  sendProcessingReturned: boolean;
  incompleteExtensionTaken: boolean;
  speechBoundaryEnteredSeq: number | null;
  continuationGapElapsedSeq: number | null;
  speechAdmissionRequestedSeq: number | null;
  speechResolverReturnedSeq: number | null;
  transcriptDeliveredSeq: number | null;
  speechSendStartedSeq: number | null;
  sendProcessingReturnedSeq: number | null;
};

let detArmed = false;
let detTick = 0;
let detBoundary = false;
let detGap = false;
let detAdmission = false;
let detAdmissionCount = 0;
let detResolver = false;
let detProposal: DeterministicSpeechProposal | null = null;
let detCtxNull = false;
let detNativeObserved = false;
let detDeliveryCount = 0;
let detSend = false;
let detProcessing = false;
let detBoundarySeq: number | null = null;
let detGapSeq: number | null = null;
let detAdmissionSeq: number | null = null;
let detResolverSeq: number | null = null;
let detTranscriptSeq: number | null = null;
let detSendSeq: number | null = null;
let detProcessingSeq: number | null = null;

function detStamp(): number {
  detTick += 1;
  return detTick;
}

export function resetDeterministicSpeechPathProof(): void {
  detArmed = false;
  detTick = 0;
  detBoundary = false;
  detGap = false;
  detAdmission = false;
  detAdmissionCount = 0;
  detResolver = false;
  detProposal = null;
  detCtxNull = false;
  detNativeObserved = false;
  detDeliveryCount = 0;
  detSend = false;
  detProcessing = false;
  detBoundarySeq = null;
  detGapSeq = null;
  detAdmissionSeq = null;
  detResolverSeq = null;
  detTranscriptSeq = null;
  detSendSeq = null;
  detProcessingSeq = null;
}

export function armDeterministicSpeechPathProof(): void {
  resetDeterministicSpeechPathProof();
  detArmed = true;
}

export function noteDeterministicSpeechBoundaryEntered(): void {
  if (!detArmed || detBoundarySeq != null) return;
  detBoundary = true;
  detBoundarySeq = detStamp();
}

export function noteDeterministicContinuationGapElapsed(): void {
  if (!detArmed || detGapSeq != null) return;
  detGap = true;
  detGapSeq = detStamp();
}

export function noteDeterministicAdmissionRequested(): void {
  if (!detArmed) return;
  detAdmissionCount += 1;
  detAdmission = true;
  if (detAdmissionSeq == null) detAdmissionSeq = detStamp();
}

export function noteDeterministicResolverReturned(input: {
  proposal: DeterministicSpeechProposal;
  classifierContextNull: boolean;
  speechNativeCompletionObserved: boolean;
}): void {
  if (!detArmed || detResolverSeq != null) return;
  detResolver = true;
  detProposal = input.proposal;
  detCtxNull = input.classifierContextNull;
  detNativeObserved = input.speechNativeCompletionObserved;
  detResolverSeq = detStamp();
}

export function noteDeterministicTranscriptDelivered(): void {
  if (!detArmed) return;
  detDeliveryCount += 1;
  if (detTranscriptSeq == null) detTranscriptSeq = detStamp();
}

export function noteDeterministicSpeechSendStarted(): void {
  if (!detArmed || detSendSeq != null) return;
  detSend = true;
  detSendSeq = detStamp();
}

export function noteDeterministicSendProcessingReturned(): void {
  if (!detArmed || detProcessingSeq != null) return;
  detProcessing = true;
  detProcessingSeq = detStamp();
}

export function snapshotDeterministicSpeechPathProof(): DeterministicSpeechPathProof {
  return {
    speechBoundaryEntered: detBoundary,
    continuationGapElapsed: detGap,
    speechAdmissionRequested: detAdmission,
    speechResolverReturned: detResolver,
    speechProposal: detProposal,
    classifierContextNull: detCtxNull,
    speechNativeCompletionObserved: detNativeObserved,
    transcriptDeliveryCount: detDeliveryCount,
    speechSendStarted: detSend,
    sendProcessingReturned: detProcessing,
    incompleteExtensionTaken: detAdmissionCount > 1,
    speechBoundaryEnteredSeq: detBoundarySeq,
    continuationGapElapsedSeq: detGapSeq,
    speechAdmissionRequestedSeq: detAdmissionSeq,
    speechResolverReturnedSeq: detResolverSeq,
    transcriptDeliveredSeq: detTranscriptSeq,
    speechSendStartedSeq: detSendSeq,
    sendProcessingReturnedSeq: detProcessingSeq,
  };
}

export function deterministicSpeechPathSatisfied(snap: DeterministicSpeechPathProof): boolean {
  return snap.speechBoundaryEntered
    && snap.continuationGapElapsed
    && snap.speechAdmissionRequested
    && snap.speechResolverReturned
    && snap.speechProposal === 'uncertain'
    && snap.classifierContextNull
    && snap.speechNativeCompletionObserved === false
    && snap.transcriptDeliveryCount === 1
    && snap.speechSendStarted
    && snap.sendProcessingReturned
    && snap.incompleteExtensionTaken === false
    && before(snap.speechBoundaryEnteredSeq, snap.continuationGapElapsedSeq)
    && before(snap.continuationGapElapsedSeq, snap.speechAdmissionRequestedSeq)
    && before(snap.speechAdmissionRequestedSeq, snap.speechResolverReturnedSeq)
    && before(snap.speechResolverReturnedSeq, snap.transcriptDeliveredSeq)
    && before(snap.transcriptDeliveredSeq, snap.speechSendStartedSeq)
    && before(snap.speechSendStartedSeq, snap.sendProcessingReturnedSeq);
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
