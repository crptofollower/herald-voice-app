// Natural Speech Turn Boundary V1.1 — open speech only.
// Native one-shot end is a provisional segment boundary, not the Herald turn.
// Empty continuation silence is not Herald-turn completion.
// continuous:false is unchanged. control_confirmation keeps native-end = Herald turn.

import type { RecognitionMode } from './recognitionModeConfig';
import { decideOneShotEnd } from './oneShotEndDecision';
import {
  decideSpeechAdmission,
  type SpeechAdmissionTrigger,
  type SpeechCompletionProposal,
} from './speechAdmission';

/** Provisional. User-facing continuation window after native listening-ready. Not device-tuned. */
export const OPEN_SPEECH_CONTINUATION_GAP_MS = 1200;
/** Provisional. Safety cap on one open Herald turn wall-clock. Not device-tuned. */
export const OPEN_SPEECH_MAX_TURN_MS = 20_000;
/** Provisional. Safety cap on contentful segments and empty continuation ends. Not device-tuned. */
export const OPEN_SPEECH_MAX_SEGMENTS = 5;

export type OpenSpeechPhase =
  | 'idle'
  | 'listening'
  | 'awaiting_continuation'
  | 'finalized'
  | 'abandoned';

export type OpenSpeechTurnState = {
  mode: RecognitionMode;
  phase: OpenSpeechPhase;
  heraldTurnId: number;
  nativeSessionId: number;
  continuationGeneration: number;
  segments: string[];
  segmentsAtSessionStart: number;
  delivered: boolean;
  turnStartedAtMs: number;
  /** True after speechstart on the live native session until that session ends. */
  speechInProgress: boolean;
  /** Reopened session must become listening-ready before the user gap is armed. */
  awaitingReadyAnchoredGap: boolean;
  continuationGapArmed: boolean;
  emptyContinuationCount: number;
  /** Stitch that already used its single incomplete extension. Episode-local. */
  extendedStitch: string | null;
  admissionEpoch: number;
  lastAppliedAdmissionEpoch: number;
};

export type OpenSpeechEffect =
  | { type: 'deliver'; utterance: string; source: string }
  | { type: 'reopen_native' }
  | { type: 'arm_continuation_gap'; generation: number }
  | { type: 'clear_continuation_gap' }
  | { type: 'arm_max_turn' }
  | { type: 'clear_max_turn' }
  | { type: 'abort_native' }
  | { type: 'no_recognizable_speech'; reason: 'silence' | 'heard_unrecognized' }
  | { type: 'evaluate_admission'; trigger: SpeechAdmissionTrigger; text: string; epoch: number; heraldTurnId: number }
  | { type: 'bounded_recovery' };

export type OpenSpeechEvent =
  | { type: 'herald_start'; mode: RecognitionMode; nativeSessionId: number; nowMs: number }
  | { type: 'native_result_final'; nativeSessionId: number; text: string }
  | { type: 'speechstart'; nativeSessionId: number }
  | { type: 'native_listening_ready'; nativeSessionId: number; nowMs: number }
  | { type: 'native_end'; nativeSessionId: number; speechStarted: boolean; partial: string; nowMs: number }
  | { type: 'continuation_gap_elapsed'; generation: number }
  | { type: 'no_speech_error'; nativeSessionId: number }
  | { type: 'recognition_error'; nativeSessionId: number }
  | { type: 'user_stop' }
  | { type: 'automated_teardown' }
  | { type: 'tts_preempt' }
  | { type: 'max_turn_elapsed' }
  | {
      type: 'admission_evaluated';
      trigger: SpeechAdmissionTrigger;
      proposal: SpeechCompletionProposal | null;
      text: string;
      epoch: number;
      heraldTurnId: number;
    };

let nextHeraldTurnId = 1;

export function resetOpenSpeechTurnIdsForTests(): void {
  nextHeraldTurnId = 1;
}

