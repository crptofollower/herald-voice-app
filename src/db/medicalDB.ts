// src/db/medicalDB.ts
// Herald device SQLite — medical tables read/write.
// Session L — Device-First Intelligence Layer
//
// Three tables: medical_records, medications, medical_contacts.
// Device SQLite is the runtime source of truth for Tier 1 medical queries.
// Rows are written from on-device chat (writeMedicalFact, SSE onFacts) and
// may be bootstrapped once from Railway via migration.ts (/user/export).
// Ongoing use does not sync these tables back to the cloud.
//
// This file fixes the Session W gap: medical data was extracted by the
// backend and stored on Railway only. From Session L forward, medical
// facts flow: Railway extraction → SSE done payload → this file.

import { getDB } from "./schema";
import { extractDrugName, extractDosage } from "../utils/detectMedicalEvent";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MedicalRecord {
  id: string;
  visit_date?: string;
  doctor_name?: string;
  facility?: string;
  reason?: string;
  diagnosis?: string;
  follow_up?: string;
  notes?: string;
  created_at: string;
}

export interface Medication {
  id: string;
  name: string;
  dosage?: string;
  frequency?: string;
  prescribing_doctor?: string;
  start_date?: string;
  end_date?: string;
  is_active: number; // 1 = active, 0 = past
  notes?: string;
  created_at: string;
}

export interface MedicalContact {
  id: string;
  name: string;
  specialty?: string;
  phone?: string;
  address?: string;
  is_primary: number; // 1 = primary, 0 = other
  notes?: string;
  created_at: string;
}

// ─── Medical Records ──────────────────────────────────────────────────────────

export function writeMedicalRecord(
  record: Omit<MedicalRecord, "id" | "created_at">
): string {
  const db = getDB();
  const id = `mr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.runSync(
    `INSERT INTO medical_records
       (id, visit_date, doctor_name, facility, reason, diagnosis, follow_up, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      record.visit_date ?? null,
      record.doctor_name ?? null,
      record.facility ?? null,
      record.reason ?? null,
      record.diagnosis ?? null,
      record.follow_up ?? null,
      record.notes ?? null,
      now,
    ]
  );
  return id;
}

export function getMedicalRecords(): MedicalRecord[] {
  const db = getDB();
  return db.getAllSync<MedicalRecord>(
    "SELECT * FROM medical_records ORDER BY visit_date DESC, created_at DESC;"
  );
}

// ─── Medications ──────────────────────────────────────────────────────────────

export function writeMedication(
  med: Omit<Medication, "id" | "created_at">
): string {
  const db = getDB();
  const id = `med_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.runSync(
    `INSERT INTO medications
       (id, name, dosage, frequency, prescribing_doctor, start_date, end_date, is_active, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      med.name,
      med.dosage ?? null,
      med.frequency ?? null,
      med.prescribing_doctor ?? null,
      med.start_date ?? null,
      med.end_date ?? null,
      med.is_active ?? 1,
      med.notes ?? null,
      now,
    ]
  );
  return id;
}

export function getActiveMedications(): Medication[] {
  const db = getDB();
  return db.getAllSync<Medication>(
    "SELECT * FROM medications WHERE is_active = 1 AND removed_at IS NULL ORDER BY created_at DESC;"
  );
}

export function getAllMedications(): Medication[] {
  const db = getDB();
  return db.getAllSync<Medication>(
    "SELECT * FROM medications ORDER BY is_active DESC, created_at DESC;"
  );
}

/**
 * Build A — deactivate (not delete) a medication by name match.
 * For "stop taking X" / "remove X from my meds". Keeps history (is_active=0)
 * so a med you were on for a month still exists as a past medication, but
 * stops showing in "what am I on". Returns how many rows changed.
 */
export function deactivateMedicationByName(name: string): number {
  const db = getDB();
  const now = new Date().toISOString();
  const res = db.runSync(
    `UPDATE medications SET is_active = 0, removed_at = ? WHERE is_active = 1 AND lower(name) LIKE lower(?);`,
    [now, `%${name.trim()}%`]
  );
  return res.changes ?? 0;
}

