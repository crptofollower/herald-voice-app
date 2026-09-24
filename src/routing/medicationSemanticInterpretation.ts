// src/routing/medicationSemanticInterpretation.ts
// Medication Semantic Interpretation V1 — the probabilistic proposal +
// deterministic admission seam approved in:
//   HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_IMPLEMENTATION_DESIGN.md
//   HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1_CTO_REVIEW_RESOLUTION.md
//
// Ratified architecture:
//   natural-language utterance -> probabilistic SemanticProposal
//     -> deterministic admission -> existing authoritative capability
//     -> authoritative state/action.
// The interpreter proposes meaning, never authority. This module contains
// NO database access, NO session/pending mutation, and NO write authority of
// any kind — it produces a pure decision that the caller (routeIntent.ts)
// converts into the pre-existing 'medical_capture' IntentRecord shape.
//
// SemanticProposal remains provider-neutral and storage-blind:
//   { mentions[], predicate, focus, confidence }
//
// CONTRACT CORRECTION (2026-09-07, Semantic Interpretation V1 contract
// closure): `act` was removed from this contract. It required a model to
// self-report a closed 7-value illocutionary-force taxonomy; a bounded
// 84-generation discrimination experiment against the real production
// model/prompt/parser found the model never once emitted the required
// 'assert' value (0/84) — it substituted an aspectual distinction (state vs.
// change-of-state: 'read' for "I'm on X"/"I'm taking X", the out-of-schema
// 'start' for "I started X") that answers a different question than the one
// asked. That is a CONTRACT defect, not a per-model quirk: no vocabulary
// widening ("just also accept read/start") can fix it, because 'read' is
// also the value a model should legitimately emit for a genuine QUESTION —
// widening the allowlist would have deleted the one protection `act`
// existed to provide. The safety property `act` protected (never treat a
// question/correction/cancel/confirm as a fresh assertion) is preserved
// below by a deterministic, provider-neutral pre-check on the raw utterance
// (isReadShapedUtterance / isMedicationInquirySpeechAct, already shipped and
// used by the deterministic floor) instead of a model self-report.
//
// `mentions` was simplified from `{text}[]` to `string[]`: the object
// wrapper carried no information beyond `.text`, and the SAME 84-generation
// dataset showed the model produced flat strings 84/84 times, never once the
// object shape — an independent, equally systematic CONTRACT mismatch.

import type { LlamaContext } from 'llama.rn';
import {
  detectMedicalEvent,
  extractDosage,
  extractFrequency,
  hasIndependentMedicationEvidence,
  isReadShapedUtterance,
  isMedicationQuestionShape,
} from '../utils/detectMedicalEvent';
import { runSpecialistInference } from './semanticProvider';
import {
  boundDiagnosticStrings,
  logSemanticAdmissionDone,
  logSemanticGroundingDone,
  logSemanticSpecialistInferenceEnd,
  logSemanticSpecialistInferenceStart,
  logSemanticWriteLift,
  type SemanticWriteLiftReason,
  mono as latMono,
} from '../utils/latencyInstrument';
import type { CapabilityProposal } from './capabilityRouting';

// ─── SemanticProposal (corrected shape) ────────────────────────────────────

export type SemanticProposal = {
  mentions: string[];
  predicate: string;
  focus: string;
  confidence: number;
};

// ─── Strict parse / validation — no coercion ───────────────────────────────
// Mirrors the validate-and-reject-on-any-mismatch discipline already proven
// by parseSemanticProposal in src/dev/listRemoveInterpretationShadow.ts.
// Any field of the wrong type or shape rejects the WHOLE proposal (null) —
// never defaulted, never coerced, never partially trusted.
export function parseSemanticProposal(rawModelOutput: string): SemanticProposal | null {
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

  if (typeof o.predicate !== 'string') return null;
  if (typeof o.focus !== 'string') return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
  if (o.confidence < 0 || o.confidence > 1) return null;
  if (!Array.isArray(o.mentions)) return null;

  const mentions: string[] = [];
  for (const m of o.mentions) {
    if (typeof m !== 'string') return null;
    mentions.push(m);
  }

  return {
    mentions,
    predicate: o.predicate,
    focus: o.focus,
    confidence: o.confidence,
  };
}

