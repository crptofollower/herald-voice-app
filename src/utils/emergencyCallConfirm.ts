// Emergency-call confirm-primitive classifier — used only by ChatScreen.tsx's
// dispatchEmergency() no-emergency-contact-configured fallback (confirm_call
// pending). Pure and screen-independent so it can be unit-tested directly.
//
// Reuses the shared anchored CONFIRM_YES_RE / CONFIRM_NO_RE / CANCEL_RE
// vocabulary from conversationSession.ts rather than defining a second one —
// mirrors the existing phoneConfirm.ts pattern. The only new logic is testing
// those SAME regexes against leading word-prefixes of the utterance, to
// distinguish a bare bounded decline from a decline carrying its own
// trailing conversational content.
//
// Classifications:
//   'yes'                 — bounded affirmative → dial 911
//   'no'                  — bounded negative/cancel → existing decline path
//   'reject_with_content' — leading no/cancel token + trailing content →
//                           release WITHOUT assuming an alternate call
//                           target (the proven defect this retires)
//   'unresolved'          — anything else → existing honest re-ask

import { CONFIRM_YES_RE, CONFIRM_NO_RE, CANCEL_RE } from '../routing/conversationSession';

export type EmergencyCallReply = 'yes' | 'no' | 'reject_with_content' | 'unresolved';

function leadingRejectionWithContent(trimmed: string): boolean {
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false; // nothing trails a single-word reply
  // Test successive short leading prefixes against the SAME shared
  // negative/cancel vocabulary — never a second, hand-authored word list.
  for (let n = 1; n <= Math.min(3, words.length - 1); n++) {
    const prefix = words.slice(0, n).join(' ').replace(/[\s.,!]+$/, '');
    if (CONFIRM_NO_RE.test(prefix) || CANCEL_RE.test(prefix)) return true;
  }
  return false;
}

export function classifyEmergencyCallReply(text: string): EmergencyCallReply {
  const trimmed = text.trim();
  if (CONFIRM_YES_RE.test(trimmed)) return 'yes';
  if (CONFIRM_NO_RE.test(trimmed) || CANCEL_RE.test(trimmed)) return 'no';
  if (leadingRejectionWithContent(trimmed)) return 'reject_with_content';
  return 'unresolved';
}
