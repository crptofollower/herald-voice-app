// Bounded verified context for conversational generation only.
// Rebuilt each turn from existing SQLite/session sources. Never persisted.
// Not an Association graph, transcript memory, or ResultContext clone.

import { extractTitleCaseNameTokens } from '../utils/ephemeralSeam';

export type VerifiedConversationalPacket = {
  verifiedPersonalFacts: string;
  sessionEvidence: string;
  pending: string | null;
  /** Title-case persons in session/current text with no SQLite biography. */
  unverifiedPersonNames: string[];
  /** Verbatim user lines that mention those persons — evidence, not memory. */
  userSuppliedPersonMentions: string[];
};

function nameInText(haystack: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

export function buildVerifiedConversationalPacket(input: {
  verifiedPersonalFacts: string;
  sessionEvidenceLines: string[];
  pendingLabel: string | null;
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
  return {
    verifiedPersonalFacts: verified,
    sessionEvidence,
    pending: input.pendingLabel?.trim() || null,
    unverifiedPersonNames,
    userSuppliedPersonMentions,
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
