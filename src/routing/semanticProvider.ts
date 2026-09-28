// Slice 6 — one semantic proposal seam. Proposals are not authority.
// The packet is closed. Personal values stay in the local handle map.

import { classifyWithLLM, type ClassifyOutcome } from '../hooks/llmLayers';
import { beginCtxCompletion, mono as latMono, observeCtxCompletionEnd } from '../utils/latencyInstrument';
import { noteReferenceInvocation } from '../dev/semanticJourneyEvidence';
import { runSharedSemanticCompletion, type SemanticCompletionRunOptions } from '../utils/semanticCompletionLifecycle';
import type { LlamaContext } from 'llama.rn';

export type SpecialistInferenceKind =
  | 'medication'
  | 'grocery'
  | 'todo'
  | 'capability'
  | 'recollection_nomination'
  | 'recollection_flow'
  | 'active_reference'
  | 'recap';

export type OpaqueTypeTag =
  | 'person'
  | 'medication_list'
  | 'grocery_list'
  | 'todo_list'
  | 'calendar_set'
  | 'focus';

export type OpaqueRef = {
  handle: string;
  typeTag: OpaqueTypeTag;
};

export type SemanticRiskTier = 'none' | 'read' | 'write' | 'external';

export type SemanticPacket = {
  userText: string;
  refs: readonly OpaqueRef[];
  hardPending: boolean;
  riskTier: SemanticRiskTier;
};

export type SemanticProposal =
  | { status: 'abstain' }
  | { status: 'failed'; reason: string }
  | { status: 'proposal'; capabilityId?: string; handle?: string; typeTag?: OpaqueTypeTag };

export type LocalHandleMap = ReadonlyMap<string, { localId: string; typeTag: OpaqueTypeTag }>;

const HANDLE_RE = /^ref_[1-9][0-9]*$/;

export function buildOpaqueHandleMap(
  entries: readonly { localId: string; typeTag: OpaqueTypeTag }[],
): { refs: OpaqueRef[]; local: Map<string, { localId: string; typeTag: OpaqueTypeTag }> } {
  const local = new Map<string, { localId: string; typeTag: OpaqueTypeTag }>();
  const refs: OpaqueRef[] = [];
  entries.forEach((entry, index) => {
    const handle = `ref_${index + 1}`;
    local.set(handle, { localId: entry.localId, typeTag: entry.typeTag });
    refs.push({ handle, typeTag: entry.typeTag });
  });
  return { refs, local };
}

/** Closed packet. Extra personal fields are not part of the type and are dropped. */
export function buildSemanticPacket(input: {
  userText: string;
  refs?: readonly OpaqueRef[];
  hardPending?: boolean;
  riskTier?: SemanticRiskTier;
}): SemanticPacket {
  return {
    userText: input.userText,
    refs: input.refs ?? [],
    hardPending: input.hardPending === true,
    riskTier: input.riskTier ?? 'none',
  };
}

export function packetContainsPersonalDump(packet: SemanticPacket): boolean {
  const dumped = JSON.stringify(packet);
  return dumped.includes('recentEvidence')
    || dumped.includes('phone')
    || dumped.includes('transcript');
}

export function resolveProposedHandle(
  proposal: SemanticProposal,
  local: LocalHandleMap,
  expectedType?: OpaqueTypeTag,
): { ok: true; localId: string; typeTag: OpaqueTypeTag } | { ok: false; reason: 'abstain' | 'failed' | 'unknown_handle' | 'domain_mismatch' | 'malformed' } {
  if (proposal.status === 'abstain') return { ok: false, reason: 'abstain' };
  if (proposal.status === 'failed') return { ok: false, reason: 'failed' };
  if (!proposal.handle) return { ok: false, reason: 'malformed' };
  if (!HANDLE_RE.test(proposal.handle)) return { ok: false, reason: 'unknown_handle' };
  const row = local.get(proposal.handle);
  if (!row) return { ok: false, reason: 'unknown_handle' };
  if (expectedType && row.typeTag !== expectedType) return { ok: false, reason: 'domain_mismatch' };
  if (proposal.typeTag && proposal.typeTag !== row.typeTag) return { ok: false, reason: 'domain_mismatch' };
  return { ok: true, localId: row.localId, typeTag: row.typeTag };
}

/**
 * The one conversation-classification call. The model sees the utterance
 * and structural list tags only. Contact names and the user name do not
 * enter the packet.
 */
