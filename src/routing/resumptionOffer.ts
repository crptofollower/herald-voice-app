// Deterministic Resumption Offer V1.
// One RAM pending slot. The interrupted segment is frozen at offer time.
// YES realizes that frozen target. NO/CANCEL declines. Any other reply
// releases the slot and continues ordinary routing. No model, no store.

import { ConversationSession, CANCEL_RE, CONFIRM_NO_RE, CONFIRM_YES_RE } from './conversationSession';
import { establishHardPending } from './hardPendingBoundary';
import type { ConversationTurnFocusEntry, ConversationTurnLedger, ConversationTurnRecord } from './conversationTurnLedger';
import {
  HONEST_RECAP_MISS,
  peekInterruptedSegment,
  realizeConversationalRecap,
  validateFrozenResumptionTopics,
  type FrozenInterruptedSegment,
} from './immediateSemanticRecap';

export const RESUMPTION_OFFER_KEY = 'offer:resumption';
export const RESUMPTION_OFFER_TEXT = 'Want to pick up where we left off?';
export const RESUMPTION_DECLINE_TEXT = 'Okay.';

const frozenBySession = new WeakMap<ConversationSession, FrozenInterruptedSegment>();

export function resumptionOfferOwnsReply(userText: string): boolean {
  const text = userText.trim();
  return CONFIRM_YES_RE.test(text) || CONFIRM_NO_RE.test(text) || CANCEL_RE.test(text);
}

function segmentKey(segment: FrozenInterruptedSegment): string {
  return segment.turnIndices.join(',');
}

/** Completed segment-breaking interruption that may ask to resume. */
export function interruptionEligibleForResumptionOffer(record: ConversationTurnRecord): boolean {
  if (record.outcome !== 'committed' && record.outcome !== 'presented' && record.outcome !== 'declined') return false;
  if (record.operation === 'capture' || record.operation === 'action' || record.operation === 'clarify_resolution') return true;
  if (record.operation === 'read') {
    return record.focus.some((focus) => focus.referable && focus.kind !== 'topic');
  }
  return false;
}

export function armResumptionOffer(session: ConversationSession, frozen: FrozenInterruptedSegment): void {
  frozenBySession.set(session, frozen);
  establishHardPending(session, {
    pendingKey: RESUMPTION_OFFER_KEY,
    budget: 1,
    ownsReply: resumptionOfferOwnsReply,
    resume: async () => ({ status: 'noop', ack: '' }),
  });
}

export function takeFrozenResumption(session: ConversationSession): FrozenInterruptedSegment | undefined {
  const frozen = frozenBySession.get(session);
  frozenBySession.delete(session);
  return frozen;
}

export function releaseResumptionOffer(session: ConversationSession): void {
  frozenBySession.delete(session);
  if (session.peekPendingKey() === RESUMPTION_OFFER_KEY) session.clearPending();
}

export function resolveOwnedResumptionOffer(
  text: string,
  frozen: FrozenInterruptedSegment | undefined,
  live: ConversationTurnRecord[],
  discourseMentions: { mentionId: string; status: string }[] | undefined,
): { reply: string; focus: ConversationTurnFocusEntry[] | null } {
  const trimmed = text.trim();
  if (CONFIRM_NO_RE.test(trimmed) || CANCEL_RE.test(trimmed)) {
    return { reply: RESUMPTION_DECLINE_TEXT, focus: null };
  }
  if (!frozen || !CONFIRM_YES_RE.test(trimmed)) {
    return { reply: HONEST_RECAP_MISS, focus: null };
  }
  const valid = validateFrozenResumptionTopics(live, frozen, discourseMentions);
  if (valid === 'expired' || valid.length === 0) {
    return { reply: HONEST_RECAP_MISS, focus: null };
  }
  return {
    reply: realizeConversationalRecap(valid.map((topic) => topic.displayValue)),
    focus: valid,
  };
}

export function appendResumptionOffer(input: {
  responseText: string;
  session: ConversationSession;
  ledger: ConversationTurnLedger;
  discourseMentions?: { mentionId: string; status: string }[];
  recoveryOpen: boolean;
  emergencyThisTurn: boolean;
  lastOfferedSegmentKey: string | null;
}): { responseText: string; lastOfferedSegmentKey: string | null; offered: boolean } {
  const keep = {
    responseText: input.responseText,
    lastOfferedSegmentKey: input.lastOfferedSegmentKey,
    offered: false,
  };
  if (input.emergencyThisTurn || input.recoveryOpen || input.session.hasPending()) return keep;
  const live = input.ledger.peek(Date.now());
  const newest = live[live.length - 1];
  if (!newest || !interruptionEligibleForResumptionOffer(newest)) return keep;
  const segment = peekInterruptedSegment(live, input.discourseMentions);
  if (!segment) return keep;
  const key = segmentKey(segment);
  if (key === input.lastOfferedSegmentKey) return keep;
  armResumptionOffer(input.session, segment);
  const speech = input.responseText.trim();
  return {
    responseText: speech ? `${speech}\n${RESUMPTION_OFFER_TEXT}` : RESUMPTION_OFFER_TEXT,
    lastOfferedSegmentKey: key,
    offered: true,
  };
}
