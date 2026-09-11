// src/routing/todoSemanticCapture.ts
// Semantic todo.capture V1 — probabilistic proposal + deterministic
// grounding/admission. The interpreter proposes meaning only. Persistence
// remains DOMAIN_WRITERS.todo_add. P2 travels source:'llm' through the
// existing applyIntents Build C confirm gate.
//
// This module contains NO database access, NO session/pending mutation, and
// NO write authority. It does not use grocery list_add or grocery item
// normalization.

import type { LlamaContext } from 'llama.rn';
import { findStandardSpan } from '../hooks/llmLayers';
import { isLlamaContextBusy } from '../utils/llamaContextExclusive';
import {
  logSemanticAdmissionDone,
  logSemanticGroundingDone,
  logSemanticSpecialistInferenceEnd,
  logSemanticSpecialistInferenceStart,
  mono as latMono,
} from '../utils/latencyInstrument';
import { isReadShapedUtterance } from '../utils/detectMedicalEvent';
import { shouldRefuseLlmCaptureProposal } from './speechActAuthority';
import type { CapabilityProposal } from './capabilityRouting';

export const TODO_SEMANTIC_CAPABILITIES = ['todo_capture', 'not_todo_capture', 'uncertain'] as const;
export type TodoSemanticCapability = (typeof TODO_SEMANTIC_CAPABILITIES)[number];

export type TodoSemanticProposal = {
  capability: TodoSemanticCapability;
  candidates: string[];
  confidence: number;
};