/**
 * Build A — wipe ALL medications. For "clear my medications / start fresh".
 * Destructive and irreversible, so callers MUST confirm before invoking.
 * Also the cleanup path for corrupted rows. Returns how many rows removed.
 */
export function clearAllMedications(): number {
  const db = getDB();
  const now = new Date().toISOString();
  // Soft-delete: never shred. Marks every active med inactive + stamps removed_at
  // so the audit trail ("when did I clear these?") has its data from day one.
  // Recoverable — rows remain in the table with is_active=0.
  const res = db.runSync(
    `UPDATE medications SET is_active = 0, removed_at = ? WHERE is_active = 1;`,
    [now]
  );
  return res.changes ?? 0;
}

// ─── Medical Contacts ─────────────────────────────────────────────────────────

export function writeMedicalContact(
  contact: Omit<MedicalContact, "id" | "created_at">
): string {
  const db = getDB();
  const id = `mc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  db.runSync(
    `INSERT INTO medical_contacts
       (id, name, specialty, phone, address, is_primary, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      id,
      contact.name,
      contact.specialty ?? null,
      contact.phone ?? null,
      contact.address ?? null,
      contact.is_primary ?? 0,
      contact.notes ?? null,
      now,
    ]
  );
  return id;
}

export function getMedicalContacts(): MedicalContact[] {
  const db = getDB();
  return db.getAllSync<MedicalContact>(
    "SELECT * FROM medical_contacts ORDER BY is_primary DESC, name ASC;"
  );
}

// ─── writeMedicalFact ─────────────────────────────────────────────────────────
//
// Called from ChatScreen onFacts when category is 'medication' or 'medical'.
// Parses the fact string and writes to the appropriate table.
// This is intentionally simple — structured intake (the state machine) handles
// the full multi-turn flow. This catches facts extracted from casual conversation.

/**
 * Build A — extract the best-guess medication name from a casual sentence.
 * Exported so the confirm-gate can SHOW the guess ("save chocolate as a
 * medication?") using the EXACT name that would be written. Pure: no DB,
 * no side effects.
 */
export function guessMedicationName(value: string): string {
  // Delegates to the shared, filler-word-aware extractor (detectMedicalEvent.ts)
  // instead of this file's own separate, unfiltered regex — one extraction
  // algorithm, not two drifting implementations of the same job.
  const extracted = extractDrugName(value);
  if (extracted) return extracted;
  // Preserve the old fallback contract: this function always returns a
  // non-empty-ish string (some callers template-literal it without a null
  // check), even when extraction finds nothing real to skip to.
  return (value.split(/[\s,]/)[0]?.trim() ?? value).replace(/[.,;:!?]+$/, "");
}

// ─── confirmMedicationCapture ──────────────────────────────────────────────────
// The single supersede-aware writer for medications (SPINE §4a one-writer).
// Primary caller: the confirm gate, after the user said yes to a name/dosage
// shown back to them — writes EXACTLY those values, never re-deriving from raw
// text at write time. Also called by writeMedicalFact's SSE fact path (no
// confirm gate there). On an existing active row of the same name it SUPERSEDES
// (retire old, insert new); otherwise it creates.
export function confirmMedicationCapture(
  name: string,
  dosage?: string,
  rawValue?: string
): { id: string; action: 'created' | 'superseded'; previousId?: string } {
  const db = getDB();
  const trimmedName = name.trim();
  const existing = db.getFirstSync<{ id: string }>(
    "SELECT id FROM medications WHERE LOWER(name) = ? AND is_active = 1 LIMIT 1;",
    [trimmedName.toLowerCase()]
  );
  if (existing) {
    const now = new Date().toISOString();
    db.runSync(
      "UPDATE medications SET is_active = 0, removed_at = ? WHERE id = ?;",
      [now, existing.id]
    );
    const newId = writeMedication({
      name: trimmedName,
      dosage,
      notes: rawValue,
      is_active: 1,
    });
    return { id: newId, action: 'superseded', previousId: existing.id };
  }
  const newId = writeMedication({
    name: trimmedName,
    dosage,
    notes: rawValue,
    is_active: 1,
  });
  return { id: newId, action: 'created' };
}

