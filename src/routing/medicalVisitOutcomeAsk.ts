// src/routing/medicalVisitOutcomeAsk.ts
// Moment 2 — post-visit outcome ask, then chained follow-up capture.
//
// Orchestration only. Prompt wording, pending shape, and the confirm gate
// live here — NOT in medicalDB.ts (storage/query authority stays untouched,
// per Spine §4a). SQLite writes this module performs:
//   1. attachVisitOutcome inside outcome-confirm YES (visit id from the
//      cold-mount slot — never re-resolved by doctor name).
//   2. attachFollowUp inside follow-up-confirm YES, same visit id.
// Outcome commit stands independently: follow-up collection begins only
// after visit_outcome is already written. If RAM pending disappears
// (background / unmount / new ConversationSession) before follow-up
// confirm, visit_outcome remains and follow_up stays NULL — no rollback,
// no resurrection in this slice.
//
// Follow-up existence is asked explicitly after confirmed outcome because
// Herald does not infer structured return timing from visit_outcome prose.
// That extra turn is a deliberate accepted never-needy trade-off. Do not
// parse the outcome blob. Do not dual-write it into follow_up.
//
// Nested-pending shape reuses the shipped medical_visit_upcoming →
// confirmStage pattern in routeIntent.ts (nested 'pending' result, replace-
// slot via ConversationSession — see conversationSession.ts:126-133). One
// deliberate departure from that pattern: confirm stages HERE set an
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
import { CANCEL_RE, CONFIRM_YES_RE, CONFIRM_NO_RE, type CorrectableField } from './conversationSession';
import { attachFollowUp, attachVisitOutcome } from '../db/medicalDB';

// Whole-string match only, deliberately narrow. A real answer that merely
// starts with "no" ("No complications, all good") must still fall through
// to candidate capture — only a standalone decline utterance short-circuits
// here. Deliberately excludes "nothing"/"not really" — those may be
// legitimate or ambiguous visit outcomes, not clear declines. Missing an
// edge-case phrasing is safe (falls through to normal capture, same as
// today) — matching a real answer as a decline would not be.
const OUTCOME_DECLINE_RE = /^(no|no thanks|no thank you|nope|nah|not now)[.!]?$/i;

// Existence-question extras beyond CONFIRM_NO_RE / CANCEL_RE. Closed set,
// whole-string only — not a general natural-language interpreter.
const FOLLOW_UP_EXISTENCE_DECLINE_EXTRA_RE =
  /^(no thanks|no thank you|nah|not now|they didn't|they didn['\u2019]?t|they did not)[\s.,!]*$/i;

const FOLLOW_UP_EXISTENCE_PROMPT = 'Did they tell you when to come back?';
const FOLLOW_UP_VALUE_PROMPT = 'When did they say to come back?';

export interface VisitOutcomeAskSlot {
  prompt: string;
  pendingKey: 'medical_visit_outcome';
  kind: 'standard';
  budget: number;
  resume: (userText: string) => Promise<CommitResult>;
}

type PendingCommit = Extract<CommitResult, { status: 'pending' }>;

function isFollowUpExistenceDecline(text: string): boolean {
  const t = text.trim();
  return CONFIRM_NO_RE.test(t) || CANCEL_RE.test(t) || FOLLOW_UP_EXISTENCE_DECLINE_EXTRA_RE.test(t);
}

function isFollowUpValueCancel(text: string): boolean {
  return isFollowUpExistenceDecline(text);
}

function followUpFromWho(doctorName?: string): string {
  return doctorName ? ` from ${doctorName}` : '';
}

// Non-empty ack required so ConversationSession treats this as a recognized
// close (empty ack would re-ask). Not a question — go dark after decline.
function declineFollowUpCapture(): CommitResult {
  return { status: 'noop', ack: 'Okay.' };
}