export function createIdleOpenSpeechTurnState(): OpenSpeechTurnState {
  return {
    mode: 'open',
    phase: 'idle',
    heraldTurnId: 0,
    nativeSessionId: 0,
    continuationGeneration: 0,
    segments: [],
    segmentsAtSessionStart: 0,
    delivered: false,
    turnStartedAtMs: 0,
    speechInProgress: false,
    awaitingReadyAnchoredGap: false,
    continuationGapArmed: false,
    emptyContinuationCount: 0,
    extendedStitch: null,
    admissionEpoch: 0,
    lastAppliedAdmissionEpoch: 0,
  };
}

export function stitchOpenSpeechSegments(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

function live(state: OpenSpeechTurnState, nativeSessionId: number): boolean {
  if (state.delivered) return false;
  if (state.phase === 'finalized' || state.phase === 'abandoned' || state.phase === 'idle') return false;
  return nativeSessionId === state.nativeSessionId;
}

function atOpenCap(state: OpenSpeechTurnState, nowMs: number): boolean {
  if (state.segments.length >= OPEN_SPEECH_MAX_SEGMENTS) return true;
  if (state.emptyContinuationCount >= OPEN_SPEECH_MAX_SEGMENTS) return true;
  if (state.heraldTurnId > 0 && nowMs - state.turnStartedAtMs >= OPEN_SPEECH_MAX_TURN_MS) return true;
  return false;
}

function requestAdmission(
  state: OpenSpeechTurnState,
  trigger: SpeechAdmissionTrigger,
): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  const text = stitchOpenSpeechSegments(state.segments);
  const admissionEpoch = state.admissionEpoch + 1;
  return {
    state: {
      ...state,
      phase: 'awaiting_continuation',
      continuationGapArmed: false,
      speechInProgress: false,
      admissionEpoch,
    },
    effects: [
      { type: 'clear_continuation_gap' },
      { type: 'evaluate_admission', trigger, text, epoch: admissionEpoch, heraldTurnId: state.heraldTurnId },
    ],
  };
}

function applyAdmission(
  state: OpenSpeechTurnState,
  trigger: SpeechAdmissionTrigger,
  proposal: SpeechCompletionProposal | null,
  text: string,
  epoch: number,
  heraldTurnId: number,
): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  if (heraldTurnId !== state.heraldTurnId || epoch !== state.admissionEpoch) return { state, effects: [] };
  if (epoch === state.lastAppliedAdmissionEpoch) return { state, effects: [] };
  const stamped = { ...state, lastAppliedAdmissionEpoch: epoch };
  if (stamped.delivered || stamped.phase === 'finalized' || stamped.phase === 'abandoned') {
    return { state: stamped, effects: [] };
  }
  if (stamped.speechInProgress) return { state: stamped, effects: [] };
  const stitch = stitchOpenSpeechSegments(stamped.segments);
  if (stitch !== text) return { state: stamped, effects: [] };
  const decision = decideSpeechAdmission({
    trigger,
    proposal,
    extensionConsumed: stamped.extendedStitch === stitch,
  });
  if (decision === 'admit') return finalize(stamped, `admission:${trigger}`);
  if (decision === 'recover') {
    if (stitch) return finalize(stamped, `admission:${trigger}`);
    const abandoned = abandon(stamped);
    return {
      state: abandoned.state,
      effects: [...abandoned.effects, { type: 'bounded_recovery' }],
    };
  }
  return reopenAfterContent({ ...stamped, extendedStitch: stitch });
}

function capSource(state: OpenSpeechTurnState, nowMs: number): string {
  if (state.segments.length >= OPEN_SPEECH_MAX_SEGMENTS) return 'max_segments';
  if (state.emptyContinuationCount >= OPEN_SPEECH_MAX_SEGMENTS) return 'max_segments';
  if (state.heraldTurnId > 0 && nowMs - state.turnStartedAtMs >= OPEN_SPEECH_MAX_TURN_MS) return 'max_turn';
  return 'max_segments';
}

