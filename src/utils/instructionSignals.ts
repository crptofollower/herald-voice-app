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

/** Sentence boundary for obligation-prefix detection only -- periods DO end a
 *  sentence here, unlike RESIDUAL_CLAUSE_SPLIT_RE, which deliberately keeps
 *  "Dr. Smith" and comma-joined bodies intact for a different job (bounding
 *  a captured tail, not finding where a new sentence starts). */
const OBLIGATION_SENTENCE_SPLIT_RE = /[.!?]+\s+/;

/**
 * Shared sentence segmentation, Conversation Reliability V1 / Multi-Candidate
 * V1. Single source of truth for OBLIGATION_SENTENCE_SPLIT_RE's split +
 * trim + drop-empty, reused by hasObligationPrefixSentence,
 * extractNarrativeTodoAdd, and (externally) the Multi-Candidate V1
 * sentence-scoped residual scan in tierRouter.ts -- one segmentation
 * mechanism, not a second one reinvented per consumer.
 */
export function splitNarrativeSentences(msg: string): string[] {
  return msg.split(OBLIGATION_SENTENCE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

/**
 * Natural-speech guard, Conversation Reliability V1: true when a first-person
 * obligation prefix (TODO_ADD_PREFIX's own phrase set -- no new vocabulary)
 * opens ANY sentence in the utterance, not only the utterance's first word.
 * A narrative preamble ("I went to a trade show... I need to call my
 * accountant and tell her to file my taxes") must not defeat a guard whose
 * whole purpose is recognizing this phrasing as an obligation statement
 * rather than a direct command -- TODO_ADD_PREFIX's own `^` anchor only ever
 * protected the isolated, sentence-initial form of the identical phrase.
 */
export function hasObligationPrefixSentence(msg: string): boolean {
  return splitNarrativeSentences(msg).some((s) => TODO_ADD_PREFIX.test(s));
}

/** Remainder after a TODO prefix is already an existing named-list add. */
function namedListAddOwnsRemainder(body: string): boolean {
  const t = body.trim();
  // LIST_ADD_SIGNALS may match a later conjunct. Ownership requires the
  // remainder itself to begin with the existing add/put list-add operators.
  if (!/^(?:please\s+)?(?:add|put)\b/i.test(t)) return false;
  return LIST_ADD_SIGNALS.some((p) => p.test(t));
}

/**
 * Residual/compound capture boundary. Cuts a captured tail at the start of a
 * new clause/intent — not at every "and" (so "work out and start dinner" and
 * "milk and eggs" stay intact). Deliberately omits bare period (protects
 * "Dr. Smith") and comma (protects list-like bodies).
 */
export const RESIDUAL_CLAUSE_SPLIT_RE =
  /[!?]+|\s+[–—]\s+|\bbut\b|\bbecause\b|\band\s+then\b|\band\s+(?=I\b|we\b|what\b|when\b|who\b|where\b|why\b|how\b|call\b|remind\b)/i;

export function splitResidualClauses(text: string): string[] {
  return text.split(RESIDUAL_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
}

export function boundCapturedTail(text: string): string {
  const cut = text.search(RESIDUAL_CLAUSE_SPLIT_RE);
  if (cut < 0) return text.trim();
  return text.slice(0, cut).trim();
}

/** Extra object cut for mutation spans. `I need to` is unsafe on the shared
 *  splitter (it is also a TODO_ADD prefix), so it is applied only here. */
const MUTATION_OBJECT_TAIL_RE = /\b(?:because|and\s+then|I\s+need\s+to)\b/i;

export function boundMutationObject(text: string): string {
  const head = boundCapturedTail(text);
  const cut = head.search(MUTATION_OBJECT_TAIL_RE);
  if (cut < 0) return head;
  return head.slice(0, cut).trim();
}

const TODO_ADD_DISCOURSE_OPENER =
  /^(?:hey|okay|ok|yeah|so|um|uh|please|alright|like)[,:]?\s+/i;

/**
 * Grammatical function words (subordinating/coordinating conjunctions,
 * common discourse fillers) that are never a plausible vocative address.
 * extractTodoAdd's vocative fallback exists for genuine address ("Herald,
 * I need to...") but its bare `[A-Za-z]{2,16}` name-token match cannot tell
 * "Herald" from "If" on shape alone. Confirmed during Conversation
 * Reliability V1 testing: without this exclusion, "If I need to call my
 * accountant today, I will do it after lunch." is misread as addressing
 * someone named "If", fabricating a task from a hypothetical. Mirrors the
 * existing, separate exclusion list in stripTodoInstructionWrappers below
 * (same shape of problem, same style of fix, not a new pattern).
 */
const VOCATIVE_NON_NAME_EXCLUDE =
  /^(?:if|so|but|when|while|since|because|although|unless|though|whether|once|until|after|before)$/i;

export type TodoAddExtraction =
  | { kind: 'add'; body: string }
  | { kind: 'clarify' };

/**
 * Clause-initial TODO_ADD body capture. A trigger later in a compound
 * utterance is not authority to commit the whole string as the task body.
 * If the remainder after a TODO prefix is already an explicit named-list
 * add (existing LIST_ADD_SIGNALS), this returns null so list destination
 * ownership can admit — it does not invent list grammar.
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
    if (body.length <= 2) return null;
    if (namedListAddOwnsRemainder(body)) return null;
    return { kind: 'add', body };
  }
  const vocative = rest.match(/^(?!I\b)([A-Za-z]{2,16})[,:]?\s+(.+)$/s);
  if (
    vocative
    && !VOCATIVE_NON_NAME_EXCLUDE.test(vocative[1])
  ) {
    const afterName = vocative[2].trim();
    const namedPrefix = afterName.match(TODO_ADD_PREFIX);
    if (namedPrefix) {
      const body = boundCapturedTail(afterName.slice(namedPrefix[0].length));
      if (body.length <= 2) return null;
      if (namedListAddOwnsRemainder(body)) return null;
      return { kind: 'add', body };
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

/**
 * Sentence-scoped TODO_ADD extraction, Conversation Reliability V1.
 * extractTodoAdd's own body-bound and named-list refusal are reused
 * verbatim, unchanged -- this only widens WHERE in the utterance a direct
 * TODO_ADD_PREFIX match is allowed to be found, using the same
 * OBLIGATION_SENTENCE_SPLIT_RE segmentation hasObligationPrefixSentence
 * uses. A narrative preamble must not hide an embedded obligation sentence
 * from capture, the same reason it must not let one hijack tier-1 CALL.
 *
 * Deliberately does NOT call extractTodoAdd's own vocative-address fallback
 * per sentence: extractTodoAdd's `/^(?!I\b)([A-Za-z]{2,16})[,:]?\s+(.+)$/`
 * reinterpretation exists for genuine address ("Herald, I need to...") and
 * is already applied once, correctly, to the whole message below. Reapplying
 * it per sentence would let an ordinary discourse opener ("If", "So", "But")
 * that happens to precede "I need to..." be misread as addressing Herald by
 * name -- confirmed as a real false positive during testing (pre-existing in
 * extractTodoAdd itself, not introduced here, but this function must not
 * widen its exposure). Only a direct, sentence-initial TODO_ADD_PREFIX match
 * is accepted per sentence.
 *
 * The whole-message result wins first (byte-identical to today's behavior
 * whenever it already succeeds); only when that yields no body does each
 * sentence get this narrower, independent attempt. A sentence that doesn't
 * itself open with the prefix is skipped, never coerced into a match -- this
 * cannot silently promote narrative into a task; it can only find a sentence
 * that was already, on its own, a complete valid to-do statement.
 */
/**
 * A genuine question ("What do you think I should focus on today?") is not
 * an obligation statement even though it can contain a TODO_ADD_SIGNALS
 * word ("I should") as a substring. extractTodoAdd's own 'clarify' verdict
 * only means "TODO_ADD_SIGNALS matched somewhere, no clean body extracted"
 * -- for a question that is meaningless, and used to be masked by
 * TODO_DATE_SIGNALS rejecting most such utterances (they often mention
 * "today"/"weekend") before extraction ever ran. Confirmed as a real
 * regression during Conversation Reliability V1 temporal-obligation
 * testing (CF-43). A trailing "?" is the general, non-phrase-specific
 * signal used to withhold that verdict -- declarative compound instructions
 * ("Remove that -- yeah, but I need to work out and start dinner.") are
 * unaffected and keep the existing clarify prompt.
 */
const QUESTION_TAIL_RE = /\?\s*$/;

/**
 * extractTodoAdd's own boundCapturedTail bounds a captured body at
 * RESIDUAL_CLAUSE_SPLIT_RE's clause markers only -- it deliberately never
 * splits on a bare sentence-ending period (that splitter protects "Dr.
 * Smith" and comma-joined bodies for a different job). Applied to a whole
 * multi-sentence message, that means a genuine second sentence AFTER the
 * matched obligation can be silently swallowed into candidate 1's body.
 * Multi-Candidate V1 (Conversation Reliability) surfaced this directly:
 * "I need to call my accountant today and tell her to file my taxes. Paul
 * also needs wine." previously captured the WHOLE remainder, including
 * Paul's unrelated sentence, as candidate 1's body. Re-bounding at the
 * first genuine sentence boundary (if any) keeps candidate 1 grounded in
 * only its own sentence -- the per-sentence loop below is already
 * immune to this (each `sentence` it scans is already a single sentence),
 * this only re-bounds the whole-message-first attempt.
 */
function boundToFirstSentence(body: string): string {
  const cut = body.search(OBLIGATION_SENTENCE_SPLIT_RE);
  if (cut < 0) return body;
  return body.slice(0, cut).trim();
}

export function extractNarrativeTodoAdd(msg: string): TodoAddExtraction | null {
  const direct = extractTodoAdd(msg);
  if (direct?.kind === 'add') {
    const body = boundToFirstSentence(direct.body);
    return body.length > 2 ? { kind: 'add', body } : { kind: 'clarify' };
  }
  const sentences = splitNarrativeSentences(msg);
  if (sentences.length > 1) {
    for (const sentence of sentences) {
      let rest = sentence;
      for (let i = 0; i < 3; i++) {
        const opener = rest.match(TODO_ADD_DISCOURSE_OPENER);
        if (!opener) break;
        rest = rest.slice(opener[0].length);
      }
      const prefixAtStart = rest.match(TODO_ADD_PREFIX);
      if (!prefixAtStart) continue;
      const body = boundCapturedTail(rest.slice(prefixAtStart[0].length));
      if (body.length <= 2) continue;
      if (namedListAddOwnsRemainder(body)) continue;
      return { kind: 'add', body };
    }
  }
  if (direct?.kind === 'clarify' && QUESTION_TAIL_RE.test(msg.trim())) return null;
  return direct;
}

// Union of tierRouter TODO_COMPLETE first-person verb patterns (672, 676, 677).
export const COMPLETED_PAST_FIRST_PERSON_RE =
  /\bI\s+(?:already\s+)?(?:called|finished|completed|did|done|took care of|handled|picked up|dropped off|returned|sent|submitted|paid|filed|bought|got|grabbed|went to|made it to|got to|stopped by)\b/i;

const TODO_COMPLETE_EXPLICIT_RE =
  /\bcross (off|that off)\b|\bmark (that |it )?done\b|\bthat(?:'s| is) done\b/i;

// Longer movement/phrasal verbs first so "got to" does not collapse to "got".
const TODO_COMPLETE_PAST_EXTRACT_RE =
  /\bI\s+(?:already\s+)?(took care of|picked up|dropped off|went to|made it to|got to|stopped by|called|finished|completed|did|done|handled|returned|sent|submitted|paid|filed|bought|grabbed|got)\b(.*)$/i;

/** Past acquisition/consumption reports are not to-do completion operators. */
const PAST_ACQUISITION_REPORT_VERB_RE = /^(got|bought|grabbed|picked up)$/i;

const MOVEMENT_COMPLETE_VERB_RE =
  /^(went to|made it to|got to|stopped by)$/i;

/** Place/outing locatives — not a to-do referent even when determined. */
const MOVEMENT_OUTING_LOCATIVE_RE =
  /\b(?:grocery\s+store|store|shop|market|mall|restaurant|cafe|park|beach|movies?|lunch|dinner|breakfast)\b/i;

const DETERMINED_OR_ANAPHOR_OBJECT_RE =
  /^(?:the|a|an|my|our|his|her|their|this|that|those|these|it|them)\b/i;

/** Later I/we + verb inside a captured object = a second event, not the referent. */
const SECOND_EVENT_IN_OBJECT_RE = /\b(?:I|we)\s+\w+/i;

function isMovementCompleteVerb(verb: string): boolean {
  return MOVEMENT_COMPLETE_VERB_RE.test(verb.trim());
}

function clauseHasTodoCompleteMutationShape(clause: string): boolean {
  const t = clause.trim();
  if (!t) return false;
  if (TODO_COMPLETE_EXPLICIT_RE.test(t)) return true;
  const m = t.match(TODO_COMPLETE_PAST_EXTRACT_RE);
  if (!m) return false;
  if (PAST_ACQUISITION_REPORT_VERB_RE.test((m[1] ?? '').trim())) return false;
  const object = boundMutationObject(m[2] ?? '');
  if (!object) return false;
  if (SECOND_EVENT_IN_OBJECT_RE.test(object)) return false;
  if (isMovementCompleteVerb(m[1] ?? '')) {
    if (!DETERMINED_OR_ANAPHOR_OBJECT_RE.test(object)) return false;
    if (MOVEMENT_OUTING_LOCATIVE_RE.test(object) && LIST_ACQUISITION_TEMPORAL_RE.test(t)) {
      return false;
    }
  }
  return true;
}

/**
 * True when first-person past (or an explicit complete operator) is a genuine
 * to-do mutation, not merely narrative that contains overlapping vocabulary.
 */
export function extractTodoCompleteMutation(msg: string): { raw: string } | null {
  const text = msg.trim();
  if (!text) return null;
  if (TODO_COMPLETE_EXPLICIT_RE.test(text)) return { raw: text };
  const clauses = splitResidualClauses(text);
  const candidates = clauses.length > 0 ? clauses : [text];
  for (const clause of candidates) {
    if (clauseHasTodoCompleteMutationShape(clause)) {
      return { raw: clause.trim() };
    }
  }
  return null;
}

const LIST_ACQUISITION_TEMPORAL_RE =
  /\b(yesterday|today|tonight|this\s+morning|this\s+afternoon|last\s+(?:night|week|weekend|month))\b/i;

/**
 * Past-tense I/we acquisition reports ("I got eggs", "we bought milk") are
 * not list-remove authority. Explicit list operators and independently
 * authorized positional/pending grocery acts live elsewhere.
 */
export function extractListRemoveAcquisitionItem(_msg: string): string | null {
  return null;
}

// Third-person singular referent set. Single owner, shared by Flow C's referent
// speech acts (conversationalSubject.ts) and the visit-history fail-closed guard
// (tierRouter.ts). Pronoun form is ELIGIBILITY ONLY — never a selector. Herald
// has no gender field and must not infer one; a matched pronoun may refer to the
// one active subject regardless of form.
export const THIRD_PERSON_REFERENT = 'he|him|his|she|her|hers';

export const THIRD_PERSON_REFERENT_RE =
  new RegExp(`\\b(?:${THIRD_PERSON_REFERENT})\\b`, 'i');
