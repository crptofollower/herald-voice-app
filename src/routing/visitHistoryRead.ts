// Shared visit-history read composition — direct named-doctor queries and
// specialty-clarification resume use this one authority path.

import type { VisitHistoryTemporalConstraint } from './visitHistoryTemporal';

export async function composeVisitHistoryReadResponse(
  doctorHint: string | undefined,
  temporal: VisitHistoryTemporalConstraint,
): Promise<{ response: string; reason: string }> {
  if (temporal.kind === 'unresolved') {
    return {
      response: 'I can check yesterday, last week, last month, or how many months ago — not a specific month or date like that.',
      reason: 'medical:visit_history_unresolved_temporal',
    };
  }

  const { getLastVisit, getLastVisitInRange } = await import('../db/medicalDB');
  const { formatSpokenDate } = await import('../utils/parseTime');
  const {
    findPersistedDoctorCalendarEvidence,
    findPersistedDoctorCalendarEvidenceInRange,
    realizePersistedDoctorCalendarEvidence,
    displayNameForCalendarEvidence,
  } = await import('../db/calendarEvidenceDoctorRead');

  const visit = temporal.kind === 'resolved'
    ? getLastVisitInRange(doctorHint, temporal.range.start, temporal.range.end)
    : getLastVisit(doctorHint);
  const persisted = temporal.kind === 'resolved'
    ? findPersistedDoctorCalendarEvidenceInRange(doctorHint, temporal.range.start, temporal.range.end)
    : findPersistedDoctorCalendarEvidence(doctorHint);
  const calDisplay = doctorHint
    ?? (persisted[0] ? displayNameForCalendarEvidence(persisted[0], 'your doctor') : 'your doctor');
  const calendarSpeech = realizePersistedDoctorCalendarEvidence(
    doctorHint ?? calDisplay,
    calDisplay,
    persisted,
  );

  if (visit) {
    const who = visit.doctorName ?? 'your doctor';
    const spoken = formatSpokenDate(visit.visitDate);
    const details: string[] = [];
    if (visit.reason) details.push(`for ${visit.reason}`);
    if (visit.diagnosis) details.push(`diagnosed with ${visit.diagnosis}`);
    if (visit.notes) details.push(visit.notes);
    if (visit.follow_up) details.push(`follow-up: ${visit.follow_up}`);
    const reasonPart = details.length > 0 ? ` — ${details.join('; ')}` : '';
    const medicalSpeech = temporal.kind === 'resolved'
      ? `Yes, you saw ${who} on ${spoken}${reasonPart}.`
      : `You last saw ${who} on ${spoken}${reasonPart}.`;
    return {
      response: calendarSpeech ? `${medicalSpeech} ${calendarSpeech}` : medicalSpeech,
      reason: 'medical:visit_history_read',
    };
  }

  if (temporal.kind === 'resolved') {
    if (calendarSpeech) {
      return { response: calendarSpeech, reason: 'medical:visit_history_read' };
    }
    const who = doctorHint ?? 'that doctor';
    return {
      response: `I don't have a visit with ${who} ${temporal.range.speechLabel}.`,
      reason: 'medical:visit_history_read',
    };
  }

  if (doctorHint) {
    const { answerHistoricalCalendarVisitEvidence } = await import('./conversationalSubject');
    return {
      response: await answerHistoricalCalendarVisitEvidence(doctorHint, doctorHint),
      reason: 'medical:visit_history_read',
    };
  }

  if (calendarSpeech) {
    return { response: calendarSpeech, reason: 'medical:visit_history_read' };
  }

  return {
    response: "I don't have any visits yet — tell me and I'll remember.",
    reason: 'medical:visit_history_read',
  };
}
