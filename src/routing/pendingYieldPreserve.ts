// Conversation Carry V1 / Slice 1 — pending yield & preserve.
// Reuses classifyRoutedEffect. Not a turn-shape classifier.
// Yield requires an existing deterministic RouteDecision effect, never
// pendingOwnsReply === false alone, never a model proposal.

import type { RouteDecision } from './routeIntent';
import { CANCEL_RE, CONFIRM_NO_RE, CONFIRM_YES_RE } from './conversationSession';
import { classifyRoutedEffect } from './routedOperationEffect';

/** YES/NO medical confirm. Production key from medical_visit writer. */
export const CARRY_SLICE1_YES_NO_KEY = 'medical_visit';
/** Multi-doctor visit-outcome collect. Production key from medicalVisitOutcomeDisambiguate. */
export const CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY = 'medical_visit_outcome_read_disambiguate';
/** LLM capture confirm. Production key from applyIntents llm_confirm. */
export const CARRY_SLICE1_LLM_CONFIRM_KEY = 'llm_confirm:list_add';

export const CONVERSATION_CARRY_SLICE1_PENDING_KEYS = [
  CARRY_SLICE1_YES_NO_KEY,
  CARRY_SLICE1_DOCTOR_DISAMBIGUATE_KEY,
  CARRY_SLICE1_LLM_CONFIRM_KEY,
] as const;

export type ConversationCarryPendingYield =
  | 'resume'
  | 'preserve_read'
  | 'supersede';

export function isConversationCarrySlice1PendingKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return (CONVERSATION_CARRY_SLICE1_PENDING_KEYS as readonly string[]).includes(key);
}

/** Existing medical_visit confirm vocabulary. Not a turn-shape classifier. */
export function conversationCarrySlice1OwnsReply(opts: {
  pendingKey: string | null | undefined;
  text: string;
  sessionOwns: boolean;
}): boolean {
  if (opts.sessionOwns) return true;
  if (opts.pendingKey !== CARRY_SLICE1_YES_NO_KEY) return false;
  const trimmed = opts.text.trim();
  return CONFIRM_YES_RE.test(trimmed) || CONFIRM_NO_RE.test(trimmed) || CANCEL_RE.test(trimmed);
}

/**
 * Pure. `decision` is an already-selected RouteDecision from routeIntent.
 * Does not inspect utterance text and does not authorize writes.
 */
export function decideConversationCarryPendingYield(opts: {
  ownsReply: boolean;
  decision: RouteDecision | null;
}): ConversationCarryPendingYield {
  if (opts.ownsReply) return 'resume';
  if (!opts.decision) return 'resume';
  const effect = classifyRoutedEffect(opts.decision);
  if (effect === 'read_only') return 'preserve_read';
  if (effect === 'external_effect') return 'supersede';
  return 'resume';
}
