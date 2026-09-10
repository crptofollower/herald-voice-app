// src/routing/capabilityRouting.ts
// Natural Language Authority V1 / Slice 1 — bounded capability selection for
// the medication catalog READ, and nothing else. Governing design:
//   HERALD_NL_AUTHORITY_ARCHITECTURE_SYNTHESIS_2026-09-07.md
//
// Constitutional split, unchanged:
//   natural-language utterance
//     → probabilistic CapabilityProposal (this module proposes meaning only)
//     → deterministic, NON-LINGUISTIC structural admission (this module)
//     → existing authoritative reader (the CALLER invokes it; not here)
//
// This module contains NO database access, NO session/pending mutation, NO
// write authority, and — the load-bearing property for this slice — NO regex,
// keyword, phrase, branded-name, or sentence-template matching over the
// transcript. It never inspects the English utterance to decide that it is
// "medication-shaped." The probabilistic interpreter determines meaning; the
// deterministic layer here only checks the SHAPE of the proposal (schema,
// capability membership, risk class, confidence bucket). The one place raw
// text is touched is the model prompt input in generateCapabilityProposal —
// it is handed to the interpreter verbatim, never pattern-matched.
//
// Slice boundary: only `medication.read_summary` is WIRED. Every other
// capability (including every non-medication off-ramp) admits to ABSTAIN and
// the caller falls through unchanged. The off-ramps exist so the model is
// never forced to pick medication for an unrelated utterance — an utterance
// that is not a medication catalog read has somewhere else to go in the
// vocabulary, which is what makes "unrelated input cannot be forced into
// medication" a property of the interpreter, not of a deterministic keyword
// exclusion list.

import type { LlamaContext } from 'llama.rn';
import { isLlamaContextBusy } from '../utils/llamaContextExclusive';

// ─── Closed capability vocabulary ───────────────────────────────────────────
// One id per real Herald capability. Named for what Herald DOES, never for
// what the user SAID. Only `medication.read_summary` is wired in this slice;
// the rest are genuine off-ramps (and `other` is the catch-all) so the model
// has meaningful non-medication choices.

export const CAPABILITY_IDS = [
  'medication.read_summary', // WIRED READ — medication catalog read admission
  'medication.capture',      // dispatch: medication write interpreter (not admitted here)
  'grocery.capture',         // dispatch: grocery write interpreter (not admitted here)
  'list.read',               // off-ramp: shopping / to-do list read
  'calendar.read',           // off-ramp: appointments / schedule read
  'contact.call',            // off-ramp: call or text someone
  'uncertain',               // off-ramp: meaning too unclear to assign a capability
  'other',                   // off-ramp: anything else, general questions, small talk
] as const;

export type CapabilityId = typeof CAPABILITY_IDS[number];

export type CapabilityConfidence = 'high' | 'medium' | 'low';

export type CapabilityProposal = {
  capability: CapabilityId;
  confidence: CapabilityConfidence;
};

const CAPABILITY_ID_SET = new Set<string>(CAPABILITY_IDS);
const CONFIDENCE_SET = new Set<string>(['high', 'medium', 'low']);

// ─── Risk class — a pure function of the capability, NEVER of confidence ─────
// Confidence can only downgrade an admission to ABSTAIN; it can never raise
// the risk class or grant authority. Risk class is table-derived so a model
// can never argue its way into a lower-consequence lane.

export type CapabilityRiskClass = 'read' | 'write' | 'external' | 'none';

export const CAPABILITY_RISK_CLASS: Record<CapabilityId, CapabilityRiskClass> = {
  'medication.read_summary': 'read',
  'medication.capture': 'write',
  'grocery.capture': 'write',
  'list.read': 'read',
  'calendar.read': 'read',
  'contact.call': 'external',
  'uncertain': 'none',
  'other': 'none',
};

