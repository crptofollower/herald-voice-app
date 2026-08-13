// src/utils/phoneConfirm.ts
// D-phone-confirm, 2026-08-13 — M1 mechanism-tier fix.
//
// A syntactically valid 10-digit spoken phone number is not evidence it is
// the CORRECT number — STT can transpose or drop-and-pad digits while
// preserving count (device finding: "214-55-01000" -> committed as
// (214) 550-1000 when the user said (214) 555-0100). Structural validation
// cannot detect this class of error; there is no signal inside the process
// boundary that distinguishes it from a correct capture.
//
// This closes it the way Trust First already requires for low-confidence
// captures: ask, confirm, read back (CLAUDE.md). Until confirmed, the
// candidate is held in this closure only — it is never written to
// contactsDB, so it is structurally impossible for recall to return it as
// settled memory (no field-invalidation mechanism was required or built).
//
// Deliberately NOT a generalized high-entropy-value framework. This helper
// knows about phone numbers only (normalizePhone, formatUS). Proven for
// phone_capture and emergency_contact (both device-tested writers as of
// this commit). Do not import into service_capture or the dial-path
// collect stages (extractPhone10 in routeIntent.ts) without their own
// device proof — see state doc, "deferred" section.

import type { CommitResult } from '../routing/routeIntent';
import { CONFIRM_YES_RE, CONFIRM_NO_RE } from '../routing/conversationSession';
import { normalizePhone, formatUS } from './phone';

export type PhoneConfirmCandidate = {
  name: string;
  phone: string;            // digits, as captured (writer already validated >=7)
  relationship?: string;
};

export function formatPhoneForSpeech(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? formatUS(digits) : phone;
}

/**
 * Builds a 'pending' CommitResult that reads back a phone-number candidate
 * and holds it non-authoritative until the user confirms. `onConfirm` is
 * the only thing that performs a write — this helper never touches
 * contactsDB / capturePerson / setEmergencyContact directly, so callers
 * stay the sole writer for their own domain (Rule 1, one writer per fact).
 *
 * CANCEL_RE ("never mind", "cancel", ...) is handled upstream by
 * ConversationSession.resolvePending before resume() is ever called —
 * do not duplicate that check here.
 */
export function buildPhoneConfirmPending(
  candidate: PhoneConfirmCandidate,
  opts: {
    prompt: string;
    onConfirm: (c: PhoneConfirmCandidate) => CommitResult;
    reaskPrompt?: string;
  },
): CommitResult {
  const reaskPrompt =
    opts.reaskPrompt ??
    "I still didn't get a complete phone number — try saying it once more, slowly.";

  return {
    status: 'pending',
    prompt: opts.prompt,
    pendingKey: 'phone_confirm',
    reaskPrompt,
    resume: async (userText: string): Promise<CommitResult> => {
      const trimmed = userText.trim();

      if (CONFIRM_YES_RE.test(trimmed)) {
        return opts.onConfirm(candidate);
      }
      if (CONFIRM_NO_RE.test(trimmed)) {
        return { status: 'noop', ack: "Got it — I won't save that number." };
      }

      // Not yes/no. If the reply itself is a fresh valid 10-digit number,
      // treat it as a replacement candidate for the SAME identity and ask
      // again — never swap it in without its own read-back+confirm turn.
      const retry = normalizePhone(trimmed);
      if (retry.valid) {
        return buildPhoneConfirmPending(
          { ...candidate, phone: retry.normalized },
          {
            prompt: `Got it — ${candidate.name} at ${retry.spoken}. Is that right?`,
            onConfirm: opts.onConfirm,
            reaskPrompt,
          },
        );
      }

      // Genuinely unresolved (includes "No, that was not right. The
      // number was 214-55-0100." — 9 digits scraped from the whole
      // utterance, fails normalizePhone, falls here). Deliberately NOT
      // given its own correction-marker handling in this commit — the
      // existing re-ask ladder is safe (no commit, no fabrication), just
      // not maximally smooth. See state doc for the follow-on decision.
      return { status: 'noop', ack: '' };
    },
  };
}
