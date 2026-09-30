/**
 * Read-only shaping of journey turn evidence. Does not decide a route.
 */
import { deterministicAcknowledgementSpeech, type ResponseAct } from '../routing/responseAct';
import type { JourneyScriptHit } from './journeyScriptedCompletion';

export type FiveSliceDiscourseMention = {
  surfaceSpan: string;
  kind: string;
  status: string;
  durable: boolean;
};

export type FiveSliceSemanticAdmission = {
  decision: string;
  reason: string | null;
  capability: string | null;
};

export type FiveSliceTurnEvidence = {
  evidenceClass: 'injected' | 'deterministic';
  scriptedCompletions: JourneyScriptHit[];
  immediateRecap: Record<string, unknown> | null;
  discourseMentions: FiveSliceDiscourseMention[];
  semanticAdmission: FiveSliceSemanticAdmission | null;
};

const RECAP_MARKER = 'HERALD_IMMEDIATE_RECAP_DIAG ';
const LATENCY_MARKER = '[LATENCY-INSTRUMENT] ';

export function parseImmediateRecapDiagLine(line: string): Record<string, unknown> | null {
  const at = line.indexOf(RECAP_MARKER);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at + RECAP_MARKER.length)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseSemanticAdmissionLine(line: string): FiveSliceSemanticAdmission | null {
  const at = line.indexOf(LATENCY_MARKER);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(at + LATENCY_MARKER.length)) as Record<string, unknown>;
    if (parsed.event !== 'SEMANTIC_ADMISSION_DONE') return null;
    return {
      decision: typeof parsed.decision === 'string' ? parsed.decision : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      capability: typeof parsed.capability === 'string' ? parsed.capability : null,
    };
  } catch {
    return null;
  }
}

/**
 * Journey envelope response only. Does not select an act or change the utterance result.
 * An unhandled acknowledgement is copied from the act. Any response already chosen is kept.
 */
export function applyJourneyAcknowledgementResponse(outcome: unknown, response: string | null): string | null {
  if (response != null) return response;
  if (!outcome || typeof outcome !== 'object') return null;
  const record = outcome as { handled?: unknown; responseAct?: unknown };
  if (record.handled !== false) return null;
  const act = record.responseAct;
  if (!act || typeof act !== 'object') return null;
  return deterministicAcknowledgementSpeech(act as ResponseAct);
}

export function buildFiveSliceTurnEvidence(input: {
  hits: readonly JourneyScriptHit[];
  immediateRecap: Record<string, unknown> | null;
  discourseMentions: readonly FiveSliceDiscourseMention[];
  semanticAdmission: FiveSliceSemanticAdmission | null;
}): FiveSliceTurnEvidence {
  return {
    evidenceClass: input.hits.length > 0 ? 'injected' : 'deterministic',
    scriptedCompletions: input.hits.slice(),
    immediateRecap: input.immediateRecap,
    discourseMentions: input.discourseMentions.slice(),
    semanticAdmission: input.semanticAdmission,
  };
}
