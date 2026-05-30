// src/routing/migration.ts
// Herald — one-time Railway to device SQLite migration.
// Session L — Device-First Intelligence Layer
//
// Runs once on first launch after Session L is installed.
// Pulls all personal data from Railway via /user/export/:id and writes
// it to device SQLite tables. After migration, device is source of truth.
// Railway retains a copy for backup only.
//
// Migration is idempotent — safe to call on every app open. The
// 'migration_complete' profile field gates whether it actually runs.
//
// What migrates:
//   profile fields     → local_profile table
//   medical_records    → medical_records table
//   medications        → medications table
//   medical_contacts   → medical_contacts table
//   life_moments       → facts table (one-time classification pass)
//
// What does NOT migrate (stays Railway-only):
//   billing state, waitlist, invite records — non-personal

import { API_BASE } from "../constants/api";
import { getDB } from "../db/schema";
import { setProfileFields, setProfileField, getProfileField } from "../db/profileDB";
import {
  importMedicalRecords,
  importMedications,
  importMedicalContacts,
} from "../db/medicalDB";
import { writeFact } from "../db/factDB";

// ─── Types matching Railway /user/export response ─────────────────────────────

interface RailwayExport {
  profile?: Record<string, unknown>;
  medical_records?: unknown[];
  medications?: unknown[];
  medical_contacts?: unknown[];
  life_moments?: Array<{ role: string; content: string }>;
  life_tracker?: unknown[];
}

// ─── runMigration ─────────────────────────────────────────────────────────────
//
// Main entry point. Call from App.tsx after initDB() resolves.
// No-ops immediately if migration already complete.
// Silent failure — if Railway is unreachable, retries on next app open.

export async function runMigration(userId: string): Promise<void> {
  // Gate: only run once
  if (getProfileField("migration_complete") === "true") return;
  if (!userId) return;

  try {
    const response = await fetch(
      `${API_BASE}/user/export/${userId}?access_code=herald2026`,
      { method: "GET" }
    );

    if (!response.ok) return; // Silent — retry next open

    const data: RailwayExport = await response.json();

    const db = getDB();
    db.execSync("BEGIN IMMEDIATE;");
    try {
      // ── Profile fields ──────────────────────────────────────────────────────
      if (data.profile && typeof data.profile === "object") {
        const profileFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(data.profile)) {
          if (v != null && v !== "") {
            profileFields[k] = String(v);
          }
        }
        setProfileFields(profileFields);
      }

      // ── Medical records ─────────────────────────────────────────────────────
      if (Array.isArray(data.medical_records) && data.medical_records.length > 0) {
        importMedicalRecords(data.medical_records as any);
      }

      // ── Medications ─────────────────────────────────────────────────────────
      if (Array.isArray(data.medications) && data.medications.length > 0) {
        importMedications(data.medications as any);
      }

      // ── Medical contacts ────────────────────────────────────────────────────
      if (Array.isArray(data.medical_contacts) && data.medical_contacts.length > 0) {
        importMedicalContacts(data.medical_contacts as any);
      }

      // ── Life moments → facts (one-time classification pass) ─────────────────
      // life_moments are raw conversation pairs stored on Railway.
      // We classify each assistant turn into typed facts here.
      // This is the one-time conversion — from Session L forward, facts are
      // written directly to device SQLite as structured data.
      if (Array.isArray(data.life_moments)) {
        for (const moment of data.life_moments) {
          if (moment.role === "assistant" && moment.content) {
            const classified = classifyMoment(moment.content);
            if (classified) {
              writeFact(classified.fact, classified.category, "stated");
            }
          }
        }
      }

      db.execSync("COMMIT;");

      setProfileField("migration_audit", JSON.stringify({
        medical_records_in: data.medical_records?.length ?? 0,
        medications_in: data.medications?.length ?? 0,
        medical_contacts_in: data.medical_contacts?.length ?? 0,
        life_moments_in: data.life_moments?.length ?? 0,
        timestamp: new Date().toISOString(),
      }));
      setProfileField("migration_complete", "true");
      setProfileField("migration_date", new Date().toISOString());
    } catch {
      db.execSync("ROLLBACK;");
      return;
    }

  } catch {
    // Silent failure — leave device state intact, retry next open
    // Do NOT mark migration_complete on failure
  }
}

// ─── classifyMoment ───────────────────────────────────────────────────────────
//
// Classifies a raw life_moment assistant turn into a typed fact.
// Intentionally conservative — only extracts high-confidence facts.
// Returns null for noise (greetings, filler, weather responses etc.)

function classifyMoment(
  content: string
): { fact: string; category: string } | null {
  const text = content.trim();
  if (!text || text.length < 15) return null;

  // Skip obvious non-facts
  if (/^(good morning|good evening|good afternoon|hello|hi there)/i.test(text)) return null;
  if (/^(sure|of course|absolutely|got it|understood|happy to)/i.test(text)) return null;
  if (/degrees|forecast|weather|temperature/i.test(text)) return null;

  // Medical — high confidence signals
  if (/Dr\.?\s+\w+|prescribed|medication|diagnosis|appointment/i.test(text)) {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (first && first.length <= 120) {
      return { fact: first, category: "medical" };
    }
  }

  // Relationships
  if (/\b(wife|husband|son|daughter|mom|dad|father|mother|brother|sister|friend)\b/i.test(text)) {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (first && first.length <= 120) {
      return { fact: first, category: "relationships" };
    }
  }

  // Location
  if (/\b(live in|located in|based in|moved to|from)\b/i.test(text)) {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (first && first.length <= 120) {
      return { fact: first, category: "location" };
    }
  }

  // Professional
  if (/\b(work at|works at|job|career|company|employer|role|position)\b/i.test(text)) {
    const first = text.split(/[.!?]/)[0]?.trim();
    if (first && first.length <= 120) {
      return { fact: first, category: "professional" };
    }
  }

  return null;
}

// ─── isMigrationComplete ──────────────────────────────────────────────────────
//
// Synchronous check — use in components that need to know migration status.

export function isMigrationComplete(): boolean {
  return getProfileField("migration_complete") === "true";
}