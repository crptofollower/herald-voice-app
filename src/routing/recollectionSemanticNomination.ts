// Recollection semantic nominator — probabilistic proposal only.
// Dedicated closed-label contract. No DB, no Track-T, no Track-R writes.
// On-device ctx.completion only. Unknown/malformed/unavailable → UNCERTAIN.

import { isLlamaContextBusy } from '../utils/llamaContextExclusive';
import { runSharedSemanticCompletion } from '../utils/semanticCompletionLifecycle';
import { hasSensitiveRecollectionBackstop } from '../utils/reminiscenceAdmission';
import {
  REMINISCENCE_DISPOSITIONS,
  type ReminiscenceDisposition,
  type ReminiscenceNominationContext,
} from '../utils/reminiscenceDisposition';

type RecollectionSemanticCtx = {
  completion: (args: unknown) => Promise<unknown> | unknown;
};

export const RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT = `You classify one spoken utterance for autobiographical recollection admission.
You have no memory authority and must not invent facts, names, or rewritten sentences.
Return ONLY a JSON object with keys:
disposition: one of AUTOBIOGRAPHICAL, CONTINUE_ARC, TRANSIENT, SENSITIVE, THIRD_PARTY, UNCERTAIN
confidence: number 0 to 1
reason: optional short code, never a stored memory
Rules:
- AUTOBIOGRAPHICAL: the speaker recounts their own past experience, including mundane or everyday history. Do not require importance, drama, or a childhood cue phrase.
- CONTINUE_ARC: only when arc_open is true AND the utterance is a short continuation or answer that depends on the already-open personal recollection. If the referent is too thin to be a continuation, UNCERTAIN.
- TRANSIENT: present-tense or passing chatter, not a retained personal past.
- SENSITIVE: health/medical, financial, legal, credentials/secrets, or mixed sensitive content. Treat the whole utterance as SENSITIVE. Do not split.
- THIRD_PARTY: someone else's story as the primary content, without the speaker's own autobiographical claim.
- UNCERTAIN: residue, fragments, or anything you cannot place in the labels above.
Never emit any other label. Never claim a write occurred.`;

export const RECOLLECTION_SEMANTIC_TIMEOUT_MS = 8000;

// Observational only. OFF ⇒ C4 never awaits the interpreter. Production
// conversational tail must remain trivial when the local ctx is absent.
export const RECOLLECTION_SEMANTIC_SHADOW_ENABLED = true;

export type RecollectionSemanticGeneration =
  | { status: 'ok'; disposition: ReminiscenceDisposition; confidence?: number; reason?: string; raw: string; durationMs: number }
  | { status: 'parse_fail'; raw: string; durationMs: number }
  | { status: 'unavailable'; reason: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error'; durationMs: number };

export type RecollectionSemanticShadow = {
  stubDisposition: ReminiscenceDisposition | null;
  status: RecollectionSemanticGeneration['status'] | 'sensitive_override';
  unavailableReason?: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error';
  modelDisposition: ReminiscenceDisposition | null;
  effectiveDisposition: ReminiscenceDisposition;
  sensitiveOverride: boolean;
  confidence?: number;
  reason?: string;
  raw?: string;
  durationMs?: number;
};

export function shouldObserveRecollectionSemanticShadow(
  getCtx: (() => RecollectionSemanticCtx | null) | undefined,
): boolean {
  if (!RECOLLECTION_SEMANTIC_SHADOW_ENABLED) return false;
  if (typeof getCtx !== 'function') return false;
  if (!getCtx()) return false;
  if (isLlamaContextBusy()) return false;
  return true;
}

export function parseRecollectionSemanticProposal(rawModelOutput: string): {
  disposition: ReminiscenceDisposition;
  confidence?: number;
  reason?: string;
} | null {
  const start = rawModelOutput.indexOf('{');
  const end = rawModelOutput.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawModelOutput.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.disposition !== 'string') return null;
  if (!(REMINISCENCE_DISPOSITIONS as readonly string[]).includes(o.disposition)) return null;
  let confidence: number | undefined;
  if (o.confidence !== undefined) {
    if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
    if (o.confidence < 0 || o.confidence > 1) return null;
    confidence = o.confidence;
  }
  let reason: string | undefined;
  if (o.reason !== undefined) {
    if (typeof o.reason !== 'string') return null;
    reason = o.reason.slice(0, 80);
  }
  return {
    disposition: o.disposition as ReminiscenceDisposition,
    confidence,
    reason,
  };
}

