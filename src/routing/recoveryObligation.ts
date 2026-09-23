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

export type RecoveryObligationState = {
  establishedAtTurn: number;
  reason: typeof RECOVERY_CREATE_REASON;
};

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
    return 'Got it — your medications. What did you want to know about them?';
  }
  return 'Got it — your calendar. What did you want to know about it?';
}

export function formatRecoveryAmbiguousClarification(): string {
  return "Got it — I'm not sure which of those you meant. Can you say it again?";
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

  /** True only on the single turn immediately after establishment. */
  canContinue(): boolean {
    if (!this.state) return false;
    return this.state.establishedAtTurn === this.turn - 1;
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
    };
  }
}
