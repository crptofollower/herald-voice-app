// Rung 5 Step 2 — contact↔entity person identity and the Me node.
// contacts remains the person store. Graph nodes reuse contacts.id.
// people stays unwritten. No entity_relationships writes.

import { getDB } from './schema';
import { getProfileField } from './profileDB';

export const ME_ENTITY_ID = 'me';
export const PERSON_ENTITY_TYPE = 'person';

export function hasPersonEntitiesTable(): boolean {
  const db = getDB();
  try {
    const row = db.getFirstSync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities' LIMIT 1;",
    );
    return !!row;
  } catch {
    return false;
  }
}

export function ensurePersonEntityNode(id: string, name: string): void {
  if (!hasPersonEntitiesTable()) return;
  const db = getDB();
  const now = new Date().toISOString();
  db.runSync(
    `INSERT OR IGNORE INTO entities (id, name, type, notes, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?);`,
    [id, name.trim(), PERSON_ENTITY_TYPE, now, now],
  );
}

export function linkContactToPersonEntity(contactId: string): void {
  if (!hasPersonEntitiesTable()) return;
  const db = getDB();
  db.runSync(
    `UPDATE contacts SET entity_id = ?
     WHERE id = ? AND entity_id IS NULL;`,
    [contactId, contactId],
  );
}

export function ensureMeEntity(): void {
  if (!hasPersonEntitiesTable()) return;
  let name = 'Me';
  try {
    const profileName = getProfileField('name');
    if (profileName && profileName.trim()) name = profileName.trim();
  } catch {
    // local_profile may be absent in incomplete harnesses
  }
  ensurePersonEntityNode(ME_ENTITY_ID, name);
}

export function ensureRung5PersonEntityIdentity(): {
  contactsEnsured: number;
  mePresent: boolean;
} {
  if (!hasPersonEntitiesTable()) {
    return { contactsEnsured: 0, mePresent: false };
  }
  const db = getDB();
  const rows = db.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM contacts WHERE removed_at IS NULL;`,
  );
  for (const row of rows) {
    ensurePersonEntityNode(row.id, row.name);
    linkContactToPersonEntity(row.id);
  }
  ensureMeEntity();
  const me = db.getFirstSync<{ id: string }>(
    `SELECT id FROM entities WHERE id = ? LIMIT 1;`,
    [ME_ENTITY_ID],
  );
  return { contactsEnsured: rows.length, mePresent: !!me };
}

export function withContactPersonEntityTx<T>(fn: () => T): T {
  if (!hasPersonEntitiesTable()) return fn();
  const db = getDB();
  db.execSync('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.execSync('COMMIT;');
    return result;
  } catch (e) {
    try { db.execSync('ROLLBACK;'); } catch { /* already closed / no tx */ }
    throw e;
  }
}
