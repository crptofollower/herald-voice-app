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

// Names both candidates only when EXACTLY 2 are nameable. Never invents a
// name for an unattributed row (DECISION 2, 1-nameable default). Above two
// uses the same generic one-question reask as 0/1 — never a spoken roster.
function buildReaskPrompt(candidates: string[]): string {
  if (candidates.length === 2) {
    return `I mean ${candidates[0]} or ${candidates[1]} — which one?`;
  }
  return "I'm not sure I'm following — can you say the doctor's name again?";
}
