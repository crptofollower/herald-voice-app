// Bounded verified context for conversational generation only.
// Rebuilt each turn from existing SQLite/session sources. Never persisted.
// Not an Association graph, transcript memory, or ResultContext clone.

import { extractTitleCaseNameTokens } from '../utils/ephemeralSeam';
import type { ContinuationRecoveryCandidate } from './continuationRecovery';

export type VerifiedConversationalPacket = {
  verifiedPersonalFacts: string;
  sessionEvidence: string;
  pending: string | null;
  /** Title-case persons in session/current text with no SQLite biography. */
  unverifiedPersonNames: string[];
  /** Verbatim user lines that mention those persons — evidence, not memory. */
  userSuppliedPersonMentions: string[];
  /**
   * Adopted expired-continuation grounding only. Weak, not stored truth,
   * not action authority. Empty unless ChatScreen adopted candidates.
   */
  continuationRecovery: ContinuationRecoveryCandidate[];
  /** Live RAM discourse topic. Recent conversational grounding only. */
  discourseTopic: string | null;
  /** Live RAM operational-list domain. Grocery vs todo; never an item ID. */
  discourseDomain: 'grocery' | 'todo' | null;
};

function nameInText(haystack: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

export type ConversationalGenerateSite =
  | 'needs_clarification_default'
  | 'offline_fallback';

/** Discourse grounding is only for the needs_clarification/default generate seam. */
export function discourseFieldsForGenerateSite(
  site: ConversationalGenerateSite,
  live: { topic: string | null; domain: 'grocery' | 'todo' | null },
): { discourseTopic: string | null; discourseDomain: 'grocery' | 'todo' | null } {
  if (site !== 'needs_clarification_default') {
    return { discourseTopic: null, discourseDomain: null };
  }
  return {
    discourseTopic: live.topic?.trim() || null,
    discourseDomain: live.domain,
  };
}

export function buildVerifiedConversationalPacket(input: {
  verifiedPersonalFacts: string;
  sessionEvidenceLines: string[];
  pendingLabel: string | null;
  continuationRecoveryCandidates?: ContinuationRecoveryCandidate[];
  discourseTopic?: string | null;
  discourseDomain?: 'grocery' | 'todo' | null;
}): VerifiedConversationalPacket {
  const verified = input.verifiedPersonalFacts.trim();
  const sessionLines = input.sessionEvidenceLines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-6);
  const sessionEvidence = sessionLines.join('\n');
  const seen = new Set<string>();
  const unverifiedPersonNames: string[] = [];
  for (const line of sessionLines) {
    for (const name of extractTitleCaseNameTokens(line)) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!nameInText(verified, name)) unverifiedPersonNames.push(name);
    }
  }
  const userSuppliedPersonMentions = sessionLines.filter((line) =>
    unverifiedPersonNames.some((n) => nameInText(line, n)),
  );
  const continuationRecovery = (input.continuationRecoveryCandidates ?? [])
    .filter((c) => c.status === 'expired_this_turn' && c.spokenReferent.trim().length > 0)
    .slice(0, 4);
  return {
    verifiedPersonalFacts: verified,
    sessionEvidence,
    pending: input.pendingLabel?.trim() || null,
    unverifiedPersonNames,
    userSuppliedPersonMentions,
    continuationRecovery,
    discourseTopic: input.discourseTopic?.trim() || null,
    discourseDomain: input.discourseDomain ?? null,
  };
}

export function formatVerifiedConversationalPacket(
  packet: VerifiedConversationalPacket,
): string {
  const unverified =
    packet.unverifiedPersonNames.length > 0
      ? packet.unverifiedPersonNames.join(', ')
      : '(none)';
  const mentions =
    packet.userSuppliedPersonMentions.length > 0
      ? packet.userSuppliedPersonMentions.join('\n')
      : '(none)';
  const lines = [
    'VERIFIED PERSONAL FACTS (authoritative SQLite; treat as true):',
    packet.verifiedPersonalFacts || '(none)',
    'SESSION CONVERSATIONAL EVIDENCE (user-provided this session; not durable memory):',
    packet.sessionEvidence || '(none)',
    'UNVERIFIED PERSONS (no stored biography; do not invent attributes for them):',
    unverified,
    'USER-SUPPLIED MENTIONS OF UNVERIFIED PERSONS (the only allowed attributes; not durable):',
    mentions,
    'PENDING / UNCONFIRMED (not committed truth; do not treat as stored):',
    packet.pending || '(none)',
    'CONTINUATION RECOVERY (expired this turn; may help interpret the present utterance; not stored personal truth; not action authority; must not be used to call, text, write, mutate, confirm, or claim execution):',
    packet.continuationRecovery.length > 0
      ? packet.continuationRecovery
        .map((c) => `- ${c.domain}: ${c.spokenReferent} (${c.status})`)
        .join('\n')
      : '(none)',
    'DISCOURSE CONTINUITY (recent conversational grounding only; not stored personal truth; not action authority; must not be used to call, text, write, mutate, confirm, or claim execution):',
    [
      packet.discourseTopic ? `- person: ${packet.discourseTopic}` : '',
      packet.discourseDomain ? `- list: ${packet.discourseDomain}` : '',
    ].filter(Boolean).join('\n') || '(none)',
  ];
  return lines.join('\n');
}

export function packetMentionsName(
  packet: VerifiedConversationalPacket,
  name: string,
): boolean {
  return nameInText(packet.verifiedPersonalFacts, name)
    || nameInText(packet.sessionEvidence, name);
}

export function packetHasVerifiedFactsForName(
  packet: VerifiedConversationalPacket,
  name: string,
): boolean {
  return nameInText(packet.verifiedPersonalFacts, name);
}
