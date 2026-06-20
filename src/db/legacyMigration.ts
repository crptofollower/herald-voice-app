// src/db/legacyMigration.ts
import * as SQLite from "expo-sqlite";
import { getDB } from "./schema";
import { setProfileField, getProfileField } from "./profileDB";
import { writeMedicalRecord } from "./medicalDB";
import { writeFact } from "./factDB";

const FLAG = "legacy_import_done";

export async function importLegacyDatabases(): Promise<void> {
  // run-once guard, stored in the canonical DB
  if (getProfileField(FLAG) === "true") return;

  const db = getDB();

  // ── herald_local.db ───────────────────────────────────────────────
  try {
    const local = SQLite.openDatabaseSync("herald_local.db");
    try {
      // profile — newer-wins: only fill keys the canonical DB doesn't have
      for (const r of local.getAllSync<{ key: string; value: string }>(
        "SELECT key, value FROM local_profile"
      )) {
        if (!getProfileField(r.key)) setProfileField(r.key, r.value);
      }
    } catch {}

    try {
      for (const m of local.getAllSync<{ type: string; summary: string; detail: string; date: string }>(
        "SELECT type, summary, detail, date FROM local_medical WHERE active = 1"
      )) {
        // Legacy entries import VERBATIM as medical records — never as structured
        // medications. The legacy store has no clean drug-name field; manufacturing
        // one would assert a structured value Herald never captured (Spine §3).
        // The meds table has exactly one writer: confirmMedicationCapture.
        // A later confirm-sweep can offer to structure these from the user's own words.
        writeMedicalRecord({
          notes: [m.summary, m.detail].filter(Boolean).join(" — "),
          visit_date: m.date || undefined,
        });
      }
    } catch {}

    try {
      for (const mem of local.getAllSync<{ summary: string; category: string; weight: number }>(
        "SELECT summary, category, weight FROM local_memories WHERE active = 1"
      )) {
        writeFact(mem.summary, mem.category, { importanceScore: Math.min(100, (mem.weight ?? 1) * 10) });
      }
    } catch {}

    try {
      for (const p of local.getAllSync<{ category: string; value: string; count: number }>(
        "SELECT category, value, count FROM local_preferences"
      )) {
        db.runSync(
          `INSERT INTO local_preferences (category, value, count) VALUES (?, ?, ?)
           ON CONFLICT(category, value) DO UPDATE SET count = count + excluded.count`,
          [p.category, p.value, p.count ?? 1]
        );
      }
    } catch {}

    local.closeSync();
    SQLite.deleteDatabaseSync("herald_local.db"); // only after copy succeeded
  } catch {
    // legacy file absent (fresh install) — nothing to do
  }

  // ── herald_sessions.db ────────────────────────────────────────────
  try {
    const sess = SQLite.openDatabaseSync("herald_sessions.db");
    try {
      for (const s of sess.getAllSync<{ summary: string; created_at: number }>(
        "SELECT summary, created_at FROM session_summaries"
      )) {
        db.runSync("INSERT INTO session_summaries (summary, created_at) VALUES (?, ?)", [s.summary, s.created_at]);
      }
    } catch {}
    sess.closeSync();
    SQLite.deleteDatabaseSync("herald_sessions.db");
  } catch {}

  setProfileField(FLAG, "true");
}