/** Closed specialist kinds. The provider owns the completion runtime. */
export async function runSpecialistInference(
  kind: SpecialistInferenceKind,
  getCtx: () => LlamaContext | null,
  params: unknown,
  opts?: SemanticCompletionRunOptions,
) {
  switch (kind) {
    case 'medication':
    case 'grocery':
    case 'todo':
    case 'capability':
    case 'recollection_nomination':
    case 'recollection_flow':
      return runSharedSemanticCompletion(getCtx, params, opts);
    default:
      return { status: 'unavailable' as const, reason: 'no_ctx' as const };
  }
}

const REFERENCE_SEMANTIC_TIMEOUT_MS = 8000;

/** Reference, recap, and continuation proposals. The shared lifecycle owns the native call. */
export async function completeBoundedInterpretation(
  kind: 'active_reference' | 'recap' | 'reference_continuation' | 'discourse_mention' | 'discourse_applicability' | 'discourse_correction',
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  params: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ status: 'ok'; value: unknown } | { status: 'unavailable' }> {
  if (
    kind !== 'active_reference'
    && kind !== 'recap'
    && kind !== 'reference_continuation'
    && kind !== 'discourse_mention'
    && kind !== 'discourse_applicability'
    && kind !== 'discourse_correction'
  ) {
    return { status: 'unavailable' };
  }
  if (!ctx || typeof ctx.completion !== 'function') return { status: 'unavailable' };
  const run = await runSharedSemanticCompletion(() => ctx, params, {
    callerDeadlineMs: opts?.timeoutMs ?? REFERENCE_SEMANTIC_TIMEOUT_MS,
  });
  if (run.status !== 'ok') return { status: 'unavailable' };
  return { status: 'ok', value: run.value };
}

const SPEECH_COMPLETION_PROMPT = 'Reply with one word only: complete, incomplete, or uncertain.';

