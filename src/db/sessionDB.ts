// src/db/sessionDB.ts
// Stores compact session summaries for cross-session context injection.
// Written on app background. Read by buildAmbientDeviceContext on every turn.
// No LLM involved — raw message excerpts, under 1000 chars per session.

import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

function getDB(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync('herald_sessions.db');
    _db.execSync(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }
  return _db;
}

export function writeSessionSummary(summary: string): void {
  try {
    const db = getDB();
    const trimmed = summary.slice(0, 1000);
    db.runSync(
      'INSERT INTO session_summaries (summary, created_at) VALUES (?, ?)',
      [trimmed, Date.now()]
    );
    // Keep only last 5 sessions
    db.runSync(
      'DELETE FROM session_summaries WHERE id NOT IN (SELECT id FROM session_summaries ORDER BY created_at DESC LIMIT 5)'
    );
  } catch {}
}

export function getRecentSessionSummaries(limit = 3): string {
  try {
    const db = getDB();
    const rows = db.getAllSync<{ summary: string; created_at: number }>(
      'SELECT summary, created_at FROM session_summaries ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
    if (rows.length === 0) return '';
    return rows
      .reverse()
      .map((r) => {
        const date = new Date(r.created_at).toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
        return `[${date}] ${r.summary}`;
      })
      .join('\n\n');
  } catch {
    return '';
  }
}
