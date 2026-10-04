// Stage B — high-recall emergency proposal. Zero authority.
// A hit may only ask Stage C to clarify. It never clears Law 0, dispatches,
// sends SMS, arms confirm_call, opens Linking, or dials.

export type EmergencyProposalSpan = {
  text: string;
  start: number;
  end: number;
  reason: string;
};

export type EmergencyProposal = {
  possibleEmergency: true;
  spans: EmergencyProposalSpan[];
  source: 'recall_trigger';
};

const CONCEPTS: Array<[RegExp, string]> = [
  [/\bbreath(?:e|ing)?\b/gi, 'breath/breathing'],
  [/\bchok(?:e|ing|ed)\b/gi, 'choking'],
  [/\bchest\b/gi, 'chest'],
  [/\bheart\b/gi, 'heart'],
  [/\bblood\b/gi, 'blood'],
  [/\bbleeding\b/gi, 'bleeding'],
  [/\bfall\b/gi, 'fall'],
  [/\bfell\b/gi, 'fell'],
  [/\bfallen\b/gi, 'fallen'],
  [/\bfloor\b/gi, 'floor'],
  [/\bfaint(?:ed|ing)?\b/gi, 'faint'],
  [/\bpass(?:ed|ing)?[\s-]*out\b/gi, 'pass out'],
  [/\bdizzy\b/gi, 'dizzy'],
  [/\bstroke\b/gi, 'stroke'],
  [/\bseizure\b/gi, 'seizure'],
  [/\bhurt(?:s|ing)?\b/gi, 'hurt'],
  [/\bpain\b/gi, 'pain'],
  [/\binjury\b/gi, 'injury'],
  [/\bscared\b/gi, 'scared'],
  [/\bafraid\b/gi, 'afraid'],
  [/\bemergency\b/gi, 'emergency'],
  [/\b911\b/gi, '911'],
  [/\bambulance\b/gi, 'ambulance'],
];

const INABILITY = /\b(?:cant|can(?:not|'t| not)|couldn'?t|unable to|not able to|won'?t let me)\b/i;
const MOBILITY = /\b(?:stand(?:\s*up)?|move|walk|rise|get(?:\s*(?:back\s*)?up|\s*off|\s*out|\s*myself\s+up|\s*down))\b/i;
const HELP_SELF_MOBILITY = /\b(?:(?:can|could|would|will)\s+you\s+)?help\s+me\s+(?:get\s+(?:myself\s+up|(?:back\s+)?up|out|off)|stand(?:\s+up)?)\b/i;
const STUCK = /\bstuck\b/gi;
const SURFACE = /\b(?:floor|ground|bed|chair|tub|bathtub|bath|shower|toilet|couch|stairs)\b/i;
const BODY_FAIL = /\b(?:legs?|knees?|body)\b[\s\S]{0,40}\b(?:giving out|gave out|not working|not moving|not holding)\b|\b(?:giving out|gave out|not working|not moving|not holding)\b[\s\S]{0,40}\b(?:legs?|knees?|body)\b/i;

function pushMatches(text: string, re: RegExp, reason: string, spans: EmergencyProposalSpan[]): void {
  const flags = re.global ? re.flags : `${re.flags}g`;
  const scanner = new RegExp(re.source, flags);
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    if (match[0].length === 0) {
      scanner.lastIndex += 1;
      continue;
    }
    spans.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      reason,
    });
  }
}

export function proposeEmergency(text: string): EmergencyProposal | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const spans: EmergencyProposalSpan[] = [];
  for (const [re, reason] of CONCEPTS) pushMatches(text, re, reason, spans);
  const inability = INABILITY.test(text);
  const mobility = MOBILITY.test(text);
  if (inability && mobility) {
    pushMatches(text, INABILITY, 'mobility-inability', spans);
    pushMatches(text, MOBILITY, 'mobility-inability', spans);
  }
  pushMatches(text, HELP_SELF_MOBILITY, 'help-self-mobility', spans);
  pushMatches(text, STUCK, 'stuck', spans);
  if (SURFACE.test(text) && (inability || mobility || /\b(?:fell|fallen|fall)\b/i.test(text))) {
    pushMatches(text, SURFACE, 'surface-context', spans);
  }
  pushMatches(text, BODY_FAIL, 'body-not-working', spans);
  if (spans.length === 0) return null;
  return { possibleEmergency: true, spans, source: 'recall_trigger' };
}
