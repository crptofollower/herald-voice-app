// src/routing/emergencySignals.ts
// Law 0 — emergency preempts everything (Spine §3a; S_DISCLOSE_DESIGN_SPEC.md §3).
// Single exported constant + detector — the one home for emergency detection.
// TWO call sites consume this during the Step 4 transition (ChatScreen's interim
// top-of-sendMessage guard + processUtterance's permanent Law 0 check) because
// the 4 legacy ref-pendings (med-clear/todo/insurance/contact-collect) still sit
// upstream of processUtterance in ChatScreen. Once Step 4 migrates those refs
// into ConversationSession, ChatScreen's guard becomes redundant — DELETE IT then,
// leaving processUtterance as the single consumer the spec calls for.
// Do not alter the patterns without one-way-door review (Spine §9).
//
// 2026-08-14 CORRECTION (rev. 4, final): replaces the original bare "help me"
// pattern (unbounded negative-lookahead whitelist of safe verbs) and two
// interim revisions. This version distinguishes DIRECT address ("help me" /
// "please help me" / "could you help me") from REPORTED/NARRATIVE speech
// about a third party's willingness to help ("she said she could help me" /
// "my son may help me" / "he'd help me") using two small structural checks —
// an immediate infinitive/modal marker before "help me" (to/would/will/'d),
// and a third-person or "my [noun]" possessive subject governing a modal
// anywhere in the same clause. Each "help me" occurrence is evaluated in its
// own clause (split on sentence punctuation and but/and) so an earlier
// narrative clause can never suppress a later, genuinely direct plea in the
// same utterance. No standalone self-distress detector is included — the
// mandatory compound case ("...I fell and now I need help") is fully covered
// by the pre-existing, unmodified first pattern below. Full regression
// matrix (42 cases): design review 2026-08-14 (rev. 4).

export const EMERGENCY_SIGNALS = [
  /\bi\b.{0,15}\bneed(?:s|ed)?\s+help\b|\bcall for help\b|\bi('m| am) having an emergency\b|\bthis is an emergency\b|\bsend help\b/i,
  /\bherald.{0,10}(help|emergency|i('m| am) scared|i('ve| have) fallen)\b/i,
];

const HELP_ME_RE = /\bhelp\s+me\b/i;

const THIRD_PERSON_SUBJECT_CLAUSE_RE =
  /\b(?:he|she|they|it|my\s+\w+)\s+(?:'s\s+|is\s+|was\s+|said\s+|asked\s+|promised\s+|told\s+me\s+)?(?:could|can|might|may|would|will|should|'d|'ll)\b[^.!?]*\bhelp\s+me\b/i;

const NARRATIVE_PRECEDING_RE = /(?:\bto|\bwould|\bwill)\s*$|'d\s*$/i;

const CLAUSE_SPLIT_RE = /[.!?,;]+|\bbut\b|\band\b/i;

export function isDirectDistressHelpMe(text: string): boolean {
  const t = text.trim();
  if (!HELP_ME_RE.test(t)) return false;

  const clauses = t.split(CLAUSE_SPLIT_RE);
  for (const clause of clauses) {
    const c = clause.trim();
    if (!c) continue;
    const m = HELP_ME_RE.exec(c);
    if (!m) continue;

    if (THIRD_PERSON_SUBJECT_CLAUSE_RE.test(c)) continue;
    const before = c.slice(0, m.index);
    if (NARRATIVE_PRECEDING_RE.test(before)) continue;

    return true;
  }
  return false;
}

export function detectEmergency(text: string): boolean {
  return EMERGENCY_SIGNALS.some(p => p.test(text)) || isDirectDistressHelpMe(text);
}
