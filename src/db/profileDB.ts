// src/db/profileDB.ts
// Herald device SQLite — local_profile table read/write.
// Session L — Device-First Intelligence Layer
//
// Stores core identity fields accessed on every greeting and throughout sessions.
// This is the single source of truth for name, location, persona, and ai_name
// once Session L is live. Railway retains a copy for backup only.
//
// Standard keys:
//   name                — user's name ("Mike")
//   ai_name             — companion name ("Herald", "Obi", "Maya")
//   city                — confirmed city label ("The Colony, TX")
//   lat                 — last confirmed latitude
//   lng                 — last confirmed longitude
//   timezone            — device timezone string
//   persona             — active persona key ("beach", "city", etc.)
//   onboarding_complete — "true" once onboarding is done
//   schema_version      — current SCHEMA_VERSION at time of last migration

import { getDB } from "./schema";

// ─── setProfileField ──────────────────────────────────────────────────────────
//
// Upsert a single profile field. All values stored as text.

export function setProfileField(key: string, value: string): void {
  const db = getDB();
  db.runSync(
    `INSERT INTO local_profile (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    [key, value, new Date().toISOString()]
  );
}

// ─── getProfileField ──────────────────────────────────────────────────────────
//
// Returns a single profile field value, or null if not set.

export function getProfileField(key: string): string | null {
  const db = getDB();
  const row = db.getFirstSync<{ value: string }>(
    "SELECT value FROM local_profile WHERE key = ?;",
    [key]
  );
  return row?.value ?? null;
}

// ─── getProfile ───────────────────────────────────────────────────────────────
//
// Returns all profile fields as a key-value object.

export function getProfile(): Record<string, string> {
  const db = getDB();
  const rows = db.getAllSync<{ key: string; value: string }>(
    "SELECT key, value FROM local_profile;"
  );
  const profile: Record<string, string> = {};
  for (const row of rows) {
    profile[row.key] = row.value;
  }
  return profile;
}

// ─── setProfileFields ─────────────────────────────────────────────────────────
//
// Batch upsert — used by migration.ts to import Railway profile in one pass.

export function setProfileFields(fields: Record<string, string>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== "") {
      setProfileField(key, String(value));
    }
  }
}

// ─── getProfileSummary ────────────────────────────────────────────────────────
//
// Returns a natural-language summary of the profile for use in responses.
// Example: "Your name is Mike. You're in The Colony, TX. Your companion is Herald."

export function getProfileSummary(): string {
  const p = getProfile();
  const parts: string[] = [];
  if (p.name) parts.push(`Your name is ${p.name}.`);
  if (p.city) parts.push(`You're in ${p.city}.`);
  if (p.ai_name) parts.push(`Your companion is ${p.ai_name}.`);
  return parts.join(" ");
}

// ─── isOnboardingComplete ─────────────────────────────────────────────────────

export function isOnboardingComplete(): boolean {
  return getProfileField("onboarding_complete") === "true";
}

// ─── clearProfileField ────────────────────────────────────────────────────────
//
// Removes a single field. Used for correcting bad geocode data etc.

export function clearProfileField(key: string): void {
  const db = getDB();
  db.runSync("DELETE FROM local_profile WHERE key = ?;", [key]);
}