// Recovery Obligation V1 — RAM-only one-turn failed-understanding repair.
// Grants no read/write/pending/topic authority. EDR observes family on consume.

import { detectExplicitDomainReference } from './explicitDomainReference';
import {
  CONFIRM_NO_RE,
  CONFIRM_YES_RE,
  extractCorrection,
} from './conversationSession';

export const RECOVERY_CREATE_REASON = 'needs_clarification:default' as const;

export type RecoveryCreateSeamKind = 'clarify' | 'generative' | 'authoritative';

export type SoftObligationJob =
  | 'failed_understanding'
  | 'clarify_reference'
  | 'clarify_intent'
  | 'invite_continuation';

/** Typed scope. Eligibility is this scope against current canonical state. */
export type SoftObligationScope =
  | { kind: 'presented_sets'; setIds: readonly string[] }
  | { kind: 'working_focus'; focusKey: string }
  | { kind: 'intent_context'; domains: readonly string[] }
  | { kind: 'turn_local' };

export type SoftObligationView = {
  liveSetIds: readonly string[];
  focusKey: string | null;
};

export type RecoveryObligationState = {
  establishedAtTurn: number;
  reason: typeof RECOVERY_CREATE_REASON | SoftObligationJob;
  job: SoftObligationJob;
  scope: SoftObligationScope;
};

/**
 * Open is not eligible. A typed job stays eligible only while its stored
 * scope is still present in canonical state. Turn count, recency, prose,
 * and model confidence are not inputs. Intent context and turn-local scope
 * have no durable object to re-check, so they are not eligible later.
 * failed_understanding keeps its own one-turn gate.
 */
export function isSoftObligationEligible(
  obligation: RecoveryObligationState,
  state: SoftObligationView,
): boolean {
  if (obligation.job === 'failed_understanding') return false;
  if (obligation.scope.kind === 'presented_sets') {
    return obligation.scope.setIds.length > 0
      && obligation.scope.setIds.every((id) => state.liveSetIds.includes(id));
  }
  if (obligation.scope.kind === 'working_focus') {
    return state.focusKey !== null && state.focusKey === obligation.scope.focusKey;
  }
  return false;
}

/** Canned failed-understanding only — not recap/Qwen/authoritative owners. */
export function shouldEstablishRecoveryObligation(input: {
  processHandled: boolean;
  routeKind: string;
  routeReason: string;
  recapHandled: boolean;
  activeSubjectHandled: boolean;
  seamKind: RecoveryCreateSeamKind | null;
  hasPending: boolean;
}): boolean {
  if (input.processHandled) return false;
  if (input.hasPending) return false;
  if (input.routeKind !== 'needs_clarification') return false;
  if (input.routeReason !== 'default') return false;
  if (input.recapHandled) return false;
  if (input.activeSubjectHandled) return false;
  return input.seamKind === 'clarify';
}

const MISUNDERSTANDING_REPAIR_RE = /\bthat'?s not what i meant\b/i;

/** Repair of a live failed-understanding exchange. Does not select a domain. */
export function isRecoveryRepairSignal(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (CONFIRM_NO_RE.test(trimmed) || CONFIRM_YES_RE.test(trimmed)) return false;
  if (extractCorrection(trimmed)) return true;
  return MISUNDERSTANDING_REPAIR_RE.test(trimmed);
}

export function formatRecoveryDomainClarification(family: 'calendar' | 'medications'): string {
  if (family === 'medications') {
    return 'Got it — your medications. What did you want to ask?';
  }
  return 'Got it — your calendar. What did you want to ask?';
}

export function formatRecoveryAmbiguousClarification(): string {
  return "Got it — I'm not sure which one you meant. What did you want to ask?";
}

export function realizeRecoveryObligationConsume(text: string): {
  responseText: string;
  family: 'calendar' | 'medications' | null;
} {
  const edr = detectExplicitDomainReference(text);
  if (edr) {
    return {
      family: edr.family,
      responseText: formatRecoveryDomainClarification(edr.family),
    };
  }
  return { family: null, responseText: formatRecoveryAmbiguousClarification() };
}

export class RecoveryObligationHolder {
  private state: RecoveryObligationState | null = null;
  private turn = 0;

  beginUserTurn(): void {
    this.turn += 1;
  }

  peek(): RecoveryObligationState | null {
    return this.state;
  }

  /** Failed-understanding only: the single next turn. Typed jobs use isOpenSoft. */
  canContinue(): boolean {
    if (!this.state || this.state.job !== 'failed_understanding') return false;
    return this.state.establishedAtTurn === this.turn - 1;
  }

  /** Typed soft obligation. Not turn-count. Not assistant prose. */
  isOpenSoft(): boolean {
    if (!this.state || this.state.job === 'failed_understanding') return false;
    return true;
  }

  establishJob(
    job: Exclude<SoftObligationJob, 'failed_understanding'>,
    scope: SoftObligationScope,
  ): void {
    this.state = { establishedAtTurn: this.turn, reason: job, job, scope };
  }

  hasLive(): boolean {
    return this.canContinue();
  }

  clear(): void {
    this.state = null;
  }

  establish(): void {
    this.state = {
      establishedAtTurn: this.turn,
      reason: RECOVERY_CREATE_REASON,
      job: 'failed_understanding',
      scope: { kind: 'turn_local' },
    };
  }
}
