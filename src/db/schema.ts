// src/db/schema.ts
// Herald device SQLite — table definitions and migration runner.
// Session L — Device-First Intelligence Layer
//
// SCHEMA VERSION: 6
// v1: Initial schema — facts, profile, medical, calendar_cache (ISO strings), life_tracker
// v2: calendar_cache rebuilt with Unix ms timestamps (timezone fix)
// v3: Entity graph + importance scoring + temporal awareness (locked Session L spec)
//     New tables: entities, entity_relationships, life_events,
//                 financial_accounts, financial_obligations,
//                 people, behavior_patterns, observations,
//                 memory_importance, medication_log, pending_writes
//     facts table: +entity_id, +importance_score, +valid_until, +context_type
//     Indexes: facts(category), facts(importance_score), facts(context_type)
//     WAL mode enabled on getDB() open
//
// RULE: NEVER modify a past migration. Always add at the next version number.
//
// ─── SECURITY ROADMAP (locked) ────────────────────────────────────────────────
// Current state: Device SQLite is protected by Android app sandbox only.
// On non-rooted devices this is sufficient for Gate 2 (Mickey, 1 user).
// BEFORE Gate 3 (5 users, Heather, real medical data on device):
//   → Encrypt herald_device.db with SQLCipher or expo-sqlite + encryption key
//   → Key stored in Android Keystore via expo-secure-store (never in AsyncStorage)
//   → Key is device-bound — not backed up, not extractable
//   → ADB backup cannot extract encrypted DB
//   → Migration: encrypt existing DB on first open after upgrade
// Session W is the target. Do not onboard Gate 3 users without this in place.
// The product promise "your data never leaves your phone" is only half-true
// without encryption — technically correct but misleading on a rooted/lost device.

import * as SQLite from "expo-sqlite";

export const SCHEMA_VERSION = 6;
export const DB_NAME = "herald_device.db";

// ─── Open database ────────────────────────────────────────────────────────────
// WAL mode: enables concurrent reads during writes, prevents lock contention
// if calendar refresh and fact write overlap.

let _db: SQLite.SQLiteDatabase | null = null;

export function getDB(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync(DB_NAME);
    // WAL mode — one-time pragma, persists across connections
    _db.execSync("PRAGMA journal_mode=WAL;");
    _db.execSync("PRAGMA foreign_keys=ON;");
  }
  return _db;
}

// ─── Migration runner ─────────────────────────────────────────────────────────

