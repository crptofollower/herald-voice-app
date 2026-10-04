// src/routing/emergencySignals.ts
// Stage A — hard emergency authority. High-recall distress is not authority.
// Unknown help-me remainders, modal-you capability questions, and distress
// vocabulary beside help do not admit. Bare pleas admit only when a clause
// is an approved content-free plea after closed modifiers are removed.

import {
  isDirectAddressToHerald,
  isDirectDistressHelpMe,
  splitDirectAddressClauses,
} from './directAddress';

export { isDirectDistressHelpMe };

export const EMERGENCY_SIGNALS = [
  /\bi\b.{0,15}\bneed(?:s|ed)?\s+help\b|\bcall for help\b|\bi('m| am) having an emergency\b|\bthis is an emergency\b|\bsend help\b/i,
  // Herald-addressed emergency is not this pattern. Admission is the
  // clause-owned form in matchesHeraldAddressedEmergency.
  /^(?:hey\s+)?herald\s+emergency$/i,
];

const BARE_CORES = new Set([
  'help me',
  'i need help',
  'somebody help me',
  'someone help me',
  'can somebody help me',
  'could somebody help me',
  'can someone help me',
  'could someone help me',
]);

const MODIFIER_PHRASES = [
  'right away',
  'right now',
  'at once',
  'this instant',
  'that instant',
  'this minute',
  'that minute',
  'this second',
  'that second',
  'this moment',
  'that moment',
  'oh god',
];

const MODIFIER_WORDS = new Set([
  'please',
  'herald',
  'hey',
  'oh',
  'okay',
  'ok',
  'really',
  'just',
  'so',
  'immediately',
  'urgently',
  'quickly',
  'fast',
  'asap',
  'now',
]);

function matchesSignal0Clause(clause: string): boolean {
  if (/\bcall for help\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  if (/\bi(?:'m| am) having an emergency\b/i.test(clause)) return true;
  if (/\bthis is an emergency\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  if (/\bsend help\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  return false;
}

function clauseWords(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function stripClosedModifiers(words: string[]): string[] {
  let rest = words.slice();
  let changed = true;
  while (changed) {
    changed = false;
    const joined = ` ${rest.join(' ')} `;
    for (const phrase of MODIFIER_PHRASES) {
      const token = ` ${phrase} `;
      if (!joined.includes(token)) continue;
      rest = joined.replace(token, ' ').trim().split(/\s+/).filter(Boolean);
      changed = true;
      break;
    }
  }
  return rest.filter((word) => !MODIFIER_WORDS.has(word));
}

function isContentFreeBarePlea(clause: string): boolean {
  return BARE_CORES.has(stripClosedModifiers(clauseWords(clause)).join(' '));
}

function matchesEmergencySignal0(text: string): boolean {
  for (const clause of splitDirectAddressClauses(text.trim())) {
    if (matchesSignal0Clause(clause)) return true;
  }
  return false;
}

function normalizeClauseWords(clause: string): string[] {
  return clause
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function isHeraldVocativeClause(clause: string): boolean {
  return /^(?:hey\s+)?(?:please\s+)?herald$/.test(normalizeClauseWords(clause).join(' '));
}

function isExactEmergencyClause(clause: string): boolean {
  return /^(?:please\s+)?emergency$/.test(normalizeClauseWords(clause).join(' '));
}

function isHeraldEmergencyClause(clause: string): boolean {
  return /^(?:hey\s+)?(?:please\s+)?herald(?:\s+please)?\s+emergency$/.test(normalizeClauseWords(clause).join(' '));
}

/** Clause-owned Herald + emergency. Token proximity is not authority. */
function matchesHeraldAddressedEmergency(text: string): boolean {
  const clauses = splitDirectAddressClauses(text.trim());
  if (clauses.some(isHeraldEmergencyClause)) return true;
  return clauses.some(isHeraldVocativeClause) && clauses.some(isExactEmergencyClause);
}

export function detectEmergency(text: string): boolean {
  if (matchesEmergencySignal0(text)) return true;
  if (matchesHeraldAddressedEmergency(text)) return true;
  for (const clause of splitDirectAddressClauses(text.trim())) {
    if (isContentFreeBarePlea(clause)) return true;
  }
  return false;
}

const SERVICE_OBJECTS = new Set([
  '911',
  'nine one one',
  'an ambulance',
  'the ambulance',
  'emergency services',
]);

const REQUEST_MODALS = new Set(['can', 'could', 'would', 'will']);

function splitServiceRequestClauses(text: string): string[] {
  return text.split(/[.!?,;?]+|\bbut\b|\band\b/i).map((clause) => clause.trim()).filter(Boolean);
}

function isServiceRequestLeadIn(clause: string): boolean {
  let words = normalizeClauseWords(clause);
  if (words.length === 0) return false;
  if (words[0] === 'hey') words = words.slice(1);
  if (words[0] === 'please') words = words.slice(1);
  if (words[0] === 'herald') words = words.slice(1);
  if (words[0] === 'please') words = words.slice(1);
  if (words[0] === 'help' && words[1] === 'me') words = words.slice(2);
  return words.length === 0;
}

function isDirectServiceRequestClause(clause: string): boolean {
  let words = normalizeClauseWords(clause);
  if (words.length === 0) return false;
  if (words[words.length - 1] === 'please') words = words.slice(0, -1);
  if (words[0] === 'hey') words = words.slice(1);
  if (words[0] === 'please') words = words.slice(1);
  if (words[0] === 'herald') words = words.slice(1);
  if (words[0] === 'please') words = words.slice(1);
  if (REQUEST_MODALS.has(words[0] ?? '') && words[1] === 'you') {
    words = words.slice(2);
    if (words[0] === 'please') words = words.slice(1);
  }
  if (words[0] === 'help' && words[1] === 'me') words = words.slice(2);
  if (words[0] === 'i' && words[1] === 'need' && words[2] === 'you' && words[3] === 'to') words = words.slice(4);
  if (words[0] === 'please') words = words.slice(1);
  if (words[0] !== 'call') return false;
  words = words.slice(1);
  if (words[0] === 'me') words = words.slice(1);
  return SERVICE_OBJECTS.has(words.join(' '));
}

/**
 * A complete clause is a direct request to Herald to call a closed emergency
 * service. This is not Stage A and does not dispatch. ChatScreen arms the
 * existing 911 confirm_call only after this returns true.
 */
export function detectEmergencyServiceRequest(text: string): boolean {
  const clauses = splitServiceRequestClauses(text.trim());
  if (clauses.length === 0) return false;
  if (!clauses.some(isDirectServiceRequestClause)) return false;
  return clauses.every((clause) => isDirectServiceRequestClause(clause) || isServiceRequestLeadIn(clause));
}

export function detectDirectEmergencyService(text: string): boolean {
  return detectEmergencyServiceRequest(text);
}