function finalize(
  state: OpenSpeechTurnState,
  source: string,
): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  if (state.delivered || state.phase === 'finalized' || state.phase === 'abandoned') {
    return { state, effects: [] };
  }
  const utterance = stitchOpenSpeechSegments(state.segments);
  const next: OpenSpeechTurnState = {
    ...state,
    phase: 'finalized',
    delivered: true,
    awaitingReadyAnchoredGap: false,
    continuationGapArmed: false,
    speechInProgress: false,
  };
  const effects: OpenSpeechEffect[] = [
    { type: 'clear_continuation_gap' },
    { type: 'clear_max_turn' },
  ];
  if (utterance) effects.push({ type: 'deliver', utterance, source });
  return { state: next, effects };
}

function abandon(state: OpenSpeechTurnState): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  if (state.phase === 'finalized' || state.phase === 'abandoned') {
    return { state, effects: [] };
  }
  return {
    state: {
      ...state,
      phase: 'abandoned',
      delivered: true,
      awaitingReadyAnchoredGap: false,
      continuationGapArmed: false,
      speechInProgress: false,
    },
    effects: [
      { type: 'clear_continuation_gap' },
      { type: 'clear_max_turn' },
      { type: 'abort_native' },
    ],
  };
}

function appendSegment(state: OpenSpeechTurnState, text: string): OpenSpeechTurnState {
  const trimmed = text.trim();
  if (!trimmed) return state;
  return { ...state, segments: [...state.segments, trimmed] };
}

function reopenAfterContent(state: OpenSpeechTurnState): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  return {
    state: {
      ...state,
      phase: 'awaiting_continuation',
      speechInProgress: false,
      awaitingReadyAnchoredGap: true,
      continuationGapArmed: false,
      emptyContinuationCount: 0,
    },
    effects: [
      { type: 'clear_continuation_gap' },
      { type: 'reopen_native' },
    ],
  };
}

function reopenAfterEmptyContinuation(
  state: OpenSpeechTurnState,
): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  const emptyContinuationCount = state.emptyContinuationCount + 1;
  const next: OpenSpeechTurnState = {
    ...state,
    phase: 'awaiting_continuation',
    speechInProgress: false,
    emptyContinuationCount,
    awaitingReadyAnchoredGap: state.continuationGapArmed ? false : true,
  };
  return {
    state: next,
    effects: [{ type: 'reopen_native' }],
  };
}

function sessionAddedContent(state: OpenSpeechTurnState, partial: string): boolean {
  if (state.segments.length > state.segmentsAtSessionStart) return true;
  if (state.segments.length === 0 && partial.trim()) return true;
  return false;
}

/**
 * Pure Herald-turn boundary. One Herald open turn may span many one-shot
 * native sessions and must emit at most one deliver effect.
 */
