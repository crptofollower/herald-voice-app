// src/db/calendarEvidenceIngest.ts
// Calendar Evidence → Doctor Read Composition V1 — production sync seam.
// Domain-neutral persistence of worth-gated device-calendar events.
// Does not classify medical at ingest. Does not write medical_records.

import { addAppointment } from "./appointmentsDB";
import { persistEvidence, type EvidenceRecord } from "./evidenceDB";

const APPOINTMENT_KEYWORDS = [
  "dentist", "dental", "doctor", "dr.", "physician", "clinic", "hospital",
  "appointment", "checkup", "check-up", "physical", "exam", "screening",
  "specialist", "therapy", "therapist", "counseling", "psychiatrist",
  "optometrist", "eye doctor", "vision", "dermatologist", "cardiologist",
  "orthopedic", "surgeon", "surgery", "procedure", "lab", "blood work",
  "mammogram", "colonoscopy", "vaccination", "vaccine", "shot", "flu shot",
  "prescription", "pharmacy", "refill",
  "oil change", "car service", "tire", "mechanic", "auto",
  "ac service", "hvac", "plumber", "electrician", "pest control", "inspection",
  "gym", "trainer", "massage", "chiropractor", "acupuncture",
  "financial advisor", "accountant", "tax", "insurance",
  "flight", "hotel", "trip", "vacation", "travel",
  "birthday", "anniversary", "graduation", "wedding",
];

export function isAppointmentWorth(title: string, notes: string = ""): boolean {
  const text = (title + " " + notes).toLowerCase();
  return APPOINTMENT_KEYWORDS.some((kw) => text.includes(kw));
}

export type AuthorizedCalendarIngestInput = {
  title: string;
  notes?: string;
  startISO: string;
  endISO?: string;
  allDay?: boolean;
  location?: string;
  category?: string;
  externalId: string;
  observedAt?: string;
};

export type AuthorizedCalendarIngestResult = {
  appointmentId: string;
  evidence: EvidenceRecord;
};

export function ingestAuthorizedCalendarEvent(
  input: AuthorizedCalendarIngestInput,
): AuthorizedCalendarIngestResult | null {
  if (!isAppointmentWorth(input.title, input.notes ?? "")) return null;
  const externalId = input.externalId.trim();
  if (!externalId) return null;

  const appointmentId = addAppointment({
    title: input.title,
    category: input.category,
    apptDateISO: input.startISO,
    apptDatePrecision: input.allDay ? "date_only" : "exact",
    endDateISO: input.endISO,
    location: input.location || undefined,
    notes: input.notes || undefined,
    source: "device_calendar",
    externalId,
  });

  const evidence = persistEvidence({
    sourceClass: "external_source",
    sourceKind: "calendar",
    sourceId: externalId,
    rawText: input.title,
    eventAt: input.startISO,
    observedAt: input.observedAt,
  });

  return { appointmentId, evidence };
}
