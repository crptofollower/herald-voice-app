// src/db/contactsDB.ts
// Herald device SQLite — contacts table read/write.
// Schema V3 — Build 22
//
// Herald's lightweight contact layer ON TOP of OS contacts.
// Not a replacement — a memory layer that knows relationships and importance.
// Critical for 65+ use case: "text my daughter", "call my doctor."
//
// Write path:
//   - Populated from onFacts pipeline when relationship facts are extracted
//   - Populated from one-time Railway migration
//   - Written manually when user explicitly introduces someone
//
// Read path:
//   - findContactByRelationship('daughter') → used by SMS/CALL intents
//   - findContactByName('Sarah') → used by "how is Sarah doing"
//   - getImportantContacts() → surfaced proactively

import { getDB } from "./schema";
import { normalizePersonTarget, liftRelationshipName } from "../utils/personReference";

export interface Contact {
  id: string;
  name: string;
  relationship?: string;
  phone?: string;
  address?: string;
  email?: string;
  birthday?: string;
  importance: number;       // 1-10
  entity_id?: string;
  os_contact_id?: string;  // links to device contact if matched
  notes?: string;
  last_contact?: string;   // ISO date
  is_emergency?: number;  // 1 = emergency contact, 0 = normal
  created_at: string;
  updated_at: string;
}

export const RELATIONSHIP_WORDS =
  /^(?:my |our |his |her |their )?(wife|husband|son|daughter|mom|dad|father(?:-in-law)?|mother(?:-in-law)?|brother|sister)$/i;

export function stripRelationshipLead(rawName: string): string {
  let t = rawName.trim();
  t = t.replace(/^(my|our|his|her|their|the|a)(?:\s+|$)/i, '').trim();
  t = t.replace(/^(wife|husband|son|daughter|mom|dad|father(?:-in-law)?|mother(?:-in-law)?|brother|sister)(?:\s+|$)/i, '').trim();
  return t;
}

