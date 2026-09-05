// Shared direct-address / narrative-exclusion predicate.
// Extracted from isDirectDistressHelpMe's clause-split, third-person-subject,
// and narrative-preceding discipline. One implementation; two consumers
// (emergency admission, LLM capture-proposal refusal). Pure. Synchronous.

import { PERSON_RELATIONSHIP_ALTERNATION } from '../utils/personReference';

export const DIRECT_ADDRESS_CLAUSE_SPLIT_RE = /[.!?,;]+|\bbut\b|\band\b/i;

const HELP_ME_RE = /\bhelp\s+me\b/i;

const THIRD_PERSON_SUBJECT_CLAUSE_RE =
  /\b(?:he|she|they|it|my\s+\w+)\s+(?:'s\s+|is\s+|was\s+|said\s+|asked\s+|promised\s+|told\s+me\s+)?(?:could|can|might|may|would|will|should|'d|'ll)\b[^.!?]*\bhelp\s+me\b/i;

const NARRATIVE_PRECEDING_RE = /(?:\bto|\bwould|\bwill)\s*$|'d\s*$/i;

const WH_CLAUSE_START_RE = /^(?:how|what)\b/i;
const BARE_PLEA_REMAINDER_RE = /^(?:please|now)?$/i;
const MUNDANE_SOFT_TAIL = String.raw`(?:\s+(?:please|now))?`;
const MUNDANE_PHONE_RE = new RegExp(`^with\\s+my\\s+phone${MUNDANE_SOFT_TAIL}$`, 'i');
const MUNDANE_WH_WITH_RE = new RegExp(`^with${MUNDANE_SOFT_TAIL}$`, 'i');
const MUNDANE_ALARM_RE = new RegExp(`^set\\s+an?\\s+alarm${MUNDANE_SOFT_TAIL}$`, 'i');
const MUNDANE_CALL_RE = new RegExp(
  `^call\\s+my\\s+(?:${PERSON_RELATIONSHIP_ALTERNATION})${MUNDANE_SOFT_TAIL}$`,
  'i',
);

const ATTITUDE_PREFIX_RE =
  /^\s*i\s+(?:think|thought|guess|figured|believe|heard|suppose)(?:\s+that)?\s+/i;

const FIRST_PERSON_AGENT_RE =
  /\b(?:i|we)\s+(?:really\s+|just\s+|still\s+|actually\s+|so\s+)?(?:need(?:\s+to)?|have\s+to|gotta|got\s+to|should|must|want(?:\s+to)?|am|'m|was|'ve|will|can|could|fell)\b/i;

const SECOND_PERSON_REQUEST_RE =
  /\b(?:can|could|would|will)\s+you\b|\bhelp\s+me\b|^\s*(?:please\s+)?(?:help|call|text|add|remind)\b/i;

const THIRD_PERSON_FINITE_RE =
  /\b(?:he|she|they|it|someone|somebody|my\s+\w+|(?!i\b|we\b)[A-Za-z][A-Za-z']+)\s+(?:needs?|needed|has\s+to|have\s+to|should|must|could|can|might|may|wants?)\b/i;

const REPORTED_SPEECH_RE =
  /\b(?:he|she|they|someone|somebody)\s+(?:said|asked|promised|told)\b/i;

const SUBJECT_SKIP_TOKEN_RE =
  /^(?:really|just|still|actually|so|now|please|urgently|immediately|also|even)$/i;

const NEED_HELP_RE = /\bneed(?:s|ed)?\s+help\b/i;

const CONVERSATIONAL_ASSISTANCE_RE =
  /^(?:please\s+|now\s+)?[a-z]+ing\s+(?:what|who|when|where|why|how)\b/i;

export function splitDirectAddressClauses(text: string): string[] {
  return text.split(DIRECT_ADDRESS_CLAUSE_SPLIT_RE).map((c) => c.trim()).filter(Boolean);
}

export function isMundaneAssistanceRemainder(after: string, isWhAddressee: boolean): boolean {
  if (MUNDANE_PHONE_RE.test(after)) return true;
  if (isWhAddressee && MUNDANE_WH_WITH_RE.test(after)) return true;
  if (MUNDANE_ALARM_RE.test(after)) return true;
  if (MUNDANE_CALL_RE.test(after)) return true;
  return false;
}

function stripAttitudePrefix(clause: string): string {
  return clause.replace(ATTITUDE_PREFIX_RE, '').trim();
}

function hasFirstPersonAgent(clause: string): boolean {
  return FIRST_PERSON_AGENT_RE.test(clause);
}

function isFirstPersonSubjectOfMatch(clause: string, matchIndex: number): boolean {
  const before = clause.slice(0, matchIndex).trim();
  if (!before) return false;
  const tokens = before.split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && SUBJECT_SKIP_TOKEN_RE.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  const subj = tokens[tokens.length - 1] ?? '';
  return /^(?:i|we)$/i.test(subj);
}

function isReportedSpeechBefore(clause: string, matchIndex: number): boolean {
  return REPORTED_SPEECH_RE.test(clause.slice(0, matchIndex));
}

/**
 * Clause-aware direct distress "help me" detector. Logic unchanged from the
 * proven isDirectDistressHelpMe matrix; moved here so emergency and capture
 * share one implementation.
 */
export function isDirectDistressHelpMe(text: string): boolean {
  const t = text.trim();
  if (!HELP_ME_RE.test(t)) return false;

  const nonempty = splitDirectAddressClauses(t);
  const singleClause = nonempty.length === 1;

  for (const c of nonempty) {
    const m = HELP_ME_RE.exec(c);
    if (!m) continue;

    if (THIRD_PERSON_SUBJECT_CLAUSE_RE.test(c)) continue;
    const before = c.slice(0, m.index);
    if (NARRATIVE_PRECEDING_RE.test(before)) continue;

    const after = c.slice(m.index + m[0].length).replace(/[?.!]+$/g, '').trim();
    const isWhAddressee = WH_CLAUSE_START_RE.test(c) && /\byou\b/i.test(before);

    if (singleClause && isMundaneAssistanceRemainder(after, isWhAddressee)) continue;

    if (BARE_PLEA_REMAINDER_RE.test(after)) {
      if (isWhAddressee && singleClause) continue;
      return true;
    }

    return true;
  }
  return false;
}

/** First-person "need help" that is a distress plea, not assistance/narrative. */
export function hasFirstPersonDistressNeedHelp(text: string): boolean {
  const nonempty = splitDirectAddressClauses(text.trim());
  const singleClause = nonempty.length === 1;
  for (const c of nonempty) {
    const re = new RegExp(NEED_HELP_RE.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(c))) {
      if (isReportedSpeechBefore(c, m.index)) continue;
      if (!isFirstPersonSubjectOfMatch(c, m.index)) continue;
      const after = c.slice(m.index + m[0].length).replace(/[?.!]+$/g, '').trim();
      const before = c.slice(0, m.index);
      const isWhAddressee = WH_CLAUSE_START_RE.test(c) && /\byou\b/i.test(before);
      if (singleClause && isMundaneAssistanceRemainder(after, isWhAddressee)) continue;
      if (CONVERSATIONAL_ASSISTANCE_RE.test(after)) continue;
      return true;
    }
  }
  return false;
}

/** Third-party finite action in a clause (needs/should/wants…), after attitude hedges. */
export function utteranceHasThirdPartyFiniteAction(text: string): boolean {
  for (const raw of splitDirectAddressClauses(text.trim())) {
    const clause = stripAttitudePrefix(raw);
    if (clause && THIRD_PERSON_FINITE_RE.test(clause)) return true;
  }
  return false;
}

/**
 * True when the utterance is directed at Herald in first/second person about
 * the speaker's own situation, rather than third-party narrative/storytelling.
 */
export function isDirectAddressToHerald(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isDirectDistressHelpMe(t)) return true;
  if (hasFirstPersonDistressNeedHelp(t)) return true;

  for (const raw of splitDirectAddressClauses(t)) {
    const clause = stripAttitudePrefix(raw);
    if (!clause) continue;
    if (THIRD_PERSON_FINITE_RE.test(clause) && !hasFirstPersonAgent(clause)) continue;
    if (hasFirstPersonAgent(clause)) return true;
    if (SECOND_PERSON_REQUEST_RE.test(clause)) return true;
  }
  return false;
}
