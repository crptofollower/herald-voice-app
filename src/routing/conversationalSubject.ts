// src/routing/conversationalSubject.ts
// Flow C — one-turn conversational subject (identity/reference only).
//
// Sibling to ConversationSession, NOT a PendingSlot. PendingSlot remains
// unresolved-turn authority. This holder stores a stable entity id after a
// completed deterministic identity read so the next user turn may ask for
// that entity's phone with a third-person singular pronoun.
//
// RAM only. Same mounted-chat lifecycle as ConversationSession.
// TTL: exactly one following user turn. Consume clears. Unused next turn
// clears. Process death/restart: gone. No SQLite persistence.
//
// Phone is NEVER cached. Previous ACK/prose is NEVER cached as truth.
// displayName / relationship / category are convenience context only —
// they must not be spoken as authoritative truth without a fresh row.
//
// Herald has no gender/pronoun field in this capability. Do NOT infer
// gender. Do NOT store gender. A supported pronoun may refer to the ONE
// active subject regardless of pronoun form; the subject was established
// deterministically before the pronoun arrived.
//
// PARKED Flow C coverage gaps (do not hook):
//   - LLM dispatchLocalIntent household_read
//   - residual compound household action

import { findContactById } from '../db/contactsDB';
import { getServiceProviderById } from '../utils/householdRead';
import { formatPhoneForSpeech } from '../utils/phoneConfirm';

export type FamilyConversationalSubject = {
  domain: 'family_contact';
  entityId: string;
  displayName: string;
  relationship: string | null;
  establishedAtTurn: number;
};

export type HouseholdConversationalSubject = {
  domain: 'household_provider';
  entityId: string;
  displayName: string;
  category: string;
  establishedAtTurn: number;
};

export type ConversationalSubject =
  | FamilyConversationalSubject
  | HouseholdConversationalSubject;

// Closed first-slice speech act: phone-number question about a third-person
// singular pronoun. Pronoun form is eligibility only — never a selector.
const REFERENT_PHONE_RE =
  /^\s*(?:what(?:'s|s|\s+is))\s+(he|him|his|she|her|hers)\s+(?:phone\s+)?number\s*[?.!]?\s*$/i;

export function isReferentPhoneQuestion(text: string): boolean {
  const m = text.match(REFERENT_PHONE_RE);
  if (!m) return false;
  // Captured pronoun is discarded. It does not select among entities,
  // infer gender, or consult any gender field (none exists).
  void m[1];
  return true;
}

export class ConversationalSubjectHolder {
  private subject: ConversationalSubject | null = null;
  private turn = 0;
  private referentEvaluated = false;

  beginUserTurn(): void {
    this.turn += 1;
    this.referentEvaluated = false;
  }

  currentTurn(): number {
    return this.turn;
  }

  peek(): ConversationalSubject | null {
    return this.subject;
  }

  hasLive(): boolean {
    return this.subject !== null;
  }

  didEvaluateReferent(): boolean {
    return this.referentEvaluated;
  }

  markReferentEvaluated(): void {
    this.referentEvaluated = true;
  }

  clear(): void {
    this.subject = null;
  }

  establishFamily(match: {
    entityId: string;
    displayName: string;
    relationship: string | null;
  }): void {
    this.subject = {
      domain: 'family_contact',
      entityId: match.entityId,
      displayName: match.displayName,
      relationship: match.relationship,
      establishedAtTurn: this.turn,
    };
  }

  establishHousehold(match: {
    entityId: string;
    displayName: string;
    category: string;
  }): void {
    this.subject = {
      domain: 'household_provider',
      entityId: match.entityId,
      displayName: match.displayName,
      category: match.category,
      establishedAtTurn: this.turn,
    };
  }
}

function namedPhoneCopy(name: string, phone: string): string {
  return `${name}'s number is ${formatPhoneForSpeech(phone)}.`;
}

function namedMissCopy(name: string): string {
  return `I don't have a number for ${name} yet.`;
}

const NEUTRAL_MISS = `I don't have a number for them yet.`;

/**
 * Authoritative re-read by stable id. Subject metadata is not truth.
 * Pronoun form is not passed in — gender is not a selector.
 */
export function answerReferentPhone(subject: ConversationalSubject): string {
  if (subject.domain === 'family_contact') {
    const row = findContactById(subject.entityId);
    if (!row) return NEUTRAL_MISS;
    const name = row.name?.trim();
    if (!name || name.length < 2) return NEUTRAL_MISS;
    const phone = row.phone?.trim();
    if (!phone) return namedMissCopy(name);
    return namedPhoneCopy(name, phone);
  }

  const row = getServiceProviderById(subject.entityId);
  if (!row) return NEUTRAL_MISS;
  const name = row.name?.trim();
  if (!name || name.length < 2) return NEUTRAL_MISS;
  const phone = row.phone?.trim();
  if (!phone) return namedMissCopy(name);
  return namedPhoneCopy(name, phone);
}