const BLANK_OR_PUNCTUATION_ONLY = /^[\s.,!?'"-]*$/;

const BAD_NAME = /^(unknown|none|null|n\/a|n\.a\.|someone|somebody)$/i;

export type ContactWriteResult =
  | { ok: true; action: 'inserted' | 'updated'; contactId: string }
  | { ok: false; reason: 'invalid_name' | 'relationship_only' | 'missing_identity' | 'no_rows_updated' | 'db_error' };

export function writeContactRaw(
  contact: Omit<Contact, "id" | "created_at" | "updated_at">
): string {
  const db = getDB();
  const now = new Date().toISOString();

  try {
    const rel = contact.relationship?.trim().toLowerCase() || null;
    const existing = rel
      ? db.getFirstSync<{ id: string }>(
          "SELECT id FROM contacts WHERE LOWER(name) = ? AND LOWER(relationship) = ? AND removed_at IS NULL LIMIT 1;",
          [contact.name.trim().toLowerCase(), rel]
        )
      : db.getFirstSync<{ id: string }>(
          "SELECT id FROM contacts WHERE LOWER(name) = ? AND removed_at IS NULL LIMIT 1;",
          [contact.name.trim().toLowerCase()]
        );

    if (existing) {
      db.runSync(
        `UPDATE contacts SET
           relationship  = relationship,
           phone         = COALESCE(?, phone),
           address       = COALESCE(?, address),
           email         = COALESCE(?, email),
           birthday      = COALESCE(?, birthday),
           importance    = MAX(importance, ?),
           notes         = COALESCE(?, notes),
           is_emergency  = COALESCE(?, is_emergency),
           updated_at    = ?
         WHERE id = ?;`,
        [
          contact.phone ?? null, contact.address ?? null, contact.email ?? null,
          contact.birthday ?? null, contact.importance ?? 5, contact.notes ?? null,
          contact.is_emergency ?? null, now, existing.id,
        ]
      );
      return existing.id;
    }

    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.runSync(
      `INSERT INTO contacts
         (id, name, relationship, phone, address, email, birthday, importance,
          entity_id, os_contact_id, notes, is_emergency, last_contact, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id, contact.name.trim(), contact.relationship ?? null, contact.phone ?? null,
        contact.address ?? null, contact.email ?? null, contact.birthday ?? null,
        contact.importance ?? 5, contact.entity_id ?? null, contact.os_contact_id ?? null,
        contact.notes ?? null, contact.is_emergency ?? 0, contact.last_contact ?? null,
        now, now,
      ]
    );
    return id;
  } catch {
    return "";
  }
}

export function writeContactValidated(
  contact: Omit<Contact, "id" | "created_at" | "updated_at">
): ContactWriteResult {
  const name = stripRelationshipLead((contact.name ?? '').trim());

  if (!name || name.length < 2 || BLANK_OR_PUNCTUATION_ONLY.test(name)) {
    return { ok: false, reason: 'missing_identity' };
  }
  if (BAD_NAME.test(name)) {
    return { ok: false, reason: 'invalid_name' };
  }
  if (RELATIONSHIP_WORDS.test(name)) {
    return { ok: false, reason: 'relationship_only' };
  }

  const db = getDB();
  const now = new Date().toISOString();

  try {
    const rel = contact.relationship?.trim().toLowerCase() || null;
    const existing = rel
      ? db.getFirstSync<{ id: string }>(
          "SELECT id FROM contacts WHERE LOWER(name) = ? AND LOWER(relationship) = ? AND removed_at IS NULL LIMIT 1;",
          [name.toLowerCase(), rel]
        )
      : db.getFirstSync<{ id: string }>(
          "SELECT id FROM contacts WHERE LOWER(name) = ? AND removed_at IS NULL LIMIT 1;",
          [name.toLowerCase()]
        );

    if (existing) {
      const result = db.runSync(
        `UPDATE contacts SET
           relationship  = relationship,
           phone         = COALESCE(?, phone),
           address       = COALESCE(?, address),
           email         = COALESCE(?, email),
           birthday      = COALESCE(?, birthday),
           importance    = MAX(importance, ?),
           notes         = COALESCE(?, notes),
           is_emergency  = COALESCE(?, is_emergency),
           updated_at    = ?
         WHERE id = ?;`,
        [
          contact.phone ?? null, contact.address ?? null, contact.email ?? null,
          contact.birthday ?? null, contact.importance ?? 5, contact.notes ?? null,
          contact.is_emergency ?? null, now, existing.id,
        ]
      );
      if (result.changes === 0) {
        return { ok: false, reason: 'no_rows_updated' };
      }
      return { ok: true, action: 'updated', contactId: existing.id };
    }

    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.runSync(
      `INSERT INTO contacts
         (id, name, relationship, phone, address, email, birthday, importance,
          entity_id, os_contact_id, notes, is_emergency, last_contact, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id, name, contact.relationship ?? null, contact.phone ?? null,
        contact.address ?? null, contact.email ?? null, contact.birthday ?? null,
        contact.importance ?? 5, contact.entity_id ?? null, contact.os_contact_id ?? null,
        contact.notes ?? null, contact.is_emergency ?? 0, contact.last_contact ?? null,
        now, now,
      ]
    );
    return { ok: true, action: 'inserted', contactId: id };
  } catch {
    return { ok: false, reason: 'db_error' };
  }
}

export function resolveRelationshipOrNull(rawLabel: string): Contact | null {
  const trimmed = rawLabel.trim();
  if (!RELATIONSHIP_WORDS.test(trimmed)) return null;
  const bare = trimmed.replace(/^(my|our|his|her|their)\s+/i, '');
  return findContactByRelationship(bare);
}

const ADDRESS_PREFIX_STRIP = /^\s*(it'?s|it is|that'?s|that is|the address is|my address is|address is)\s*[:,-]?\s*/i;

export function normalizeAddressInput(raw: string): string {
  return raw.trim().replace(/[.!?]+$/, '').replace(ADDRESS_PREFIX_STRIP, '').trim();
}

// ─── findContactByRelationship ────────────────────────────────────────────────
//
// "text my daughter" → findContactByRelationship('daughter')
// Returns highest-importance match. Multiple daughters? Returns primary one.

export function findContactByRelationship(relationship: string): Contact | null {
  const db = getDB();
  try {
    return db.getFirstSync<Contact>(
      `SELECT * FROM contacts
       WHERE LOWER(relationship) = ? AND removed_at IS NULL
       ORDER BY importance DESC
       LIMIT 1;`,
      [relationship.toLowerCase().trim()]
    ) ?? null;
  } catch {
    return null;
  }
}

// ─── findContactByName ────────────────────────────────────────────────────────
//
// "how is Sarah doing" → findContactByName('Sarah')
// Partial match — "Sar" finds "Sarah". Returns best match.
//
// Generic shared tokens ("company", "inc", …) are not enough on their own:
// a hit requires at least one distinguishing word, and every distinguishing
// word in the query must appear in the contact name.

const CONTACT_NAME_STOPWORDS = new Set([
  'company', 'co', 'inc', 'llc', 'ltd', 'corp', 'corporation',
  'the', 'a', 'an', 'and', 'of', 'for', 'my', 'our',
]);

/** Distinctive tokens for name match; null = stopword-only / empty → no name hit. */
export function distinctiveNameTokens(raw: string): string[] | null {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const distinctive = words.filter((w) => !CONTACT_NAME_STOPWORDS.has(w));
  return distinctive.length > 0 ? distinctive : null;
}

/**
 * Order-independent, token-based match test. Same distinguishing-word
 * rule as findAllContactMatches, so the Herald-contacts table and the
 * OS/device-contacts fallback (ChatScreen.resolveContactPhone) can never
 * disagree about what counts as a match. Pure — no DB, no expo-contacts —
 * headless-testable (Engineering Principles: trust-critical logic must
 * live outside the React layer).
 */
export function nameMatchesQuery(name: string | null | undefined, query: string): boolean {
  const distinctive = distinctiveNameTokens(query);
  if (!distinctive) return false;
  const nameLower = (name ?? '').toLowerCase();
  return distinctive.every(w => nameLower.includes(w));
}

/**
 * Relationship terms Herald recognizes as PERSONAL destination references.
 * NOT a resolution mechanism — resolution stays with findAllContactMatches /
 * findContactByRelationship. This set only decides honest-fail vs Maps search.
 */
const PERSONAL_RELATIONSHIP_TERMS = new Set([
  'wife', 'husband', 'spouse', 'partner',
  'mom', 'mother', 'dad', 'father',
  'son', 'daughter', 'sister', 'brother',
  'grandma', 'grandmother', 'grandpa', 'grandfather',
  'aunt', 'uncle', 'cousin', 'nephew', 'niece',
  'mother-in-law', 'father-in-law', 'sister-in-law', 'brother-in-law',
  'son-in-law', 'daughter-in-law',
]);

export function isRelationshipTerm(cleaned: string): boolean {
  return PERSONAL_RELATIONSHIP_TERMS.has(cleaned.trim().toLowerCase());
}

/**
 * TRUE when an unresolved navigation destination refers to a PERSON, not a
 * place. Deterministic, pure, no DB, no LLM. Two signals only:
 *   1. possessive + dwelling noun ("Shannon's house", "my wife's place")
 *   2. cleaned token is a known relationship term ("wife")
 * Business names ending in a bare possessive (McDonald's, Trader Joe's,
 * Dave's) match neither and keep their existing Maps behavior.
 * [Spine §4 ACK-matches-commit, §5 confident-wrong-action, §3a Law 5]
 */
export function isPersonalDestination(raw: string, cleaned: string): boolean {
  const normalized = raw.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
  const dwellingPossessive = /'s\s+(house|home|place|address)\s*$/i.test(normalized);
  return dwellingPossessive || isRelationshipTerm(cleaned);
}

export function findContactByName(name: string): Contact | null {
  const db = getDB();
  const distinctive = distinctiveNameTokens(name);
  if (!distinctive) return null;
  try {
    // Every distinguishing word must appear — "company" alone never selects,
    // and "insurance company" cannot match on the shared "company" token.
    const clauses = distinctive.map(() => 'LOWER(name) LIKE ?').join(' AND ');
    const params = distinctive.map((w) => `%${w}%`);
    return db.getFirstSync<Contact>(
      `SELECT * FROM contacts
       WHERE ${clauses} AND removed_at IS NULL
       ORDER BY importance DESC
       LIMIT 1;`,
      params
    ) ?? null;
  } catch {
    return null;
  }
}

// ─── findAllContactMatches ────────────────────────────────────────────────────
//
// Like findContactByRelationship + findContactByName combined, but returns
// EVERY live match instead of top-1. Feeds the disambiguation stage — when
// more than one match exists, Herald asks which one instead of guessing.
// Name branch uses the same distinguishing-word rule as findContactByName.

export function findAllContactMatches(input: string): Contact[] {
  const db = getDB();
  const term = input.trim().toLowerCase();
  const distinctive = distinctiveNameTokens(term);
  try {
    let rows: Contact[];
    if (!distinctive) {
      // Stopword-only needle (e.g. "company") — relationship exact only, never name LIKE.
      rows = db.getAllSync<Contact>(
        `SELECT * FROM contacts
         WHERE removed_at IS NULL AND LOWER(relationship) = ?
         ORDER BY importance DESC;`,
        [term]
      );
    } else {
      const nameClauses = distinctive.map(() => 'LOWER(name) LIKE ?').join(' AND ');
      const nameParams = distinctive.map((w) => `%${w}%`);
      rows = db.getAllSync<Contact>(
        `SELECT * FROM contacts
         WHERE removed_at IS NULL
           AND (LOWER(relationship) = ? OR (${nameClauses}))
         ORDER BY importance DESC;`,
        [term, ...nameParams]
      );
    }
    // A contact can satisfy both predicates (e.g. relationship "daughter"
    // AND name contains the search term) — dedup by id.
    const seen = new Set<string>();
    const deduped: Contact[] = [];
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        deduped.push(row);
      }
    }
    return deduped;
  } catch {
    return [];
  }
}