let shadowCalls = 0;
let lastShadow: RecollectionSemanticShadow | null = null;

export function getRecollectionSemanticShadowCount(): number {
  return shadowCalls;
}

export function peekLastRecollectionSemanticShadow(): RecollectionSemanticShadow | null {
  return lastShadow;
}

export function resetRecollectionSemanticShadow(): void {
  shadowCalls = 0;
  lastShadow = null;
}

function logRecollectionSemantic(event: string, extra: Record<string, unknown> = {}) {
  console.warn('[recollectionSemanticNomination] ' + JSON.stringify({ event, ...extra }));
}

export async function generateRecollectionSemanticProposal(
  raw: string,
  getCtx: () => RecollectionSemanticCtx | null,
  opts?: { timeoutMs?: number; arcOpen?: boolean },
): Promise<RecollectionSemanticGeneration> {
  const started = Date.now();
  logRecollectionSemantic('interpreter_invoke');
  const run = await runSharedSemanticCompletion(getCtx, {
    messages: [
      { role: 'system', content: RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `arc_open: ${opts?.arcOpen === true ? 'true' : 'false'}\nutterance: ${raw}`,
      },
    ],
    n_predict: 96,
    temperature: 0,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
  }, {
    callerDeadlineMs: opts?.timeoutMs ?? RECOLLECTION_SEMANTIC_TIMEOUT_MS,
  });
  if (run.status === 'unavailable') {
    logRecollectionSemantic('interpreter_unavailable', { reason: run.reason });
    return { status: 'unavailable', reason: run.reason, durationMs: Date.now() - started };
  }
  const result = run.value as { content?: string; text?: string };
  const text = String(result?.content || result?.text || '').trim();
  const proposal = parseRecollectionSemanticProposal(text);
  if (!proposal) {
    logRecollectionSemantic('parse_fail');
    return { status: 'parse_fail', raw: text, durationMs: Date.now() - started };
  }
  logRecollectionSemantic('proposal', { disposition: proposal.disposition });
  return {
    status: 'ok',
    disposition: proposal.disposition,
    confidence: proposal.confidence,
    reason: proposal.reason,
    raw: text,
    durationMs: Date.now() - started,
  };
}

function unavailableShadow(reason: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error'): RecollectionSemanticShadow {
  return {
    stubDisposition: null,
    status: 'unavailable',
    unavailableReason: reason,
    modelDisposition: null,
    effectiveDisposition: 'UNCERTAIN',
    sensitiveOverride: false,
    durationMs: 0,
  };
}

export async function observeRecollectionSemanticShadow(
  text: string,
  nomination: ReminiscenceNominationContext,
  getCtx: () => RecollectionSemanticCtx | null,
  stubDisposition: ReminiscenceDisposition,
  opts?: { timeoutMs?: number },
): Promise<RecollectionSemanticShadow> {
  shadowCalls += 1;
  try {
    const generation = await generateRecollectionSemanticProposal(text, getCtx, {
      timeoutMs: opts?.timeoutMs,
      arcOpen: nomination.arcOpen,
    });
    let modelDisposition: ReminiscenceDisposition | null = null;
    let effective: ReminiscenceDisposition = 'UNCERTAIN';
    let status: RecollectionSemanticShadow['status'] = generation.status;
    let unavailableReason: RecollectionSemanticShadow['unavailableReason'];
    let confidence: number | undefined;
    let reason: string | undefined;
    if (generation.status === 'ok') {
      modelDisposition = generation.disposition;
      effective = generation.disposition;
      confidence = generation.confidence;
      reason = generation.reason;
    } else if (generation.status === 'unavailable') {
      unavailableReason = generation.reason;
    }
    const sensitiveOverride = hasSensitiveRecollectionBackstop(text)
      && effective !== 'SENSITIVE';
    if (hasSensitiveRecollectionBackstop(text)) {
      effective = 'SENSITIVE';
      if (sensitiveOverride) status = 'sensitive_override';
    }
    lastShadow = {
      stubDisposition,
      status,
      unavailableReason,
      modelDisposition,
      effectiveDisposition: effective,
      sensitiveOverride,
      confidence,
      reason,
      raw: generation.status === 'ok' || generation.status === 'parse_fail' ? generation.raw : undefined,
      durationMs: generation.durationMs,
    };
    return lastShadow;
  } catch {
    lastShadow = {
      ...unavailableShadow('error'),
      stubDisposition,
    };
    return lastShadow;
  }
}
