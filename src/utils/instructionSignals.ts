// Single owner for instruction/action semantic grammars shared by deterministic
// routing (tierRouter), ephemeral conversation eligibility, and CONV-C1 speech-
// act authority. Leaf module — no routing/DB imports.

// ephemeralConversation.ts — clause-initial imperative action detection.
export const IMPERATIVE_ACTION_RE =
  /^\s*(please\s+)?(remind\s+me(?!\s+what\b)|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|call|text|add|schedule|set|cancel|delete|remove)\b/i;

export const REMINDER_SIGNALS = [
  /\bremind me\b/i,
  /\bdon't let me forget\b/i,
  /\bremember to\b/i,
  /\bdon't forget to\b/i,
  /\bcan you set a reminder\b/i,
  /\bset a reminder\b/i,
];

export const NOTE_CAPTURE_SIGNALS = [
  /\b(note|jot|write down|record) (this|that)\b/i,
  /\bnote that\b/i,
  /\bjot this down\b/i,
  /^remember that\b/i,
  /\bcan you make a note\b/i,
  /\bmake a note (to|that|about)\b/i,
  /\bcan you note\b/i,
];

export const LIST_ADD_SIGNALS = [
  /\badd (.+) to (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
  /\bput (.+) on (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
  /\badd to (my |the )?(grocery |shopping |to.?do )?\blist\b (.+)/i,
  /\bcan you add (.+?) to (my |the )?(grocery |shopping |to.?do |)?\blist\b/i,
];

export const TODO_ADD_SIGNALS = [
  /\bI need to\b/i,
  /\bI have to\b/i,
  /\bI gotta\b/i,
  /\bI've got to\b/i,
  /\bdon't let me forget\b/i,
  /\bI should\b/i,
  /\bI must\b/i,
];

export const TODO_ADD_PREFIX =
  /^(I need to|I have to|I gotta|I've got to|don't let me forget|I should|I must)\s+/i;

/**
 * Residual/compound capture boundary. Cuts a captured tail at the start of a
 * new clause/intent — not at every "and" (so "work out and start dinner" and
 * "milk and eggs" stay intact). Deliberately omits bare period (protects
 * "Dr. Smith") and comma (protects list-like bodies).
 */
export const RESIDUAL_CLAUSE_SPLIT_RE =
  /[!?]+|\s+[–—]\s+|\bbut\b|\band\s+(?=I\b|we\b|what\b|when\b|who\b|where\b|why\b|how\b|call\b|remind\b)/i;

export function splitResidualClauses(text: string): string[] {
  return text.split(RESIDUAL_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

export function boundCapturedTail(text: string): string {
  const cut = text.search(RESIDUAL_CLAUSE_SPLIT_RE);
  if (cut < 0) return text.trim();
  return text.slice(0, cut).trim();
}

const TODO_ADD_DISCOURSE_OPENER =
  /^(?:hey|okay|ok|yeah|so|um|uh|please|alright|like)[,:]?\s+/i;

export type TodoAddExtraction =
  | { kind: 'add'; body: string }
  | { kind: 'clarify' };

/**
 * Clause-initial TODO_ADD body capture. A trigger later in a compound
 * utterance is not authority to commit the whole string as the task body.
 */
export function extractTodoAdd(msg: string): TodoAddExtraction | null {
  if (!TODO_ADD_SIGNALS.some((p) => p.test(msg))) return null;
  let rest = msg.trim();
  for (let i = 0; i < 3; i++) {
    const opener = rest.match(TODO_ADD_DISCOURSE_OPENER);
    if (!opener) break;
    rest = rest.slice(opener[0].length);
  }
  const prefixAtStart = rest.match(TODO_ADD_PREFIX);
  if (prefixAtStart) {
    const body = boundCapturedTail(rest.slice(prefixAtStart[0].length));
    return body.length > 2 ? { kind: 'add', body } : null;
  }
  const vocative = rest.match(/^(?!I\b)([A-Za-z]{2,16})[,:]?\s+(.+)$/s);
  if (vocative) {
    const afterName = vocative[2].trim();
    const namedPrefix = afterName.match(TODO_ADD_PREFIX);
    if (namedPrefix) {
      const body = boundCapturedTail(afterName.slice(namedPrefix[0].length));
      return body.length > 2 ? { kind: 'add', body } : null;
    }
  }
  return { kind: 'clarify' };
}

/**
 * Residual-seam TODO capture: extract from an isolated clause, never from the
 * full original utterance through EOS. A leading TODO prefix that primary
 * already consumed (grocery acquisition, etc.) must not be re-read as the body.
 */
export function extractResidualTodoAdd(msg: string): TodoAddExtraction | null {
  const clauses = splitResidualClauses(msg);
  if (clauses.length === 0) return null;
  const skipFirst = clauses.length > 1 && TODO_ADD_PREFIX.test(clauses[0]);
  for (let i = skipFirst ? 1 : 0; i < clauses.length; i++) {
    const extracted = extractTodoAdd(clauses[i]);
    if (extracted?.kind === 'add') return extracted;
  }
  return null;
}

// Union of tierRouter TODO_COMPLETE first-person verb patterns (672, 676, 677).
export const COMPLETED_PAST_FIRST_PERSON_RE =
  /\bI\s+(?:already\s+)?(?:called|finished|completed|did|done|took care of|handled|picked up|dropped off|returned|sent|submitted|paid|filed|bought|got|grabbed|went to|made it to|got to|stopped by)\b/i;

// Third-person singular referent set. Single owner, shared by Flow C's referent
// speech acts (conversationalSubject.ts) and the visit-history fail-closed guard
// (tierRouter.ts). Pronoun form is ELIGIBILITY ONLY — never a selector. Herald
// has no gender field and must not infer one; a matched pronoun may refer to the
// one active subject regardless of form.
export const THIRD_PERSON_REFERENT = 'he|him|his|she|her|hers';

export const THIRD_PERSON_REFERENT_RE =
  new RegExp(`\\b(?:${THIRD_PERSON_REFERENT})\\b`, 'i');
