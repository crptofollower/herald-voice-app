// CONV-C1 — speech-act authority fence (D1 + D3, build one).
// Pure, synchronous, side-effect-free. No DB, network, LLM, or history.
//
// An LLM proposal does not acquire capture/action authority merely because it
// is structurally valid. REFUSE → caller treats proposals like a pass filter.

import type { IntentRecord } from '../hooks/llmLayers';
import { FAMILY_SYNONYMS } from '../utils/familyRead';
import { utteranceRequiresBoundedPastEventAck } from '../utils/predicateExtensionContainment';
import { isDirectAddressToHerald, utteranceHasThirdPartyFiniteAction } from './directAddress';
import {
  IMPERATIVE_ACTION_RE,
  REMINDER_SIGNALS,
  NOTE_CAPTURE_SIGNALS,
  LIST_ADD_SIGNALS,
  TODO_ADD_PREFIX,
  COMPLETED_PAST_FIRST_PERSON_RE,
} from '../utils/instructionSignals';

/** State-capture intent types (durable attribute writes). */
const STATE_CAPTURE_TYPES = new Set<string>([
  'family_capture', 'medical_capture', 'medical_visit', 'medical_visit_upcoming',
  'doctor_intro_capture', 'diagnosis_capture', 'insurance_capture', 'service_capture',
  'phone_capture', 'address_capture', 'emergency_contact',
]);

/** Action/task intent types. */
const ACTION_TASK_TYPES = new Set<string>(['contact_call', 'todo_add', 'list_add']);

// Single-owner interaction/report verb vocabulary (Phase 1: none existed).
const INTERACTION_REPORT_VERBS =
  'called|texted|messaged|emailed|visited|phoned|rang|contacted|reached out|dropped by|stopped by|came by';

const RELATION_ALT = Object.keys(FAMILY_SYNONYMS)
  .sort((a, b) => b.length - a.length)
  .map(r => r.replace(/-/g, '\\-'))
  .join('|');

// C1-only explicit-instruction extensions — NOT merged into NOTE_CAPTURE_SIGNALS
// (would broaden tier-1 note_capture routing).
const EXPLICIT_INSTRUCTION_NOTE_EXTENSIONS = [
  /\bremember\s+my\s+/i,
  /\b(?:note|jot|write down|record)\s+(?:that\s+)?my\s+/i,
];

const DECLARATIVE_FAMILY_CAPTURE_RE = [
  new RegExp(String.raw`\bmy\s+(${RELATION_ALT})\s+is\s+`, 'i'),
  new RegExp(String.raw`\bmy\s+(${RELATION_ALT})'?s\s+name\s+is\s+`, 'i'),
  new RegExp(String.raw`\bmy\s+(${RELATION_ALT})\b[^.?]*\bname\s+is\s+`, 'i'),
];

const INTERACTION_REPORT_RE = new RegExp(
  String.raw`\bmy\s+(${RELATION_ALT})(?:\s+([A-Za-z][A-Za-z'\-]+))?\b[^.?!]*\b(${INTERACTION_REPORT_VERBS})\b`,
  'i',
);

/** Exported for ephemeral zero-evidence gate — existing D1 narration shape only. */
export function utteranceHasInteractionReportShape(utterance: string): boolean {
  return INTERACTION_REPORT_RE.test(utterance);
}

// First-person interaction/report: the user is narrating their own exchange.
// Same verb class as D1, plus talked/spoke; not a family-relation subject.
// Questions are excluded so "tell me about NAME" / "what does NAME…" stay closed.
const FIRST_PERSON_INTERACTION_REPORT_RE = new RegExp(
  String.raw`^\s*I\s+(?:already\s+)?(?:talked to|spoke with|spoke to|${INTERACTION_REPORT_VERBS})\b`,
  'i',
);