export type MedicationDispatchWriteLiftDiag = {
  lifted: SemanticProposal | null;
  selectedCapability: string;
  outcome: 'ok' | 'fail';
  reason: SemanticWriteLiftReason;
};

export function diagnoseMedicationDispatchWriteLift(
  proposal: CapabilityProposal,
): MedicationDispatchWriteLiftDiag {
  const selectedCapability = proposal.capability;
  if (proposal.capability !== 'medication.capture') {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'wrong_capability' };
  }
  const write = proposal.write;
  if (!write) {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'missing_write' };
  }
  if (write.mentions === undefined) {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'missing_mentions' };
  }
  if (write.predicate === undefined) {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'missing_predicate' };
  }
  if (write.focus === undefined) {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'missing_focus' };
  }
  if (write.score === undefined) {
    return { lifted: null, selectedCapability, outcome: 'fail', reason: 'missing_score' };
  }
  const lifted: SemanticProposal = {
    mentions: write.mentions,
    predicate: write.predicate,
    focus: write.focus,
    confidence: write.score,
  };
  if (write.mentions.length === 0) {
    return { lifted, selectedCapability, outcome: 'ok', reason: 'empty_mentions' };
  }
  return { lifted, selectedCapability, outcome: 'ok', reason: 'ok' };
}

/** Lift a one-pass dispatch write payload into the specialist proposal shape. No inference. */
export function medicationSemanticProposalFromDispatchWrite(
  proposal: CapabilityProposal,
): SemanticProposal | null {
  const diag = diagnoseMedicationDispatchWriteLift(proposal);
  logSemanticWriteLift({
    specialist: 'medication',
    selectedCapability: diag.selectedCapability,
    outcome: diag.outcome,
    reason: diag.reason,
  });
  return diag.lifted;
}

