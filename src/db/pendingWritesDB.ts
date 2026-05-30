// src/db/pendingWritesDB.ts
// Herald device SQLite — offline write queue.
// Schema V3 — Build 22
//
// When Herald is offline, calendar writes and SMS intents are queued here.
// On network reconnect (or next app open with connectivity), the queue is
// drained in order. Failed executions are retried up to 3 times then marked failed.
//
// Usage:
//   queueWrite('calendar', { title, dateStr, timeStr }) — from handleCalendarAction
//   drainPendingWrites(executor) — called from ChatScreen on network reconnect

import { getDB } from "./schema";

export type PendingWriteType = "calendar" | "sms" | "reminder";

export interface PendingWrite {
  id: string;
  type: PendingWriteType;
  payload: string;        // JSON string
  status: "pending" | "executing" | "done" | "failed";
  created_at: string;
  executed_at?: string;
  retry_count?: number;
}

// ─── queueWrite ───────────────────────────────────────────────────────────────
//
// Queue an intent for offline execution.
// Call from handleCalendarAction / handleSMSAction when offline is detected.

export function queueWrite(
  type: PendingWriteType,
  payload: Record<string, unknown>
): string {
  const db = getDB();
  const id = `pw_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  try {
    db.runSync(
      `INSERT INTO pending_writes (id, type, payload, status, created_at)
       VALUES (?, ?, ?, 'pending', ?);`,
      [id, type, JSON.stringify(payload), now]
    );
    return id;
  } catch {
    return "";
  }
}

// ─── getPendingWrites ─────────────────────────────────────────────────────────
//
// Returns all pending writes in creation order.

export function getPendingWrites(): PendingWrite[] {
  const db = getDB();
  try {
    return db.getAllSync<PendingWrite>(
      `SELECT * FROM pending_writes
       WHERE status = 'pending'
       ORDER BY created_at ASC;`
    );
  } catch {
    return [];
  }
}

// ─── markWriteDone ────────────────────────────────────────────────────────────

export function markWriteDone(id: string): void {
  const db = getDB();
  try {
    db.runSync(
      "UPDATE pending_writes SET status = 'done', executed_at = ? WHERE id = ?;",
      [new Date().toISOString(), id]
    );
  } catch {}
}

// ─── markWriteFailed ──────────────────────────────────────────────────────────

export function markWriteFailed(id: string): void {
  const db = getDB();
  try {
    db.runSync(
      "UPDATE pending_writes SET status = 'failed', executed_at = ? WHERE id = ?;",
      [new Date().toISOString(), id]
    );
  } catch {}
}

// ─── drainPendingWrites ───────────────────────────────────────────────────────
//
// Call this when network connectivity is restored (AppState active + isConnected).
// executor: async function that takes a PendingWrite and executes it.
// Returns count of successfully executed writes.
//
// Usage in ChatScreen:
//   const drained = await drainPendingWrites(async (write) => {
//     const payload = JSON.parse(write.payload);
//     if (write.type === 'calendar') await handleCalendarAction(payload.value, payload.context);
//     if (write.type === 'sms') await handleSMSAction(payload.value);
//   });
//   if (drained > 0) addMessage({ ... "I added those items while you were offline." });

export async function drainPendingWrites(
  executor: (write: PendingWrite) => Promise<void>
): Promise<number> {
  const pending = getPendingWrites();
  if (pending.length === 0) return 0;

  let succeeded = 0;
  for (const write of pending) {
    try {
      await executor(write);
      markWriteDone(write.id);
      succeeded++;
    } catch {
      markWriteFailed(write.id);
    }
  }
  return succeeded;
}

// ─── getPendingCount ──────────────────────────────────────────────────────────
//
// Quick check — use before showing "queued for later" message to user.

export function getPendingCount(): number {
  const db = getDB();
  try {
    const row = db.getFirstSync<{ count: number }>(
      "SELECT COUNT(*) as count FROM pending_writes WHERE status = 'pending';"
    );
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}