// The single wired capability for this slice. Isolated as a constant so the
// admission logic reads as "is this THE wired read capability," never as an
// open set that could quietly grow into a second router.
export const WIRED_READ_CAPABILITY: CapabilityId = 'medication.read_summary';

// ─── Strict parse / validation — no coercion ────────────────────────────────
// Mirrors the validate-and-reject-on-any-mismatch discipline already proven by
// parseSemanticProposal (medicationSemanticInterpretation.ts) and
// parseSemanticProposal (listRemoveInterpretationShadow.ts). Any field of the
// wrong type/value rejects the WHOLE proposal (null) — never defaulted, never
// coerced, never partially trusted. Constrained decoding guarantees the shape;
// this validator is the belt-and-suspenders that does not trust the runtime to
// have honored the grammar.
export function parseCapabilityProposal(rawModelOutput: string): CapabilityProposal | null {
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
  if (typeof o.capability !== 'string' || !CAPABILITY_ID_SET.has(o.capability)) return null;
  if (typeof o.confidence !== 'string' || !CONFIDENCE_SET.has(o.confidence)) return null;
  return {
    capability: o.capability as CapabilityId,
    confidence: o.confidence as CapabilityConfidence,
  };
}

// ─── Deterministic structural admission ─────────────────────────────────────
// Pure, synchronous. No DB, no network, no session, no transcript. Produces
// exactly one of ADMIT_READ / ABSTAIN.
//
// For `medication.read_summary` there is deliberately NO medication-language
// evidence gate (Slice 1 contract): a valid, non-low-confidence proposal for
// the wired read capability admits directly. This is SAFE precisely because a
// summary read persists nothing and fabricates nothing — its entire content is
// produced by the authoritative SQLite reader from real stored rows. A wrong
// read is a recoverable sentence, not a corrupted record; applying a linguistic
// evidence gate here would only recreate the "is this medication-shaped English"
// parser this architecture exists to remove.
//
// hasIndependentMedicationEvidence is intentionally NOT called here. It gates
// the write seam only.

export type CapabilityAdmission =
  | { decision: 'ADMIT_READ'; capability: 'medication.read_summary'; riskClass: 'read' }
  | { decision: 'ABSTAIN'; reason: string };

export function admitCapabilityProposal(proposal: CapabilityProposal): CapabilityAdmission {
  // Membership is guaranteed by parse; re-assert defensively (a future caller
  // could construct a proposal object directly, bypassing parse).
  if (!CAPABILITY_ID_SET.has(proposal.capability)) {
    return { decision: 'ABSTAIN', reason: 'unknown_capability' };
  }

  // Only the wired read capability is actionable in this slice. Every other
  // capability — every off-ramp, every write, every external action — abstains
  // and the caller falls through unchanged. A write capability can NEVER be
  // executed from this read admission path.
  if (proposal.capability !== WIRED_READ_CAPABILITY) {
    return { decision: 'ABSTAIN', reason: `capability_not_wired:${proposal.capability}` };
  }

  // Risk class derives from the capability, not from confidence. Structural
  // guard: the wired read capability must be a read. (Defends against a future
  // edit to CAPABILITY_RISK_CLASS silently changing this lane's consequence.)
  if (CAPABILITY_RISK_CLASS[proposal.capability] !== 'read') {
    return { decision: 'ABSTAIN', reason: 'risk_class_not_read' };
  }

  // Confidence is a bucket and may only downgrade to ABSTAIN — it never grants
  // admission by itself (it is checked AFTER membership + risk class, never as
  // a substitute for either).
  if (proposal.confidence === 'low') {
    return { decision: 'ABSTAIN', reason: 'low_confidence' };
  }

  return { decision: 'ADMIT_READ', capability: 'medication.read_summary', riskClass: 'read' };
}

