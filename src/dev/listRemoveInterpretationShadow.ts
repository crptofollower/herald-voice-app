// Bounded list_remove interpretation shadow. Observe / interpret / ground /
// log. Never writes, speaks, pending-arms, or uses the conversational Qwen ctx.

import type { LlamaContext } from 'llama.rn';
import { LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED } from '../constants/features';
import { getPresentedOpenListItems, type PresentedListItem } from '../db/listRead';

export const SHADOW_LOG_PREFIX = 'HERALD_INTERPRETATION_SHADOW';

export const SHADOW_QWEN_INIT = {
  n_ctx: 512,
  n_gpu_layers: 0,
};

export const SHADOW_QWEN_GENERATION = {
  n_predict: 96,
  temperature: 0,
  top_p: 0.8,
  top_k: 20,
  min_p: 0,
  jinja: true,
  enable_thinking: false,
  thinking_forced_open: false,
  reasoning_format: 'none' as const,
  chat_template_kwargs: { enable_thinking: false },
};

export const SHADOW_PROPOSAL_SYSTEM_PROMPT = `You extract JSON for grocery list_remove interpretation only.
Do not claim any action occurred. Do not invent list item IDs. Do not write or confirm anything.
Return ONLY a JSON object with these keys:
speech_act: "directive" | "narrative" | "question" | "other"
polarity: "affirmative" | "negated"
tense_aspect: "past" | "present" | "prospective" | "unknown"
candidate: "list_remove" | "none"
op: "list_remove" | "none"
referents: array of {"surface": string} (zero or more linguistic item names; no IDs)
linguistically_incomplete: boolean
confidence: number 0 to 1
directive means the user is commanding Herald to change a list. narrative means reporting events.
prospective means a future need to obtain items (gotta get, have to get, need to get).
confidence never authorizes a mutation.`;

export type ShadowSpeechAct = 'directive' | 'narrative' | 'question' | 'other';
export type ShadowPolarity = 'affirmative' | 'negated';
export type ShadowTense = 'past' | 'present' | 'prospective' | 'unknown';
export type ShadowCandidate = 'list_remove' | 'none';

export type SemanticProposal = {
  speech_act: ShadowSpeechAct;
  polarity: ShadowPolarity;
  tense_aspect: ShadowTense;
  candidate: ShadowCandidate;
  op: 'list_remove' | 'none';
  referents: { surface: string }[];
  linguistically_incomplete: boolean;
  confidence: number;
};

export type ShadowAuthorityDecision =
  | 'authorize_list_remove'
  | 'reject'
  | 'clarify_ungrounded'
  | 'unsupported_multi_referent';

export type GroceryItemSnapshot = { id: string; body: string };

export type PreTurnGrocerySnapshot = {
  captured_at_ms: number;
  elapsed_ms: number;
  items: GroceryItemSnapshot[];
};

export type ProductionOwnerRecord = {
  handled: boolean;
  source: string | null;
  route_kind: string | null;
  route_reason: string | null;
  action_type: string | null;
  production_item: string | null;
  production_list_name: string | null;
  claimed_list_remove: boolean;
  result_category: string;
};

export type ShadowAsrMeta = {
  input_source: 'typed' | 'speech';
  committed_length: number;
  is_recording_at_commit: boolean;
  partial_text_at_commit: string | null;
};

export type ExactGrounding =
  | { kind: 'none' }
  | { kind: 'exact_one'; id: string; body: string }
  | { kind: 'exact_many'; hits: GroceryItemSnapshot[] };

export function isListRemoveInterpretationShadowEnabled(): boolean {
  return LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED === true;
}

