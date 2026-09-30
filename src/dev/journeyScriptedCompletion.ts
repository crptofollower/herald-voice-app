/**
 * Journey-only scripted semantic completions.
 * Production routers do not import this module. A completion is scripted only
 * when the journey host has armed a five-slice scenario and the caller uses
 * the context returned by wrapJourneySemanticCtx.
 */
import { ACTIVE_SUBJECT_SELECTION_SYSTEM_PROMPT } from '../routing/activeSubjectReference';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../routing/capabilityRouting';
import { MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../routing/medicationSemanticInterpretation';
import { RECAP_INTERPRETATION_SYSTEM_PROMPT } from '../routing/immediateSemanticRecap';
import { RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../routing/recollectionSemanticNomination';
import {
  DISCOURSE_APPLICABILITY_PROMPT,
  DISCOURSE_CORRECTION_PROMPT,
  DISCOURSE_MENTION_PROPOSAL_PROMPT,
} from '../routing/semanticProvider';

export const FIVE_SLICE_SCENARIO_IDS = [
  'five_slice_continuity',
  'five_slice_medication_floor',
  'five_slice_recap_reachability',
  'five_slice_catalog_owner',
  'five_slice_recap_veto',
  'five_slice_correction_fallthrough',
  'five_slice_bounded_reject',
  'five_slice_bounded_admit',
  'five_slice_focus_purity',
] as const;

export const FIVE_SLICE_SCENARIO_COUNT = FIVE_SLICE_SCENARIO_IDS.length;

const SCRIPTED_SCENARIO_IDS = new Set<string>([
  'five_slice_recap_veto',
  'five_slice_correction_fallthrough',
  'five_slice_bounded_reject',
  'five_slice_bounded_admit',
  'five_slice_focus_purity',
]);

export const FIVE_SLICE_MENTION_CLOSED = '[{"span":"Ireland","kind":"place"}]';
export const FIVE_SLICE_MENTION_PROSE = `I found this: ${FIVE_SLICE_MENTION_CLOSED}`;
export const FIVE_SLICE_IMPURE_FOCUS = 'my Lisinopril 10mg refill';

export const FIVE_SLICE_FOCUS_PURITY_TEXT = JSON.stringify({
  capability: 'medication.capture',
  confidence: 'high',
  mentions: [FIVE_SLICE_IMPURE_FOCUS],
  predicate: 'filled',
  focus: FIVE_SLICE_IMPURE_FOCUS,
  score: 0.9,
});

export const FIVE_SLICE_RECAP_VETO_TEXT = '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.99}';

export type JourneyScriptHit = {
  id: string;
  promptKind: string;
  text: string;
};

let armedScenario: string | null = null;
let hits: JourneyScriptHit[] = [];

export function armJourneyScriptedCompletion(scenarioId: string | null): void {
  hits = [];
  armedScenario = scenarioId && SCRIPTED_SCENARIO_IDS.has(scenarioId) ? scenarioId : null;
}

export function clearJourneyScriptedCompletion(): void {
  armedScenario = null;
  hits = [];
}

export function journeyScriptedCompletionArmed(): boolean {
  return armedScenario !== null;
}

export function peekJourneyScriptedCompletions(): JourneyScriptHit[] {
  return hits.slice();
}

function promptBlob(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const row = params as Record<string, unknown>;
  if (typeof row.prompt === 'string') return row.prompt;
  if (!Array.isArray(row.messages)) return '';
  return row.messages.map((message) => {
    if (!message || typeof message !== 'object') return '';
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
  }).join('\n');
}

export function journeyScriptPromptKind(params: unknown): string {
  const blob = promptBlob(params);
  if (blob.startsWith(DISCOURSE_CORRECTION_PROMPT)) return 'discourse_correction';
  if (blob.startsWith(DISCOURSE_APPLICABILITY_PROMPT)) return 'discourse_applicability';
  if (blob.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) return 'discourse_mention';
  if (blob.includes(CAPABILITY_PROPOSAL_SYSTEM_PROMPT)) return 'capability';
  if (blob.includes(RECAP_INTERPRETATION_SYSTEM_PROMPT)) return 'recap';
  if (blob.includes(MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT)) return 'medication';
  if (blob.includes(RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT)) return 'recollection';
  if (blob.includes(ACTIVE_SUBJECT_SELECTION_SYSTEM_PROMPT)) return 'active_subject';
  return 'unknown';
}

function packetCandidates(prompt: string): Array<{ handle: string; surfaceSpan: string }> {
  const start = prompt.indexOf('{');
  if (start < 0) return [];
  try {
    const packet = JSON.parse(prompt.slice(start)) as { candidates?: unknown };
    if (!Array.isArray(packet.candidates)) return [];
    const out: Array<{ handle: string; surfaceSpan: string }> = [];
    for (const candidate of packet.candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const row = candidate as { handle?: unknown; surfaceSpan?: unknown };
      if (typeof row.handle !== 'string') continue;
      out.push({
        handle: row.handle,
        surfaceSpan: typeof row.surfaceSpan === 'string' ? row.surfaceSpan : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function mentionText(scenarioId: string, blob: string): JourneyScriptHit {
  if (scenarioId === 'five_slice_bounded_reject') {
    return { id: 'fs-mention-prose', promptKind: 'discourse_mention', text: FIVE_SLICE_MENTION_PROSE };
  }
  if (scenarioId === 'five_slice_bounded_admit') {
    return { id: 'fs-mention-closed', promptKind: 'discourse_mention', text: FIVE_SLICE_MENTION_CLOSED };
  }
  if (scenarioId === 'five_slice_correction_fallthrough' && blob.includes('about his trip to Ireland')) {
    return { id: 'fs-mention-closed', promptKind: 'discourse_mention', text: FIVE_SLICE_MENTION_CLOSED };
  }
  return { id: 'fs-mention-empty', promptKind: 'discourse_mention', text: '[]' };
}

/** Deterministic proposal bytes for one armed scenario and one completion request. */
export function selectJourneyScriptedCompletion(scenarioId: string, params: unknown): JourneyScriptHit {
  const kind = journeyScriptPromptKind(params);
  const blob = promptBlob(params);
  if (kind === 'discourse_correction' && scenarioId === 'five_slice_correction_fallthrough') {
    const marks = packetCandidates(blob).map((candidate) => ({
      handle: candidate.handle,
      mark: 'incompatible' as const,
    }));
    return {
      id: 'fs-correction-rejected',
      promptKind: kind,
      text: JSON.stringify({
        correction_turn: true,
        target_marks: marks,
        replacement_marks: [],
        new_spans: [],
      }),
    };
  }
  if (kind === 'discourse_applicability' && scenarioId === 'five_slice_correction_fallthrough') {
    const marks = packetCandidates(blob).map((candidate) => ({
      handle: candidate.handle,
      mark: candidate.surfaceSpan === 'Ireland' ? 'compatible' as const : 'incompatible' as const,
    }));
    return {
      id: 'fs-applicability-ireland',
      promptKind: kind,
      text: JSON.stringify({
        utterance_applicable: true,
        reference_attempt: true,
        marks,
      }),
    };
  }
  if (kind === 'discourse_mention') return mentionText(scenarioId, blob);
  if (kind === 'capability' && scenarioId === 'five_slice_focus_purity') {
    return { id: 'fs-focus-purity', promptKind: kind, text: FIVE_SLICE_FOCUS_PURITY_TEXT };
  }
  if (kind === 'medication' && scenarioId === 'five_slice_focus_purity') {
    return {
      id: 'fs-focus-purity',
      promptKind: kind,
      text: JSON.stringify({
        mentions: [FIVE_SLICE_IMPURE_FOCUS],
        predicate: 'filled',
        focus: FIVE_SLICE_IMPURE_FOCUS,
        confidence: 0.9,
      }),
    };
  }
  if (kind === 'capability' && scenarioId === 'five_slice_recap_veto') {
    return {
      id: 'fs-capability-abstain',
      promptKind: kind,
      text: JSON.stringify({ capability: 'other', confidence: 'low' }),
    };
  }
  if (kind === 'recap' && scenarioId === 'five_slice_recap_veto') {
    return { id: 'fs-recap-veto', promptKind: kind, text: FIVE_SLICE_RECAP_VETO_TEXT };
  }
  if (kind === 'recollection') {
    return { id: 'fs-recollection-shadow-abstain', promptKind: kind, text: '' };
  }
  if (kind === 'active_subject') {
    return {
      id: 'fs-active-subject-abstain',
      promptKind: kind,
      text: JSON.stringify({ applicable: false, selectedIndex: null, ambiguous: false, confidence: 0.1 }),
    };
  }
  return { id: 'fs-unscripted', promptKind: kind, text: '' };
}

/**
 * Returns the real context until a five-slice scenario is armed.
 * An armed context never forwards the completion to a live model.
 */
export function wrapJourneySemanticCtx<T>(real: T): T {
  if (!armedScenario) return real;
  const scenarioId = armedScenario;
  const completion = async (params: unknown) => {
    const selected = selectJourneyScriptedCompletion(scenarioId, params);
    hits.push(selected);
    return { text: selected.text, content: selected.text };
  };
  if (real && typeof real === 'object') {
    return { ...(real as object), completion } as T;
  }
  return { completion } as T;
}