// ─── Proposal generation (interpreter I/O boundary) ─────────────────────────
// No DB, no session, no write authority. Mirrors
// generateMedicationSemanticProposal's try/catch/unavailable + in-flight guard
// discipline (medicationSemanticInterpretation.ts) exactly. `getCtx` is
// injected by the caller so this module has no wiring to any particular model
// instance/lifecycle — the caller supplies the SAME independent medication 3B
// context the write seam uses (Slice 1: reuse the live context, add none).

export type CapabilityGenerationResult =
  | { status: 'ok'; proposal: CapabilityProposal }
  | { status: 'parse_fail'; raw: string }
  | { status: 'unavailable' };

// Capability definitions, not phrase templates. The model is told what each
// capability MEANS and picks one; there are no example utterances, no keyword
// lists, and none of the device-proof sentences. This is the probabilistic
// interpreter determining meaning — the exact job the deterministic layer must
// not do. Off-ramps (list.read / calendar.read / contact.call / other) give an
// unrelated utterance a home so medication is never a forced choice.
export const CAPABILITY_PROPOSAL_SYSTEM_PROMPT = `You label what a single spoken request is asking a memory assistant to do.
Pick exactly one capability. If none clearly fits, pick "other". If the request is too unclear to assign a capability, pick "uncertain".

capability — one of:
  medication.read_summary : the person wants to hear which medications they take or are currently on.
  medication.capture      : the person is telling the assistant about a medication they take, so it can remember it.
  grocery.capture         : the person wants the assistant to remember items to buy at the store.
  list.read               : the person wants to hear a shopping list or a to-do list.
  calendar.read           : the person wants to hear their appointments or schedule.
  contact.call            : the person wants to call or text someone.
  uncertain               : the request is too unclear to assign a capability.
  other                   : anything else, including general questions and small talk.

confidence — high, medium, or low: how sure you are of the capability.

Return ONLY a JSON object: {"capability": "...", "confidence": "..."}. Do not add any other text.`;

// Constrained structured output (llama.rn json_schema response_format, runtime
// 0.12.x). The grammar restricts `capability` to the closed vocabulary and
// `confidence` to the three buckets, so the model cannot emit an out-of-set
// capability or a free-text field. The validator (parseCapabilityProposal)
// still runs — grammar guarantees shape, not that the runtime honored it.
export const CAPABILITY_PROPOSAL_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['capability', 'confidence'],
      properties: {
        capability: { type: 'string', enum: [...CAPABILITY_IDS] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
  },
};

// Concurrency guard — same rationale as the write seam's interpreterInFlight:
// one call site, one dedicated context; reject a re-entrant call to myself
// rather than queue. Cleared in `finally`, the only reset point, so success, a
// caught exception, and a rejected completion all clear it identically.
// isLlamaContextBusy() is also checked (read-only) so two native inferences
// never run at the same wall-clock moment on a constrained device — deferring
// to "unavailable" costs nothing. Both checks are plain early-returns before
// any state is claimed; never queues, never waits.
let capabilityInterpreterInFlight = false;

export async function generateCapabilityProposal(
  raw: string,
  getCtx: () => LlamaContext | null,
): Promise<CapabilityGenerationResult> {
  const ctx = getCtx();
  if (!ctx) return { status: 'unavailable' };
  if (capabilityInterpreterInFlight) return { status: 'unavailable' };
  if (isLlamaContextBusy()) return { status: 'unavailable' };
  capabilityInterpreterInFlight = true;
  try {
    const result = await ctx.completion({
      messages: [
        { role: 'system', content: CAPABILITY_PROPOSAL_SYSTEM_PROMPT },
        { role: 'user', content: raw },
      ],
      n_predict: 48,
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
      response_format: CAPABILITY_PROPOSAL_RESPONSE_FORMAT,
    } as any);
    const text = String((result as any)?.content || (result as any)?.text || '').trim();
    const proposal = parseCapabilityProposal(text);
    return proposal ? { status: 'ok', proposal } : { status: 'parse_fail', raw: text };
  } catch {
    return { status: 'unavailable' };
  } finally {
    capabilityInterpreterInFlight = false;
  }
}