export type PersonCapability = 'phone' | 'address' | 'email' | 'any';

export type PersonIdentityResolution =
  | { status: 'single'; contact: Contact }
  | { status: 'ambiguous'; candidates: Contact[] }
  | { status: 'none' };

/** Pure capability check — no lookup, no selection. */
export function contactHasCapability(
  contact: Contact,
  capability: PersonCapability,
): boolean {
  if (capability === 'any') return true;
  if (capability === 'phone') return !!contact.phone?.trim();
  if (capability === 'address') return !!contact.address?.trim();
  return !!contact.email?.trim();
}

/**
 * Identity-only Herald person resolution. Normalizes via shared personReference
 * helpers and matches with findAllContactMatches. Does not filter by capability
 * and does not call OS contacts.
 */
export function resolvePersonIdentity(rawTarget: string): PersonIdentityResolution {
  const cleaned = liftRelationshipName(normalizePersonTarget(rawTarget));
  if (!cleaned) return { status: 'none' };

  const candidates = findAllContactMatches(cleaned);
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length === 1) return { status: 'single', contact: candidates[0] };
  return { status: 'ambiguous', candidates };
}

export type PersonCapabilityResolution =
  | { status: 'available'; value: string; source: 'herald' | 'os' }
  | { status: 'missing' }
  | { status: 'ambiguous'; candidates: Contact[] };

