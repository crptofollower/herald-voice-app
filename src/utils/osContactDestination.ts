// Deterministic OS contact destination matching for CALL/SMS.
// Pure — no expo-contacts, no DB. ChatScreen/adapters supply rows.

import {
  distinctiveNameTokens,
  RELATIONSHIP_WORDS,
  stripRelationshipLead,
} from '../db/contactsDB';
import { liftRelationshipName, normalizePersonTarget } from './personReference';

export type OsContactLike = {
  id?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumbers?: Array<{ number?: string | null } | null> | null;
};

export type OsPhoneableDestination = { name: string; phone: string };

export type OsDestinationShape =
  | { phone: string; name: string; source: 'device' }
  | {
      phone: null;
      name: string;
      source: 'device';
      candidateNames: string[];
      deviceCandidates: OsPhoneableDestination[];
    };

/** OS name query: relationship words are Herald metadata, never required display tokens. */
export function osNameQuery(raw: string, heraldName?: string): string {
  let t = raw.trim().replace(/[.!?]+$/g, '').trim();
  t = t.replace(/^(?:please\s+)?(?:call|text|message|sms|dial)\s+/i, '');
  t = t.replace(/^it'?s\s+/i, '');
  t = t.replace(/^under\s+/i, '');
  const cleaned = liftRelationshipName(normalizePersonTarget(t));
  const stripped = stripRelationshipLead(cleaned);
  if (stripped) return stripped;
  const herald = (heraldName ?? '').trim();
  if (herald && !RELATIONSHIP_WORDS.test(herald)) return herald;
  return '';
}

/** Union prior given-name evidence with a clarification span (e.g. Shannon + Durand). */
export function refineOsNameQuery(prior: string, clarification: string): string {
  const a = osNameQuery(prior);
  const b = osNameQuery(clarification);
  const ta = distinctiveNameTokens(a) ?? [];
  const tb = distinctiveNameTokens(b) ?? [];
  if (ta.length === 0) return b;
  if (tb.length === 0) return a;
  if (ta.every(t => tb.includes(t))) return b;
  // Clarification is a subset of prior tokens (e.g. "Paul show" → "Paul"):
  // keep the user's narrower span, do not retain leftover STT tokens.
  if (tb.every(t => ta.includes(t))) return b;
  const merged = [...ta];
  for (const t of tb) {
    if (!merged.includes(t)) merged.push(t);
  }
  return merged.join(' ');
}

export function osMatchHaystack(c: OsContactLike): string {
  return [c.name, c.firstName, c.lastName].filter(Boolean).join(' ');
}

/**
 * True when query tokens cover the destination name with no leftover distinctive
 * OS tokens. Blocks silent dial of "Josh" → "Josh Boss".
 */
export function osNameFullyCovered(query: string, destinationName: string): boolean {
  const q = distinctiveNameTokens(query) ?? [];
  const d = distinctiveNameTokens(destinationName) ?? [];
  if (q.length === 0 || d.length === 0) return false;
  if (!q.every(t => d.includes(t))) return false;
  return d.every(t => q.includes(t));
}

/** First usable number: skip empty/invalid slots; prefer ≥10 digits. */
export function firstUsablePhoneDigits(
  phoneNumbers: OsContactLike['phoneNumbers'],
): string | null {
  if (!phoneNumbers?.length) return null;
  let fallback: string | null = null;
  for (const p of phoneNumbers) {
    const raw = p?.number?.trim();
    if (!raw) continue;
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) return digits;
    if (digits.length > 0 && !fallback) fallback = digits;
  }
  return fallback;
}

function contactMatchesQuery(c: OsContactLike, q: string, distinctive: string[]): boolean {
  const qLower = q.trim().toLowerCase();
  if (
    c.name?.toLowerCase() === qLower
    || c.firstName?.toLowerCase() === qLower
    || c.lastName?.toLowerCase() === qLower
  ) {
    return true;
  }
  const hay = osMatchHaystack(c).toLowerCase();
  return distinctive.every(w => hay.includes(w));
}

/**
 * Phoneable OS destinations for a name query.
 * Full token coverage wins over weaker given-name-only hits.
 * Never truncates the result set.
 */
export function selectPhoneableOsDestinations(
  data: OsContactLike[],
  query: string,
): OsPhoneableDestination[] {
  const q = query.trim();
  if (!q) return [];
  const distinctive = distinctiveNameTokens(q);
  if (!distinctive) return [];

  const phoneable: Array<OsPhoneableDestination & { coverage: number; idKey: string }> = [];
  const seen = new Set<string>();
  for (const c of data) {
    if (!contactMatchesQuery(c, q, distinctive)) continue;
    const phone = firstUsablePhoneDigits(c.phoneNumbers);
    if (!phone) continue;
    const name = (c.name?.trim() || `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || q);
    const idKey = c.id ? `id:${c.id}` : `np:${name.toLowerCase()}|${phone}`;
    if (seen.has(idKey)) continue;
    seen.add(idKey);
    const hay = osMatchHaystack(c).toLowerCase();
    const coverage = distinctive.filter(w => hay.includes(w)).length;
    phoneable.push({ name, phone, coverage, idKey });
  }

  const full = phoneable.filter(p => p.coverage >= distinctive.length);
  const ranked = full.length > 0 ? full : phoneable;
  return ranked.map(({ name, phone }) => ({ name, phone }));
}

export function osDestinationShape(
  destinations: OsPhoneableDestination[],
  spoken: string,
): OsDestinationShape | null {
  if (destinations.length === 0) return null;
  if (destinations.length === 1) {
    return { phone: destinations[0].phone, name: destinations[0].name, source: 'device' };
  }
  return {
    phone: null,
    name: spoken,
    source: 'device',
    candidateNames: destinations.map(d => d.name),
    deviceCandidates: destinations.map(d => ({ name: d.name, phone: d.phone })),
  };
}
