// Single owner for instruction/action semantic grammars shared by deterministic
// routing (tierRouter), ephemeral conversation eligibility, and CONV-C1 speech-
// act authority. Leaf module — no routing/DB imports.

// ephemeralConversation.ts — clause-initial imperative action detection.
export const IMPERATIVE_ACTION_RE =
  /^\s*(please\s+)?(remind\s+me|don'?t\s+let\s+me\s+forget|make\s+sure\s+i|call|text|add|schedule|set|cancel|delete|remove)\b/i;

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
