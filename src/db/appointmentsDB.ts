// src/db/appointmentsDB.ts
// Herald device SQLite — appointments table read/write.
// Canonical domain record (Spine §4a) for scheduling memory.
// One writer: addAppointment(). Two callers feed it — useCalendar.ts
// (device_calendar source, daily sync) and handleCalendarAction in
// ChatScreen.tsx (user_told source, spoken intent) — the write path
// itself is singular.

import { getDB } from "./schema";

export interface AppointmentInput {
  title: string;
  category?: string;
  apptDateISO: string;
  apptDatePrecision?: "exact" | "date_only" | "fuzzy";
  endDateISO?: string;
  location?: string;
  notes?: string;
  source: "device_calendar" | "user_told";
  externalId?: string;
  rawPhrase?: string;
}

export interface Appointment {
  id: string;
  title: string;
  category: string | null;
  appt_date: string;
  appt_date_precision: string;
  end_date: string | null;
  location: string | null;
  notes: string | null;
  source: string;
  external_id: string | null;
  raw_phrase: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

// ─── add ──────────────────────────────────────────────────────────────────
// device_calendar rows upsert on external_id (preserves created_at across
// daily resyncs — exact-match dedupe per §4a, never a silent merge).
// user_told rows always insert fresh (no external_id to dedupe against).

export function addAppointment(input: AppointmentInput): string {
  const db = getDB();
  const now = new Date().toISOString();

  if (input.source === "device_calendar" && input.externalId) {
    const existing = db.getFirstSync<{ id: string }>(
      `SELECT id FROM appointments
       WHERE external_id = ? AND removed_at IS NULL;`,
      [input.externalId]
    );
    if (existing) {
      db.runSync(
        `UPDATE appointments SET
           title = ?, category = ?, appt_date = ?, appt_date_precision = ?,
           end_date = ?, location = ?, notes = ?, updated_at = ?
         WHERE id = ?;`,
        [
          input.title, input.category ?? null, input.apptDateISO,
          input.apptDatePrecision ?? "exact", input.endDateISO ?? null,
          input.location ?? null, input.notes ?? null, now, existing.id,
        ]
      );
      return existing.id;
    }
  }

  const id = `appt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.runSync(
    `INSERT INTO appointments
       (id, title, category, appt_date, appt_date_precision, end_date,
        location, notes, source, external_id, raw_phrase, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?);`,
    [
      id, input.title, input.category ?? null, input.apptDateISO,
      input.apptDatePrecision ?? "exact", input.endDateISO ?? null,
      input.location ?? null, input.notes ?? null, input.source,
      input.externalId ?? null, input.rawPhrase ?? null, now, now,
    ]
  );
  return id;
}

// ─── read ─────────────────────────────────────────────────────────────────
// One deterministic read authority. windowStartISO/windowEndISO are
// UTC ISO strings — caller resolves "today"/"this week" to a range.

export function getAppointments(
  windowStartISO: string,
  windowEndISO: string
): Appointment[] {
  const db = getDB();
  return db.getAllSync<Appointment>(
    `SELECT * FROM appointments
     WHERE removed_at IS NULL
       AND status = 'upcoming'
       AND appt_date >= ? AND appt_date <= ?
     ORDER BY appt_date ASC;`,
    [windowStartISO, windowEndISO]
  );
}

// ─── remove ───────────────────────────────────────────────────────────────

export function removeAppointment(id: string): void {
  const db = getDB();
  db.runSync(
    "UPDATE appointments SET removed_at = ? WHERE id = ?;",
    [new Date().toISOString(), id]
  );
}

// ─── clear ────────────────────────────────────────────────────────────────

export function clearAppointments(): void {
  const db = getDB();
  db.runSync(
    "UPDATE appointments SET removed_at = ? WHERE removed_at IS NULL;",
    [new Date().toISOString()]
  );
}
