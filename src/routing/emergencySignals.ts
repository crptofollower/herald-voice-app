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

export const EMERGENCY_SIGNALS = [
  // was: /\b(i need help|call for help|i('m| am) having an emergency|this is an emergency|send help)\b/i
  // widened: tolerates "really/actually/honestly/kind of" etc. between "I" and "need help" —
  // C-J's own canonical example ("Ok I really need help now") is the reason this exists.
  /\bi\b.{0,15}\bneed(?:s|ed)?\s+help\b|\bcall for help\b|\bi('m| am) having an emergency\b|\bthis is an emergency\b|\bsend help\b/i,
  /\bhelp me\b(?!\s+(?:find|remember|with|look|check|set|add|show|get|open|play|call|text|remind|schedule|book|order|understand|explain|figure|make|write|read|tell|search|navigate|go|turn|start|stop|cancel))/i,
  /\bherald.{0,10}(help|emergency|i('m| am) scared|i('ve| have) fallen)\b/i,
];

export function detectEmergency(text: string): boolean {
  return EMERGENCY_SIGNALS.some(p => p.test(text));
}
