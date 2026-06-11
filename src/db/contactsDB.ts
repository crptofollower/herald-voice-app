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
  created_at: string;
  updated_at: string;
}

// ─── writeContact ─────────────────────────────────────────────────────────────
//
// Upsert by name (case-insensitive). If a contact with the same name exists,
// updates fields rather than creating a duplicate.

export function writeContact(
  contact: Omit<Contact, "id" | "created_at" | "updated_at">
): string {
  const db = getDB();
  const now = new Date().toISOString();

  try {
    const existing = db.getFirstSync<{ id: string }>(
      "SELECT id FROM contacts WHERE LOWER(name) = ? LIMIT 1;",
      [contact.name.trim().toLowerCase()]
    );

    if (existing) {
      // Update fields that are provided — don't overwrite with nulls
      db.runSync(
        `UPDATE contacts SET
           relationship  = COALESCE(?, relationship),
           phone         = COALESCE(?, phone),
           address       = COALESCE(?, address),
           email         = COALESCE(?, email),
           birthday      = COALESCE(?, birthday),
           importance    = MAX(importance, ?),
           notes         = COALESCE(?, notes),
           updated_at    = ?
         WHERE id = ?;`,
        [
          contact.relationship ?? null,
          contact.phone ?? null,
          contact.address ?? null,
          contact.email ?? null,
          contact.birthday ?? null,
          contact.importance ?? 5,
          contact.notes ?? null,
          now,
          existing.id,
        ]
      );
      return existing.id;
    }

    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.runSync(
      `INSERT INTO contacts
         (id, name, relationship, phone, address, email, birthday, importance,
          entity_id, os_contact_id, notes, last_contact, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        id,
        contact.name.trim(),
        contact.relationship ?? null,
        contact.phone ?? null,
        contact.address ?? null,
        contact.email ?? null,
        contact.birthday ?? null,
        contact.importance ?? 5,
        contact.entity_id ?? null,
        contact.os_contact_id ?? null,
        contact.notes ?? null,
        contact.last_contact ?? null,
        now,
        now,
      ]
    );
    return id;
  } catch {
    // contacts table not yet available (pre-V3) — return placeholder
    return "";
  }
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
       WHERE LOWER(relationship) = ?
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

export function findContactByName(name: string): Contact | null {
  const db = getDB();
  try {
    return db.getFirstSync<Contact>(
      `SELECT * FROM contacts
       WHERE LOWER(name) LIKE ?
       ORDER BY importance DESC
       LIMIT 1;`,
      [`%${name.toLowerCase().trim()}%`]
    ) ?? null;
  } catch {
    return null;
  }
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
       WHERE importance >= ?
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
      "SELECT * FROM contacts ORDER BY importance DESC, name ASC;"
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
    writeContact({
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
      writeContact({
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
    writeContact({
      name: best.name ?? input,
      phone,
      importance: 5,
    });

    return { name: best.name ?? input, phone };
  } catch {
    return null;
  }
}
