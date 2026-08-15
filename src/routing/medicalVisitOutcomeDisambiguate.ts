import type { CommitResult } from './routeIntent';
import { matchCandidateToken, type MatchableCandidate } from './conversationSession';
import { getAmbiguousDoctorCandidates, getLastVisitOutcomeSummary } from '../db/medicalDB';

/**
 * Builds the pending CommitResult for an unhinted, multi-doctor-ambiguous
 * visit-outcome read. Constructed by routeIntent (below), armed by
 * processUtterance (below) -- this module owns neither session state nor
 * ConversationSession itself, only the plan.
 */
export function buildMedicalVisitOutcomePending(): Extract<CommitResult, { status: 'pending' }> {
  const candidates = getAmbiguousDoctorCandidates();
  const matchable: MatchableCandidate[] = candidates.map((name) => ({ label: name, ref: name }));

  return {
    status: 'pending',
    prompt: 'Which doctor do you mean?',
    pendingKey: 'medical_visit_outcome_read_disambiguate',
    kind: 'standard',
    reaskPrompt: buildReaskPrompt(candidates),
    resume: async (userText: string): Promise<CommitResult> => {
      const match = matchCandidateToken(userText, matchable);
      if (match === 'ambiguous' || match === 'none') {
        return { status: 'noop', ack: '' };
      }
      const response = getLastVisitOutcomeSummary(match.label);
      return { status: 'committed', ack: response };
    },
  };
}

// Names candidates only when EXACTLY 2+ are all nameable. Never invents a
// name for an unattributed row. See DECISION 2 above for the 1-nameable
// case default.
function buildReaskPrompt(candidates: string[]): string {
  if (candidates.length === 2) {
    return `I mean ${candidates[0]} or ${candidates[1]} — which one?`;
  }
  if (candidates.length > 2) {
    const allButLast = candidates.slice(0, -1).join(', ');
    return `I mean ${allButLast}, or ${candidates[candidates.length - 1]} — which one?`;
  }
  return "I'm not sure I'm following — can you say the doctor's name again?";
}
