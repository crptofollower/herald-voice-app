// src/db/legacyMigration.ts
import * as SQLite from "expo-sqlite";
import { getDB } from "./schema";
import { setProfileField, getProfileField } from "./profileDB";
import { writeMedication, writeMedicalRecord } from "./medicalDB";
import { writeFact } from "./factDB";

const FLAG = "legacy_import_done";

function parseDrugName(s: string): string {
  const m = s.match(/(?:take|taking|on|prescribed|using)\s+([A-Za-z][\w-]*)/i);
  return (m?.[1] ?? s.split(/[\s,:]/).filter(Boolean)[0] ?? s).replace(/[.,;:!?]+$/, "");
}

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
        if (m.type === "medication") {
          writeMedication({ name: parseDrugName(m.summary), notes: m.detail || m.summary, is_active: 1 });
        } else {
          writeMedicalRecord({
            notes: [m.summary, m.detail].filter(Boolean).join(" — "),
            visit_date: m.date || undefined,
          });
        }
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