export function normalizeShadowReferent(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function capturePreTurnGrocerySnapshot(): PreTurnGrocerySnapshot | null {
  if (!isListRemoveInterpretationShadowEnabled()) return null;
  const t0 = Date.now();
  try {
    const items = getPresentedOpenListItems('grocery').map((row: PresentedListItem) => ({
      id: row.id,
      body: row.body,
    }));
    return {
      captured_at_ms: t0,
      elapsed_ms: Date.now() - t0,
      items,
    };
  } catch {
    return {
      captured_at_ms: t0,
      elapsed_ms: Date.now() - t0,
      items: [],
    };
  }
}

export function productionMutatedGroceryIds(
  snapshot: PreTurnGrocerySnapshot,
): string[] {
  let now: GroceryItemSnapshot[] = [];
  try {
    now = getPresentedOpenListItems('grocery').map((row) => ({ id: row.id, body: row.body }));
  } catch {
    now = [];
  }
  const stillOpen = new Set(now.map((r) => r.id));
  return snapshot.items.filter((row) => !stillOpen.has(row.id)).map((row) => row.id);
}

export function describeProductionOwner(input: {
  handled: boolean;
  source?: string;
  routeKind?: string;
  routeReason?: string;
  actionType?: string;
  productionItem?: string;
  productionListName?: string;
}): ProductionOwnerRecord {
  const claimed = input.actionType === 'list_remove';
  let result_category = 'other';
  if (input.handled) result_category = input.source ?? 'handled';
  else if (claimed) result_category = 'device_action:list_remove';
  else if (input.actionType) result_category = `device_action:${input.actionType}`;
  else if (input.routeKind) result_category = input.routeKind;
  return {
    handled: input.handled,
    source: input.source ?? null,
    route_kind: input.routeKind ?? null,
    route_reason: input.routeReason ?? null,
    action_type: input.actionType ?? null,
    production_item: input.productionItem ?? null,
    production_list_name: input.productionListName ?? null,
    claimed_list_remove: claimed,
    result_category,
  };
}

export function groundExactReferent(
  surface: string,
  snapshot: GroceryItemSnapshot[],
): ExactGrounding {
  const needle = normalizeShadowReferent(surface);
  if (!needle) return { kind: 'none' };
  const hits = snapshot.filter((row) => normalizeShadowReferent(row.body) === needle);
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'exact_one', id: hits[0].id, body: hits[0].body };
  return { kind: 'exact_many', hits };
}

export function fuzzyLikeCandidates(
  surface: string,
  snapshot: GroceryItemSnapshot[],
): GroceryItemSnapshot[] {
  const needle = normalizeShadowReferent(surface);
  if (!needle) return [];
  return snapshot.filter((row) => normalizeShadowReferent(row.body).includes(needle)
    || needle.includes(normalizeShadowReferent(row.body)));
}

export function computeShadowAuthority(input: {
  proposal: SemanticProposal | null;
  snapshot: GroceryItemSnapshot[];
}): {
  decision: ShadowAuthorityDecision;
  authorized: boolean;
  grounded_id: string | null;
  grounding: ExactGrounding | null;
  fail_gate: string | null;
} {
  const proposal = input.proposal;
  if (!proposal) {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'no_proposal' };
  }
  if (proposal.referents.length > 1) {
    return {
      decision: 'unsupported_multi_referent',
      authorized: false,
      grounded_id: null,
      grounding: null,
      fail_gate: 'multi_referent',
    };
  }
  if (proposal.candidate !== 'list_remove' || proposal.op !== 'list_remove') {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'not_list_remove_op' };
  }
  if (proposal.speech_act !== 'directive') {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'not_directive' };
  }
  if (proposal.polarity !== 'affirmative') {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'negated' };
  }
  if (proposal.tense_aspect === 'prospective') {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'prospective' };
  }
  if (proposal.linguistically_incomplete) {
    return { decision: 'reject', authorized: false, grounded_id: null, grounding: null, fail_gate: 'incomplete' };
  }
  const surface = proposal.referents[0]?.surface ?? '';
  if (!surface.trim()) {
    return { decision: 'clarify_ungrounded', authorized: false, grounded_id: null, grounding: { kind: 'none' }, fail_gate: 'empty_referent' };
  }
  const grounding = groundExactReferent(surface, input.snapshot);
  if (grounding.kind === 'exact_one') {
    return {
      decision: 'authorize_list_remove',
      authorized: true,
      grounded_id: grounding.id,
      grounding,
      fail_gate: null,
    };
  }
  return {
    decision: 'clarify_ungrounded',
    authorized: false,
    grounded_id: null,
    grounding,
    fail_gate: grounding.kind === 'exact_many' ? 'exact_many' : 'no_exact_ground',
  };
}

const SPEECH_ACTS = new Set<ShadowSpeechAct>(['directive', 'narrative', 'question', 'other']);
const POLARITIES = new Set<ShadowPolarity>(['affirmative', 'negated']);
const TENSES = new Set<ShadowTense>(['past', 'present', 'prospective', 'unknown']);
const CANDIDATES = new Set<ShadowCandidate>(['list_remove', 'none']);

