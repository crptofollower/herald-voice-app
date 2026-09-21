// src/db/calendarEvidenceDoctorRead.ts
// Read-time medical relevance over persisted calendar evidence.
// Reuses accepted doctor/calendar matchers. Never writes domain truth.

import { extractDoctorName } from "../utils/detectMedicalEvent";
import { realizeCalendarEvidenceAct } from "../conversation/calendarEvidenceRealization";
import {
  doctorCalendarIdentityKey,
  formatCalendarEvidenceForSpeech,
  titleHasStrongDoctorNameSpan,
  titleMatchesDoctorCalendarTerm,
  type CachedEvent,
} from "./calendarCacheDB";
import { normalizeDoctorNameForMatch } from "./medicalDB";
import { listActiveEvidence, type EvidenceRecord } from "./evidenceDB";

function toCachedEvent(row: EvidenceRecord): CachedEvent | null {
  if (!row.eventAt) return null;
  const start_ms = Date.parse(row.eventAt);
  if (!Number.isFinite(start_ms)) return null;
  return {
    id: row.id,
    title: row.rawText,
    start_ms,
    end_ms: start_ms,
    all_day: 0,
    cached_at: row.observedAt,
  };
}

function isDoctorRelevantCalendarTitle(title: string): boolean {
  if (extractDoctorName(title)) return true;
  return titleHasStrongDoctorNameSpan(title, normalizeDoctorNameForMatch);
}

export function findPersistedDoctorCalendarEvidence(doctorHint?: string): EvidenceRecord[] {
  let rows: EvidenceRecord[] = [];
  try {
    rows = listActiveEvidence({
      sourceClass: "external_source",
      sourceKind: "calendar",
    });
  } catch {
    return [];
  }
  const relevant = rows.filter((row) => {
    if (!row.eventAt) return false;
    if (doctorHint) {
      return titleMatchesDoctorCalendarTerm(row.rawText, doctorHint, normalizeDoctorNameForMatch);
    }
    return isDoctorRelevantCalendarTitle(row.rawText);
  });
  return [...relevant].sort((a, b) => String(a.eventAt).localeCompare(String(b.eventAt)));
}

export function findPersistedDoctorCalendarEvidenceInRange(
  doctorHint: string | undefined,
  start: Date,
  end: Date,
): EvidenceRecord[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return findPersistedDoctorCalendarEvidence(doctorHint).filter((row) => {
    const ms = Date.parse(row.eventAt!);
    return Number.isFinite(ms) && ms >= startMs && ms < endMs;
  });
}

export function realizePersistedDoctorCalendarEvidence(
  doctorTerm: string,
  displayName: string,
  hits: EvidenceRecord[],
): string | null {
  const events = hits.map(toCachedEvent).filter((e): e is CachedEvent => !!e);
  if (events.length === 0) return null;
  const keys = new Set(
    events.map((e) => doctorCalendarIdentityKey(e.title, doctorTerm, normalizeDoctorNameForMatch)),
  );
  if (keys.size > 1) {
    const dates = events.map((h) => {
      const dateLabel = new Date(h.start_ms).toLocaleDateString([], {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      return `${h.title} on ${dateLabel}`;
    });
    return realizeCalendarEvidenceAct({
      kind: "multi",
      displayName,
      scope: { kind: "relative_months", direction: "past", months: 12 },
      dates,
    });
  }
  const event = events[events.length - 1];
  return formatCalendarEvidenceForSpeech(displayName, event, "date");
}

export function displayNameForCalendarEvidence(row: EvidenceRecord, fallback: string): string {
  return extractDoctorName(row.rawText) ?? fallback;
}
