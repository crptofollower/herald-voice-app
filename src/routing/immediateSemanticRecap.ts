// src/routing/immediateSemanticRecap.ts
// Conversation Continuity Consumer V1 — Immediate Semantic Recap.
//
// Target capability: after a meaningful captured/confirmed turn, the user
// can naturally ask "what did I just tell you" (in unseen wording) on the
// very next turn and get an answer sourced from bounded ledger evidence /
// deterministic re-read — without restating the topic.
//
// Two-stage interpretation (approved architecture):
//   Stage A — a small, domain-agnostic deterministic classifier recognizes
//     structurally obvious immediate-recap shapes ("what did I just tell
//     you", "what did I just say", "remind me what I said"). Fast path
//     only — it is NOT the complete mechanism.
//   Stage B — when Stage A is not confident, a bounded local semantic
//     interpreter (same discipline as medicationSemanticInterpretation.ts:
//     strict parse/validate, no coercion, confidence never grants trust by
//     itself) may PROPOSE that the turn is an immediate-recap request and
//     which of the CALLER-SUPPLIED candidate foci it refers to. It selects
//     by INDEX into a list this module already built from real ledger
//     evidence — it cannot fabricate a focus that was not already present,
//     because there is no channel through which it could name one.
//
// This module contains NO medication-specific field extraction (.drug,
// .dosage, .frequency, raw IntentRecord parsing). It consumes only the
// normalized ConversationTurnRecord/ConversationTurnFocusEntry contract
// (Semantic Focus Contract V1). The ONE place domain knowledge legitimately
// appears is REREAD_ADAPTERS below — a small, explicit, per-domain registry
// exactly mirroring routeIntent.ts's own DOMAIN_WRITERS pattern (a dispatch
// table, not inline conditional logic) — adding a future domain means
// adding one more registry entry, not changing any function above it.

import type { LlamaContext } from 'llama.rn';
import { completeBoundedInterpretation } from './semanticProvider';
import type { ConversationTurnFocusEntry, ConversationTurnRecord } from './conversationTurnLedger';
import {
  logSemanticRecapInferenceEnd,
  logSemanticRecapInferenceStart,
  mono as latMono,
} from '../utils/latencyInstrument';

// ─── Diagnostics only (2026-09-xx, device acceptance gate) ────────────────
// Pure observability: one compact event per answerImmediateSemanticRecap()
// call, emitted immediately before each existing return statement — no
// existing branch, condition, or return VALUE is touched. Bounded to
// exactly the fields already present in the normalized focus contract
// (kind/displayValue/tier/resolverKey-PRESENCE/intentType) — never a raw
// resolverKey value, never a DB field beyond what the ledger already
// carries. See HERALD_IMMEDIATE_RECAP_DIAG_SCHEMA below for the full shape.
export type ImmediateRecapDiagCandidate = {
  index: number;
  kind: ConversationTurnFocusEntry['kind'];
  displayValue: string;
  tier: ConversationTurnFocusEntry['tier'];
  hasResolverKey: boolean;
  intentType: string | null;
};

export type ImmediateRecapDiagStageB =
  | { status: 'not_invoked' }
  | { status: 'no_interpreter_context' }
  | { status: 'unavailable' }
  | { status: 'parse_fail' }
  | { status: 'ok'; isImmediateRecap: boolean; selectedIndex: number | null; confidence: number };

export type ImmediateRecapDiagEvent = {
  invoked: true;
  utteranceNormalized: string;
  stageAMatched: boolean;
  stageB: ImmediateRecapDiagStageB;
  candidateCount: number;
  candidates: ImmediateRecapDiagCandidate[];
  selectedCandidateIndex: number | null;
  selectedCandidateTier: ConversationTurnFocusEntry['tier'] | null;
  adapterFound: boolean | null;
  rereadOutcome: 'success' | 'stale_miss' | 'not_applicable';
  finalResult:
    | 'answered_authoritative' | 'answered_unconfirmed' | 'answered_proposal' | 'answered_conversational'
    | 'clarify_ambiguous' | 'capability_gap' | 'no_candidate' | 'stale_reference_miss' | 'not_recap';
};