export function reduceOpenSpeechTurn(
  state: OpenSpeechTurnState,
  event: OpenSpeechEvent,
): { state: OpenSpeechTurnState; effects: OpenSpeechEffect[] } {
  switch (event.type) {
    case 'herald_start': {
      const started: OpenSpeechTurnState = {
        mode: event.mode,
        phase: 'listening',
        heraldTurnId: nextHeraldTurnId++,
        nativeSessionId: event.nativeSessionId,
        continuationGeneration: 0,
        segments: [],
        segmentsAtSessionStart: 0,
        delivered: false,
        turnStartedAtMs: event.nowMs,
        speechInProgress: false,
        awaitingReadyAnchoredGap: false,
        continuationGapArmed: false,
        emptyContinuationCount: 0,
        extendedStitch: null,
        admissionEpoch: 0,
        lastAppliedAdmissionEpoch: 0,
      };
      return { state: started, effects: [{ type: 'arm_max_turn' }] };
    }

    case 'native_result_final': {
      if (!live(state, event.nativeSessionId)) return { state, effects: [] };
      return { state: appendSegment(state, event.text), effects: [] };
    }

    case 'speechstart': {
      if (!live(state, event.nativeSessionId)) return { state, effects: [] };
      return {
        state: {
          ...state,
          phase: 'listening',
          continuationGeneration: state.continuationGeneration + 1,
          speechInProgress: true,
          awaitingReadyAnchoredGap: false,
          continuationGapArmed: false,
        },
        effects: [{ type: 'clear_continuation_gap' }],
      };
    }

    case 'native_listening_ready': {
      if (!live(state, event.nativeSessionId)) return { state, effects: [] };
      if (state.mode !== 'open') return { state, effects: [] };
      if (!state.awaitingReadyAnchoredGap || state.continuationGapArmed) return { state, effects: [] };
      if (state.segments.length === 0) return { state, effects: [] };
      const continuationGeneration = state.continuationGeneration + 1;
      return {
        state: {
          ...state,
          continuationGeneration,
          awaitingReadyAnchoredGap: false,
          continuationGapArmed: true,
        },
        effects: [{ type: 'arm_continuation_gap', generation: continuationGeneration }],
      };
    }

    case 'native_end': {
      if (state.delivered || state.phase === 'finalized' || state.phase === 'abandoned') {
        return { state, effects: [] };
      }
      if (event.nativeSessionId !== state.nativeSessionId) {
        return { state, effects: [] };
      }

      let withPartial: OpenSpeechTurnState = { ...state, speechInProgress: false };
      if (state.segments.length === state.segmentsAtSessionStart && event.partial.trim()) {
        withPartial = appendSegment(withPartial, event.partial);
      }

      if (state.mode === 'control_confirmation') {
        const decision = decideOneShotEnd({
          bufferHasContent: withPartial.segments.length > 0,
          speechStarted: event.speechStarted,
          bestPartialHasContent: !!event.partial.trim(),
        });
        if (decision === 'flush' || decision === 'flush_partial') {
          return finalize(withPartial, 'control_confirmation_native_end');
        }
        const abandoned: OpenSpeechTurnState = {
          ...withPartial,
          phase: 'abandoned',
          delivered: true,
          awaitingReadyAnchoredGap: false,
          continuationGapArmed: false,
        };
        return {
          state: abandoned,
          effects: [
            { type: 'clear_continuation_gap' },
            { type: 'clear_max_turn' },
            {
              type: 'no_recognizable_speech',
              reason: decision === 'heard_unrecognized' ? 'heard_unrecognized' : 'silence',
            },
          ],
        };
      }

      if (withPartial.segments.length === 0) {
        const abandoned: OpenSpeechTurnState = {
          ...withPartial,
          phase: 'abandoned',
          delivered: true,
          awaitingReadyAnchoredGap: false,
          continuationGapArmed: false,
        };
        return {
          state: abandoned,
          effects: [
            { type: 'clear_continuation_gap' },
            { type: 'clear_max_turn' },
            {
              type: 'no_recognizable_speech',
              reason: event.speechStarted ? 'heard_unrecognized' : 'silence',
            },
          ],
        };
      }

      if (sessionAddedContent(withPartial, event.partial)) {
        if (atOpenCap(withPartial, event.nowMs)) {
          return finalize(withPartial, capSource(withPartial, event.nowMs) === 'max_turn' ? 'max_turn' : 'max_segments');
        }
        return reopenAfterContent(withPartial);
      }

      // Empty continuation: provider silence is not Herald-turn completion.
      const emptied: OpenSpeechTurnState = {
        ...withPartial,
        emptyContinuationCount: withPartial.emptyContinuationCount,
      };
      if (atOpenCap({ ...emptied, emptyContinuationCount: emptied.emptyContinuationCount + 1 }, event.nowMs)
        || emptied.emptyContinuationCount + 1 >= OPEN_SPEECH_MAX_SEGMENTS
        || (emptied.heraldTurnId > 0 && event.nowMs - emptied.turnStartedAtMs >= OPEN_SPEECH_MAX_TURN_MS)
        || emptied.segments.length >= OPEN_SPEECH_MAX_SEGMENTS) {
        const counted = { ...emptied, emptyContinuationCount: emptied.emptyContinuationCount + 1 };
        return finalize(counted, capSource(counted, event.nowMs) === 'max_turn' ? 'max_turn' : 'max_segments');
      }
      return reopenAfterEmptyContinuation(emptied);
    }

    case 'continuation_gap_elapsed': {
      if (event.generation !== state.continuationGeneration) return { state, effects: [] };
      if (state.delivered) return { state, effects: [] };
      if (state.speechInProgress) return { state, effects: [] };
      if (!state.continuationGapArmed) return { state, effects: [] };
      if (state.phase !== 'awaiting_continuation' && state.phase !== 'listening') {
        return { state, effects: [] };
      }
      if (state.segments.length > state.segmentsAtSessionStart) return { state, effects: [] };
      if (state.segments.length > 0) return requestAdmission(state, 'continuation_gap');
      return abandon(state);
    }

    case 'no_speech_error': {
      if (!live(state, event.nativeSessionId) && state.phase !== 'awaiting_continuation') {
        return { state, effects: [] };
      }
      if (event.nativeSessionId !== state.nativeSessionId) return { state, effects: [] };
      if (state.mode === 'control_confirmation') {
        if (state.segments.length > 0) return finalize(state, 'control_confirmation_no_speech');
        const abandoned: OpenSpeechTurnState = {
          ...state,
          phase: 'abandoned',
          delivered: true,
          awaitingReadyAnchoredGap: false,
          continuationGapArmed: false,
        };
        return {
          state: abandoned,
          effects: [
            { type: 'clear_continuation_gap' },
            { type: 'clear_max_turn' },
            { type: 'no_recognizable_speech', reason: 'silence' },
          ],
        };
      }
      if (state.segments.length > 0) {
        // Continuation no-speech is not independently authority to finalize.
        return { state, effects: [] };
      }
      const abandoned: OpenSpeechTurnState = {
        ...state,
        phase: 'abandoned',
        delivered: true,
        awaitingReadyAnchoredGap: false,
        continuationGapArmed: false,
      };
      return {
        state: abandoned,
        effects: [
          { type: 'clear_continuation_gap' },
          { type: 'clear_max_turn' },
          { type: 'no_recognizable_speech', reason: 'silence' },
        ],
      };
    }

    case 'recognition_error': {
      if (event.nativeSessionId !== state.nativeSessionId) return { state, effects: [] };
      if (state.delivered) return { state, effects: [] };
      if (state.segments.length > 0) return finalize(state, 'continuation_error');
      return abandon(state);
    }

    case 'user_stop': {
      if (state.delivered) return { state, effects: [] };
      if (state.segments.length > 0) return finalize(state, 'user_stop');
      return abandon(state);
    }

    case 'automated_teardown': {
      return abandon(state);
    }

    case 'tts_preempt': {
      return abandon(state);
    }

    case 'max_turn_elapsed': {
      if (state.delivered) return { state, effects: [] };
      if (state.segments.length > 0) return finalize(state, 'max_turn');
      return abandon(state);
    }

    case 'admission_evaluated':
      return applyAdmission(state, event.trigger, event.proposal, event.text, event.epoch, event.heraldTurnId);

    default:
      return { state, effects: [] };
  }
}

export function applyReopenedNativeSession(
  state: OpenSpeechTurnState,
  nativeSessionId: number,
): OpenSpeechTurnState {
  if (state.phase !== 'awaiting_continuation' || state.delivered) return state;
  return {
    ...state,
    nativeSessionId,
    phase: 'listening',
    segmentsAtSessionStart: state.segments.length,
    speechInProgress: false,
  };
}
