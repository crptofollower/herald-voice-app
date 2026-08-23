// Ephemeral Trust Containment V1 — shared seam authority (2026-08-23).
// Pure predicates + pre-ephemeral owner ordering. No LLM, no DB imports here
// beyond what authoritative owner helpers already touch.

import {
  canRunEphemeralConversation,
  isEligibleForEphemeralConversation,
  type EphemeralResult,
} from './ephemeralConversation';
import { detectFamilyRead, answerFamilyRead } from './familyRead';
import { answerFromDevice } from './localAnswers';
import { captureHousehold } from './householdCapture';
import { dispatchReadIntents, type ReadIntentMeta } from '../routing/readIntent';
import { utteranceHasInteractionReportShape } from '../routing/speechActAuthority';
import { COMPLETED_PAST_FIRST_PERSON_RE } from './instructionSignals';
import {
  buildBoundedPastEventAcknowledgment,
  utteranceRequiresBoundedPastEventAck,
} from './predicateExtensionContainment';

export const EPHEMERAL_CLARIFY_REPLY =
  "I'm not sure I'm following you — can you help me understand?";

const FIRST_PERSON_ANCHOR_RE = /\b(I|my|me|we|our)\b/i;

export function tryReadIntentReply(meta: ReadIntentMeta | undefined): string | null {
  if (!meta) return null;
  const outcome = dispatchReadIntents(meta.readIntents, { readLabeled: meta.readLabeled });
  if (outcome.status === 'answered' || outcome.status === 'clarify') {
    return outcome.responseText;
  }
  return null;
}

export type AuthoritativeOwnerResult =
  | { handled: true; reply: string }
  | { handled: false };

/** Shared first-refusal ordering — mirrors offline pre-ephemeral owners. */
export function tryAuthoritativeLocalOwnersBeforeEphemeral(
  text: string,
  readMeta?: ReadIntentMeta,
): AuthoritativeOwnerResult {
  const fam = detectFamilyRead(text);
  if (fam) {
    return { handled: true, reply: answerFamilyRead(fam) };
  }
  const local = answerFromDevice(text);
  if (local) {
    return { handled: true, reply: local };
  }
  const read = tryReadIntentReply(readMeta);
  if (read) {
    return { handled: true, reply: read };
  }
  const household = captureHousehold(text);
  if (household && household.type !== 'needs_llm' && 'captured' in household) {
    return { handled: true, reply: household.ack };
  }
  return { handled: false };
}

/**
 * Narrow zero-evidence opening profile — not a proposition detector.
 * Structural absence of user-anchoring signals; short label-like fragments fail closed.
 * Copula alone does not ground an unresolved referent (grammatical ≠ authoritative).
 */
export function isBareZeroEvidenceOpeningFragment(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (FIRST_PERSON_ANCHOR_RE.test(t)) return false;
  if (utteranceHasInteractionReportShape(t)) return false;
  if (COMPLETED_PAST_FIRST_PERSON_RE.test(t)) return false;
  const words = t.replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length <= 4 && !/\?/.test(t)) return true;
  return false;
}

export function hasPendingRepairOwnership(input: {
  hasSessionPending: boolean;
  hasContactCollectPending: boolean;
}): boolean {
  return input.hasSessionPending || input.hasContactCollectPending;
}

export function mayRunGenerativeEphemeralPersonalProse(input: {
  reason: string;
  text: string;
  hasAuthorizedContinuation: boolean;
  hasPendingSession: boolean;
  hasContactCollectPending: boolean;
  isEligible: boolean;
}): boolean {
  if (input.reason !== 'default') return false;
  if (!input.isEligible) return false;
  if (hasPendingRepairOwnership({
    hasSessionPending: input.hasPendingSession,
    hasContactCollectPending: input.hasContactCollectPending,
  })) {
    return false;
  }
  if (input.hasAuthorizedContinuation) return true;
  if (isBareZeroEvidenceOpeningFragment(input.text)) return false;
  // Predicate-Extension V1: past personal event reports get bounded ack, not free generative.
  if (utteranceRequiresBoundedPastEventAck(input.text)) return false;
  return true;
}

export type EphemeralSeamOutcome =
  | { kind: 'authoritative'; reply: string }
  | { kind: 'clarify'; reply: string }
  | { kind: 'generative'; reply: string; grantContinuation: boolean };

export async function resolveEphemeralSeam(input: {
  text: string;
  reason: string;
  readMeta?: ReadIntentMeta;
  hasAuthorizedContinuation: boolean;
  hasPendingSession: boolean;
  hasContactCollectPending: boolean;
  rdTier: 1 | 2 | 3;
  hasStructuredCaptures: boolean;
  isPersonalCaptureRisk: boolean;
  llmStatus: 'unavailable' | 'loading' | 'ready' | 'error';
  classifierBusy: boolean;
  ephemeralBusy: boolean;
  generate: () => Promise<EphemeralResult>;
  /** When true, authoritative owners were already run on this turn (offline path). */
  skipAuthoritativeOwners?: boolean;
}): Promise<EphemeralSeamOutcome> {
  if (!input.skipAuthoritativeOwners) {
    const owner = tryAuthoritativeLocalOwnersBeforeEphemeral(input.text, input.readMeta);
    if (owner.handled) {
      return { kind: 'authoritative', reply: owner.reply };
    }
  }

  const eligible = isEligibleForEphemeralConversation(
    input.text,
    input.hasAuthorizedContinuation,
  );
  const mayGenerate = mayRunGenerativeEphemeralPersonalProse({
    reason: input.reason,
    text: input.text,
    hasAuthorizedContinuation: input.hasAuthorizedContinuation,
    hasPendingSession: input.hasPendingSession,
    hasContactCollectPending: input.hasContactCollectPending,
    isEligible: eligible,
  });
  const repairOwned = hasPendingRepairOwnership({
    hasSessionPending: input.hasPendingSession,
    hasContactCollectPending: input.hasContactCollectPending,
  });
  if (
    input.reason === 'default'
    && !repairOwned
    && eligible
    && utteranceRequiresBoundedPastEventAck(input.text)
  ) {
    return {
      kind: 'generative',
      reply: buildBoundedPastEventAcknowledgment(input.text),
      grantContinuation: true,
    };
  }

  if (!mayGenerate) {
    return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY };
  }

  const canConverse = canRunEphemeralConversation({
    rdTier: input.rdTier,
    hasStructuredCaptures: input.hasStructuredCaptures,
    isPersonalCaptureRisk: input.isPersonalCaptureRisk,
    hasPending: input.hasPendingSession,
    llmStatus: input.llmStatus,
    classifierBusy: input.classifierBusy,
    ephemeralBusy: input.ephemeralBusy,
  });
  if (!canConverse) {
    return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY };
  }

  const ephemeral = await input.generate();
  if (ephemeral.status === 'ok') {
    return { kind: 'generative', reply: ephemeral.text, grantContinuation: true };
  }
  return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY };
}
