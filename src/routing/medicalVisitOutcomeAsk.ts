// src/routing/medicalVisitOutcomeAsk.ts
// Moment 2 — post-visit outcome ask, two-stage capture-then-confirm.
//
// Orchestration only. Prompt wording, pending shape, and the confirm gate
// live here — NOT in medicalDB.ts (storage/query authority stays untouched,
// per Spine §4a). The only SQLite write this module performs is the single
// attachVisitOutcome call inside the confirm-stage resume, gated strictly
// behind an explicit CONFIRM_YES_RE match. Until that match, the user's
// reply exists only as a local closure variable — never written, never
// promoted, never inferred from (CLAUDE.md Trust First; No Magic AI).
//
// Nested-pending shape reuses the shipped medical_visit_upcoming →
// confirmStage pattern in routeIntent.ts (nested 'pending' result, replace-
// slot via ConversationSession — see conversationSession.ts:126-133). One
// deliberate departure from that pattern: the confirm stage HERE sets an
// explicit candidate-specific `reaskPrompt` (CommitResult's existing,
// already-supported optional field — see routeIntent.ts:37-40). A generic
// DEFAULT_REASK ("can you say that again?") does not tell the user what
// durable medical memory they are being asked to authorize on re-ask, and
// this stage exists specifically to get informed yes/no consent for a
// candidate the user hasn't confirmed yet — the confirm question itself
// must stay visible on every ambiguous turn. No new confirmation
// vocabulary, no ConversationSession change: reaskPrompt is an existing,
// already-wired field (conversationSession.ts:114, `slot.reaskPrompt ??
// DEFAULT_REASK`).

import type { CommitResult } from './routeIntent';
import { CONFIRM_YES_RE, CONFIRM_NO_RE } from './conversationSession';
import { attachVisitOutcome } from '../db/medicalDB';

export interface VisitOutcomeAskSlot {
  prompt: string;
  pendingKey: 'medical_visit_outcome';
  kind: 'standard';
  budget: number;
  resume: (userText: string) => Promise<CommitResult>;
}

/**
 * Builds the cold-mount pending slot for the post-visit outcome ask.
 * Pure — no DB reads or writes at build time. Caller is responsible for
 * arming this via ConversationSession.setPending, presenting `.prompt`,
 * and stamping outcome_asked_at AFTER presentation (see ChatScreen.tsx
 * cold-mount block — sequencing is load-bearing, not incidental).
 */
export function buildVisitOutcomeAskSlot(awaiting: {
  id: string;
  doctorName?: string;
}): VisitOutcomeAskSlot {
  const who = awaiting.doctorName ? ` with ${awaiting.doctorName}` : '';

  return {
    prompt: `How did your appointment${who} go?`,
    pendingKey: 'medical_visit_outcome',
    kind: 'standard',
    budget: 2,
    resume: async (userText: string): Promise<CommitResult> => {
      if (!userText.trim()) {
        return { status: 'noop', ack: '' }; // re-ask ladder, original question
      }

      // In-memory candidate ONLY. This closure variable is the sole place
      // the reply exists until the user explicitly confirms it. If the
      // session ends (cancel, emergency, app termination) before that,
      // nothing was ever persisted — by construction, not by cleanup.
      const candidate = userText;
      const confirmPrompt = `Should I remember "${candidate}" from your appointment${who}?`;

      return {
        status: 'pending',
        pendingKey: 'medical_visit_outcome_confirm',
        prompt: confirmPrompt,
        // Candidate-specific reaskPrompt (see module header) — an
        // ambiguous reply re-asks THIS exact question, not a generic
        // "say that again," and never falls back to the original
        // "how did it go" question.
        reaskPrompt: `Please say yes or no. ${confirmPrompt}`,
        resume: async (confirmText: string): Promise<CommitResult> => {
          const t = confirmText.trim();
          if (CONFIRM_NO_RE.test(t)) {
            return {
              status: 'noop',
              ack: "Okay, I won't save that. What would you like me to do?",
            };
          }
          if (CONFIRM_YES_RE.test(t)) {
            attachVisitOutcome(awaiting.id, candidate); // the one and only write
            return { status: 'committed', ack: "Got it — I'll remember that." };
          }
          // Neither yes nor no → re-ask ladder, confirm stage retained.
          return { status: 'noop', ack: '' };
        },
      };
    },
  };
}
