// src/routing/grocerySemanticDecomposition.ts
// Grocery Semantic Decomposition V1 — probabilistic proposal + deterministic
// grounding/admission. The interpreter proposes meaning only. Persistence
// remains DOMAIN_WRITERS.list_add (Grocery Integrity V1). P2 travels
// source:'llm' through the existing applyIntents Build C confirm gate.
//
// This module contains NO database access, NO session/pending mutation, and
// NO write authority.

import type { LlamaContext } from 'llama.rn';
import { findStandardSpan } from '../hooks/llmLayers';
import { isLlamaContextBusy } from '../utils/llamaContextExclusive';
import { isReadShapedUtterance } from '../utils/detectMedicalEvent';
import { shouldRefuseLlmCaptureProposal } from './speechActAuthority';

export const GROCERY_SEMANTIC_CAPABILITIES = ['grocery_capture', 'not_grocery_capture', 'uncertain'] as const;
export type GrocerySemanticCapability = (typeof GROCERY_SEMANTIC_CAPABILITIES)[number];

export type GrocerySemanticProposal = {
  capability: GrocerySemanticCapability;
  candidates: string[];
  confidence: number;
};

export type GroceryProposalGenerationResult =
  | { status: 'ok'; proposal: GrocerySemanticProposal }
  | { status: 'parse_fail'; raw: string }
  | { status: 'unavailable'; reason: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error' };

export type GroceryAdmissionDecision =
  | { decision: 'ADMIT'; candidates: string[]; admissionClass: 'P1' | 'P2' }
  | { decision: 'REJECT'; reason: string }
  | { decision: 'CLARIFY'; reason: string }
  | { decision: 'DEFER'; reason: string };

const GROCERY_SEMANTIC_CONFIDENCE_THRESHOLD = 0.6;
const GROCERY_SEMANTIC_TIMEOUT_MS = 8000;

function logGrocerySemantic(event: string, extra: Record<string, unknown> = {}) {
  console.warn('[grocerySemanticDecomposition] ' + JSON.stringify({ event, ...extra }));
}

export function parseGrocerySemanticProposal(rawModelOutput: string): GrocerySemanticProposal | null {
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
  if (typeof o.capability !== 'string') return null;
  if (!(GROCERY_SEMANTIC_CAPABILITIES as readonly string[]).includes(o.capability)) return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
  if (o.confidence < 0 || o.confidence > 1) return null;
  if (!Array.isArray(o.candidates)) return null;
  const candidates: string[] = [];
  for (const c of o.candidates) {
    if (typeof c !== 'string') return null;
    candidates.push(c);
  }
  return {
    capability: o.capability as GrocerySemanticCapability,
    candidates,
    confidence: o.confidence,
  };
}

/** Every candidate must be a verbatim utterance span. One miss rejects the set. */
export function groundGroceryCandidates(raw: string, candidates: string[]): string[] | null {
  const grounded: string[] = [];
  for (const c of candidates) {
    const span = findStandardSpan(raw, c);
    if (!span) return null;
    const trimmed = span.trim();
    if (!trimmed) return null;
    grounded.push(trimmed);
  }
  if (grounded.length === 0) return null;
  return grounded;
}

export function formatGroceryCaptureConfirmPrompt(items: string[]): string {
  const named = formatSpokenItemList(items);
  const pronoun = items.length === 1 ? 'it' : 'them';
  return `It sounds like you want ${named} added to your grocery list. Want me to add ${pronoun}?`;
}

function formatSpokenItemList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function speechActBlocksGroceryCapture(raw: string): boolean {
  if (isReadShapedUtterance(raw)) return true;
  return shouldRefuseLlmCaptureProposal(raw, [{ type: 'list_add', items: ['x'], listName: 'grocery' }]);
}

export function admitGrocerySemanticP1(
  raw: string,
  proposal: GrocerySemanticProposal,
): GroceryAdmissionDecision {
  if (proposal.capability !== 'grocery_capture') {
    return { decision: 'DEFER', reason: 'p1_capability_not_grocery_capture' };
  }
  if (proposal.confidence < GROCERY_SEMANTIC_CONFIDENCE_THRESHOLD) {
    return { decision: 'CLARIFY', reason: 'low_confidence' };
  }
  const grounded = groundGroceryCandidates(raw, proposal.candidates);
  if (!grounded) {
    logGrocerySemantic('grounding_failed', { admissionClass: 'P1', candidateCount: proposal.candidates.length });
    return { decision: 'REJECT', reason: 'ungrounded_candidate' };
  }
  logGrocerySemantic('grounding_ok', { admissionClass: 'P1', candidateCount: grounded.length });
  return { decision: 'ADMIT', candidates: grounded, admissionClass: 'P1' };
}

export function admitGrocerySemanticP2(
  raw: string,
  proposal: GrocerySemanticProposal,
  ctx: { hasPending: boolean },
): GroceryAdmissionDecision {
  if (ctx.hasPending) return { decision: 'DEFER', reason: 'pending_owns_turn' };
  if (speechActBlocksGroceryCapture(raw)) {
    return { decision: 'REJECT', reason: 'speech_act_refuse' };
  }
  if (proposal.capability === 'uncertain' || proposal.capability === 'not_grocery_capture') {
    return { decision: 'REJECT', reason: `capability_${proposal.capability}` };
  }
  if (proposal.capability !== 'grocery_capture') {
    return { decision: 'REJECT', reason: 'capability_unknown' };
  }
  if (proposal.confidence < GROCERY_SEMANTIC_CONFIDENCE_THRESHOLD) {
    return { decision: 'CLARIFY', reason: 'low_confidence' };
  }
  const grounded = groundGroceryCandidates(raw, proposal.candidates);
  if (!grounded) {
    logGrocerySemantic('grounding_failed', { admissionClass: 'P2', candidateCount: proposal.candidates.length });
    return { decision: 'REJECT', reason: 'ungrounded_candidate' };
  }
  if (shouldRefuseLlmCaptureProposal(raw, [{ type: 'list_add', items: grounded, listName: 'grocery' }])) {
    return { decision: 'REJECT', reason: 'speech_act_refuse' };
  }
  logGrocerySemantic('grounding_ok', { admissionClass: 'P2', candidateCount: grounded.length });
  return { decision: 'ADMIT', candidates: grounded, admissionClass: 'P2' };
}

export const GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT = `You extract JSON describing whether a sentence is asking to add grocery items, for grocery interpretation only.
Do not claim any action occurred. Do not invent items not present in the sentence.
Return ONLY a JSON object with these keys:
capability: one of "grocery_capture", "not_grocery_capture", "uncertain"
candidates: array of strings — each string MUST be copied verbatim from the sentence; each is one grocery item as the sentence means it; empty array if none
confidence: number 0 to 1
Describe the sentence, not the world. Never resolve or normalize a name. confidence never authorizes a capture by itself.
If the sentence treats a multi-word food name as one item, emit it as one candidate.`;

let interpreterInFlight = false;

export async function generateGrocerySemanticProposal(
  raw: string,
  getCtx: () => LlamaContext | null,
): Promise<GroceryProposalGenerationResult> {
  logGrocerySemantic('interpreter_invoke');
  const ctx = getCtx();
  if (!ctx) {
    logGrocerySemantic('interpreter_unavailable', { reason: 'no_ctx' });
    return { status: 'unavailable', reason: 'no_ctx' };
  }
  if (interpreterInFlight) {
    logGrocerySemantic('interpreter_unavailable', { reason: 'in_flight' });
    return { status: 'unavailable', reason: 'in_flight' };
  }
  if (isLlamaContextBusy()) {
    logGrocerySemantic('interpreter_unavailable', { reason: 'busy' });
    return { status: 'unavailable', reason: 'busy' };
  }
  interpreterInFlight = true;
  try {
    const completion = ctx.completion({
      messages: [
        { role: 'system', content: GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT },
        { role: 'user', content: raw },
      ],
      n_predict: 128,
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    } as any);
    const timed = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), GROCERY_SEMANTIC_TIMEOUT_MS);
    });
    const result = await Promise.race([completion, timed]);
    const text = String((result as any)?.content || (result as any)?.text || '').trim();
    const proposal = parseGrocerySemanticProposal(text);
    if (!proposal) {
      logGrocerySemantic('parse_fail');
      return { status: 'parse_fail', raw: text };
    }
    logGrocerySemantic('proposal', {
      capability: proposal.capability,
      candidateCount: proposal.candidates.length,
      confidence: proposal.confidence,
    });
    return { status: 'ok', proposal };
  } catch (e) {
    const reason = String(e).includes('timeout') ? 'timeout' : 'error';
    logGrocerySemantic('interpreter_unavailable', { reason });
    return { status: 'unavailable', reason };
  } finally {
    interpreterInFlight = false;
  }
}

export async function tryP1GrocerySemanticItems(
  raw: string,
  getCtx: () => LlamaContext | null,
): Promise<string[] | null> {
  const generation = await generateGrocerySemanticProposal(raw, getCtx);
  if (generation.status !== 'ok') return null;
  const admission = admitGrocerySemanticP1(raw, generation.proposal);
  if (admission.decision !== 'ADMIT') return null;
  logGrocerySemantic('p1_admit', { candidateCount: admission.candidates.length });
  return admission.candidates;
}
