-- Herald Database Schema v1.0
-- SQLite on Railway. One file per deployment.
-- Designed to scale to multi-user when Phase 5 adds Stripe billing.
-- Run this on fresh Railway instance.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Users ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
    user_id     TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    persona     TEXT NOT NULL DEFAULT 'beach',
    is_owner    INTEGER NOT NULL DEFAULT 0,   -- 1 = miked
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT
);

-- ─── Messages (chat history) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- ─── Memories (LLM-extracted episodic facts) ──────────────────────────────

CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    session_id  TEXT,                          -- kept for audit, not queried
    content     TEXT NOT NULL,
    source      TEXT DEFAULT 'conversation',   -- 'conversation' | 'onboarding' | 'freddie'
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, created_at);

-- ─── Proactive queue ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proactive_queue (
    id          TEXT PRIMARY KEY,              -- uuid
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    type        TEXT NOT NULL,                 -- 'freddie'|'weather'|'sports'|'health'|'reminder'|'news'
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    metadata    TEXT,                          -- JSON blob
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    read_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_proactive_user ON proactive_queue(user_id, read, created_at);

-- ─── Freddie trades (synced nightly from VM) ─────────────────────────────

CREATE TABLE IF NOT EXISTS freddie_trades (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    asset       TEXT NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    entry       REAL,
    exit        REAL,
    pnl         REAL,
    grade       TEXT CHECK (grade IN ('A', 'B')),
    score       INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
    opened_at   TEXT NOT NULL,
    closed_at   TEXT,
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trades_user ON freddie_trades(user_id, opened_at);

-- ─── Watcher agents ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    type        TEXT NOT NULL,                 -- 'sports'|'price'|'news'|'health'|'weather'|'travel'
    topic       TEXT NOT NULL,
    config      TEXT,                          -- JSON (team, ticker, etc)
    active      INTEGER NOT NULL DEFAULT 1,
    touches     INTEGER NOT NULL DEFAULT 0,    -- for promotion threshold
    promoted    INTEGER NOT NULL DEFAULT 0,    -- 1 = full watcher built
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_run    TEXT
);

CREATE INDEX IF NOT EXISTS idx_watchers_user ON watchers(user_id, active);

-- ─── Briefing log (audit) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS briefing_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    briefing    TEXT NOT NULL,
    sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
    channel     TEXT DEFAULT 'email'           -- 'email' | 'push' | 'in_app'
);

-- ─── Session tracking ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(user_id),
    platform    TEXT,                          -- 'ios'|'android'|'web'|'desktop'
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
);