// ─── Provenance verification (Invariant 3) ─────────────────────────────────
// A trust-critical span is authoritative only if it is (a) a contiguous,
// case/whitespace-normalized substring of raw_phrase, or (b) the output of
// an EXISTING registered deterministic normalizer (extractDosage's own
// spoken-number table) applied to raw_phrase — mirroring passesSubstringGate
// (src/db/medicalDB.ts) exactly, so a model rephrasing/normalization that is
// not one of those two things can never become an authoritative value
// (Invariant 4). This function does not import passesSubstringGate itself
// (that would pull a DB-adjacent module into a DB-free module) but
// reproduces its exact normalization rule for spans this module inspects
// before any IntentRecord is ever constructed — the write path re-checks the
// identical rule independently at write time (defense in depth, unchanged).
function normalizeForProvenance(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isProvenanceVerified(value: string, raw: string): boolean {
  const v = value?.trim();
  if (!v) return false;
  const normValue = normalizeForProvenance(v);
  const normRaw = normalizeForProvenance(raw);
  if (normRaw.includes(normValue)) return true;
  const normalizedDosage = extractDosage(raw);
  if (normalizedDosage && normalizeForProvenance(normalizedDosage) === normValue) return true;
  return false;
}

// ─── Deterministic admission ────────────────────────────────────────────────

export type MedicationAdmissionDecision =
  | { decision: 'ADMIT'; drug: string; dosage?: string; frequency?: string }
  | { decision: 'CLARIFY'; reason: string }
  | { decision: 'REJECT'; reason: string }
  | { decision: 'DEFER'; reason: string };

export type MedicationAdmissionContext = {
  /** Invariant 1: pending state owns the turn. True whenever
   *  session.hasPending() is armed — this function must never be reached in
   *  that state by call-site construction, but is re-checked here defensively. */
  hasPending: boolean;
};

const MEDICATION_SEMANTIC_CONFIDENCE_THRESHOLD = 0.6; // tunable; not a safety boundary (Invariant 6)

/**
 * Pure, synchronous, deterministic. No DB, no network, no session mutation
 * (Invariant 8). Produces exactly one of ADMIT / CLARIFY / REJECT / DEFER.
 *
 * Evaluates the WHOLE utterance as one proposal — no clause segmentation is
 * added here (V1 compound-utterance boundary, unchanged from the approved
 * design).
 */
function finishMedicationAdmission(decision: MedicationAdmissionDecision): MedicationAdmissionDecision {
  logSemanticAdmissionDone({
    capability: 'medication.capture',
    decision: decision.decision,
    ...(decision.decision !== 'ADMIT' ? { reason: decision.reason } : {}),
  });
  return decision;
}

export function admitMedicationSemanticProposal(
  raw: string,
  proposal: SemanticProposal,
  ctx: MedicationAdmissionContext,
): MedicationAdmissionDecision {
  // Invariant 1 — pending state owns the turn.
  if (ctx.hasPending) return finishMedicationAdmission({ decision: 'DEFER', reason: 'pending_owns_turn' });

  // Invariant 2 — existing deterministic medication detection owns the turn
  // first. Re-checks the exact, unmodified detectMedicalEvent the deterministic
  // floor already runs (belt-and-suspenders against a future call-site
  // regression; the approved insertion point in routeIntent.ts already
  // guarantees this by construction/ordering).
  if (detectMedicalEvent(raw)) return finishMedicationAdmission({ decision: 'DEFER', reason: 'deterministic_floor_already_claims' });

  // Speech-act gate (contract correction, 2026-09-07) — replaces the former
  // model-self-reported `act === 'assert'` check. The safety property is
  // identical (never treat a question/read as a fresh assertion); the
  // mechanism is now deterministic and provider-neutral: reuse of
  // already-shipped guards from detectMedicalEvent.ts — general
  // sentence-initial subject-auxiliary-inversion shape ("Am I...", "Should
  // I...", "Do I...") plus genuinely interrogative medication-inquiry
  // frames (frequency/timing/"do I take"). Uses isMedicationQuestionShape,
  // not the floor's own isMedicationInquirySpeechAct: verified by direct
  // execution that reusing the floor function verbatim here misclassifies
  // real assertions ("I'm switching to a new dose of Synthroid, 75
  // micrograms." is not a question) via its DOSE_INQUIRY co-occurrence
  // branch, which requires no interrogative marker at all — safe for the
  // floor's narrower callers, unsafe at the seam's wider evaluation surface.
  // Not medication-name knowledge, not a drug list — pure sentence shape.
  if (isReadShapedUtterance(raw) || isMedicationQuestionShape(raw)) {
    return finishMedicationAdmission({ decision: 'REJECT', reason: 'read_shaped_utterance' });
  }

  const focus = proposal.focus.trim();
  if (!focus) return finishMedicationAdmission({ decision: 'REJECT', reason: 'empty_focus' });

  // Invariant 3 — every trust-critical span provenance-verified against raw.
  // A single unverified mention rejects the whole proposal — a hallucinated
  // span is never merely dropped and silently proceeded with.
  for (const mention of proposal.mentions) {
    if (!isProvenanceVerified(mention, raw)) {
      logSemanticGroundingDone({
        capability: 'medication.capture',
        result: 'failed',
        reason: 'unverified_mention',
        candidates: boundDiagnosticStrings(proposal.mentions),
      });
      return finishMedicationAdmission({ decision: 'REJECT', reason: 'unverified_mention' });
    }
  }
  if (!isProvenanceVerified(focus, raw)) {
    logSemanticGroundingDone({
      capability: 'medication.capture',
      result: 'failed',
      reason: 'unverified_focus',
      candidates: boundDiagnosticStrings([proposal.focus]),
    });
    return finishMedicationAdmission({ decision: 'REJECT', reason: 'unverified_focus' });
  }
  logSemanticGroundingDone({ capability: 'medication.capture', result: 'ok' });

  // Invariant 6 — confidence may cause clarification; it never grants
  // admission by itself. Checked only AFTER provenance, never as a substitute
  // for it.
  if (proposal.confidence < MEDICATION_SEMANTIC_CONFIDENCE_THRESHOLD) {
    return finishMedicationAdmission({ decision: 'CLARIFY', reason: 'low_confidence' });
  }

  // Invariant 5 & 7 — hasIndependentMedicationEvidence (never
  // hasMedicationDomainEvidence) supplies domain evidence, and itself refuses
  // a filler/category focus ("medicine", "pill", "prescription") as a name.
  if (!hasIndependentMedicationEvidence(raw, focus)) {
    return finishMedicationAdmission({ decision: 'CLARIFY', reason: 'insufficient_domain_evidence' });
  }

  // Invariant 4 — dosage/frequency are NEVER taken from the model's proposal
  // (the ratified SemanticProposal V1 shape has no dosage/frequency field at
  // all). They are independently re-derived from raw via the existing,
  // already-production deterministic normalizers — the only route by which a
  // dosage/frequency value may become authoritative.
  const dosage = extractDosage(raw);
  const frequency = extractFrequency(raw);

  return finishMedicationAdmission({ decision: 'ADMIT', drug: focus, dosage, frequency });
}

// ─── Proposal generation (interpreter I/O boundary) ────────────────────────
// No DB, no session, no write authority (Invariant 8). Mirrors
// generateShadowProposal's try/catch/unavailable discipline
// (src/dev/listRemoveInterpretationShadow.ts) exactly. `getCtx` is injected
// by the caller so this module has no direct wiring to any particular model
// instance/lifecycle.

export type ProposalGenerationResult =
  | { status: 'ok'; proposal: SemanticProposal }
  | { status: 'parse_fail'; raw: string }
  | { status: 'unavailable' };

export const MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT = `You extract JSON describing what a sentence expresses, for medication interpretation only.
Do not claim any action occurred. Do not invent medication names, doctors, or dosages not present in the sentence.
Return ONLY a JSON object with these keys:
mentions: array of strings — each string MUST be copied verbatim from the sentence
predicate: the verb/relation expressed (e.g. "take", "prescribed", "put on"), copied or closely derived from the sentence
focus: the single span that names the medication being discussed, copied verbatim from the sentence; empty string if none
confidence: number 0 to 1
Describe the sentence, not the world. Never resolve or normalize a name. confidence never authorizes a capture by itself.`;

// Concurrency guard (bounded runtime wiring, 2026-09-07): this interpreter
// has exactly one call site and one dedicated context — it needs only
// "reject a re-entrant call to myself," not the multi-owner/wait-queue
// machinery llamaContextExclusive.ts provides for the shared classifier
// context (which arbitrates several named owners over one resource). A
// single module-level flag is the smallest mechanism that guarantees no two
// medication semantic completions run concurrently against this context.
// Set/cleared around exactly one call site; the `finally` below is the only
// reset point, so success, a caught exception, and a rejected completion
// promise all clear it identically — no exit path can leave it stuck true.
//
// Also checks isLlamaContextBusy() (read-only, already exported by
// llamaContextExclusive.ts — not modified here) before starting inference:
// even though this context never shares KV state with the shared classifier
// context, running two native inference sessions at the same wall-clock
// moment on a resource-constrained mobile device is a real, unproven
// concern this codebase has no evidence to dismiss. Deferring to
// "unavailable" costs nothing and avoids it entirely, per the standing
// preference for safe serialization over speculative concurrency
// optimization. Never queues, never waits — both checks are now owned by
// semanticCompletionLifecycle.ts. This module does not hold a private in-flight boolean.

export async function generateMedicationSemanticProposal(
  raw: string,
  getCtx: () => LlamaContext | null,
): Promise<ProposalGenerationResult> {
  const t0 = latMono();
  const run = await runSpecialistInference('medication', getCtx, {
    messages: [
      { role: 'system', content: MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT },
      { role: 'user', content: raw },
    ],
    n_predict: 128,
    temperature: 0,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
  }, {
    onAcquired: () => logSemanticSpecialistInferenceStart('medication'),
  });
  if (run.status === 'unavailable') {
    if (run.reason === 'error') {
      logSemanticSpecialistInferenceEnd('medication', latMono() - t0, undefined, 'error');
    }
    return { status: 'unavailable' };
  }
  const result = run.value;
  const text = String((result as any)?.content || (result as any)?.text || '').trim();
  const proposal = parseSemanticProposal(text);
  logSemanticSpecialistInferenceEnd(
    'medication',
    latMono() - t0,
    result,
    proposal ? 'ok' : 'parse_fail',
  );
  return proposal ? { status: 'ok', proposal } : { status: 'parse_fail', raw: text };
}