/** Minimal OS row returned by the authorized OS capability search. */
export type OsPersonCapabilityMatch = {
  name: string;
  phone?: string;
  address?: string;
  email?: string;
};

/**
 * OS search constrained to an already-resolved person's identity attributes.
 * Must never receive the original user utterance / rawTarget.
 */
export type OsPersonCapabilitySearch = (
  identity: { name: string; relationship?: string },
  capability: Exclude<PersonCapability, 'any'>,
) => Promise<OsPersonCapabilityMatch[]>;

let _osPersonCapabilitySearch: OsPersonCapabilitySearch | null = null;

/** Register (or clear) the OS capability search used by resolvePersonCapability. */
export function setOsPersonCapabilitySearch(fn: OsPersonCapabilitySearch | null): void {
  _osPersonCapabilitySearch = fn;
}

function capabilityValue(
  row: { phone?: string | null; address?: string | null; email?: string | null },
  capability: Exclude<PersonCapability, 'any'>,
): string | undefined {
  const raw =
    capability === 'phone' ? row.phone
    : capability === 'address' ? row.address
    : row.email;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

/**
 * Capability provider for an already-resolved contact. Herald field first;
 * OS only when Herald lacks the field, searched by that contact's identity
 * attributes (never the original utterance). Does not call
 * resolvePersonIdentity and never silently picks among OS multiples.
 */
export async function resolvePersonCapability(
  contact: Contact,
  capability: PersonCapability,
): Promise<PersonCapabilityResolution> {
  if (capability === 'any') {
    return { status: 'available', value: contact.name, source: 'herald' };
  }

  const heraldValue = capabilityValue(contact, capability);
  if (heraldValue) {
    return { status: 'available', value: heraldValue, source: 'herald' };
  }

  if (!_osPersonCapabilitySearch) return { status: 'missing' };

  const osMatches = await _osPersonCapabilitySearch(
    { name: contact.name, relationship: contact.relationship },
    capability,
  );

  const withCap = osMatches.filter(m => !!capabilityValue(m, capability));
  if (withCap.length === 0) return { status: 'missing' };
  if (withCap.length === 1) {
    return {
      status: 'available',
      value: capabilityValue(withCap[0], capability)!,
      source: 'os',
    };
  }

  return {
    status: 'ambiguous',
    candidates: withCap.map((m, i) => ({
      id: `os:${i}:${m.name}`,
      name: m.name,
      phone: m.phone,
      address: m.address,
      email: m.email,
      importance: 5,
      created_at: '',
      updated_at: '',
    })),
  };
}

// ─── getImportantContacts ─────────────────────────────────────────────────────
//
// Returns contacts with importance >= threshold, ordered by importance.
// Used by proactive system to surface "haven't heard from your daughter in a while."

export function getImportantContacts(minImportance = 7): Contact[] {
  const db = getDB();
  try {
    return db.getAllSync<Contact>(
      `SELECT * FROM contacts
       WHERE importance >= ? AND removed_at IS NULL
       ORDER BY importance DESC, name ASC;`,
      [minImportance]
    );
  } catch {
    return [];
  }
}

// ─── getAllContacts ────────────────────────────────────────────────────────────

export function getAllContacts(): Contact[] {
  const db = getDB();
  try {
    return db.getAllSync<Contact>(
      "SELECT * FROM contacts WHERE removed_at IS NULL ORDER BY importance DESC, name ASC;"
    );
  } catch {
    return [];
  }
}

// ─── updateLastContact ────────────────────────────────────────────────────────
//
// Called when Herald sends an SMS or the user mentions talking to someone.

export function updateLastContact(contactId: string): void {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    db.runSync(
      "UPDATE contacts SET last_contact = ?, updated_at = ? WHERE id = ?;",
      [now, now, contactId]
    );
  } catch {}
}

