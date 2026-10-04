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
  /\bherald\b.{0,40}\bemergency\b/i,
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

export function detectEmergency(text: string): boolean {
  if (matchesEmergencySignal0(text)) return true;
  if (EMERGENCY_SIGNALS[1].test(text)) return true;
  for (const clause of splitDirectAddressClauses(text.trim())) {
    if (isContentFreeBarePlea(clause)) return true;
  }
  return false;
}

/**
 * Explicit request to contact emergency services. This is not Stage A and
 * does not dispatch. ChatScreen arms the existing 911 confirm_call.
 */
export function detectDirectEmergencyService(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\b(?:do not|don't|dont)\s+call\b/i.test(trimmed)) return false;
  if (/\bcall(?:ed|ing)?\s+(?:911|emergency services)\b/i.test(trimmed) && !/\bcall\s+(?:911|emergency services)\b/i.test(trimmed)) {
    return false;
  }
  const addressed = '(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+)?(?:herald\\s*,?\\s*)?(?:help\\s+me\\s*,?\\s*)?';
  const call911 = new RegExp(`\\b${addressed}call\\s+911\\b`, 'i');
  const callServices = new RegExp(`\\b${addressed}call\\s+emergency\\s+services\\b`, 'i');
  const ambulance = new RegExp(`\\b${addressed}(?:call|get|send)\\s+(?:me\\s+)?(?:an?\\s+|the\\s+)?ambulance\\b`, 'i');
  return call911.test(trimmed) || callServices.test(trimmed) || ambulance.test(trimmed);
}
