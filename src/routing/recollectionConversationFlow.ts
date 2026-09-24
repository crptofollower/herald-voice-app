// Natural Conversation Flow V1A — ephemeral in-story Kit wording only.
// No writer edge. No durable provenance. Bounded context only.

import { getEvidenceById } from '../db/evidenceDB';
import { REMINISCENCE_SOURCE_KIND } from '../db/recollectionRead';
import { runSpecialistInference } from './semanticProvider';
import { RECOLLECTION_SEMANTIC_TIMEOUT_MS } from './recollectionSemanticNomination';
import type { ReminiscenceArcHolder } from './reminiscenceArc';

export const RECOLLECTION_FLOW_FALLBACK = 'Okay.';

export const RECOLLECTION_FLOW_SYSTEM_PROMPT = `You write Kit's next spoken reply inside an already-open personal recollection story.
You have no memory authority and must not invent facts.
You may relate the current utterance only to the supplied bounded context, acknowledge what the user actually said, and ask at most one natural relevant follow-up.
Do not invent an unstated event, emotion, preference, causal relationship, duration, frequency, place, date, age, or other fact.
Do not convert a plausible implication into an assertion.
Never claim you remembered or stored anything. Never claim an external action occurred.
Return ONLY the spoken reply as plain text.`;

type FlowCtx = {
  completion: (args: unknown) => Promise<unknown> | unknown;
};

export type RecollectionFlowGeneration =
  | { status: 'ok'; text: string }
  | { status: 'unavailable'; reason: 'no_ctx' | 'in_flight' | 'busy' | 'timeout' | 'error' | 'empty' };

function lastCurrentArcVerbatims(arc: ReminiscenceArcHolder): string[] {
  const ids = arc.peekRowIds().slice(-3);
  const rows: string[] = [];
  for (const id of ids) {
    const rec = getEvidenceById(id);
    if (!rec) continue;
    if (rec.sourceClass !== 'user_explicit') continue;
    if (rec.sourceKind !== REMINISCENCE_SOURCE_KIND) continue;
    rows.push(rec.rawText);
  }
  return rows;
}

export function formatRecollectionFlowUserContent(input: {
  currentUtterance: string;
  precedingKitAct: string | null;
  arcRows: string[];
}): string {
  const rows = input.arcRows.slice(-3);
  const story = rows.length === 0
    ? '(none)'
    : rows.map((row, i) => `${i + 1}. ${row}`).join('\n');
  return [
    'current_user_verbatim:',
    input.currentUtterance,
    '',
    'preceding_kit_act:',
    input.precedingKitAct && input.precedingKitAct.trim() ? input.precedingKitAct.trim() : '(none)',
    '',
    'current_story_rows:',
    story,
  ].join('\n');
}

export function recollectionFlowSpeech(run: RecollectionFlowGeneration): string {
  if (run.status === 'ok' && run.text.trim()) return run.text.trim();
  return RECOLLECTION_FLOW_FALLBACK;
}

export async function generateRecollectionConversationFlow(
  currentUtterance: string,
  getCtx: (() => FlowCtx | null) | undefined,
  arc: ReminiscenceArcHolder,
  opts?: { timeoutMs?: number },
): Promise<RecollectionFlowGeneration> {
  const precedingKitAct = arc.peekAssistantQuestion();
  const arcRows = lastCurrentArcVerbatims(arc);
  const userContent = formatRecollectionFlowUserContent({
    currentUtterance,
    precedingKitAct,
    arcRows,
  });
  const run = await runSpecialistInference('recollection_flow', () => getCtx?.() ?? null, {
    messages: [
      { role: 'system', content: RECOLLECTION_FLOW_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
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
    return { status: 'unavailable', reason: run.reason };
  }
  const result = run.value as { content?: string; text?: string };
  const text = String(result?.content || result?.text || '').trim();
  if (!text) return { status: 'unavailable', reason: 'empty' };
  return { status: 'ok', text };
}