// ─── extractContactFromFact ───────────────────────────────────────────────────
//
// Called from writeFacts() when a relationship fact is detected.
// Parses "father-in-law named David" → writes Contact(name: David, relationship: father-in-law).
// This is best-effort — structured intake handles the full flow.

export function extractContactFromFact(fact: string): void {
  // Pattern: "[relationship] named [name]" or "[name] is my [relationship]"
  const namedPattern = /(\w[\w\s-]+?)\s+named\s+(\w+)/i;
  const isMyPattern = /(\w+)\s+is\s+my\s+([\w\s-]+)/i;
  const myRelPattern = /my\s+([\w\s-]+?)\s+(?:is\s+)?(?:named\s+)?(\w+)/i;

  let name: string | null = null;
  let relationship: string | null = null;

  let m = fact.match(namedPattern);
  if (m) { relationship = m[1].trim(); name = m[2].trim(); }

  if (!name) {
    m = fact.match(isMyPattern);
    if (m) { name = m[1].trim(); relationship = m[2].trim(); }
  }

  if (!name) {
    m = fact.match(myRelPattern);
    if (m) { relationship = m[1].trim(); name = m[2].trim(); }
  }

  if (name && name.length >= 2 && name.length <= 30) {
    writeContactValidated({
      name,
      relationship: relationship ?? undefined,
      importance: relationship ? 7 : 5,
    });
  }
}

// ─── importContacts ───────────────────────────────────────────────────────────
//
// Bulk import from Railway migration or backup restore.

export function importContacts(contacts: Partial<Contact>[]): void {
  for (const c of contacts) {
    if (c.name) {
      writeContactRaw({
        name: c.name,
        relationship: c.relationship,
        phone: c.phone,
        email: c.email,
        birthday: c.birthday,
        importance: c.importance ?? 5,
        entity_id: c.entity_id,
        os_contact_id: c.os_contact_id,
        notes: c.notes,
        last_contact: c.last_contact,
      });
    }
  }
}