export async function runMigrations(): Promise<void> {
  const db = getDB();

  db.execSync(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version     INTEGER NOT NULL,
      migrated_at TEXT NOT NULL
    );
  `);

  const row = db.getFirstSync<{ version: number }>(
    "SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1;"
  );
  const currentVersion = row?.version ?? 0;

  if (currentVersion >= SCHEMA_VERSION) return;

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

const MIGRATIONS: Record<number, (db: SQLite.SQLiteDatabase) => void> = {

  // ── v1: Initial schema ─────────────────────────────────────────────────────
  1: (db) => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS facts (
        id          TEXT PRIMARY KEY,
        fact        TEXT NOT NULL,
        category    TEXT NOT NULL,
        confidence  TEXT NOT NULL DEFAULT 'stated',
        source_date TEXT NOT NULL,
        last_used   TEXT,
        use_count   INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS local_profile (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS medical_records (
        id            TEXT PRIMARY KEY,
        visit_date    TEXT,
        doctor_name   TEXT,
        facility      TEXT,
        reason        TEXT,
        diagnosis     TEXT,
        follow_up     TEXT,
        notes         TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS medications (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        dosage             TEXT,
        frequency          TEXT,
        prescribing_doctor TEXT,
        start_date         TEXT,
        end_date           TEXT,
        is_active          INTEGER DEFAULT 1,
        notes              TEXT,
        created_at         TEXT NOT NULL
      );

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

      -- v1 used ISO strings — replaced in v2
      CREATE TABLE IF NOT EXISTS calendar_cache (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        all_day    INTEGER DEFAULT 0,
        notes      TEXT,
        cached_at  TEXT NOT NULL
      );

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

  // ── v2: Calendar cache — Unix ms timestamps ────────────────────────────────
  2: (db) => {
    db.execSync(`
      DROP TABLE IF EXISTS calendar_cache;

      CREATE TABLE calendar_cache (
        id        TEXT PRIMARY KEY,
        title     TEXT NOT NULL,
        start_ms  INTEGER NOT NULL,
        end_ms    INTEGER NOT NULL,
        all_day   INTEGER DEFAULT 0,
        notes     TEXT,
        cached_at TEXT NOT NULL
      );
    `);
  },

  // ── v3: Entity graph, importance scoring, temporal awareness ───────────────
  // Locked design from Session L. Three LLM reviews converged on this schema.
  // Tables are created empty — wiring to write paths comes in Session M/W.
  // Adding now so the structure is ready and migration doesn't run mid-session.
  3: (db) => {
    db.execSync(`

      -- ── Field additions to facts ──────────────────────────────────────────
      -- SQLite ALTER TABLE only supports ADD COLUMN — safe to run on existing table.
      -- entity_id: links fact to its entity in the graph
      -- importance_score: 0-100, drives surfacing priority
      -- valid_until: NULL = permanent. ISO date = expires (used for temporary facts
      --   like "picking someone up at 4:30 today")
      -- context_type: 'active' = current/ongoing. 'historical' = past event.
      --   Fixes stale context in memory synthesis ("airport pickup from 3 days ago").

      -- ALTER TABLE ADD COLUMN does not support IF NOT EXISTS in SQLite.
      -- Wrap each in its own execSync so a duplicate-column error on reinstall
      -- does not abort the entire migration. Each column is idempotent this way.
      `);
      // Add V3 columns to facts — safe on reinstall
      for (const col of [
        "ALTER TABLE facts ADD COLUMN entity_id       TEXT",
        "ALTER TABLE facts ADD COLUMN importance_score INTEGER DEFAULT 50",
        "ALTER TABLE facts ADD COLUMN valid_until      TEXT",
        "ALTER TABLE facts ADD COLUMN context_type     TEXT DEFAULT 'historical'",
      ]) {
        try { db.execSync(col + ";"); } catch { /* column already exists — safe */ }
      }
      db.execSync(`

      -- Indexes on facts — queried on every memory probe and Tier 1 response.
      -- No index = full table scan on every message. Costs nothing to add now.
      CREATE INDEX IF NOT EXISTS idx_facts_category
        ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_importance
        ON facts(importance_score DESC);
      CREATE INDEX IF NOT EXISTS idx_facts_context_type
        ON facts(context_type);

      -- ── Entities ──────────────────────────────────────────────────────────
      -- Unified objects Herald knows about. Everything links here.
      -- type values: person | condition | medication | account | place | event
      CREATE TABLE IF NOT EXISTS entities (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        notes       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- ── Entity relationships ───────────────────────────────────────────────
      -- Knowledge graph edges. "David is father_in_law of Mike."
      -- relation examples: father_in_law | spouse | child | prescribed_by |
      --                    located_at | employer | friend | caregiver
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id           TEXT PRIMARY KEY,
        from_entity  TEXT NOT NULL,
        relation     TEXT NOT NULL,
        to_entity    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        FOREIGN KEY (from_entity) REFERENCES entities(id),
        FOREIGN KEY (to_entity)   REFERENCES entities(id)
      );

      -- ── Life events ────────────────────────────────────────────────────────
      -- Historical anchors. Not calendar events — milestones.
      -- Examples: retirement, surgery, move, birth, graduation, marriage.
      CREATE TABLE IF NOT EXISTS life_events (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        event_date  TEXT,
        category    TEXT,
        notes       TEXT,
        entity_id   TEXT,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      -- ── Financial accounts ─────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS financial_accounts (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        type         TEXT,
        institution  TEXT,
        last_four    TEXT,
        notes        TEXT,
        created_at   TEXT NOT NULL
      );

      -- ── Financial obligations ──────────────────────────────────────────────
      -- Bills, subscriptions, recurring payments.
      CREATE TABLE IF NOT EXISTS financial_obligations (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        amount       REAL,
        due_day      INTEGER,
        auto_pay     INTEGER DEFAULT 0,
        account_id   TEXT,
        notes        TEXT,
        created_at   TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES financial_accounts(id)
      );

      -- ── People ────────────────────────────────────────────────────────────
      -- Rich contacts beyond medical_contacts.
      -- importance: 1-10. last_contact: ISO date.
      CREATE TABLE IF NOT EXISTS people (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        relationship  TEXT,
        birthday      TEXT,
        importance    INTEGER DEFAULT 5,
        last_contact  TEXT,
        notes         TEXT,
        entity_id     TEXT,
        created_at    TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      -- ── Behavior patterns ─────────────────────────────────────────────────
      -- AI-observed patterns. Never user-entered.
      -- Examples: "Calls daughter Sunday mornings."
      --           "Checks markets at 8am before anything else."
      -- confidence: 0.0-1.0. Increases with repeated observation.
      CREATE TABLE IF NOT EXISTS behavior_patterns (
        id          TEXT PRIMARY KEY,
        pattern     TEXT NOT NULL,
        domain      TEXT,
        confidence  REAL DEFAULT 0.5,
        observed_at TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- ── Observations ──────────────────────────────────────────────────────
      -- Pre-fact staging. Herald noticed something but confidence is too low
      -- to commit to facts table yet. Promoted to facts after confirmation
      -- or repeated observation.
      CREATE TABLE IF NOT EXISTS observations (
        id          TEXT PRIMARY KEY,
        observation TEXT NOT NULL,
        category    TEXT,
        confidence  REAL DEFAULT 0.4,
        source_msg  TEXT,
        created_at  TEXT NOT NULL
      );

      -- ── Memory importance ──────────────────────────────────────────────────
      -- Domain-level importance weights. Used by getTopFacts() to rank.
      -- health=100, medication=95, financial=70, work=60, preference=20.
      -- Seeded with defaults — can be tuned per user over time.
      CREATE TABLE IF NOT EXISTS memory_importance (
        domain      TEXT PRIMARY KEY,
        score       INTEGER NOT NULL,
        updated_at  TEXT NOT NULL
      );

      -- Seed default importance scores
      INSERT OR IGNORE INTO memory_importance (domain, score, updated_at) VALUES
        ('medical',     100, datetime('now')),
        ('medication',   95, datetime('now')),
        ('financial',    70, datetime('now')),
        ('work',         60, datetime('now')),
        ('family',       85, datetime('now')),
        ('relationships',75, datetime('now')),
        ('schedule',     65, datetime('now')),
        ('location',     50, datetime('now')),
        ('travel',       45, datetime('now')),
        ('sports',       30, datetime('now')),
        ('food',         20, datetime('now')),
        ('general',      10, datetime('now'));

      -- ── Medication log ────────────────────────────────────────────────────
      -- Adherence tracking. One row per dose.
      -- status: taken | skipped | delayed
      CREATE TABLE IF NOT EXISTS medication_log (
        id            TEXT PRIMARY KEY,
        medication_id TEXT NOT NULL,
        scheduled_at  TEXT NOT NULL,
        taken_at      TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        notes         TEXT,
        FOREIGN KEY (medication_id) REFERENCES medications(id)
      );

      -- ── Pending writes (offline queue) ────────────────────────────────────
      -- When Herald is offline, calendar writes and SMS intents are queued here
      -- and executed when connectivity is restored.
      -- type: calendar | sms | reminder
      -- payload: JSON string of the intent data
      -- status: pending | executing | done | failed
      CREATE TABLE IF NOT EXISTS pending_writes (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT NOT NULL,
        executed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_writes_status
        ON pending_writes(status);

      -- ── Contacts ──────────────────────────────────────────────────────────
      -- Herald's own lightweight contact layer — links to facts by entity_id.
      -- Not a replacement for OS contacts — a memory layer ON TOP of them.
      -- Critical for 65+ use case: "text my daughter", "call my doctor."
      -- relationship: daughter | son | spouse | doctor | friend | caregiver etc.
      -- importance: 1-10. Herald surfaces high-importance contacts proactively.
      -- os_contact_id: links to device contact if matched (optional).
      CREATE TABLE IF NOT EXISTS contacts (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        relationship   TEXT,
        phone          TEXT,
        email          TEXT,
        birthday       TEXT,
        importance     INTEGER DEFAULT 5,
        entity_id      TEXT,
        os_contact_id  TEXT,
        notes          TEXT,
        last_contact   TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_relationship
        ON contacts(relationship);
      CREATE INDEX IF NOT EXISTS idx_contacts_importance
        ON contacts(importance DESC);

    `);
  },

  // ── v4: Reminders table ────────────────────────────────────────────────────
  4: (db) => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS reminders (
        id          TEXT PRIMARY KEY,
        body        TEXT NOT NULL,
        remind_at   TEXT NOT NULL,
        fired       INTEGER DEFAULT 0,
        created_at  TEXT NOT NULL
      );
    `);
  },

  // ── v5: Notes, lists, list_items ──────────────────────────────────────────
  5: (db) => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lists (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS list_items (
        id         TEXT PRIMARY KEY,
        list_id    TEXT NOT NULL,
        body       TEXT NOT NULL,
        checked    INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (list_id) REFERENCES lists(id)
      );
    `);
  },

  // ── v6: tables that previously lived only in herald_local.db / herald_sessions.db ──
  6: (db) => {
    db.execSync(`
      CREATE TABLE IF NOT EXISTS local_preferences (
        category TEXT NOT NULL,
        value    TEXT NOT NULL,
        count    INTEGER DEFAULT 1,
        PRIMARY KEY (category, value)
      );
      CREATE TABLE IF NOT EXISTS session_summaries (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        summary    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_clarifications (
        id         TEXT PRIMARY KEY,
        record_id  TEXT NOT NULL,
        slot       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
};