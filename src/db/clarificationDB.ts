// src/db/clarificationDB.ts
// One-follow-up loop state for medical capture (Part B).

import { getDB } from "./schema";

export function writeClarification(recordId: string, slot: string): string {
  const db = getDB();
  const id = `cl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.runSync(
    `INSERT INTO pending_clarifications (id, record_id, slot, created_at) VALUES (?, ?, ?, ?);`,
    [id, recordId, slot, new Date().toISOString()]
  );
  return id;
}

export function getPendingClarification(): { id: string; record_id: string; slot: string } | null {
  const db = getDB();
  const row = db.getFirstSync<{ id: string; record_id: string; slot: string }>(
    `SELECT id, record_id, slot FROM pending_clarifications ORDER BY created_at ASC LIMIT 1;`
  );
  return row ?? null;
}

export function clearClarification(id: string): void {
  const db = getDB();
  db.runSync(`DELETE FROM pending_clarifications WHERE id = ?;`, [id]);
}
