// Conversational Evidence Admission V1.
// One deterministic authority for whether a user's utterance is preservable
// as RAM conversational evidence. Model state, discourse proposals, Qwen,
// SQLite, and B2 are not inputs. Permission to generate prose is a separate
// decision and lives in the ephemeral seam.

import { INTERROGATIVE_RE } from '../utils/ephemeralConversation';
import { isClosedClassNameToken } from '../utils/ephemeralSeam';
import { extractCorrection } from './conversationSession';
import { isUnsafeContinuityEvidence } from './discourseContinuity';
import {
  CONVERSATION_TURN_UTTERANCE_MAX_CHARS,
  type ConversationTurnFocusEntry,
} from './conversationTurnLedger';
import { isUnresolvedCorrectionUtterance } from './recoveryObligation';
import { isExplicitInstructionToHerald } from './speechActAuthority';

export type CanonicalConversationalEvidence = {
  displayValue: string;
};

/** Structural route facts only. Callers pass the real RouteDecision. */
export type ConversationalEvidenceRoute = {
  kind: string;
  reason?: string;
  readMeta?: unknown;
};

const SELF_REPAIR_LEAD_RE = /^(?:sorry|wait|no),\s+(.+)$/i;
const MAX_TOKENS = 20;
const PRONOUN_RE = /^(i|he|she|it|we|they)$/;
const PRONOUN_CLITIC_RE = /^(i|he|she|it|we|they)'(?:m|re|ve|ll|d|s)$/;
const DETERMINER_RE = /^(the|a|an|my|our|his|her|their|its)$/;
const SECOND_PERSON_RE = /^(you|your|yours|you're|you've|you'll|you'd)$/;
const DEMONSTRATIVE_RE = /^(this|that|these|those)$/;
const AUXILIARY_RE = /^(?:am|is|are|was|were|be|been|being|have|has|had|do|does|did|can|could|may|might|must|shall|should|will|would)$/;
/** Grammatical function words. Not an open verb or noun list. */
const FUNCTION_WORD_RE = /^(?:the|a|an|my|me|we|our|you|your|he|she|they|it|this|that|these|those|if|when|what|who|why|how|and|but|or|so|for|to|of|in|on|at|by|with|from|about|not|no|yes|ok|okay)$/;

export function isConversationalEvidenceRoute(route: ConversationalEvidenceRoute): boolean {
  if (route.kind === 'needs_clarification' && route.reason === 'default') return true;
  if (route.kind === 'backend' && route.readMeta == null) return true;
  return false;
}

function word(token: string): string {
  return token.replace(/^[^\w']+|[^\w']+$/g, '').replace(/’/g, "'");
}

function tokensOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sentenceCount(text: string): number {
  return text.trim().split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}

function isSelfRepair(text: string): boolean {
  const trimmed = text.trim();
  if (extractCorrection(trimmed)) return true;
  if (SELF_REPAIR_LEAD_RE.test(trimmed)) return true;
  return isUnresolvedCorrectionUtterance(trimmed);
}

function isAuxiliary(token: string): boolean {
  return AUXILIARY_RE.test(token.toLowerCase());
}

function isInflectedPredicate(token: string): boolean {
  if (token !== token.toLowerCase()) return false;
  if (isClosedClassNameToken(token) || isAuxiliary(token)) return false;
  return token.length > 2 && /(?:[^s]s|ed)$/.test(token);
}

function isEdPredicate(token: string): boolean {
  return token === token.toLowerCase() && token.length > 2 && /ed$/.test(token) && !isClosedClassNameToken(token);
}