export function parseSemanticProposal(raw: string): SemanticProposal | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!SPEECH_ACTS.has(o.speech_act as ShadowSpeechAct)) return null;
  if (!POLARITIES.has(o.polarity as ShadowPolarity)) return null;
  if (!TENSES.has(o.tense_aspect as ShadowTense)) return null;
  if (!CANDIDATES.has(o.candidate as ShadowCandidate)) return null;
  if (o.op !== 'list_remove' && o.op !== 'none') return null;
  if (typeof o.linguistically_incomplete !== 'boolean') return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence)) return null;
  if (!Array.isArray(o.referents)) return null;
  const referents: { surface: string }[] = [];
  for (const r of o.referents) {
    if (!r || typeof r !== 'object') return null;
    const surface = (r as { surface?: unknown }).surface;
    if (typeof surface !== 'string') return null;
    referents.push({ surface });
  }
  return {
    speech_act: o.speech_act as ShadowSpeechAct,
    polarity: o.polarity as ShadowPolarity,
    tense_aspect: o.tense_aspect as ShadowTense,
    candidate: o.candidate as ShadowCandidate,
    op: o.op,
    referents,
    linguistically_incomplete: o.linguistically_incomplete,
    confidence: o.confidence,
  };
}

export async function generateShadowProposal(
  ctx: LlamaContext,
  utterance: string,
): Promise<{ proposal: SemanticProposal | null; latency_ms: number; raw: string; status: string }> {
  const t0 = Date.now();
  try {
    const result = await ctx.completion({
      messages: [
        { role: 'system', content: SHADOW_PROPOSAL_SYSTEM_PROMPT },
        { role: 'user', content: utterance },
      ],
      ...SHADOW_QWEN_GENERATION,
    });
    const raw = String(result?.content || result?.text || '').trim();
    const proposal = parseSemanticProposal(raw);
    return {
      proposal,
      latency_ms: Date.now() - t0,
      raw,
      status: proposal ? 'ok' : 'parse_fail',
    };
  } catch {
    return { proposal: null, latency_ms: Date.now() - t0, raw: '', status: 'unavailable' };
  }
}

export async function runListRemoveInterpretationShadow(input: {
  text: string;
  snapshot: PreTurnGrocerySnapshot;
  production: ProductionOwnerRecord | null;
  asr: ShadowAsrMeta;
  getShadowCtx: () => LlamaContext | null;
}): Promise<void> {
  if (!isListRemoveInterpretationShadowEnabled()) return;
  const mutated_ids = productionMutatedGroceryIds(input.snapshot);
  const ctx = input.getShadowCtx();
  let proposal: SemanticProposal | null = null;
  let proposal_status = 'unavailable';
  let proposal_latency_ms: number | null = null;
  if (!ctx) {
    proposal_status = 'unavailable';
  } else {
    const gen = await generateShadowProposal(ctx, input.text);
    proposal = gen.proposal;
    proposal_status = gen.status;
    proposal_latency_ms = gen.latency_ms;
  }
  const authority = computeShadowAuthority({
    proposal,
    snapshot: input.snapshot.items,
  });
  const surfaces = proposal?.referents.map((r) => r.surface) ?? [];
  const fuzzy = surfaces.flatMap((s) =>
    fuzzyLikeCandidates(s, input.snapshot.items).map((row) => ({ surface: s, id: row.id, body: row.body })),
  );
  console.warn(SHADOW_LOG_PREFIX + ' ' + JSON.stringify({
    text: input.text,
    asr: input.asr,
    snapshot_elapsed_ms: input.snapshot.elapsed_ms,
    snapshot_item_ids: input.snapshot.items.map((i) => i.id),
    production: input.production,
    production_mutated_grocery_ids: mutated_ids,
    proposal,
    proposal_status,
    proposal_latency_ms,
    referent_surfaces: surfaces,
    grounding: authority.grounding,
    fuzzy_candidates_not_authoritative: fuzzy,
    shadow_decision: authority.decision,
    shadow_authorized: authority.authorized,
    fail_gate: authority.fail_gate,
    grounded_id: authority.grounded_id,
  }));
}
