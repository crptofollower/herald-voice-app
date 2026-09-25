// Slice 6 — one semantic proposal seam. Proposals are not authority.
// The packet is closed. Personal values stay in the local handle map.

import { classifyWithLLM, type ClassifyOutcome } from '../hooks/llmLayers';
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
  kind: 'active_reference' | 'recap' | 'reference_continuation',
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  params: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ status: 'ok'; value: unknown } | { status: 'unavailable' }> {
  if (kind !== 'active_reference' && kind !== 'recap' && kind !== 'reference_continuation') {
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
  try {
    const value = await ctx.completion({
      prompt: `${SPEECH_COMPLETION_PROMPT}\n${packet.userText}`,
      n_predict: 8,
    });
    const raw = typeof value === 'string' ? value : value?.text;
    const token = String(raw ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
    if (token === 'complete' || token === 'incomplete' || token === 'uncertain') return token;
    return 'uncertain';
  } catch {
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