function isLowercaseLexical(token: string): boolean {
  if (token !== token.toLowerCase()) return false;
  if (!/^[a-z][a-z'-]*$/.test(token)) return false;
  if (isAuxiliary(token) || FUNCTION_WORD_RE.test(token)) return false;
  return true;
}

function isLowercaseHead(token: string): boolean {
  if (token !== token.toLowerCase()) return false;
  if (!/^[a-z][a-z'-]*$/.test(token)) return false;
  if (isAuxiliary(token) || isInflectedPredicate(token)) return false;
  return true;
}

function isTitleCaseContent(token: string): boolean {
  if (!/^[A-Z][a-z]+(?:'[A-Za-z]+)?$/.test(token)) return false;
  return !isClosedClassNameToken(token);
}

function pronounFrame(words: string[]): boolean {
  const first = words[0]?.toLowerCase() ?? '';
  const bare = PRONOUN_RE.test(first);
  const clitic = PRONOUN_CLITIC_RE.test(first);
  if (!bare && !clitic) return false;
  const rest = words.slice(1);
  if (rest.length === 0) return false;
  if (isAuxiliary(rest[0]!)) {
    let index = 0;
    while (index < rest.length && isAuxiliary(rest[index]!)) index += 1;
    return index < rest.length;
  }
  return isLowercaseLexical(rest[0]!);
}

function determinerFrame(words: string[]): boolean {
  if (!DETERMINER_RE.test(words[0]?.toLowerCase() ?? '')) return false;
  let index = 1;
  let head = 0;
  while (index < words.length && isLowercaseHead(words[index]!)) {
    head += 1;
    index += 1;
  }
  if (head === 0 || index >= words.length) return false;
  const predicate = words[index]!;
  if (!isAuxiliary(predicate) && !isInflectedPredicate(predicate)) return false;
  return index + 1 < words.length;
}

function titleCaseFrame(words: string[]): boolean {
  let index = 0;
  while (index < words.length && index < 3 && isTitleCaseContent(words[index]!)) index += 1;
  if (index < 1 || index >= words.length) return false;
  const predicate = words[index]!;
  if (!isAuxiliary(predicate) && !isEdPredicate(predicate)) return false;
  return index + 1 < words.length;
}

function admitsProposition(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (sentenceCount(trimmed) !== 1) return false;
  if (INTERROGATIVE_RE.test(trimmed)) return false;
  if (isExplicitInstructionToHerald(trimmed)) return false;
  if (isSelfRepair(trimmed)) return false;
  if (isUnsafeContinuityEvidence(trimmed)) return false;
  const raw = tokensOf(trimmed);
  if (raw.length === 0 || raw.length > MAX_TOKENS) return false;
  const words = raw.map(word).filter(Boolean);
  if (words.length === 0 || words.length > MAX_TOKENS) return false;
  const first = words[0]!.toLowerCase();
  if (SECOND_PERSON_RE.test(first) || DEMONSTRATIVE_RE.test(first)) return false;
  return pronounFrame(words) || determinerFrame(words) || titleCaseFrame(words);
}

/**
 * The only conversational-evidence admission decision.
 * Returns the full trimmed utterance, or null when the route or the
 * grammatical frame declines.
 */
export function canonicalConversationalEvidence(
  text: string,
  routeDecision: ConversationalEvidenceRoute,
): CanonicalConversationalEvidence | null {
  if (!isConversationalEvidenceRoute(routeDecision)) return null;
  const trimmed = text.trim();
  if (!trimmed || !admitsProposition(trimmed)) return null;
  const displayValue = trimmed.length > CONVERSATION_TURN_UTTERANCE_MAX_CHARS
    ? trimmed.slice(0, CONVERSATION_TURN_UTTERANCE_MAX_CHARS)
    : trimmed;
  return { displayValue };
}

/**
 * One topic builder. Topic text is the admitted utterance. Grounded spans
 * cannot shrink it. Model-created narrative person focus is not retained.
 * Deterministic focus already on the turn is kept and blocks a second topic.
 */
export function conversationalTurnFocus(input: {
  evidence: CanonicalConversationalEvidence | null;
  retainedFocus: readonly ConversationTurnFocusEntry[];
  discourseMentionIds?: readonly string[];
}): ConversationTurnFocusEntry[] {
  const retained = input.retainedFocus.filter((entry) => !(
    entry.kind === 'person'
    && entry.tier === 'conversational'
    && (entry.resolverKey == null || entry.resolverKey.length === 0)
  ));
  if (retained.length > 0) return [...retained];
  if (!input.evidence) return [];
  const displayValue = input.evidence.displayValue.trim().slice(0, CONVERSATION_TURN_UTTERANCE_MAX_CHARS);
  if (!displayValue) return [];
  const discourseMentionIds = [...new Set((input.discourseMentionIds ?? []).filter((id) => id.length > 0))];
  return [{
    kind: 'topic',
    displayValue,
    referable: true,
    tier: 'conversational',
    ...(discourseMentionIds.length > 0 ? { discourseMentionIds } : {}),
  }];
}