export type TodoProposalGenerationResult =
  | { status: 'ok'; proposal: TodoSemanticProposal }
  | { status: 'parse_fail'; raw: string }
  | { status: 'unavailable'; reason: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error' };

export type TodoAdmissionDecision =
  | { decision: 'ADMIT'; candidates: string[]; admissionClass: 'P2' }
  | { decision: 'REJECT'; reason: string }
  | { decision: 'CLARIFY'; reason: string }
  | { decision: 'DEFER'; reason: string };

const TODO_SEMANTIC_TIMEOUT_MS = 8000;

function logTodoSemantic(event: string, extra: Record<string, unknown> = {}) {
  console.warn('[todoSemanticCapture] ' + JSON.stringify({ event, ...extra }));
}

export function parseTodoSemanticProposal(rawModelOutput: string): TodoSemanticProposal | null {
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
  if (!(TODO_SEMANTIC_CAPABILITIES as readonly string[]).includes(o.capability)) return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
  if (o.confidence < 0 || o.confidence > 1) return null;
  if (!Array.isArray(o.candidates)) return null;
  const candidates: string[] = [];
  for (const c of o.candidates) {
    if (typeof c !== 'string') return null;
    candidates.push(c);
  }
  return {
    capability: o.capability as TodoSemanticCapability,
    candidates,
    confidence: o.confidence,
  };
}

/** Lift a one-pass dispatch write payload into the specialist proposal shape. No inference. */
export function todoSemanticProposalFromDispatchWrite(
  proposal: CapabilityProposal,
): TodoSemanticProposal | null {
  if (proposal.capability !== 'todo.capture') return null;
  const write = proposal.write;
  if (!write) return null;
  if (write.op !== 'todo_capture' && write.op !== 'not_todo_capture' && write.op !== 'uncertain') {
    return null;
  }
  if (!write.candidates || write.score === undefined) return null;
  return {
    capability: write.op,
    candidates: write.candidates,
    confidence: write.score,
  };
}

/** Every candidate must be a verbatim utterance span. One miss rejects the set. */
export function groundTodoCandidates(raw: string, candidates: string[]): string[] | null {
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

export function formatTodoCaptureConfirmPrompt(tasks: string[]): string {
  const named = formatSpokenTaskList(tasks);
  const pronoun = tasks.length === 1 ? 'it' : 'them';
  return `It sounds like you want ${named} added to your to-do list. Want me to add ${pronoun}?`;
}

function formatSpokenTaskList(tasks: string[]): string {
  if (tasks.length === 0) return '';
  if (tasks.length === 1) return tasks[0];
  if (tasks.length === 2) return `${tasks[0]} and ${tasks[1]}`;
  return `${tasks.slice(0, -1).join(', ')}, and ${tasks[tasks.length - 1]}`;
}

function speechActBlocksTodoCapture(raw: string): boolean {
  if (isReadShapedUtterance(raw)) return true;
  return shouldRefuseLlmCaptureProposal(raw, [{ type: 'todo_add', body: 'x' }]);
}

function logAdmission(decision: TodoAdmissionDecision): TodoAdmissionDecision {
  const extra: Record<string, unknown> = { decision: decision.decision };
  if (decision.decision !== 'ADMIT') extra.reason = decision.reason;
  else extra.admissionClass = decision.admissionClass;
  logTodoSemantic('admission', extra);
  logSemanticAdmissionDone({
    capability: 'todo.capture',
    decision: decision.decision,
    ...(decision.decision !== 'ADMIT' ? { reason: decision.reason } : { admissionClass: decision.admissionClass }),
  });
  return decision;
}

export function admitTodoSemanticP2(
  raw: string,
  proposal: TodoSemanticProposal,
  ctx: { hasPending: boolean },
): TodoAdmissionDecision {
  if (ctx.hasPending) return logAdmission({ decision: 'DEFER', reason: 'pending_owns_turn' });
  if (speechActBlocksTodoCapture(raw)) {
    return logAdmission({ decision: 'REJECT', reason: 'speech_act_refuse' });
  }
  if (proposal.capability === 'uncertain' || proposal.capability === 'not_todo_capture') {
    return logAdmission({ decision: 'REJECT', reason: `capability_${proposal.capability}` });
  }
  if (proposal.capability !== 'todo_capture') {
    return logAdmission({ decision: 'REJECT', reason: 'capability_unknown' });
  }
  if (proposal.candidates.length === 0) {
    return logAdmission({ decision: 'CLARIFY', reason: 'empty_candidates' });
  }
  // Confidence is recorded on the proposal only. It never authorizes a write
  // and must not veto a verbatim-grounded P2 confirmation.
  const grounded = groundTodoCandidates(raw, proposal.candidates);
  if (!grounded) {
    logTodoSemantic('grounding_failed', { admissionClass: 'P2', candidateCount: proposal.candidates.length });
    logSemanticGroundingDone({
      capability: 'todo.capture',
      result: 'failed',
      reason: 'ungrounded_candidate',
    });
    return logAdmission({ decision: 'REJECT', reason: 'ungrounded_candidate' });
  }
  logSemanticGroundingDone({
    capability: 'todo.capture',
    result: 'ok',
    candidateCount: grounded.length,
  });
  if (shouldRefuseLlmCaptureProposal(raw, grounded.map((body) => ({ type: 'todo_add' as const, body })))) {
    return logAdmission({ decision: 'REJECT', reason: 'speech_act_refuse' });
  }
  logTodoSemantic('grounding_ok', { admissionClass: 'P2', candidateCount: grounded.length });
  return logAdmission({ decision: 'ADMIT', candidates: grounded, admissionClass: 'P2' });
}

export const TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT = `You extract JSON describing whether a sentence is asking to remember tasks or to-dos, for to-do interpretation only.
Do not claim any action occurred. Do not invent tasks not present in the sentence.
This is not grocery capture. Do not treat store items as tasks unless the sentence is asking to remember doing something.
Return ONLY a JSON object with these keys:
capability: one of "todo_capture", "not_todo_capture", "uncertain"
candidates: array of strings — each string MUST be copied verbatim from the sentence; each is one task as the sentence means it; empty array if none
confidence: number 0 to 1
Describe the sentence, not the world. Never resolve or normalize a name. confidence never authorizes a capture by itself.
If the sentence treats a multi-word task as one item, emit it as one candidate.`;

let interpreterInFlight = false;

export async function generateTodoSemanticProposal(
  raw: string,
  getCtx: () => LlamaContext | null,
): Promise<TodoProposalGenerationResult> {
  logTodoSemantic('interpreter_invoke');
  const ctx = getCtx();
  if (!ctx) {
    logTodoSemantic('interpreter_unavailable', { reason: 'no_ctx' });
    return { status: 'unavailable', reason: 'no_ctx' };
  }
  if (interpreterInFlight) {
    logTodoSemantic('interpreter_unavailable', { reason: 'in_flight' });
    return { status: 'unavailable', reason: 'in_flight' };
  }
  if (isLlamaContextBusy()) {
    logTodoSemantic('interpreter_unavailable', { reason: 'busy' });
    return { status: 'unavailable', reason: 'busy' };
  }
  interpreterInFlight = true;
  const t0 = latMono();
  logSemanticSpecialistInferenceStart('todo');
  try {
    const completion = ctx.completion({
      messages: [
        { role: 'system', content: TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT },
        { role: 'user', content: raw },
      ],
      n_predict: 128,
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    } as any);
    const timed = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), TODO_SEMANTIC_TIMEOUT_MS);
    });
    const result = await Promise.race([completion, timed]);
    const text = String((result as any)?.content || (result as any)?.text || '').trim();
    const proposal = parseTodoSemanticProposal(text);
    if (!proposal) {
      logTodoSemantic('parse_fail');
      logSemanticSpecialistInferenceEnd('todo', latMono() - t0, result, 'parse_fail');
      return { status: 'parse_fail', raw: text };
    }
    logTodoSemantic('proposal', {
      capability: proposal.capability,
      candidateCount: proposal.candidates.length,
      confidence: proposal.confidence,
    });
    logSemanticSpecialistInferenceEnd('todo', latMono() - t0, result, 'ok');
    return { status: 'ok', proposal };
  } catch (e) {
    const reason = String(e).includes('timeout') ? 'timeout' : 'error';
    logTodoSemantic('interpreter_unavailable', { reason });
    logSemanticSpecialistInferenceEnd('todo', latMono() - t0, undefined, reason);
    return { status: 'unavailable', reason };
  } finally {
    interpreterInFlight = false;
  }
}