const DIAG_UTTERANCE_MAX_CHARS = 200;
const DIAG_DISPLAY_VALUE_MAX_CHARS = 100;

function boundDiagText(text: string, maxChars: number): string {
  const t = text.trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function toDiagCandidate(c: RecapCandidate): ImmediateRecapDiagCandidate {
  return {
    index: c.index,
    kind: c.kind,
    displayValue: boundDiagText(c.displayValue, DIAG_DISPLAY_VALUE_MAX_CHARS),
    tier: c.focus.tier,
    hasResolverKey: !!c.focus.resolverKey,
    intentType: c.intentType,
  };
}

function logImmediateRecapDiag(event: ImmediateRecapDiagEvent): void {
  console.warn('HERALD_IMMEDIATE_RECAP_DIAG ' + JSON.stringify(event));
}

// ─── Stage A — deterministic fast path (closed deictic grammar, NOT domain phrases) ───
// Recognizes only the grammatical SHAPE "did/was/'d I (just) tell/say/mention
// [you]" or "remind me what I (just) said/told you/mentioned" — the subject
// must be first-person "I" telling/saying TO "you" (Herald), which is what
// structurally excludes "what did Dr. Smith tell me" (third-party subject)
// and "what did you just tell me" (opposite direction — assistant recap,
// unsupported by this consumer, see NEGATIVE_ASSISTANT_RECAP_RE below).
// Deliberately does NOT match on "medicine"/"medication"/"drug" or any open
// vocabulary noun — utterances that only carry meaning through such a noun
// ("which medicine was I talking about") are Stage B's job.
// Bounded 0-3-word gap between "what/which" and the verb allows a free noun
// phrase ("what medication did I...", "what appointment did I...") without
// this module knowing or caring what the noun is — the gap is grammatical
// (any short noun phrase), never a specific enumerated vocabulary.
const IMMEDIATE_RECAP_RE =
  /^(?:so[,]?\s+)?(?:um+[,]?\s+|uh+[,]?\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:please\s+)?(?:what|which)(?:\s+\S+){0,3}?\s+(?:did|was)\s+i\s+(?:just\s+)?(?:tell(?:ing)?\s+you|say(?:ing)?|mention(?:ing)?)\b/i;

const REMIND_ME_RE =
  /^(?:so[,]?\s+)?(?:um+[,]?\s+|uh+[,]?\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:please\s+)?remind\s+me\s+what\s+i\s+(?:just\s+)?(?:said|told\s+you|mentioned)\b/i;

/** Opposite-direction assistant-recap ("what did YOU tell me") — never an
 *  immediate-recap match; this consumer does not support assistant-recap,
 *  and must fail honestly rather than answer the wrong question. Checked
 *  first so it can never accidentally satisfy the two patterns above. */
const ASSISTANT_RECAP_RE = /^(?:so[,]?\s+)?what\s+did\s+you\s+(?:just\s+)?(?:tell|say to)\s+me\b/i;

/** Grammatical contraction normalization only ("what'd"/"which'd" -> "what
 *  did"/"which did") — STT/typed-text punctuation variance, not a phrase
 *  list. Applied before matching so the two regexes above only ever need
 *  to know the expanded form. */
function normalizeContractions(text: string): string {
  return text.replace(/\b(what|which)'d\b/gi, '$1 did');
}

/** Closed Active Subject acts Recap must not steal (person content-about-pronoun,
 *  medication identity "talking about"). Generic "what did I say about my medicine"
 *  remains Recap Stage A — that is not the pronoun content-lookup class. */
const RECAP_YIELDS_CONTENT_ABOUT_PERSON_RE =
  /\b(?:tell(?:ing)?\s+you|say(?:ing)?|mention(?:ing)?)\s+about\s+(?:him|her|them)\b/i;
const RECAP_YIELDS_MEDICATION_IDENTITY_RE =
  /^(?:so[,]?\s+)?(?:um+[,]?\s+|uh+[,]?\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:please\s+)?(?:what|which)\s+(?:medication|medicine|drug|meds?)\s+(?:was|were|am|are)\s+(?:i|we)\s+talking\s+about\s*[?.!]*$/i;

function recapYieldsToActiveSubject(text: string): boolean {
  const t = normalizeContractions(text.trim());
  if (!t) return false;
  return RECAP_YIELDS_CONTENT_ABOUT_PERSON_RE.test(t) || RECAP_YIELDS_MEDICATION_IDENTITY_RE.test(t);
}

export function classifyImmediateRecapDeterministic(text: string): boolean {
  const t = normalizeContractions(text.trim());
  if (!t) return false;
  if (ASSISTANT_RECAP_RE.test(t)) return false;
  if (recapYieldsToActiveSubject(t)) return false;
  return IMMEDIATE_RECAP_RE.test(t) || REMIND_ME_RE.test(t);
}

// ─── Candidate focus construction (bounded, real ledger evidence only) ────

export type RecapCandidate = {
  /** Stable index into the array THIS module built — the only thing Stage B
   *  is ever allowed to select by. There is no field through which Stage B
   *  could name a focus that isn't already one of these. */
  index: number;
  kind: ConversationTurnFocusEntry['kind'];
  displayValue: string;
  record: ConversationTurnRecord;
  focus: ConversationTurnFocusEntry;
  /** Resolved separately from record.intentType — see backfill note below.
   *  Known technical debt interaction: processUtterance.ts's generic
   *  resolvePending hook (Slice 2, preserved-not-fixed per CTO direction)
   *  always writes intentType:null on the CONFIRM turn's own record, since
   *  the original IntentRecord isn't available at that call site. Without
   *  backfill, the commit record (which wins identity resolution because
   *  it is newer and higher-tier) would carry no provenance to look up a
   *  reread adapter by, even though the earlier proposal record for the
   *  SAME identity already recorded it correctly. */
  intentType: string | null;
};

/**
 * Scans ledger evidence newest-first, keeps only `referable` focus entries,
 * and collapses same-identity entries (same resolverKey, or same
 * kind+displayValue when no resolverKey exists yet) to their MOST RECENT
 * representative. This is what makes "statement -> confirm -> yes -> commit
 * -> recap" resolve to the commit's authoritative focus without any
 * special-casing of "yes": the commit turn's ledger record (pushed by the
 * existing resolvePending hook) simply has a more recent, higher-identity
 * representative than the original proposal turn, for the SAME identity
 * key — so it naturally wins the newest-first scan. `intentType` is
 * backfilled from an older same-identity record when the winning (newest)
 * record's own is null — see RecapCandidate.intentType above. This never
 * touches processUtterance.ts; it works around the disclosed gap entirely
 * within this consumer, generically (identity-keyed, not medical_capture-
 * specific).
 */
export function buildRecapCandidates(entries: ConversationTurnRecord[]): RecapCandidate[] {
  const chosen: Omit<RecapCandidate, 'index'>[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const record = entries[i];
    for (const focus of record.focus) {
      if (!focus.referable) continue;
      const normValue = focus.displayValue.trim().toLowerCase();
      // Matches an already-chosen (more recent) representative either by
      // resolverKey equality, or by kind+displayValue equality when either
      // side lacks a resolverKey — this is what collapses an unconfirmed
      // proposal's focus (no resolverKey yet) into its own later commit's
      // focus (same displayValue, now WITH a resolverKey) as one identity,
      // without ever comparing utterance text.
      const existing = chosen.find(
        (c) =>
          (focus.resolverKey && c.focus.resolverKey === focus.resolverKey) ||
          (c.kind === focus.kind && c.displayValue.trim().toLowerCase() === normValue),
      );
      if (existing) {
        if (existing.intentType === null && record.intentType !== null) {
          existing.intentType = record.intentType;
        }
        continue; // newest-first scan: first (most recent) hit per identity owns the candidate itself
      }
      chosen.push({ kind: focus.kind, displayValue: focus.displayValue, record, focus, intentType: record.intentType });
    }
  }
  return chosen.map((c, index) => ({ ...c, index }));
}

// ─── Stage B — bounded semantic interpretation fallback ───────────────────

export type RecapInterpretationProposal = {
  isImmediateRecap: boolean;
  /** Bounds-checked against the candidate list actually supplied — an
   *  out-of-range or non-integer value fails the whole parse (null), same
   *  discipline as medicationSemanticInterpretation.ts's provenance checks. */
  selectedIndex: number | null;
  confidence: number;
};

export function parseRecapInterpretationProposal(
  rawModelOutput: string,
  candidateCount: number,
): RecapInterpretationProposal | null {
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
  if (typeof o.isImmediateRecap !== 'boolean') return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
  if (o.confidence < 0 || o.confidence > 1) return null;
  let selectedIndex: number | null = null;
  if (o.selectedIndex !== null && o.selectedIndex !== undefined) {
    if (typeof o.selectedIndex !== 'number' || !Number.isInteger(o.selectedIndex)) return null;
    if (o.selectedIndex < 0 || o.selectedIndex >= candidateCount) return null; // structural anti-fabrication bound
    selectedIndex = o.selectedIndex;
  }
  return { isImmediateRecap: o.isImmediateRecap, selectedIndex, confidence: o.confidence };
}

export const RECAP_INTERPRETATION_SYSTEM_PROMPT = `You classify whether the user is asking Herald to recap or remind them of something THEY just told Herald in this conversation — never a fresh question, never asking about someone else, never asking what Herald itself said.
You will be given a numbered list of candidates for what was recently discussed. You may ONLY refer to items by their number — never invent a new one.
Return ONLY a JSON object with these keys:
isImmediateRecap: true only if the user is asking to be reminded/told again what THEY said/mentioned/told Herald a moment ago
selectedIndex: the number of the single candidate being asked about, or null if unclear or not applicable
confidence: number 0 to 1
Do not explain. Do not add fields.`;

export function buildRecapInterpretationUserPrompt(raw: string, candidates: RecapCandidate[]): string {
  const list = candidates.map((c) => `${c.index}. ${c.displayValue}`).join('\n');
  return `Candidates:\n${list || '(none)'}\n\nUtterance: "${raw.replace(/"/g, '\\"')}"`;
}

const RECAP_INTERPRETATION_CONFIDENCE_THRESHOLD = 0.6;

export type RecapProposalGenerationResult =
  | { status: 'ok'; proposal: RecapInterpretationProposal }
  | { status: 'parse_fail' }
  | { status: 'unavailable' };

let interpreterInFlight = false;

export async function generateRecapInterpretationProposal(
  raw: string,
  candidates: RecapCandidate[],
  getCtx: () => LlamaContext | null,
): Promise<RecapProposalGenerationResult> {
  const ctx = getCtx();
  if (!ctx) return { status: 'unavailable' };
  if (interpreterInFlight) return { status: 'unavailable' };
  interpreterInFlight = true;
  const t0 = latMono();
  logSemanticRecapInferenceStart();
  try {
    const run = await completeBoundedInterpretation('recap', ctx, {
      messages: [
        { role: 'system', content: RECAP_INTERPRETATION_SYSTEM_PROMPT },
        { role: 'user', content: buildRecapInterpretationUserPrompt(raw, candidates) },
      ],
      n_predict: 96,
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    } as any);
    if (run.status !== 'ok') {
      logSemanticRecapInferenceEnd(latMono() - t0, undefined, 'error');
      return { status: 'unavailable' };
    }
    const result = run.value;
    const text = String((result as any)?.content || (result as any)?.text || '').trim();
    const proposal = parseRecapInterpretationProposal(text, candidates.length);
    logSemanticRecapInferenceEnd(latMono() - t0, result, proposal ? 'ok' : 'parse_fail');
    return proposal ? { status: 'ok', proposal } : { status: 'parse_fail' };
  } catch {
    logSemanticRecapInferenceEnd(latMono() - t0, undefined, 'error');
    return { status: 'unavailable' };
  } finally {
    interpreterInFlight = false;
  }
}

// ─── Deterministic re-read adapter registry (the ONE place domain knowledge
// legitimately lives — mirrors routeIntent.ts's DOMAIN_WRITERS dispatch
// table exactly: a small lookup, not inline conditional logic). Keyed by
// the record's own intentType (already a zero-enumeration passthrough on
// ConversationTurnRecord since Slice 2/3) — adding a future domain means
// adding one more entry here, never touching answerImmediateSemanticRecap
// below. ─────────────────────────────────────────────────────────────────

export type RereadResult = { found: true; text: string } | { found: false };
export type RereadAdapter = (resolverKey: string) => Promise<RereadResult>;

export const RECAP_REREAD_ADAPTERS: Partial<Record<string, RereadAdapter>> = {
  medical_capture: async (resolverKey: string): Promise<RereadResult> => {
    const { getActiveMedicationById, formatCurrentMedicationReadback } = await import('../db/medicalDB');
    const med = getActiveMedicationById(resolverKey);
    if (!med) return { found: false };
    return { found: true, text: formatCurrentMedicationReadback(med) };
  },
};

// ─── Top-level resolution ───────────────────────────────────────────────

export type ImmediateRecapOutcomeKind =
  | 'authoritative_reread'
  | 'unconfirmed_recap'
  | 'proposal_recap'
  | 'conversational_recap'
  | 'clarify_ambiguous'
  | 'honest_miss'
  | 'capability_gap';

export type ImmediateRecapOutcome =
  | { handled: false }
  | { handled: true; reply: string; kind: ImmediateRecapOutcomeKind };

function frameCandidate(c: RecapCandidate): { reply: string; kind: ImmediateRecapOutcomeKind } {
  const tier = c.focus.tier;
  if (tier === 'deterministic_unconfirmed') {
    return { reply: `You mentioned ${c.displayValue}, but I don't have that confirmed and saved yet.`, kind: 'unconfirmed_recap' };
  }
  if (tier === 'llm_proposal') {
    return { reply: `It sounded like you meant ${c.displayValue}, though I'm not fully sure — want to confirm?`, kind: 'proposal_recap' };
  }
  return { reply: `You mentioned ${c.displayValue}.`, kind: 'conversational_recap' };
}

/** Diagnostics-only sink (2026-09-xx device gate) — optional, written to as
 *  a pure side effect. Never read by this function, never influences a
 *  branch, condition, or return value below. Omitting it (existing callers
 *  outside this module, if any were ever added, or direct unit tests that
 *  don't care) leaves behavior byte-identical to before this instrumentation. */
type AnswerFromCandidateDiagSink = { adapterFound?: boolean; rereadOutcome?: 'success' | 'stale_miss' };

async function answerFromCandidate(c: RecapCandidate, diagSink?: AnswerFromCandidateDiagSink): Promise<ImmediateRecapOutcome> {
  if (c.focus.tier === 'authoritative' && c.focus.resolverKey) {
    const adapter = RECAP_REREAD_ADAPTERS[c.intentType ?? ''];
    if (diagSink) diagSink.adapterFound = !!adapter;
    if (!adapter) {
      // Bounded capability gap: authoritative evidence exists but no
      // deterministic reread adapter is registered for this domain yet.
      // Never assert displayValue as current fact without one — fall back
      // to the same honest, non-authoritative framing as an unconfirmed
      // recap rather than fabricate certainty.
      return { handled: true, reply: `You mentioned ${c.displayValue}, though I can't pull up the current saved details for that right now.`, kind: 'capability_gap' };
    }
    const reread = await adapter(c.focus.resolverKey);
    if (diagSink) diagSink.rereadOutcome = reread.found ? 'success' : 'stale_miss';
    if (!reread.found) {
      // Row no longer resolves (deleted/deactivated since the focus was
      // recorded) — honest miss, never fabricate from stale displayValue.
      return { handled: true, reply: `I don't have that saved anymore — want to tell me again?`, kind: 'honest_miss' };
    }
    return { handled: true, reply: reread.text, kind: 'authoritative_reread' };
  }
  const { reply, kind } = frameCandidate(c);
  return { handled: true, reply, kind };
}

export type ImmediateSemanticRecapDeps = {
  ledgerEntries: ConversationTurnRecord[];
  getInterpreterCtx?: () => LlamaContext | null;
};

/**
 * Single entry point. Returns handled:false when this mechanism has no
 * opinion (falls through to normal ephemeral/clarify handling, unchanged).
 * Never invoked while a deterministic pending is armed — the caller
 * (ephemeralSeam.ts / ChatScreen.tsx) only reaches this after
 * processUtterance's own pending check has already run and found nothing
 * pending, by construction (existing routing order, unmodified).
 */
export async function answerImmediateSemanticRecap(
  text: string,
  deps: ImmediateSemanticRecapDeps,
): Promise<ImmediateRecapOutcome> {
  const candidates = buildRecapCandidates(deps.ledgerEntries);
  const diagCandidates = candidates.map(toDiagCandidate);
  const utteranceNormalized = boundDiagText(text, DIAG_UTTERANCE_MAX_CHARS);

  if (recapYieldsToActiveSubject(text)) {
    logImmediateRecapDiag({
      invoked: true,
      utteranceNormalized,
      stageAMatched: false,
      stageB: { status: 'not_invoked' },
      candidateCount: candidates.length,
      candidates: diagCandidates,
      selectedCandidateIndex: null,
      selectedCandidateTier: null,
      adapterFound: null,
      rereadOutcome: 'not_applicable',
      finalResult: 'not_recap',
    });
    return { handled: false };
  }

  // Diagnostics-only helper (2026-09-xx device gate): assembles and emits
  // exactly one HERALD_IMMEDIATE_RECAP_DIAG event, reusing whatever
  // fields are already known at each call site. Never called more than
  // once per invocation (once per existing return statement, all mutually
  // exclusive branches) and never itself returns a value used by the
  // function — pure side effect, same discipline as HERALD_GATE_A_DIAG
  // already established in ChatScreen.tsx.
  function emitDiag(fields: {
    stageB: ImmediateRecapDiagStageB;
    selectedCandidateIndex: number | null;
    selectedCandidateTier: ConversationTurnFocusEntry['tier'] | null;
    adapterFound: boolean | null;
    rereadOutcome: 'success' | 'stale_miss' | 'not_applicable';
    finalResult: ImmediateRecapDiagEvent['finalResult'];
  }): void {
    logImmediateRecapDiag({
      invoked: true,
      utteranceNormalized,
      stageAMatched: deterministic,
      candidateCount: candidates.length,
      candidates: diagCandidates,
      ...fields,
    });
  }

  const deterministic = classifyImmediateRecapDeterministic(text);

  if (deterministic) {
    if (candidates.length === 0) {
      emitDiag({ stageB: { status: 'not_invoked' }, selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'no_candidate' });
      return { handled: true, reply: "I don't have anything recent to go on — what were you referring to?", kind: 'honest_miss' };
    }
    if (candidates.length === 1) {
      const diagSink: AnswerFromCandidateDiagSink = {};
      const outcome = await answerFromCandidate(candidates[0]!, diagSink);
      emitDiag({
        stageB: { status: 'not_invoked' },
        selectedCandidateIndex: candidates[0]!.index,
        selectedCandidateTier: candidates[0]!.focus.tier,
        adapterFound: diagSink.adapterFound ?? null,
        rereadOutcome: diagSink.rereadOutcome ?? 'not_applicable',
        finalResult: diagFinalResultFromOutcome(outcome),
      });
      return outcome;
    }
    emitDiag({ stageB: { status: 'not_invoked' }, selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'clarify_ambiguous' });
    return {
      handled: true,
      reply: `Did you mean ${candidates.slice(0, 3).map((c) => c.displayValue).join(' or ')}?`,
      kind: 'clarify_ambiguous',
    };
  }

  // Stage A did not confidently classify — fall back to bounded semantic
  // interpretation only if there is anything to interpret against and an
  // interpreter context is actually available.
  if (candidates.length === 0 || !deps.getInterpreterCtx) {
    emitDiag({
      stageB: candidates.length === 0 ? { status: 'not_invoked' } : { status: 'no_interpreter_context' },
      selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable',
      finalResult: candidates.length === 0 ? 'no_candidate' : 'not_recap',
    });
    return { handled: false };
  }
  const generation = await generateRecapInterpretationProposal(text, candidates, deps.getInterpreterCtx);
  if (generation.status !== 'ok') {
    emitDiag({ stageB: { status: generation.status }, selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'not_recap' });
    return { handled: false };
  }
  const { proposal } = generation;
  const stageBDiag: ImmediateRecapDiagStageB = { status: 'ok', isImmediateRecap: proposal.isImmediateRecap, selectedIndex: proposal.selectedIndex, confidence: proposal.confidence };
  if (!proposal.isImmediateRecap || proposal.confidence < RECAP_INTERPRETATION_CONFIDENCE_THRESHOLD) {
    emitDiag({ stageB: stageBDiag, selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'not_recap' });
    return { handled: false };
  }
  if (proposal.selectedIndex === null) {
    if (candidates.length === 1) {
      const diagSink: AnswerFromCandidateDiagSink = {};
      const outcome = await answerFromCandidate(candidates[0]!, diagSink);
      emitDiag({
        stageB: stageBDiag,
        selectedCandidateIndex: candidates[0]!.index,
        selectedCandidateTier: candidates[0]!.focus.tier,
        adapterFound: diagSink.adapterFound ?? null,
        rereadOutcome: diagSink.rereadOutcome ?? 'not_applicable',
        finalResult: diagFinalResultFromOutcome(outcome),
      });
      return outcome;
    }
    emitDiag({ stageB: stageBDiag, selectedCandidateIndex: null, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'clarify_ambiguous' });
    return {
      handled: true,
      reply: `Did you mean ${candidates.slice(0, 3).map((c) => c.displayValue).join(' or ')}?`,
      kind: 'clarify_ambiguous',
    };
  }
  const selected = candidates[proposal.selectedIndex];
  if (!selected) {
    // defensive; parseRecapInterpretationProposal already bounds-checks
    emitDiag({ stageB: stageBDiag, selectedCandidateIndex: proposal.selectedIndex, selectedCandidateTier: null, adapterFound: null, rereadOutcome: 'not_applicable', finalResult: 'not_recap' });
    return { handled: false };
  }
  const diagSink: AnswerFromCandidateDiagSink = {};
  const outcome = await answerFromCandidate(selected, diagSink);
  emitDiag({
    stageB: stageBDiag,
    selectedCandidateIndex: selected.index,
    selectedCandidateTier: selected.focus.tier,
    adapterFound: diagSink.adapterFound ?? null,
    rereadOutcome: diagSink.rereadOutcome ?? 'not_applicable',
    finalResult: diagFinalResultFromOutcome(outcome),
  });
  return outcome;
}

/** Diagnostics-only mapping from an already-computed ImmediateRecapOutcome
 *  to the diagnostic event's finalResult vocabulary — read-only, derives
 *  nothing new, changes nothing about the outcome itself. Only ever called
 *  after answerFromCandidate resolves (a real candidate was selected), so
 *  its 'honest_miss' kind here always means a stale/deleted resolver
 *  reference — never "no candidate" (that path never reaches this
 *  function; it logs 'no_candidate' directly at its own call site). */
function diagFinalResultFromOutcome(outcome: ImmediateRecapOutcome): ImmediateRecapDiagEvent['finalResult'] {
  if (!outcome.handled) return 'not_recap';
  switch (outcome.kind) {
    case 'authoritative_reread': return 'answered_authoritative';
    case 'unconfirmed_recap': return 'answered_unconfirmed';
    case 'proposal_recap': return 'answered_proposal';
    case 'conversational_recap': return 'answered_conversational';
    case 'clarify_ambiguous': return 'clarify_ambiguous';
    case 'capability_gap': return 'capability_gap';
    case 'honest_miss': return 'stale_reference_miss';
    default: return 'not_recap';
  }
}