/** Proposal only. Does not admit a turn or read personal memory. */
export async function proposeSpeechCompletion(
  userText: string,
  ctx: { completion: (params: { prompt: string; n_predict: number }) => Promise<{ text?: string } | string> } | null,
): Promise<'complete' | 'incomplete' | 'uncertain'> {
  const packet = buildSemanticPacket({ userText, riskTier: 'none' });
  if (!ctx || typeof ctx.completion !== 'function' || !packet.userText.trim()) return 'uncertain';
  const completionSeq = beginCtxCompletion('speech');
  const started = latMono();
  try {
    const value = await ctx.completion({
      prompt: `${SPEECH_COMPLETION_PROMPT}\n${packet.userText}`,
      n_predict: 8,
    });
    observeCtxCompletionEnd(completionSeq, 'speech', latMono() - started, 'ok', value);
    const raw = typeof value === 'string' ? value : value?.text;
    const token = String(raw ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (token === 'complete' || token === 'incomplete' || token === 'uncertain') return token;
    return 'uncertain';
  } catch {
    observeCtxCompletionEnd(completionSeq, 'speech', latMono() - started, 'error');
    return 'uncertain';
  }
}

/** Reference intent only. The model does not name a person or supply a fact. */
export async function proposeReferenceContinuation(
  userText: string,
  ctx: { completion: (params: { prompt: string; n_predict: number }) => Promise<{ text?: string } | string> } | null,
  options?: { groundedPeople?: boolean; groundedPresentedSets?: boolean },
): Promise<{ applicable: boolean } | null> {
  const packet = buildSemanticPacket({ userText, riskTier: 'none' });
  const hasCurrentUtterance = packet.userText.trim().length > 0;
  const note = (status: 'applicable' | 'not' | 'unavailable' | 'error', unavailableReason: string | null) => {
    noteReferenceInvocation({
      status,
      unavailableReason,
      hasCurrentUtterance,
      groundedPeople: options?.groundedPeople,
      groundedPresentedMaterial: options?.groundedPresentedSets,
    });
  };
  if (!hasCurrentUtterance) return null;
  if (!ctx || typeof ctx.completion !== 'function') {
    note('unavailable', 'ctx_missing');
    return null;
  }
  const availability = [
    options?.groundedPeople ? 'Grounded people are available for reference.' : '',
    options?.groundedPresentedSets ? 'Grounded presented material is available for reference.' : '',
  ].filter(Boolean).join('\n');
  const contextLine = availability ? `${availability}\n` : '';
  try {
    const value = await completeBoundedInterpretation('reference_continuation', ctx, {
      prompt: `Reply with one word, applicable or not.\n${contextLine}${packet.userText}`,
      n_predict: 8,
    });
    if (value.status !== 'ok') {
      note('unavailable', 'error');
      return null;
    }
    const raw = typeof value.value === 'string'
      ? value.value
      : (value.value as { text?: string } | null)?.text;
    const token = String(raw ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (token === 'applicable') {
      note('applicable', null);
      return { applicable: true };
    }
    if (token === 'not') {
      note('not', null);
      return { applicable: false };
    }
    note('unavailable', 'unrecognized');
    return null;
  } catch {
    note('error', 'error');
    return null;
  }
}

export const DISCOURSE_MENTION_PROPOSAL_PROMPT =
  'Reply with JSON only: an array of objects. Each object has span and kind. kind is person, place, or event_or_topic. span is copied exactly from the utterance. Return [] when none apply.';

export type DiscourseMentionProposalItem = {
  span: string;
  kind: string;
};

/** Current-turn span proposals. Null means admit nothing. Offsets in the payload are ignored. */
export function parseDiscourseMentionPayload(raw: string): DiscourseMentionProposalItem[] | null {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items: DiscourseMentionProposalItem[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.span !== 'string' || typeof row.kind !== 'string') return null;
    items.push({ span: row.span, kind: row.kind });
  }
  return items;
}

export async function proposeDiscourseMentions(
  userText: string,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  opts?: { timeoutMs?: number },
): Promise<DiscourseMentionProposalItem[] | null> {
  const packet = buildSemanticPacket({ userText, riskTier: 'none' });
  if (!packet.userText.trim() || !ctx || typeof ctx.completion !== 'function') return null;
  try {
    const value = await completeBoundedInterpretation('discourse_mention', ctx, {
      prompt: `${DISCOURSE_MENTION_PROPOSAL_PROMPT}\n${packet.userText}`,
      n_predict: 128,
    }, opts);
    if (value.status !== 'ok') return null;
    const payload = value.value;
    const raw = typeof payload === 'string'
      ? payload
      : String((payload as { text?: string; content?: string } | null)?.text
        ?? (payload as { content?: string } | null)?.content
        ?? '');
    return parseDiscourseMentionPayload(raw);
  } catch {
    return null;
  }
}

const APPLICABILITY_FORBIDDEN_KEYS = [
  'selectedIndex',
  'winner',
  'best',
  'rank',
  'score',
  'confidence',
  'chosenHandle',
  'selectedHandle',
];

export const DISCOURSE_APPLICABILITY_PROMPT =
  'Reply with JSON only. Keys are utterance_applicable and marks. Each mark has handle and mark. mark is compatible, incompatible, or uncertain. Do not choose a winner.';

export type DiscourseApplicabilityPayload = {
  utteranceApplicable: boolean;
  marks: Array<{ handle: string; mark: string }>;
};

function applicabilityValueHasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => applicabilityValueHasForbiddenKey(item));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (APPLICABILITY_FORBIDDEN_KEYS.includes(key)) return true;
    if (applicabilityValueHasForbiddenKey(nested)) return true;
  }
  return false;
}

/** Compatibility marks only. Null is fail-closed. Winner fields reject the payload. */
export function parseDiscourseApplicabilityPayload(raw: string): DiscourseApplicabilityPayload | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (applicabilityValueHasForbiddenKey(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.utterance_applicable !== 'boolean' || !Array.isArray(row.marks)) return null;
  const marks: Array<{ handle: string; mark: string }> = [];
  for (const item of row.marks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (applicabilityValueHasForbiddenKey(item)) return null;
    const markRow = item as Record<string, unknown>;
    if (typeof markRow.handle !== 'string' || typeof markRow.mark !== 'string') return null;
    if (markRow.mark !== 'compatible' && markRow.mark !== 'incompatible' && markRow.mark !== 'uncertain') {
      return null;
    }
    marks.push({ handle: markRow.handle, mark: markRow.mark });
  }
  return { utteranceApplicable: row.utterance_applicable, marks };
}

