// Single hard-pending establishment boundary.
// ConversationSession remains the only pending store. This module is the
// only production caller of session.setPending. It does not interpret
// confirmation, and it does not perform SMS, dial, or maps handoff.

import type { ConversationSession, PendingSlot } from './conversationSession';

export const CONTACT_COLLECT_PENDING_KEY = 'contact_collect';
export const ACTIVE_SUBJECT_CLARIFY_KEY = 'active_subject_clarify';
export const EMERGENCY_CLARIFY_KEY = 'emergency_clarify';
export const EMERGENCY_CLARIFY_TTL_MS = 120_000;
export const EMERGENCY_CLARIFY_QUESTION = 'Are you having an emergency and do you need emergency help now?';
export const EMERGENCY_CLARIFY_REASK = 'Please say yes or no — do you need emergency help now?';
export const EMERGENCY_CLARIFY_RELEASE = "If you need emergency help, say 'help me' or 'call 911'.";

export type EmergencyClarificationRecord = {
  original: string;
  establishedAt: number;
  askCount: number;
};

const emergencyClarification = new WeakMap<ConversationSession, EmergencyClarificationRecord>();

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

/** RAM-only Stage C record. No timer. A new session has no record. */
export function establishEmergencyClarification(session: ConversationSession, original: string, establishedAt = Date.now()): void {
  emergencyClarification.set(session, { original, establishedAt, askCount: 0 });
  establishHardPending(session, {
    pendingKey: EMERGENCY_CLARIFY_KEY,
    resume: async () => ({ status: 'noop', ack: '' }),
  });
}

export function readEmergencyClarification(session: ConversationSession): EmergencyClarificationRecord | null {
  if (session.peekPendingKey() !== EMERGENCY_CLARIFY_KEY) return null;
  return emergencyClarification.get(session) ?? null;
}

export function noteEmergencyClarificationReask(session: ConversationSession): void {
  const record = emergencyClarification.get(session);
  if (!record || session.peekPendingKey() !== EMERGENCY_CLARIFY_KEY) return;
  emergencyClarification.set(session, { ...record, askCount: record.askCount + 1 });
}

export function releaseEmergencyClarification(session: ConversationSession): void {
  emergencyClarification.delete(session);
  if (session.peekPendingKey() === EMERGENCY_CLARIFY_KEY) session.clearPending();
}

export function contactCollectOwnsTurn(
  session: ConversationSession,
  payload: ContactCollectPayload | null,
): boolean {
  if (!payload) return false;
  if (payload.action === 'confirm_call') return true;
  return session.peekPendingKey() === CONTACT_COLLECT_PENDING_KEY;
}
