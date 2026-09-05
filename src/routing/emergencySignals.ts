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
// interim revisions. Direct vs reported "help me" lives in directAddress.ts.
//
// 2026-08-17 LAW0-K1: unknown help-me remainder is emergency. Law 0 yields
// only when a single-clause remainder is the whole mundane request
// (with my phone; How/What trailing with; set a/an alarm; call my <relationship>)
// or a single-clause How/What + you bare remainder. Prefix matches are not enough.
//
// 2026-09-05: EMERGENCY_SIGNALS[0] is evaluated per-clause through the shared
// direct-address predicate. Whole-string `.test` is not an admission by itself.

import {
  hasFirstPersonDistressNeedHelp,
  isDirectAddressToHerald,
  isDirectDistressHelpMe,
  splitDirectAddressClauses,
} from './directAddress';

export { isDirectDistressHelpMe };

export const EMERGENCY_SIGNALS = [
  /\bi\b.{0,15}\bneed(?:s|ed)?\s+help\b|\bcall for help\b|\bi('m| am) having an emergency\b|\bthis is an emergency\b|\bsend help\b/i,
  /\bherald.{0,10}(help|emergency|i('m| am) scared|i('ve| have) fallen)\b/i,
];

function matchesSignal0Clause(clause: string): boolean {
  if (/\bcall for help\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  if (/\bi(?:'m| am) having an emergency\b/i.test(clause)) return true;
  if (/\bthis is an emergency\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  if (/\bsend help\b/i.test(clause) && isDirectAddressToHerald(clause)) return true;
  return false;
}

function matchesEmergencySignal0(text: string): boolean {
  if (hasFirstPersonDistressNeedHelp(text)) return true;
  for (const clause of splitDirectAddressClauses(text.trim())) {
    if (matchesSignal0Clause(clause)) return true;
  }
  return false;
}

export function detectEmergency(text: string): boolean {
  if (matchesEmergencySignal0(text)) return true;
  if (EMERGENCY_SIGNALS[1].test(text)) return true;
  return isDirectDistressHelpMe(text);
}
