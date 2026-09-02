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

export const EPHEMERAL_CLARIFY_REPLY =
  "I'm not sure I'm following you — can you help me understand?";

export function buildUnverifiedBiographyInquiryMiss(name: string): string {
  const n = name.trim();
  if (!n) return "I don't have anything stored about that person.";
  return `I don't have anything stored about ${n}.`;
}

/** Inquiry for a third-party biography, not a family-relation read. */
export function extractBiographyInquiryName(text: string): string | null {
  const t = text.trim();
  const m = t.match(
    /\b(?:tell me about|what do you know about|who is|who was)\s+([A-Za-z][A-Za-z'-]*)/i,
  );
  if (!m) return null;
  const first = (m[1] ?? '').trim();
  if (!first || /^(the|a|an|my|you|yourself|me|myself|us|we|herald|kit)$/i.test(first)) {
    return null;
  }
  return first;
}

const FIRST_PERSON_ANCHOR_RE = /\b(I|my|me|we|our)\b/i;

const NAME_CLOSED_CLASS_RE =
  /^(I|I'm|The|A|An|My|Me|We|Our|You|Your|He|She|They|It|This|That|These|Those|If|When|What|Who|Why|How|Do|Did|Does|Can|Could|Would|Will|Should|And|But|Or|So|For|To|Of|In|On|At|By|With|From|About|Not|No|Yes|Ok|Okay|Herald|Tell|Please|Remind|Call|Text|Make|Set|Add|Let|Thanks|Thank|Yeah|Well|Anyway|Just|Maybe|Actually|Got|Have|Has|Had|Was|Were|Is|Are|Be|Been|Being|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December)$/i;

/** Title-case tokens that can stand as third-party person names. STT lowercase is out of scope. */
export function extractTitleCaseNameTokens(text: string): string[] {
  const names: string[] = [];
  const re = /\b([A-Z][a-z]{1,}(?:'[A-Za-z]+)?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!NAME_CLOSED_CLASS_RE.test(m[1])) names.push(m[1]);
  }
  return names;
}

/** True when the utterance names a person who is not already in thread evidence. */
export function hasUnresolvedThirdPartyName(text: string, threadEvidence: string): boolean {
  const names = extractTitleCaseNameTokens(text);
  if (names.length === 0) return false;
  return names.some((n) => !new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(threadEvidence));
}

/** Interrogative whose only object is a demonstrative — not Herald identity, not a named person. */
export function isAmbiguousDemonstrativeQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /^(?:did|do|can|could|would)\s+you\s+\w+\s+(?:that|this|it)\s*\??\s*$/i.test(t)
    || /^\s*what about (?:that|this|it)\s*\??\s*$/i.test(t);
}

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
  threadEvidence?: string;
}): boolean {
  if (input.reason !== 'default') return false;
  if (!input.isEligible) return false;
  if (hasPendingRepairOwnership({
    hasSessionPending: input.hasPendingSession,
    hasContactCollectPending: input.hasContactCollectPending,
  })) {
    return false;
  }
  if (isBareZeroEvidenceOpeningFragment(input.text)) return false;
  if (isAmbiguousDemonstrativeQuestion(input.text)) return false;
  if (input.hasAuthorizedContinuation) return true;
  return true;
}

export type EphemeralSeamOutcome =
  | { kind: 'authoritative'; reply: string }
  | { kind: 'clarify'; reply: string; grantContinuation: boolean }
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
  /** Prior HOT-ring user/assistant text — evidence only, not a referent binder. */
  threadEvidence?: string;
}): Promise<EphemeralSeamOutcome> {
  if (!input.skipAuthoritativeOwners) {
    const owner = tryAuthoritativeLocalOwnersBeforeEphemeral(input.text, input.readMeta);
    if (owner.handled) {
      return { kind: 'authoritative', reply: owner.reply };
    }
  }

  const inquiryName = extractBiographyInquiryName(input.text);
  if (inquiryName) {
    const evidence = input.threadEvidence ?? '';
    const known = new RegExp(
      `\\b${inquiryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    ).test(evidence);
    if (!known) {
      return {
        kind: 'generative',
        reply: buildUnverifiedBiographyInquiryMiss(inquiryName),
        grantContinuation: true,
      };
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
    threadEvidence: input.threadEvidence,
  });
  if (!mayGenerate) {
    // Clarify still authorizes the next user turn so a repair ("I'm talking
    // about you") is not a compounding dead end. It does not write HOT prose.
    return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY, grantContinuation: true };
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
    return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY, grantContinuation: true };
  }

  const ephemeral = await input.generate();
  if (ephemeral.status === 'ok') {
    return { kind: 'generative', reply: ephemeral.text, grantContinuation: true };
  }
  return { kind: 'clarify', reply: EPHEMERAL_CLARIFY_REPLY, grantContinuation: true };
}