function buildFollowUpConfirmStage(
  visitId: string,
  doctorName: string | undefined,
  candidate: string,
): PendingCommit {
  const fromWho = followUpFromWho(doctorName);
  const confirmPrompt = `Should I remember "${candidate}" as your follow-up${fromWho}?`;
  const build = (v: string): ReturnType<CorrectableField['buildCorrected']> => ({
    pendingKey: 'medical_visit_follow_up_confirm',
    prompt: `Should I remember "${v}" as your follow-up${fromWho}?`,
    reaskPrompt: `Please say yes or no. Should I remember "${v}" as your follow-up${fromWho}?`,
    resume: async (confirmText: string): Promise<CommitResult> => {
      const t = confirmText.trim();
      if (CONFIRM_NO_RE.test(t) || CANCEL_RE.test(t)) {
        return declineFollowUpCapture();
      }
      if (CONFIRM_YES_RE.test(t)) {
        attachFollowUp(visitId, v);
        return { status: 'committed', ack: "Got it — I'll remember that." };
      }
      return { status: 'noop', ack: '' };
    },
    correctable: { currentValue: v, buildCorrected: (v2: string) => build(v2) },
  });
  const slot = build(candidate);
  return {
    status: 'pending',
    pendingKey: slot.pendingKey,
    prompt: confirmPrompt,
    reaskPrompt: `Please say yes or no. ${confirmPrompt}`,
    resume: slot.resume,
    correctable: slot.correctable,
  };
}

function buildFollowUpValueStage(
  visitId: string,
  doctorName: string | undefined,
): PendingCommit {
  return {
    status: 'pending',
    pendingKey: 'medical_visit_follow_up_value',
    prompt: FOLLOW_UP_VALUE_PROMPT,
    reaskPrompt: FOLLOW_UP_VALUE_PROMPT,
    resume: async (userText: string): Promise<CommitResult> => {
      const trimmed = userText.trim();
      if (!trimmed) {
        return { status: 'noop', ack: '' };
      }
      if (isFollowUpValueCancel(trimmed)) {
        return declineFollowUpCapture();
      }
      // Whole reply is the candidate — unparsed, no extraction, no date parser.
      return buildFollowUpConfirmStage(visitId, doctorName, userText);
    },
  };
}

function buildFollowUpExistenceStage(
  visitId: string,
  doctorName: string | undefined,
): PendingCommit {
  return {
    status: 'pending',
    pendingKey: 'medical_visit_follow_up_existence',
    prompt: FOLLOW_UP_EXISTENCE_PROMPT,
    reaskPrompt: `Please say yes or no. ${FOLLOW_UP_EXISTENCE_PROMPT}`,
    resume: async (userText: string): Promise<CommitResult> => {
      const t = userText.trim();
      if (!t) {
        return { status: 'noop', ack: '' };
      }
      if (isFollowUpExistenceDecline(t)) {
        return declineFollowUpCapture();
      }
      if (CONFIRM_YES_RE.test(t)) {
        return buildFollowUpValueStage(visitId, doctorName);
      }
      return { status: 'noop', ack: '' };
    },
  };
}

function commitOutcomeThenAskFollowUp(
  visitId: string,
  doctorName: string | undefined,
  candidate: string,
): CommitResult {
  attachVisitOutcome(visitId, candidate);
  return buildFollowUpExistenceStage(visitId, doctorName);
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
      const trimmed = userText.trim();
      if (!trimmed) {
        return { status: 'noop', ack: '' }; // re-ask ladder, original question
      }
      if (OUTCOME_DECLINE_RE.test(trimmed)) {
        return {
          status: 'noop',
          ack: "Okay, no worries. What would you like me to do?",
        };
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
            return commitOutcomeThenAskFollowUp(awaiting.id, awaiting.doctorName, candidate);
          }
          // Neither yes nor no → re-ask ladder, confirm stage retained.
          return { status: 'noop', ack: '' };
        },
        correctable: {
          currentValue: candidate,
          buildCorrected: (newValue: string) => {
            const build = (v: string): ReturnType<CorrectableField['buildCorrected']> => ({
              pendingKey: 'medical_visit_outcome_confirm',
              prompt: `Should I remember "${v}" from your appointment${who}?`,
              reaskPrompt: `Please say yes or no. Should I remember "${v}" from your appointment${who}?`,
              resume: async (confirmText: string): Promise<CommitResult> => {
                const t = confirmText.trim();
                if (CONFIRM_NO_RE.test(t)) {
                  return { status: 'noop', ack: "Okay, I won't save that. What would you like me to do?" };
                }
                if (CONFIRM_YES_RE.test(t)) {
                  return commitOutcomeThenAskFollowUp(awaiting.id, awaiting.doctorName, v);
                }
                return { status: 'noop', ack: '' };
              },
              correctable: { currentValue: v, buildCorrected: (v2: string) => build(v2) },
            });
            return build(newValue);
          },
        },
      };
    },
  };
}
