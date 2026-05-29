// src/db/schema.ts
// Herald device SQLite — table definitions and migration runner.
// Session L — Device-First Intelligence Layer
//
// SCHEMA VERSION: 1
// Increment SCHEMA_VERSION and add a migration function when any table changes.
// The migration runner applies all missing versions in order on app open.
//
// Tables:
//   schema_meta      — tracks current schema version
//   facts            — typed, categorized personal facts (the core memory store)
//   local_profile    — identity fields accessed on every greeting
//   medical_records  — visit history
//   medications      — active and past medications
//   medical_contacts — doctors and specialists
//   calendar_cache   — 14-day event window, refreshed on open + after write
//   life_tracker     — habits and goals

import * as SQLite from "expo-sqlite";

export const SCHEMA_VERSION = 1;
export const DB_NAME = "herald_device.db";

// ─── Open database ────────────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;

export function getDB(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync(DB_NAME);
  }
  return _db;
}

// ─── Migration runner ─────────────────────────────────────────────────────────
//
// On first launch: creates all tables at version 1.
// On version mismatch: applies each missing migration in sequence.
// Safe to call on every app open — no-ops if already current.

export async function runMigrations(): Promise<void> {
  const db = getDB();

  // Ensure schema_meta exists before anything else
  db.execSync(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version     INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    );
  `);

  const row = db.getFirstSync<{ version: number }>(
    "SELECT version FROM schema_meta LIMIT 1;"
  );
  const currentVersion = row?.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

  // Apply each migration in sequence
  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (migration) {
      migration(db);
      db.runSync(
        "INSERT OR REPLACE INTO schema_meta (version, migrated_at) VALUES (?, ?);",
        [v, new Date().toISOString()]
      );
    }
  }
}

// ─── Migrations ───────────────────────────────────────────────────────────────
//
// Each migration is a function that receives the db and applies DDL.
// NEVER modify a past migration — add a new one at the next version number.

const MIGRATIONS: Record<number, (db: SQLite.SQLiteDatabase) => void> = {
  1: (db) => {
    db.execSync(`
      -- Facts: every piece of personal knowledge Herald learns.
      -- category values: relationships | medical | preferences | schedule |
      --                  location | life_events | professional
      -- confidence values: stated | inferred | confirmed
      CREATE TABLE IF NOT EXISTS facts (
        id          TEXT PRIMARY KEY,
        fact        TEXT NOT NULL,
        category    TEXT NOT NULL,
        confidence  TEXT NOT NULL DEFAULT 'stated',
        source_date TEXT NOT NULL,
        last_used   TEXT,
        use_count   INTEGER DEFAULT 0
      );

      -- Profile: core identity fields accessed on every greeting.
      -- Standard keys: name, ai_name, city, lat, lng, timezone,
      --                persona, schema_version, onboarding_complete
      CREATE TABLE IF NOT EXISTS local_profile (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Medical visit history
      CREATE TABLE IF NOT EXISTS medical_records (
        id                TEXT PRIMARY KEY,
        visit_date        TEXT,
        doctor_name       TEXT,
        facility          TEXT,
        reason            TEXT,
        diagnosis         TEXT,
        follow_up         TEXT,
        notes             TEXT,
        created_at        TEXT NOT NULL
      );

      -- Medications (active and past)
      CREATE TABLE IF NOT EXISTS medications (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        dosage              TEXT,
        frequency           TEXT,
        prescribing_doctor  TEXT,
        start_date          TEXT,
        end_date            TEXT,
        is_active           INTEGER DEFAULT 1,
        notes               TEXT,
        created_at          TEXT NOT NULL
      );

      -- Medical contacts (doctors, specialists)
      CREATE TABLE IF NOT EXISTS medical_contacts (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        specialty  TEXT,
        phone      TEXT,
        address    TEXT,
        is_primary INTEGER DEFAULT 0,
        notes      TEXT,
        created_at TEXT NOT NULL
      );

      -- Calendar cache: 14-day event window.
      -- Refreshed on app open and after any calendar write.
      -- Eliminates the async timing race on calendar reads.
      CREATE TABLE IF NOT EXISTS calendar_cache (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        all_day    INTEGER DEFAULT 0,
        notes      TEXT,
        cached_at  TEXT NOT NULL
      );

      -- Life tracker: habits, goals, recurring events.
      CREATE TABLE IF NOT EXISTS life_tracker (
        id             TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        category       TEXT,
        frequency      TEXT,
        last_completed TEXT,
        streak         INTEGER DEFAULT 0,
        notes          TEXT,
        created_at     TEXT NOT NULL
      );
    `);
  },
};