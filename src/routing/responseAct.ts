// Typed Response Act. Selected from machine outcome, then realized.
// Realization may phrase an act. It may not choose or change one.
// This module does not read reply prose to decide a kind.

export type ResponseAct =
  | { kind: 'ANSWER'; text: string; epistemic: 'deterministic_read' }
  | { kind: 'ANSWER_WITH_PROVENANCE'; text: string; epistemic: 'stored_record' }
  | { kind: 'ACKNOWLEDGE'; text: string; impliesMemory: false; impliesWrite: false; impliesContinuation: false }
  | { kind: 'EXECUTION_RESULT'; text: string; verified: true }
  | { kind: 'REQUEST_CONFIRMATION'; text: string; pendingKey: string }
  | { kind: 'CLARIFY_REFERENCE'; text: string }
  | { kind: 'CLARIFY_INTENT'; text: string }
  | { kind: 'CORRECTION_ACCEPTED'; text: string; durable: false }
  | { kind: 'INVITE_CONTINUATION'; text: string }
  | { kind: 'CANCELLED'; text: string }
  | { kind: 'UNKNOWN'; text: string }
  | { kind: 'UNAVAILABLE'; text: string }
  | { kind: 'REFLECT_CURRENT_TURN'; text: string; epistemic: 'current_conversation'; durable: false };

type CommitShape = { status: string; pendingKey?: string };

/**
 * Fenced until a later slice supplies an explicit machine outcome:
 * recovery wording, recap wording, recollection flow, device-action
 * dispatch acks, model prose, failed writes, and noops that are not
 * `exit: 'cancelled'`. Those paths may still speak.
 * They do not select an act by inspecting that speech.
 * UNAVAILABLE is selected only from route kind `not_ready`.
 * INVITE_CONTINUATION and CORRECTION_ACCEPTED exist so a later owner
 * can select them explicitly. Nothing in this module selects them
 * from punctuation or from wording.
 */

export function executionResultAct(text: string): ResponseAct {
  return { kind: 'EXECUTION_RESULT', text, verified: true };
}

export function acknowledgeAct(text: string): ResponseAct {
  return { kind: 'ACKNOWLEDGE', text, impliesMemory: false, impliesWrite: false, impliesContinuation: false };
}

export function clarifyReferenceAct(text: string): ResponseAct {
  return { kind: 'CLARIFY_REFERENCE', text };
}

export function requestConfirmationAct(text: string, pendingKey: string): ResponseAct {
  return { kind: 'REQUEST_CONFIRMATION', text, pendingKey };
}

export function reflectCurrentTurnAct(text: string): ResponseAct {
  return { kind: 'REFLECT_CURRENT_TURN', text, epistemic: 'current_conversation', durable: false };
}

export function correctionAcceptedAct(text: string): ResponseAct {
  return { kind: 'CORRECTION_ACCEPTED', text, durable: false };
}

export function inviteContinuationAct(text: string): ResponseAct {
  return { kind: 'INVITE_CONTINUATION', text };
}

export function actForCommits(commits: readonly CommitShape[], text: string): ResponseAct | undefined {
  const statuses = commits.map((commit) => commit.status);
  if (statuses.includes('committed') && !statuses.includes('failed')) return executionResultAct(text);
  const pending = commits.find((commit) => commit.status === 'pending' && commit.pendingKey);
  if (pending?.pendingKey) return requestConfirmationAct(text, pending.pendingKey);
  // A failed write is not success, and it is not structural unavailability.
  // A noop has no reason field that distinguishes a decline, an idempotent
  // duplicate, or a non-execution. Both stay untyped.
  return undefined;
}

export function actForPendingResolution(result: CommitShape & { ack?: string; prompt?: string; exit?: 'cancelled' }): ResponseAct | undefined {
  if (result.status === 'noop' && result.exit === 'cancelled') return { kind: 'CANCELLED', text: result.ack ?? '' };
  if (result.status === 'committed') return executionResultAct(result.ack ?? '');
  if (result.status === 'pending' && result.pendingKey) return requestConfirmationAct(result.prompt ?? '', result.pendingKey);
  // Failed and any other noop stay untyped. `exit: 'cancelled'` is the only
  // noop discriminator this boundary trusts.
  return undefined;
}

export function actForRoute(decision: { kind: string; reason?: string; response?: string }): ResponseAct | undefined {
  if (decision.kind === 'not_ready') return { kind: 'UNAVAILABLE', text: '' };
  if (decision.kind === 'needs_clarification') {
    if (decision.reason === 'ambiguous_operational_list') return { kind: 'CLARIFY_INTENT', text: '' };
    return { kind: 'UNKNOWN', text: '' };
  }
  if (decision.kind === 'device_read') {
    const reason = decision.reason ?? '';
    const text = decision.response ?? '';
    if (reason.startsWith('medical:') || reason.startsWith('family:')) {
      return { kind: 'ANSWER_WITH_PROVENANCE', text, epistemic: 'stored_record' };
    }
    return { kind: 'ANSWER', text, epistemic: 'deterministic_read' };
  }
  return undefined;
}

/** Project an already-selected act. Empty payload keeps the caller's wording. The kind is not recomputed. */
export function projectRealization(act: ResponseAct | undefined, realizedSpeech: string): { act?: ResponseAct; speech: string } {
  if (!act || act.text.length === 0) return { act, speech: realizedSpeech };
  return { act, speech: act.text };
}
