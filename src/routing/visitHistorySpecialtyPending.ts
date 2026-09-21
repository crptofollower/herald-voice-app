// Specialty clarification pending for visit-history reads.
// Doctor identity is filled on resume. Temporal constraint is captured from
// the original utterance and never re-derived from the clarification reply.

import type { CommitResult } from './routeIntent';
import { extractDoctorName } from '../utils/detectMedicalEvent';
import { resolveVisitHistoryTemporalConstraint } from './visitHistoryTemporal';
import { composeVisitHistoryReadResponse } from './visitHistoryRead';

export const VISIT_HISTORY_SPECIALTY_RE =
  /\bmy\s+(dentist|cardiologist|neurologist|oncologist|psychiatrist|therapist|specialist)\b/i;

export function visitHistorySpecialtyPrompt(specialtyLabel: string): string {
  return `Help me out — when you say "${specialtyLabel}," who do you mean? Tell me their name and I'll look it up.`;
}

export function buildVisitHistorySpecialtyPending(
  originalText: string,
  specialtyLabel: string,
): Extract<CommitResult, { status: 'pending' }> {
  const temporal = resolveVisitHistoryTemporalConstraint(originalText);
  const prompt = visitHistorySpecialtyPrompt(specialtyLabel);
  return {
    status: 'pending',
    prompt,
    pendingKey: 'medical_visit_history_specialty',
    kind: 'standard',
    reaskPrompt: prompt,
    resume: async (userText: string): Promise<CommitResult> => {
      const doctorHint = extractDoctorName(userText);
      if (!doctorHint) return { status: 'noop', ack: '' };
      const composed = await composeVisitHistoryReadResponse(doctorHint, temporal);
      return { status: 'committed', ack: composed.response };
    },
  };
}
