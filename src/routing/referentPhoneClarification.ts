// Read-through labels for an ambiguous phone read.
// Candidate membership stays in Referents in Play. This module stores nothing.

export type PhoneCandidateView = {
  id: string;
  name: string;
  relationship?: string | null;
  location?: string | null;
};

export type BoundedPhoneResolution =
  | { kind: 'one'; candidateId: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

export type PhoneReadClarification = {
  speech: string;
  ordinalEligible: boolean;
};

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function unique(labels: string[]): boolean {
  const folded = labels.map((label) => label.toLowerCase());
  return labels.length > 1 && folded.every((label) => label.length > 0) && new Set(folded).size === labels.length;
}

function named(contact: PhoneCandidateView, suffix: string): string {
  const name = clean(contact.name) || 'that contact';
  return suffix ? `${name}, ${suffix}` : name;
}

function valueMentioned(utterance: string, value: string): boolean {
  const folded = value.trim().toLowerCase();
  if (folded.length < 2) return false;
  const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(utterance);
}

/** Match the utterance to stored values of these candidates only. */
export function resolveBoundedPhoneReferent(
  text: string,
  candidates: readonly PhoneCandidateView[],
): BoundedPhoneResolution {
  const hits = new Set<string>();
  for (const contact of candidates) {
    const values = [contact.name, contact.relationship, contact.location].map(clean).filter((value) => value.length >= 2);
    if (values.some((value) => valueMentioned(text, value))) hits.add(contact.id);
  }
  if (hits.size === 0) return { kind: 'none' };
  if (hits.size === 1) return { kind: 'one', candidateId: [...hits][0] };
  return { kind: 'ambiguous' };
}

/** Least-sensitive stored field that makes every candidate speak differently. Notes are not a round-trip field. */
export function projectPhoneReadClarification(candidates: readonly PhoneCandidateView[]): PhoneReadClarification {
  const names = candidates.map((contact) => clean(contact.name) || 'that contact');
  const projections = [
    names,
    candidates.map((contact) => named(contact, clean(contact.relationship) ? `your ${clean(contact.relationship)}` : '')),
    candidates.map((contact) => named(contact, clean(contact.location) ? `from ${clean(contact.location)}` : '')),
  ];
  for (const labels of projections) {
    if (!unique(labels)) continue;
    const spoken = labels.length === 2 ? `${labels[0]} or ${labels[1]}` : labels.join(', ');
    return {
      speech: `I found more than one match — ${spoken}. Which one?`,
      ordinalEligible: true,
    };
  }
  const shared = names.every((name) => name.toLowerCase() === names[0]?.toLowerCase()) ? names[0] : 'that name';
  const count = candidates.length === 2 ? 'two' : String(candidates.length);
  return {
    speech: `I have ${count} contacts named ${shared}. Which one do you mean? Tell me something that distinguishes them.`,
    ordinalEligible: false,
  };
}