export async function proposeDiscourseApplicability(
  prompt: string,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  opts?: { timeoutMs?: number },
): Promise<DiscourseApplicabilityPayload | null> {
  if (!prompt.trim() || !ctx || typeof ctx.completion !== 'function') return null;
  try {
    const value = await completeBoundedInterpretation('discourse_applicability', ctx, {
      prompt,
      n_predict: 256,
    }, opts);
    if (value.status !== 'ok') return null;
    const payload = value.value;
    const raw = typeof payload === 'string'
      ? payload
      : String((payload as { text?: string; content?: string } | null)?.text
        ?? (payload as { content?: string } | null)?.content
        ?? '');
    return parseDiscourseApplicabilityPayload(raw);
  } catch {
    return null;
  }
}

const CORRECTION_FORBIDDEN_KEYS = [
  'replace',
  'from',
  'to',
  'replacementId',
  'selectedIndex',
  'selectedHandle',
  'chosenHandle',
  'winner',
  'best',
  'rank',
  'score',
  'confidence',
];

export const DISCOURSE_CORRECTION_PROMPT =
  'Reply with JSON only. Keys are correction_turn, target_marks, replacement_marks, and optional new_spans. Each mark has handle and mark. mark is compatible, incompatible, or uncertain. A new_spans item has span and kind. kind is person, place, or event_or_topic. Do not choose one candidate.';

export type DiscourseCorrectionPayload = {
  correctionTurn: boolean;
  targetMarks: Array<{ handle: string; mark: string }>;
  replacementMarks: Array<{ handle: string; mark: string }>;
  newSpans: Array<{ span: string; kind: string }>;
};

function correctionValueHasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => correctionValueHasForbiddenKey(item));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CORRECTION_FORBIDDEN_KEYS.includes(key)) return true;
    if (correctionValueHasForbiddenKey(nested)) return true;
  }
  return false;
}

function correctionMarks(value: unknown): Array<{ handle: string; mark: string }> | null {
  if (!Array.isArray(value)) return null;
  const marks: Array<{ handle: string; mark: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (correctionValueHasForbiddenKey(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.handle !== 'string' || typeof row.mark !== 'string') return null;
    if (row.mark !== 'compatible' && row.mark !== 'incompatible' && row.mark !== 'uncertain') return null;
    marks.push({ handle: row.handle, mark: row.mark });
  }
  return marks;
}

/** Compatibility sets only. Null rejects the whole payload, including any replacement operation. */
export function parseDiscourseCorrectionPayload(raw: string): DiscourseCorrectionPayload | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (correctionValueHasForbiddenKey(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.correction_turn !== 'boolean') return null;
  const targetMarks = correctionMarks(row.target_marks);
  const replacementMarks = correctionMarks(row.replacement_marks);
  if (!targetMarks || !replacementMarks) return null;
  const newSpans: Array<{ span: string; kind: string }> = [];
  if (row.new_spans !== undefined) {
    if (!Array.isArray(row.new_spans)) return null;
    for (const item of row.new_spans) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      if (correctionValueHasForbiddenKey(item)) return null;
      const spanRow = item as Record<string, unknown>;
      if (typeof spanRow.span !== 'string' || typeof spanRow.kind !== 'string') return null;
      if (spanRow.kind !== 'person' && spanRow.kind !== 'place' && spanRow.kind !== 'event_or_topic') return null;
      newSpans.push({ span: spanRow.span, kind: spanRow.kind });
    }
  }
  return {
    correctionTurn: row.correction_turn,
    targetMarks,
    replacementMarks,
    newSpans,
  };
}

export async function proposeDiscourseCorrection(
  prompt: string,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  opts?: { timeoutMs?: number },
): Promise<DiscourseCorrectionPayload | null> {
  if (!prompt.trim() || !ctx || typeof ctx.completion !== 'function') return null;
  try {
    const value = await completeBoundedInterpretation('discourse_correction', ctx, {
      prompt,
      n_predict: 256,
    }, opts);
    if (value.status !== 'ok') return null;
    const payload = value.value;
    const raw = typeof payload === 'string'
      ? payload
      : String((payload as { text?: string; content?: string } | null)?.text
        ?? (payload as { content?: string } | null)?.content
        ?? '');
    return parseDiscourseCorrectionPayload(raw);
  } catch {
    return null;
  }
}

export async function proposeLocalClassification(
  userText: string,
  ctx: LlamaContext | null,
  opts?: Parameters<typeof classifyWithLLM>[3],
): Promise<ClassifyOutcome> {
  const packet = buildSemanticPacket({ userText, riskTier: 'none' });
  return classifyWithLLM(packet.userText, ctx, {
    contacts: [],
    lists: ['grocery', 'todo'],
  }, opts);
}
