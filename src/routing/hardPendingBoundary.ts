// Single hard-pending establishment boundary.
// ConversationSession remains the only pending store. This module is the
// only production caller of session.setPending. It does not interpret
// confirmation, and it does not perform SMS, dial, or maps handoff.

import type { ConversationSession, PendingSlot } from './conversationSession';

export const CONTACT_COLLECT_PENDING_KEY = 'contact_collect';
export const ACTIVE_SUBJECT_CLARIFY_KEY = 'active_subject_clarify';

export type ContactCollectPayload = {
  action: 'call' | 'navigate' | 'text' | 'confirm_phone' | 'confirm_call';
  name: string;
  body?: string;
  phone?: string;
};

type PendingEstablishment = Omit<PendingSlot, 'kind' | 'budget'> & Partial<Pick<PendingSlot, 'kind' | 'budget'>>;

/** The one production write into ConversationSession's hard pending slot. */
export function establishHardPending(session: ConversationSession, slot: PendingEstablishment): void {
  session.setPending(slot);
}

/** Read-only key. No resume, no payload, no copy of the pending contents. */
export function readHardPendingReference(session: ConversationSession): { pendingKey: string } | null {
  const pendingKey = session.peekPendingKey();
  return pendingKey ? { pendingKey } : null;
}

export function establishActiveSubjectClarification(
  session: ConversationSession,
  resume: PendingSlot['resume'],
): void {
  establishHardPending(session, {
    pendingKey: ACTIVE_SUBJECT_CLARIFY_KEY,
    resume,
  });
}

/**
 * Contact collection stays a ConversationSession pending. The ref is payload
 * for the existing collector, not a second authority: a non-911 payload is
 * eligible only while this pending key is the live slot.
 * The resume fail-closes with no dial and no sms if a turn reaches
 * resolvePending without the collector.
 */
export function armContactCollect(
  session: ConversationSession,
  ref: { current: ContactCollectPayload | null },
  payload: ContactCollectPayload,
): void {
  ref.current = payload;
  establishHardPending(session, {
    pendingKey: CONTACT_COLLECT_PENDING_KEY,
    resume: async () => ({ status: 'noop', ack: '' }),
  });
}

/** Drop the payload. Clear the session slot only when it is still this collect. */
export function releaseContactCollect(
  session: ConversationSession,
  ref: { current: ContactCollectPayload | null },
): void {
  ref.current = null;
  if (session.peekPendingKey() === CONTACT_COLLECT_PENDING_KEY) {
    session.clearPending();
  }
}

export function contactCollectOwnsTurn(
  session: ConversationSession,
  payload: ContactCollectPayload | null,
): boolean {
  if (!payload) return false;
  if (payload.action === 'confirm_call') return true;
  return session.peekPendingKey() === CONTACT_COLLECT_PENDING_KEY;
}