// ─── removeContact ─────────────────────────────────────────────────────────────
// Soft-delete by id — stamps removed_at, never a hard delete.
export function removeContact(id: string): number {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const result = db.runSync(
      "UPDATE contacts SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL;",
      [now, now, id]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── removeContactByName ───────────────────────────────────────────────────────
// Soft-delete every live row matching a name (case-insensitive). For voice
// correction and backfill undo. Clears ALL matches so a duplicate can't resurface.
export function removeContactByName(name: string): number {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const result = db.runSync(
      "UPDATE contacts SET removed_at = ?, updated_at = ? WHERE LOWER(name) = ? AND removed_at IS NULL;",
      [now, now, name.trim().toLowerCase()]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── retireRelationshipHolder ──────────────────────────────────────────────
// Relationship tags with current-value semantics (father-in-law, spouse,
// primary doctor, etc.) must have exactly one live holder (Spine §6
// principle 3: current truth ≠ historical truth). Called ONLY from an
// explicit-confirmation flow (Spine §4a: inferred identity merges require
// explicit user confirmation) — never a background/inferred merge. Clears
// the relationship field on any OTHER live contact holding it; does not
// delete the contact itself, since it may still be a legitimate contact
// under a different or no relationship.
export function retireRelationshipHolder(relationship: string, exceptName: string): number {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const result = db.runSync(
      `UPDATE contacts SET relationship = NULL, updated_at = ?
       WHERE LOWER(relationship) = ? AND LOWER(name) != ? AND removed_at IS NULL;`,
      [now, relationship.trim().toLowerCase(), exceptName.trim().toLowerCase()]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── clearContacts ─────────────────────────────────────────────────────────────
// Soft-delete ALL live contacts (the §4a clear op). Never a hard delete.
export function clearContacts(): number {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const result = db.runSync(
      "UPDATE contacts SET removed_at = ?, updated_at = ? WHERE removed_at IS NULL;",
      [now, now]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── getEmergencyContact ──────────────────────────────────────────────────
// Returns the contact flagged as emergency, or null if none set.
export function getEmergencyContact(): Contact | null {
  const db = getDB();
  try {
    return db.getFirstSync<Contact>(
      "SELECT * FROM contacts WHERE is_emergency = 1 AND removed_at IS NULL LIMIT 1;"
    ) ?? null;
  } catch {
    return null;
  }
}

// ─── setEmergencyContact ──────────────────────────────────────────────────
// Clears any existing emergency flag, then sets it on the named contact.
// Creates the contact if not found.
export function setEmergencyContact(name: string, phone?: string): void {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    db.runSync("UPDATE contacts SET is_emergency = 0, updated_at = ? WHERE is_emergency = 1;", [now]);
    const existing = findContactByName(name);
    if (existing) {
      db.runSync("UPDATE contacts SET is_emergency = 1, updated_at = ? WHERE id = ?;", [now, existing.id]);
      if (phone) db.runSync("UPDATE contacts SET phone = COALESCE(?, phone), updated_at = ? WHERE id = ?;", [phone, now, existing.id]);
    } else {
      writeContactValidated({ name, phone, importance: 10, is_emergency: 1 });
    }
  } catch {}
}

// ─── resolvePhoneNumber ───────────────────────────────────────────────────────
//
// The core resolver for "call my daughter" / "text Dr. Smith".
// Resolution order:
//   1. Herald contacts table — relationship match (fastest, most reliable)
//   2. Herald contacts table — name match
//   3. OS contacts via expo-contacts — name/relationship search (fallback)
//
// Returns { name, phone } or null if not found.
// Import expo-contacts lazily so the module is tree-shaken if not available.

export async function resolvePhoneNumber(
  nameOrRelationship: string
): Promise<{ name: string; phone: string } | null> {
  const input = nameOrRelationship.trim().toLowerCase();

  // ── 1. Herald contacts — relationship match ────────────────────────────────
  const byRelationship = findContactByRelationship(input);
  if (byRelationship?.phone) {
    return { name: byRelationship.name, phone: byRelationship.phone };
  }

  // ── 2. Herald contacts — name match ───────────────────────────────────────
  const byName = findContactByName(input);
  if (byName?.phone) {
    return { name: byName.name, phone: byName.phone };
  }

  // ── 3. OS contacts via expo-contacts ──────────────────────────────────────
  try {
    const Contacts = await import("expo-contacts");
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== "granted") return null;

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
    });

    // Score each contact by name similarity to input
    const scored = data
      .filter((c) => c.name && c.phoneNumbers?.length)
      .map((c) => {
        const nameLower = (c.name ?? "").toLowerCase();
        // Exact match
        if (nameLower === input) return { c, score: 100 };
        // Contains match
        if (nameLower.includes(input) || input.includes(nameLower.split(" ")[0]))
          return { c, score: 70 };
        // First name match
        const firstName = nameLower.split(" ")[0];
        if (firstName === input || input.includes(firstName)) return { c, score: 50 };
        return { c, score: 0 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return null;

    const best = scored[0].c;
    const phone = best.phoneNumbers![0].number?.replace(/\D/g, "") ?? "";
    if (!phone) return null;

    // Write to Herald contacts so next lookup is instant
    writeContactRaw({
      name: best.name ?? input,
      phone,
      importance: 5,
    });

    return { name: best.name ?? input, phone };
  } catch {
    return null;
  }
}