/** User-authored interaction report — content is supplied by the speaker, not requested from Herald. */
export function utteranceHasUserAuthoredInteractionReportShape(utterance: string): boolean {
  const t = utterance.trim();
  if (!t || /\?\s*$/.test(t)) return false;
  if (utteranceHasInteractionReportShape(t)) return true;
  return FIRST_PERSON_INTERACTION_REPORT_RE.test(t);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tokenInText(haystack: string, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  return new RegExp(String.raw`\b${escapeRegExp(t)}\b`, 'i').test(haystack);
}

/** Explicit instruction directed at Herald outranks every refusal rule. */
export function isExplicitInstructionToHerald(utterance: string): boolean {
  const t = utterance.trim();
  if (!t) return false;

  for (const clause of t.split(/[,;]/)) {
    if (IMPERATIVE_ACTION_RE.test(clause.trim())) return true;
  }
  if (REMINDER_SIGNALS.some(p => p.test(t))) return true;
  if (NOTE_CAPTURE_SIGNALS.some(p => p.test(t))) return true;
  if (EXPLICIT_INSTRUCTION_NOTE_EXTENSIONS.some(p => p.test(t))) return true;
  if (LIST_ADD_SIGNALS.some(p => p.test(t))) return true;
  if (TODO_ADD_PREFIX.test(t)) return true;
  if (DECLARATIVE_FAMILY_CAPTURE_RE.some(p => p.test(t))) return true;
  return false;
}

function subjectPrefixBeforeInteractionVerb(utterance: string): string | null {
  const m = utterance.match(INTERACTION_REPORT_RE);
  if (!m) return null;
  const verb = m[3];
  const idx = utterance.toLowerCase().indexOf(verb.toLowerCase());
  if (idx <= 0) return null;
  return utterance.slice(0, idx);
}

function allStateCaptureStringSlotsFromSubject(
  intents: IntentRecord[],
  subjectPrefix: string,
): boolean {
  let sawStateCapture = false;
  for (const intent of intents) {
    if (!STATE_CAPTURE_TYPES.has(intent.type)) continue;
    sawStateCapture = true;
    const rec = intent as Record<string, unknown>;
    for (const [key, val] of Object.entries(rec)) {
      if (key === 'type' || key === 'raw') continue;
      if (typeof val !== 'string' || !val.trim()) continue;
      if (!tokenInText(subjectPrefix, val)) return false;
    }
  }
  return sawStateCapture;
}

/** D1 — third-party interaction report narration → state-capture proposals. */
export function isD1InteractionReportRefusal(
  utterance: string,
  intents: IntentRecord[],
): boolean {
  if (!intents.some(i => STATE_CAPTURE_TYPES.has(i.type))) return false;
  const prefix = subjectPrefixBeforeInteractionVerb(utterance);
  if (!prefix) return false;
  return allStateCaptureStringSlotsFromSubject(intents, prefix);
}

/** D3 — completed first-person past action narration → action/task proposals. */
export function isD3CompletedPastActionRefusal(
  utterance: string,
  intents: IntentRecord[],
): boolean {
  if (!intents.some(i => ACTION_TASK_TYPES.has(i.type))) return false;
  return COMPLETED_PAST_FIRST_PERSON_RE.test(utterance);
}

/** D4 — bounded personal-event narration → state-capture proposals (model path). */
export function isD4BoundedPersonalEventRefusal(
  utterance: string,
  intents: IntentRecord[],
): boolean {
  if (!intents.some(i => STATE_CAPTURE_TYPES.has(i.type))) return false;
  return utteranceRequiresBoundedPastEventAck(utterance);
}

/** D5 — action/task proposal sourced from third-party/narrative speech. */
export function isD5NarrativeActionRefusal(
  utterance: string,
  intents: IntentRecord[],
): boolean {
  if (!intents.some((i) => ACTION_TASK_TYPES.has(i.type))) return false;
  if (!utteranceHasThirdPartyFiniteAction(utterance)) return false;
  return !isDirectAddressToHerald(utterance);
}

/**
 * True when LLM proposals must be refused (same effect as pass-filter empty).
 * Evaluation order: explicit instruction → D1 → D3 → D4 → D5 → otherwise survive.
 */
export function shouldRefuseLlmCaptureProposal(
  utterance: string,
  intents: IntentRecord[],
): boolean {
  if (intents.length === 0) return false;
  if (isExplicitInstructionToHerald(utterance)) return false;
  if (isD1InteractionReportRefusal(utterance, intents)) return true;
  if (isD3CompletedPastActionRefusal(utterance, intents)) return true;
  if (isD4BoundedPersonalEventRefusal(utterance, intents)) return true;
  if (isD5NarrativeActionRefusal(utterance, intents)) return true;
  return false;
}
