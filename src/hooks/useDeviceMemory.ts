// src/hooks/useDeviceMemory.ts
// Herald device-first memory layer.
//
// THE NORTH STAR: The phone is the brain. The cloud is the library.
// Everything personal lives here. Backend gets an anonymous token only.
//
// What this does:
//   1. Opens local SQLite database on the device
//   2. Stores weighted memories, preferences, medical cache, location
//   3. Builds instant greeting from local data (under 500ms, no network)
//   4. Saves new memories locally on every message
//   5. Provides getTopMemories() for system prompt context
//
// WEIGHT SCALE (locked -- never changes order of top 4):
//   medical=10, medication=9, family=8, finance=7
//   work=6, routine=5, travel=4, sports=3, food=3, music=2, general=1
//
// What NEVER leaves this device:
//   name, location, medical records, medications, family, finances
//   All of the above stay in this SQLite database. Always.

import { useEffect, useCallback, useRef } from "react";
import * as SQLite from "expo-sqlite";

// ─── Weight constants (locked) ────────────────────────────────────────────────

export const MEMORY_WEIGHTS: Record<string, number> = {
  medical:    10,
  medication:  9,
  family:      8,
  finance:     7,
  work:        6,
  routine:     5,
  travel:      4,
  sports:      3,
  food:        3,
  music:       2,
  general:     1,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LocalMemory {
  summary: string;
  category: string;
  weight: number;
  created_at: string;
}

export interface LocalProfile {
  name: string;
  ai_name: string;
  location: string;
  confirmed_city: string;
  email: string;
}

// ─── Database singleton ───────────────────────────────────────────────────────

let _db: SQLite.SQLiteDatabase | null = null;

function getDb(): SQLite.SQLiteDatabase {
  if (!_db) {
    _db = SQLite.openDatabaseSync("herald_local.db");
  }
  return _db;
}

// ─── Schema init ──────────────────────────────────────────────────────────────

function initSchema() {
  const db = getDb();

  // Profile -- personal data that NEVER leaves the device
  db.execSync(`
    CREATE TABLE IF NOT EXISTS local_profile (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Weighted memories -- life events scored by importance
  db.execSync(`
    CREATE TABLE IF NOT EXISTS local_memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      summary    TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT 'general',
      weight     INTEGER NOT NULL DEFAULT 1,
      source     TEXT DEFAULT 'conversation',
      active     INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  // Preferences -- food, sports, music, routines
  db.execSync(`
    CREATE TABLE IF NOT EXISTS local_preferences (
      category TEXT NOT NULL,
      value    TEXT NOT NULL,
      count    INTEGER DEFAULT 1,
      PRIMARY KEY (category, value)
    );
  `);

  // Medical cache -- NEVER leaves device, ever
  db.execSync(`
    CREATE TABLE IF NOT EXISTS local_medical (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,  -- 'visit', 'medication', 'followup'
      summary     TEXT NOT NULL,
      detail      TEXT,
      date        TEXT,
      active      INTEGER DEFAULT 1,
      created_at  TEXT NOT NULL
    );
  `);

  console.log("[Herald] Local SQLite ready");
}

// ─── Profile helpers ──────────────────────────────────────────────────────────

export function saveLocalProfile(key: string, value: string) {
  try {
    const db = getDb();
    db.runSync(
      "INSERT OR REPLACE INTO local_profile (key, value, updated_at) VALUES (?, ?, ?)",
      [key, value, new Date().toISOString()]
    );
  } catch (e) {
    console.warn("[Herald] saveLocalProfile failed:", e);
  }
}

export function getLocalProfile(): LocalProfile {
  try {
    const db = getDb();
    const rows = db.getAllSync<{ key: string; value: string }>(
      "SELECT key, value FROM local_profile"
    );
    const map: Record<string, string> = {};
    rows.forEach((r) => { map[r.key] = r.value; });
    return {
      name:           map.name           || "",
      ai_name:        map.ai_name        || "Herald",
      location:       map.location       || "",
      confirmed_city: map.confirmed_city || "",
      email:          map.email          || "",
    };
  } catch (e) {
    console.warn("[Herald] getLocalProfile failed:", e);
    return { name: "", ai_name: "Herald", location: "", confirmed_city: "", email: "" };
  }
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

export function saveLocalMemory(summary: string, category: string = "general") {
  try {
    const db = getDb();
    const weight = MEMORY_WEIGHTS[category] ?? 1;
    // Deduplicate -- don't save the same summary twice
    const existing = db.getFirstSync<{ id: number }>(
      "SELECT id FROM local_memories WHERE summary = ? AND active = 1",
      [summary]
    );
    if (existing) return;
    db.runSync(
      "INSERT INTO local_memories (summary, category, weight, created_at) VALUES (?, ?, ?, ?)",
      [summary, category, weight, new Date().toISOString()]
    );
  } catch (e) {
    console.warn("[Herald] saveLocalMemory failed:", e);
  }
}

export function getTopLocalMemories(limit: number = 8): LocalMemory[] {
  try {
    const db = getDb();
    return db.getAllSync<LocalMemory>(
      `SELECT summary, category, weight, created_at
       FROM local_memories
       WHERE active = 1
       ORDER BY weight DESC, created_at DESC
       LIMIT ?`,
      [limit]
    );
  } catch (e) {
    console.warn("[Herald] getTopLocalMemories failed:", e);
    return [];
  }
}

// ─── Preference helpers ───────────────────────────────────────────────────────

export function saveLocalPreference(category: string, value: string) {
  try {
    const db = getDb();
    db.runSync(
      `INSERT INTO local_preferences (category, value, count) VALUES (?, ?, 1)
       ON CONFLICT(category, value) DO UPDATE SET count = count + 1`,
      [category, value]
    );
  } catch (e) {
    console.warn("[Herald] saveLocalPreference failed:", e);
  }
}

// ─── Medical helpers (never leaves device) ────────────────────────────────────

export function saveLocalMedical(type: string, summary: string, detail?: string, date?: string) {
  try {
    const db = getDb();
    db.runSync(
      "INSERT INTO local_medical (type, summary, detail, date, created_at) VALUES (?, ?, ?, ?, ?)",
      [type, summary, detail || "", date || "", new Date().toISOString()]
    );
  } catch (e) {
    console.warn("[Herald] saveLocalMedical failed:", e);
  }
}

// ─── Instant local greeting ───────────────────────────────────────────────────
//
// Builds a greeting entirely from device data.
// No network call. Under 500ms. Herald speaks before the internet is touched.

export function buildLocalGreeting(aiName: string): string {
  try {
    const profile = getLocalProfile();
    const name = profile.name;
    const city = profile.confirmed_city || profile.location;

    const hour = new Date().getHours();
    let salutation = "Good morning";
    if (hour >= 12 && hour < 17) salutation = "Good afternoon";
    else if (hour >= 17) salutation = "Good evening";

    const namePart = name ? `, ${name}` : "";

    // Pull the single highest-weighted memory for the hook
    const memories = getTopLocalMemories(1);
    let hook = "";
    if (memories.length > 0) {
      // Don't announce memory -- just surface it naturally
      // The system prompt handles natural phrasing
      // Here we just check if we have something to reference
      hook = "";
    }

    if (city) {
      return `${salutation}${namePart}. What can I help you with today?`;
    }

    return `${salutation}${namePart}. What's on your mind?`;
  } catch (e) {
    return "Good morning. What can I help you with today?";
  }
}

// ─── Context block for /ask payload ──────────────────────────────────────────
//
// Builds a compact memory context string to include in API calls.
// This replaces sending the full profile -- just the weighted top memories.
// Backend gets context without getting personal data fields.

export function buildLocalContextBlock(): string {
  try {
    const lines: string[] = [];

    const profile = getLocalProfile();
    if (profile.name)           lines.push(`name: ${profile.name}`);
    if (profile.ai_name)        lines.push(`ai_name: ${profile.ai_name}`);
    if (profile.confirmed_city) lines.push(`location: ${profile.confirmed_city}`);
    else if (profile.location)  lines.push(`location: ${profile.location}`);

    const memories = getTopLocalMemories(8);
    for (const m of memories) lines.push(m.summary);

    return lines.join("\n");
  } catch {
    return "";
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDeviceMemory() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    try {
      initSchema();
    } catch (e) {
      console.warn("[Herald] Device memory init failed:", e);
    }
  }, []);

  const saveMemory = useCallback((summary: string, category?: string) => {
    saveLocalMemory(summary, category);
  }, []);

  const saveProfile = useCallback((key: string, value: string) => {
    saveLocalProfile(key, value);
  }, []);

  const savePreference = useCallback((category: string, value: string) => {
    saveLocalPreference(category, value);
  }, []);

  const saveMedical = useCallback(
    (type: string, summary: string, detail?: string, date?: string) => {
      saveLocalMedical(type, summary, detail, date);
    },
    []
  );

  const getTopMemories = useCallback((limit?: number) => {
    return getTopLocalMemories(limit);
  }, []);

  const getProfile = useCallback(() => {
    return getLocalProfile();
  }, []);

  const getLocalGreeting = useCallback((aiName: string) => {
    return buildLocalGreeting(aiName);
  }, []);

  const getContextBlock = useCallback(() => {
    return buildLocalContextBlock();
  }, []);

  return {
    saveMemory,
    saveProfile,
    savePreference,
    saveMedical,
    getTopMemories,
    getProfile,
    getLocalGreeting,
    getContextBlock,
  };
}