export function writeMedicalFact(
  category: "medication" | "medical" | "visit",
  value: string
): void {
  if (!value?.trim()) return;

  if (category === "medication") {
    // Route through the single supersede-aware writer (SPINE §4a one-writer).
    // Was: dedupe-then-no-op on an existing active row, which silently dropped
    // dose updates arriving on the SSE fact path. Now supersedes like the
    // confirm path. NOTE: this path has no confirm gate, so a casual mention
    // carries its dose when one is present to avoid replacing a richer row.
    const nameGuess = guessMedicationName(value);
    const dosageGuess = extractDosage(value);
    confirmMedicationCapture(nameGuess, dosageGuess, value);
    return;
  }

  if (category === "medical" || category === "visit") {
    // Extract doctor name if present
    const doctorMatch = value.match(/Dr\.?\s+(\w+)/i);
    writeMedicalRecord({
      doctor_name: doctorMatch ? `Dr. ${doctorMatch[1]}` : undefined,
      notes: value,
    });
    return;
  }
}

// ─── getMedicalSummary ────────────────────────────────────────────────────────
//
// Returns a spoken summary of the user's medical context.
// Called by tier1Responses.ts for Tier 1 medical queries.

export function getMedicalSummary(): string {
  const empty = "I don't have any medical information stored yet.";
  try {
    const meds = getActiveMedications();
    const contacts = getMedicalContacts();

    const parts: string[] = [];

    if (meds.length > 0) {
      const medList = meds
        .map((m) => {
          let s = m.name;
          if (m.dosage) s += ` ${m.dosage}`;
          if (m.frequency) s += `, ${m.frequency}`;
          return s;
        })
        .join("; ");
      parts.push(
        meds.length === 1
          ? `You're currently on ${medList}.`
          : `You're currently on ${meds.length} medications: ${medList}.`
      );
    }

    if (contacts.length > 0) {
      const primary = contacts.find((c) => c.is_primary) ?? contacts[0];
      parts.push(`Your primary doctor is ${primary.name}${primary.specialty ? `, ${primary.specialty}` : ""}.`);
    }

    return parts.length > 0 ? parts.join(" ") : empty;
  } catch (err) {
    console.error("[Herald] getMedicalSummary read failed:", err);
    return "I'm having trouble pulling up your medical information right now — let's try that again in a moment.";
  }
}

// ─── Bulk import (used by migration.ts) ──────────────────────────────────────

export function importMedicalRecords(records: MedicalRecord[]): void {
  for (const r of records) {
    try {
      const db = getDB();
      db.runSync(
        `INSERT OR IGNORE INTO medical_records
           (id, visit_date, doctor_name, facility, reason, diagnosis, follow_up, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [r.id, r.visit_date ?? null, r.doctor_name ?? null, r.facility ?? null,
         r.reason ?? null, r.diagnosis ?? null, r.follow_up ?? null,
         r.notes ?? null, r.created_at]
      );
    } catch {}
  }
}

export function importMedications(meds: Medication[]): void {
  for (const m of meds) {
    try {
      const db = getDB();
      db.runSync(
        `INSERT OR IGNORE INTO medications
           (id, name, dosage, frequency, prescribing_doctor, start_date, end_date, is_active, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [m.id, m.name, m.dosage ?? null, m.frequency ?? null,
         m.prescribing_doctor ?? null, m.start_date ?? null, m.end_date ?? null,
         m.is_active ?? 1, m.notes ?? null, m.created_at]
      );
    } catch {}
  }
}

export function importMedicalContacts(contacts: MedicalContact[]): void {
  for (const c of contacts) {
    try {
      const db = getDB();
      db.runSync(
        `INSERT OR IGNORE INTO medical_contacts
           (id, name, specialty, phone, address, is_primary, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [c.id, c.name, c.specialty ?? null, c.phone ?? null,
         c.address ?? null, c.is_primary ?? 0, c.notes ?? null, c.created_at]
      );
    } catch {}
  }
}