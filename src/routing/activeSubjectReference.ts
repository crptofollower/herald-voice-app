// src/routing/activeSubjectReference.ts
// Active Subject / Reference Continuity V1.
//
// Target capability: after an entity (e.g. a doctor) is established through
// an existing trustworthy path, the user can naturally continue referring to
// it — "He wants me to come back next month.", "Who am I talking about?",
// "What was I saying about him?", and unseen held-out equivalents ("Who did
// I mean there?") — without restating the name, and without any of that
// reference resolution ever authorizing a domain write on its own.
//
// Architecture (mirrors Immediate Semantic Recap's two-stage discipline,
// replicated here rather than imported — a distinct task, and recap itself
// stays untouched):
//   Stage A — a small, closed structural fast path for TWO purposes, kept
//     separate on purpose (CTO correction, 2026-09-xx):
//       (a) ACT applicability — is this utterance actually a reference-
//           continuity act at all? Confirmed deterministically only for two
//           closed question shapes ("who/what am/was/were I/we" +
//           {talk,speak,chat}×{about,with,to} or "saying"; "what did/was I
//           say/saying about him/her/them") and one statement-continuation
//           gate (contains a bound third-person referent, is not itself a
//           question). A broader,
//           verb-agnostic structural shape ("short first-person WH-question,
//           no named subject of its own") is merely a candidate for Stage B
//           to judge — it never grants act-confirmed status by itself, so
//           candidate existence alone can never make this consumer handle an
//           unrelated question.
//       (b) fast-path candidate selection — once an act is confirmed,
//           exactly one compatible candidate resolves deterministically,
//           without a model call.
//   Stage B — invoked whenever (a) is unconfirmed (unseen question shape —
//     must decide applicability itself) or whenever more than one compatible
//     candidate exists for a confirmed act. Selects by INDEX into a caller-
//     supplied, already-built candidate list, or reports `applicable:false`
//     when the utterance isn't a reference-continuity act at all. It cannot
//     fabricate a candidate that isn't already one of these — there is no
//     channel through which it could name one. When no interpreter context
//     is available and applicability is unconfirmed, this fails CLOSED
//     (`handled:false`) rather than guessing — never treated as ambiguous,
//     which would misrepresent "we don't know if this is even our act" as
//     "we know it's our act but can't tell which candidate".
//
// Trust boundary: this module never imports anything under src/db/ and
// never references DOMAIN_WRITERS. It only ever returns plain reply text and
// ConversationTurnFocusEntry[] with tier:'conversational' (via
// conversationTurnLedgerWrite.ts's buildFocusEntry, referenceOnly:true). It
// is structurally incapable of writing a medical record or any other
// authoritative fact. Resolving "he" to Dr. Smith grounds a conversation
// turn as bounded RAM evidence — it is never treated as, and cannot become,
// a domain commit. A successful grounding speaks only a minimal neutral
// acknowledgment ("Okay.", the same wording already used elsewhere in Herald
// — see medicalVisitOutcomeAsk.ts) — never a phrase implying persistence.
//
// Candidate selection never ranks by recency alone (CTO correction): the
// deterministic fast path fires ONLY when exactly one compatible (person-
// kind) candidate is live AND the act is already confirmed. Two or more
// compatible candidates always go to Stage B (semantic judgment over the
// full bounded set) or, failing that, existing ConversationSession pending/
// clarification authority — never an automatic "newest wins" selection.
// Nothing is held between turns: there is no active-subject holder here.
// Every resolution is recomputed fresh, per question, from the bounded
// ConversationTurnLedger.

import type { LlamaContext } from 'llama.rn';
import type { ConversationTurnFocusEntry, ConversationTurnRecord } from './conversationTurnLedger';
import { buildRecapCandidates, type RecapCandidate } from './immediateSemanticRecap';
import {
  logActiveSubjectInferenceEnd,
  logActiveSubjectInferenceStart,
  mono as latMono,
} from '../utils/latencyInstrument';
import { buildFocusEntry } from './conversationTurnLedgerWrite';
import { THIRD_PERSON_REFERENT_RE } from '../utils/instructionSignals';
import { matchCandidateToken, type MatchableCandidate } from './conversationSession';
import type { CommitResult } from './routeIntent';

// ─── Diagnostics only (2026-09-xx, device acceptance gate) ────────────────
// Pure observability, same discipline as HERALD_IMMEDIATE_RECAP_DIAG: one
// compact event per answerActiveSubjectReference() call, bounded to fields
// already present in the normalized focus contract — never a raw
// resolverKey value, never unrestricted personal memory or database
// contents.
export type ActiveSubjectDiagCandidate = {
  index: number;
  kind: ConversationTurnFocusEntry['kind'];
  displayValue: string;
  tier: ConversationTurnFocusEntry['tier'];
  hasResolverKey: boolean;
  intentType: string | null;
};

export type ActiveSubjectDiagAct = 'grounding' | 'identity_lookup' | 'content_lookup' | 'medication_identity' | 'not_applicable';
export type ActiveSubjectDiagSemanticResult = 'not_invoked' | 'selected' | 'ambiguous' | 'none' | 'not_applicable';
export type ActiveSubjectDiagFinalOutcome = 'grounded' | 'answered' | 'ambiguous' | 'not_handled';

export type ActiveSubjectDiagEvent = {
  invoked: true;
  utteranceNormalized: string;
  act: ActiveSubjectDiagAct;
  targetKind: ConversationTurnFocusEntry['kind'] | null;
  candidateCount: number;
  candidates: ActiveSubjectDiagCandidate[];
  fastPathUsed: boolean;
  semanticStageInvoked: boolean;
  semanticResult: ActiveSubjectDiagSemanticResult;
  selectedCandidateIndex: number | null;
  selectedCandidateKind: ConversationTurnFocusEntry['kind'] | null;
  resultingFocusTier: ConversationTurnFocusEntry['tier'] | null;
  pendingArmed: boolean;
  finalOutcome: ActiveSubjectDiagFinalOutcome;
};

const DIAG_UTTERANCE_MAX_CHARS = 200;
const DIAG_DISPLAY_VALUE_MAX_CHARS = 100;

function boundDiagText(text: string, maxChars: number): string {
  const t = text.trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

function toDiagCandidate(c: RecapCandidate): ActiveSubjectDiagCandidate {
  return {
    index: c.index,
    kind: c.kind,
    displayValue: boundDiagText(c.displayValue, DIAG_DISPLAY_VALUE_MAX_CHARS),
    tier: c.focus.tier,
    hasResolverKey: !!c.focus.resolverKey,
    intentType: c.intentType,
  };
}

function logActiveSubjectDiag(event: ActiveSubjectDiagEvent): void {
  console.warn('HERALD_ACTIVE_SUBJECT_DIAG ' + JSON.stringify(event));
}

// ─── Stage A — closed structural shapes ────────────────────────────────────

/** Closed first-person identity lookup: who or what, then an auxiliary,
 *  then I or we, then a continuity verb from the closed class
 *  {talking|speaking|chatting} × {about|with|to}, or the existing saying
 *  form. Auxiliary is a separate was, am, are, or were, or a local
 *  who-apostrophe-s contraction (straight or curly) — not a global
 *  contraction expander. Optional temporal filler just before the verb,
 *  and optional just now after. Matching this CONFIRMS the identity-lookup
 *  act (ownership), not the identity answer. Held-out paraphrases stay on
 *  Stage B. */
const IDENTITY_LOOKUP_RE =
  /^(?:who|what)(?:['\u2019]s|\s+(?:am|was|were|are))\s+(?:i|we)\s+(?:just\s+)?(?:(?:talking|speaking|chatting)\s+(about|with|to)|saying)(?:\s+just\s+now)?\s*[?.!]*$/i;

export type ActiveSubjectIdentityRelation = 'about' | 'with' | 'to';

/** Same closed identity class as Stage A. Used by processUtterance so a
 *  live Flow C medical_doctor is not unused-cleared on this turn. */
export function isClosedActiveSubjectIdentityLookup(text: string): boolean {
  return IDENTITY_LOOKUP_RE.test(text.trim());
}

/** Relation already established by the closed identity act. `saying` has no
 *  connective in the grammar, so it preserves topic (`about`). Unmatched
 *  utterances return null — this is not a phrase-exception table. */
export function closedActiveSubjectIdentityRelation(text: string): ActiveSubjectIdentityRelation | null {
  const m = text.trim().match(IDENTITY_LOOKUP_RE);
  if (!m) return null;
  const rel = m[1]?.toLowerCase();
  if (rel === 'about' || rel === 'with' || rel === 'to') return rel;
  return 'about';
}

export function realizeActiveSubjectIdentityReply(
  displayValue: string,
  relation: ActiveSubjectIdentityRelation,
): string {
  return `You were talking ${relation} ${displayValue}.`;
}

/** "what did/was I say/saying about him/her/them" — a CLOSED shape,
 *  pronoun-object set only, no noun-phrase generalization ("that doctor")
 *  added here. Matching this deterministically CONFIRMS a content-lookup
 *  act and selects content-style reply framing ("you said...") over the
 *  default identity-style framing. */
const CONTENT_LOOKUP_RE =
  /^what\s+(?:did\s+i\s+say|was\s+i\s+saying)\s+about\s+(?:him|her|them)\s*[?.!]*$/i;

/** Closed medication/thing identity lookup — V1's only non-person Active Subject kind. */
const MEDICATION_IDENTITY_RE =
  /^(?:so[,]?\s+)?(?:what|which)\s+(?:medication|medicine|drug|meds?)\s+(?:was|were|am|are)\s+(?:i|we)\s+talking\s+about\s*[?.!]*$/i;

function looksLikeQuestionShape(t: string): boolean {
  if (/\?\s*$/.test(t)) return true;
  return /^(?:who|what|when|where|why|how|which|did|was|were|is|are|do|does)\b/i.test(t);
}

/** Cheap, closed gate for a narrative continuation turn: contains a bound
 *  third-person referent and is not itself a question. Matching this
 *  CONFIRMS a grounding act (this is the CTO's own explicit example
 *  mechanism — an already-narrow, already-closed signal, not the broad
 *  question gate below). False negatives just mean grounding doesn't
 *  attempt (inert, no regression). */
function isGroundingContinuationShape(t: string): boolean {
  return THIRD_PERSON_REFERENT_RE.test(t) && !looksLikeQuestionShape(t);
}

/**
 * Generic structural PRE-FILTER for "might this be a question about someone
 * we were just discussing" — deliberately NOT keyed to any specific verb
 * ("mean", "discussing", "talking about", "saying", ...). A short WH-
 * question framed in first person (a bare "I"/"we"), that doesn't already
 * name its own subject (no embedded capitalized proper noun beyond the
 * sentence-initial word), is WORTH ASKING Stage B about.
 *
 * CTO correction (2026-09-xx): matching this function does NOT confirm act
 * applicability and must never, by itself, grant the deterministic fast
 * path or make this consumer handle the utterance. "What did I ask the
 * doctor?", "When is my appointment?", and "What medications am I taking?"
 * all match this shape (WH-start, bare "I", no proper noun, short) but are
 * NOT reference-continuity acts — candidate existence alone must never
 * decide that for them. Whether the utterance really is this act, and if so
 * which candidate it denotes, is decided entirely by Stage B's semantic
 * judgment (see resolveActiveSubjectCandidate's actConfirmed:false path) —
 * never by this gate, and never by lexical enumeration of more exclusions.
 */
function isPlausibleReferenceQuestionShape(raw: string, t: string): boolean {
  if (!/^(?:who|what|which)\b/i.test(t)) return false;
  if (!/\b(?:i|we)\b/i.test(t)) return false;
  const withoutSentenceInitialCap = raw.trim().replace(/^\s*\S+/, (m) => m.toLowerCase());
  if (/\b[A-Z][a-z]+/.test(withoutSentenceInitialCap)) return false; // has its own named subject -> not this act
  const words = t.split(/\s+/).filter(Boolean);
  return words.length <= 9;
}

// ─── Shared candidate resolution (fast path + Stage B) ────────────────────

export type ActiveSubjectResolution =
  | { kind: 'resolved'; candidate: RecapCandidate }
  | { kind: 'ambiguous'; candidates: RecapCandidate[] }
  | { kind: 'none' };

export type ActiveSubjectSelectionProposal = {
  /** True only if the utterance is genuinely a reference-continuity act
   *  (asking who/what was previously discussed, or referring back to one of
   *  the supplied candidates) — never merely because it mentions a
   *  compatible topic. Checked FIRST; when false, selectedIndex/ambiguous
   *  are ignored regardless of their values (structural anti-steal bound,
   *  mirrors the existing anti-fabrication index bound below). */
  applicable: boolean;
  /** Bounds-checked against the FILTERED candidate list actually supplied —
   *  an out-of-range or non-integer value fails the whole parse (null), same
   *  discipline as recap's parseRecapInterpretationProposal. */
  selectedIndex: number | null;
  ambiguous: boolean;
  confidence: number;
};

export function parseActiveSubjectSelectionProposal(
  rawModelOutput: string,
  candidateCount: number,
): ActiveSubjectSelectionProposal | null {
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
  if (typeof o.applicable !== 'boolean') return null;
  if (typeof o.ambiguous !== 'boolean') return null;
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || !Number.isFinite(o.confidence)) return null;
  if (o.confidence < 0 || o.confidence > 1) return null;
  let selectedIndex: number | null = null;
  if (o.selectedIndex !== null && o.selectedIndex !== undefined) {
    if (typeof o.selectedIndex !== 'number' || !Number.isInteger(o.selectedIndex)) return null;
    if (o.selectedIndex < 0 || o.selectedIndex >= candidateCount) return null; // structural anti-fabrication bound
    selectedIndex = o.selectedIndex;
  }
  return { applicable: o.applicable, selectedIndex, ambiguous: o.ambiguous, confidence: o.confidence };
}

export const ACTIVE_SUBJECT_SELECTION_SYSTEM_PROMPT = `You determine whether the user's utterance is genuinely a reference back to someone already established as a candidate below — continuing to talk about them, or asking who/what was previously discussed — as opposed to a fresh, unrelated question that merely happens to mention a similar topic or person. You will be given a numbered list of recently-discussed people and, for each, a short note about what was recently said regarding them. You may ONLY refer to candidates by their number — never invent a new number, name, or id that is not listed.
Return ONLY a JSON object with these keys:
applicable: true only if the utterance is genuinely a reference-continuity act about one of these candidates; false for any fresh or unrelated question, even one that mentions a similar person or topic
selectedIndex: the number of the single candidate the reference denotes, or null if none of the candidates fit or you cannot tell
ambiguous: true only if more than one candidate is plausibly correct and you cannot tell which one
confidence: number 0 to 1
Do not explain. Do not add fields.`;

export function buildActiveSubjectSelectionUserPrompt(raw: string, candidates: RecapCandidate[]): string {
  const list = candidates
    .map((c, i) => `${i}. ${c.displayValue} — recently discussed: "${c.record.utterance.replace(/"/g, '\\"')}"`)
    .join('\n');
  return `Candidates:\n${list || '(none)'}\n\nUtterance: "${raw.replace(/"/g, '\\"')}"`;
}

const ACTIVE_SUBJECT_SELECTION_CONFIDENCE_THRESHOLD = 0.6;

export type ActiveSubjectSelectionGenerationResult =
  | { status: 'ok'; proposal: ActiveSubjectSelectionProposal }
  | { status: 'parse_fail' }
  | { status: 'unavailable' };

let activeSubjectInterpreterInFlight = false;

export async function generateActiveSubjectSelectionProposal(
  raw: string,
  candidates: RecapCandidate[],
  getCtx: () => LlamaContext | null,
): Promise<ActiveSubjectSelectionGenerationResult> {
  const ctx = getCtx();
  if (!ctx) return { status: 'unavailable' };
  if (activeSubjectInterpreterInFlight) return { status: 'unavailable' };
  activeSubjectInterpreterInFlight = true;
  const t0 = latMono();
  logActiveSubjectInferenceStart();
  try {
    const result = await ctx.completion({
      messages: [
        { role: 'system', content: ACTIVE_SUBJECT_SELECTION_SYSTEM_PROMPT },
        { role: 'user', content: buildActiveSubjectSelectionUserPrompt(raw, candidates) },
      ],
      n_predict: 96,
      temperature: 0,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
    } as any);
    const text = String((result as any)?.content || (result as any)?.text || '').trim();
    const proposal = parseActiveSubjectSelectionProposal(text, candidates.length);
    logActiveSubjectInferenceEnd(latMono() - t0, result, proposal ? 'ok' : 'parse_fail');
    return proposal ? { status: 'ok', proposal } : { status: 'parse_fail' };
  } catch {
    logActiveSubjectInferenceEnd(latMono() - t0, undefined, 'error');
    return { status: 'unavailable' };
  } finally {
    activeSubjectInterpreterInFlight = false;
  }
}

/** Diagnostics-only sink (2026-09-xx device gate) — optional, written to as
 *  a pure side effect. Never read by resolveActiveSubjectCandidate itself,
 *  never influences a branch, condition, or return value — same discipline
 *  as recap's AnswerFromCandidateDiagSink. */
export type ActiveSubjectResolutionDiagSink = {
  fastPathUsed?: boolean;
  semanticStageInvoked?: boolean;
  semanticResult?: ActiveSubjectDiagSemanticResult;
};

/**
 * Shared resolution engine used by grounding, identity-lookup, and
 * content-lookup alike. Filters to person-kind candidates (every reference
 * shape this V1 slice supports — pronouns, "who" — is person-referring),
 * then:
 *   0 compatible candidates -> 'none' (honest miss / inert)
 *   `actConfirmed` (act applicability already established deterministically
 *     by a closed Stage-A shape — identity/content-lookup regex match, or
 *     the grounding continuation gate):
 *     exactly 1 candidate -> 'resolved' via the deterministic fast path, no
 *       model call
 *     >1 candidates -> Stage B selects WHICH candidate (applicability is
 *       not re-litigated — it was already confirmed structurally); no
 *       interpreter available -> 'ambiguous' (existing clarification
 *       authority), never a silent pick
 *   NOT `actConfirmed` (only a broad, verb-agnostic structural PRE-FILTER
 *     matched — unseen wording that might or might not actually be this
 *     act): the fast path is NEVER used, regardless of candidate count.
 *     Stage B must confirm `applicable:true` before anything resolves; no
 *     interpreter available -> 'none' (fails CLOSED — this consumer does
 *     not know whether it even owns this utterance, so it must not claim
 *     it), never 'ambiguous' (which would falsely claim ownership).
 * Recency is what bounds which candidates are even eligible (via
 * buildRecapCandidates' own TTL/count-bounded scan); it is never used to
 * rank or silently pick among multiple eligible candidates here.
 */
export async function resolveActiveSubjectCandidate(
  text: string,
  allCandidates: RecapCandidate[],
  getInterpreterCtx?: () => LlamaContext | null,
  options?: { actConfirmed?: boolean; kinds?: ConversationTurnFocusEntry['kind'][]; intentTypes?: string[] },
  diagSink?: ActiveSubjectResolutionDiagSink,
): Promise<ActiveSubjectResolution> {
  const actConfirmed = options?.actConfirmed ?? true;
  const kinds = options?.kinds ?? ['person'];
  const intentTypes = options?.intentTypes;
  const candidates = allCandidates.filter((c) => {
    if (!kinds.includes(c.kind)) return false;
    if (!intentTypes) return true;
    return typeof c.intentType === 'string' && intentTypes.includes(c.intentType);
  });
  if (candidates.length === 0) {
    if (diagSink) { diagSink.fastPathUsed = false; diagSink.semanticStageInvoked = false; }
    return { kind: 'none' };
  }

  if (actConfirmed && candidates.length === 1) {
    if (diagSink) { diagSink.fastPathUsed = true; diagSink.semanticStageInvoked = false; }
    return { kind: 'resolved', candidate: candidates[0]! };
  }
  if (actConfirmed && kinds.length === 1 && kinds[0] === 'thing' && candidates.length > 1) {
    if (diagSink) { diagSink.fastPathUsed = false; diagSink.semanticStageInvoked = false; diagSink.semanticResult = 'ambiguous'; }
    return { kind: 'ambiguous', candidates };
  }
  if (diagSink) diagSink.fastPathUsed = false;

  if (!getInterpreterCtx) {
    if (diagSink) diagSink.semanticStageInvoked = false;
    // actConfirmed: this really is our act, we just can't tell which
    // candidate without a model -> existing ambiguity/clarification
    // authority. !actConfirmed: we cannot even confirm this is our act
    // without a model -> fail CLOSED, never claim the utterance.
    return actConfirmed ? { kind: 'ambiguous', candidates } : { kind: 'none' };
  }

  if (diagSink) diagSink.semanticStageInvoked = true;
  const generation = await generateActiveSubjectSelectionProposal(text, candidates, getInterpreterCtx);
  if (generation.status !== 'ok') {
    if (diagSink) diagSink.semanticResult = actConfirmed ? 'ambiguous' : 'none';
    return actConfirmed ? { kind: 'ambiguous', candidates } : { kind: 'none' };
  }
  const { proposal } = generation;
  if (!actConfirmed && !proposal.applicable) {
    if (diagSink) diagSink.semanticResult = 'not_applicable';
    return { kind: 'none' };
  }
  if (proposal.ambiguous || proposal.selectedIndex === null || proposal.confidence < ACTIVE_SUBJECT_SELECTION_CONFIDENCE_THRESHOLD) {
    if (diagSink) diagSink.semanticResult = 'ambiguous';
    return { kind: 'ambiguous', candidates };
  }
  const selected = candidates[proposal.selectedIndex];
  if (!selected) {
    // defensive; parseActiveSubjectSelectionProposal already bounds-checks
    if (diagSink) diagSink.semanticResult = actConfirmed ? 'ambiguous' : 'none';
    return actConfirmed ? { kind: 'ambiguous', candidates } : { kind: 'none' };
  }
  if (diagSink) diagSink.semanticResult = 'selected';
  return { kind: 'resolved', candidate: selected };
}

// ─── Ambiguity -> existing ConversationSession pending authority ──────────

/**
 * Builds a resume closure for establishHardPending(). Reuses
 * conversationSession.ts's own generic matchCandidateToken — the same
 * exact/partial-token matcher every other domain's disambiguation already
 * uses — so "Dr. Smith." deterministically resolves the outstanding
 * ambiguity on the very next turn, or falls through to the SAME session's
 * existing re-ask/budget ladder on a non-match. No second pending mechanism.
 * The resulting focus is referenceOnly:true -> tier:'conversational', never
 * 'authoritative', regardless of the candidate's own resolverKey.
 */
export function buildActiveSubjectAmbiguityResume(
  candidates: RecapCandidate[],
): (userText: string) => Promise<CommitResult> {
  const matchable: MatchableCandidate[] = candidates.map((c) => ({ label: c.displayValue, ref: String(c.index) }));
  return async (userText: string): Promise<CommitResult> => {
    const match = matchCandidateToken(userText, matchable);
    if (match === 'ambiguous' || match === 'none') {
      return { status: 'noop', ack: '' }; // triggers the existing re-ask/budget ladder
    }
    const selected = candidates.find((c) => String(c.index) === match.ref);
    if (!selected) return { status: 'noop', ack: '' }; // defensive
    return {
      status: 'committed',
      ack: `Got it — ${selected.displayValue}.`,
      focus: { kind: selected.kind, displayValue: selected.displayValue, resolverKey: selected.focus.resolverKey, referable: true },
      referenceOnly: true,
    };
  };
}

// ─── Top-level entry point ─────────────────────────────────────────────────

/** Minimal neutral acknowledgment for a successfully grounded continuation
 *  turn — same wording already used elsewhere in Herald (see
 *  medicalVisitOutcomeAsk.ts's own 'Okay.' ack) for "I followed this turn",
 *  never implying persistence. Grounding a reference is RAM-only
 *  conversational evidence; this string must never change to imply saving,
 *  remembering, or any authoritative claim. */
export const ACTIVE_SUBJECT_GROUNDING_ACK = 'Okay.';

export type ActiveSubjectOutcome =
  | { handled: false }
  | { handled: true; kind: 'identity'; reply: string; focus: ConversationTurnFocusEntry[]; relation: ActiveSubjectIdentityRelation }
  | { handled: true; kind: 'content'; reply: string; focus: ConversationTurnFocusEntry[] }
  /** Minimal neutral acknowledgment only — never a phrase implying the
   *  proposition was saved or persisted as personal truth. */
  | { handled: true; kind: 'grounding'; reply: typeof ACTIVE_SUBJECT_GROUNDING_ACK; focus: ConversationTurnFocusEntry[] }
  | { handled: true; kind: 'ambiguous'; reply: string; resume: (userText: string) => Promise<CommitResult> };

export type ActiveSubjectReferenceDeps = {
  ledgerEntries: ConversationTurnRecord[];
  getInterpreterCtx?: () => LlamaContext | null;
};

/**
 * Single entry point. Returns handled:false when this mechanism has no
 * opinion (falls through to normal ephemeral/clarify handling, unchanged) —
 * when the utterance's shape doesn't match any of the three acts, when
 * resolution finds zero compatible candidates (session/ledger loss, or
 * nothing relevant established yet: never fabricates a remembered
 * conversation), and when an unseen-shaped question's applicability cannot
 * be confirmed (no interpreter, or Stage B says applicable:false) — a
 * WH-shaped utterance with a live candidate is never enough by itself.
 * Never invoked while a deterministic pending is armed — same structural
 * guarantee Immediate Semantic Recap already relies on (processUtterance's
 * own pending check always runs first).
 */
export async function answerActiveSubjectReference(
  text: string,
  deps: ActiveSubjectReferenceDeps,
): Promise<ActiveSubjectOutcome> {
  const t = text.trim();
  const utteranceNormalized = boundDiagText(text, DIAG_UTTERANCE_MAX_CHARS);

  function emit(fields: {
    act: ActiveSubjectDiagAct;
    targetKind: ConversationTurnFocusEntry['kind'] | null;
    candidates: RecapCandidate[];
    fastPathUsed: boolean;
    semanticStageInvoked: boolean;
    semanticResult: ActiveSubjectDiagSemanticResult;
    selectedCandidateIndex: number | null;
    selectedCandidateKind: ConversationTurnFocusEntry['kind'] | null;
    resultingFocusTier: ConversationTurnFocusEntry['tier'] | null;
    pendingArmed: boolean;
    finalOutcome: ActiveSubjectDiagFinalOutcome;
  }): void {
    const { candidates, ...rest } = fields;
    logActiveSubjectDiag({
      invoked: true,
      utteranceNormalized,
      candidateCount: candidates.length,
      candidates: candidates.map(toDiagCandidate),
      ...rest,
    });
  }

  if (!t) {
    emit({ act: 'not_applicable', targetKind: null, candidates: [], fastPathUsed: false, semanticStageInvoked: false, semanticResult: 'not_invoked', selectedCandidateIndex: null, selectedCandidateKind: null, resultingFocusTier: null, pendingArmed: false, finalOutcome: 'not_handled' });
    return { handled: false };
  }

  const isGrounding = isGroundingContinuationShape(t);
  const isClosedMedication = !isGrounding && MEDICATION_IDENTITY_RE.test(t);
  const isClosedIdentity = !isGrounding && !isClosedMedication && IDENTITY_LOOKUP_RE.test(t);
  const isClosedContent = !isGrounding && !isClosedMedication && !isClosedIdentity && CONTENT_LOOKUP_RE.test(t);
  const isClosedQuestion = isClosedIdentity || isClosedContent || isClosedMedication;
  const isPlausibleUnseenQuestion = !isGrounding && !isClosedQuestion && isPlausibleReferenceQuestionShape(text, t);

  if (!isGrounding && !isClosedQuestion && !isPlausibleUnseenQuestion) {
    emit({ act: 'not_applicable', targetKind: null, candidates: [], fastPathUsed: false, semanticStageInvoked: false, semanticResult: 'not_invoked', selectedCandidateIndex: null, selectedCandidateKind: null, resultingFocusTier: null, pendingArmed: false, finalOutcome: 'not_handled' });
    return { handled: false };
  }

  const targetKind: ConversationTurnFocusEntry['kind'] = isClosedMedication ? 'thing' : 'person';
  const actConfirmed = isGrounding || isClosedQuestion;
  const attemptedAct: ActiveSubjectDiagAct = isGrounding
    ? 'grounding'
    : isClosedMedication
      ? 'medication_identity'
      : isClosedContent
        ? 'content_lookup'
        : 'identity_lookup';

  const allCandidates = buildRecapCandidates(deps.ledgerEntries);
  const diagSink: ActiveSubjectResolutionDiagSink = {};
  const resolution = await resolveActiveSubjectCandidate(
    t,
    allCandidates,
    deps.getInterpreterCtx,
    {
      actConfirmed,
      kinds: [targetKind],
      ...(isClosedMedication ? { intentTypes: ['medical_capture'] } : {}),
    },
    diagSink,
  );

  const eligibleCandidates = allCandidates.filter((c) => {
    if (c.kind !== targetKind) return false;
    if (!isClosedMedication) return true;
    return c.intentType === 'medical_capture';
  });
  const act: ActiveSubjectDiagAct = diagSink.semanticResult === 'not_applicable' ? 'not_applicable' : attemptedAct;

  if (resolution.kind === 'none') {
    emit({
      act, targetKind, candidates: eligibleCandidates, fastPathUsed: diagSink.fastPathUsed ?? false,
      semanticStageInvoked: diagSink.semanticStageInvoked ?? false, semanticResult: diagSink.semanticResult ?? 'not_invoked',
      selectedCandidateIndex: null, selectedCandidateKind: null, resultingFocusTier: null, pendingArmed: false,
      finalOutcome: isClosedMedication ? 'answered' : 'not_handled',
    });
    if (isClosedMedication) {
      return { handled: true, kind: 'identity', reply: "I don't have anything recent to go on — what were you referring to?", focus: [], relation: 'about' };
    }
    return { handled: false };
  }

  if (resolution.kind === 'ambiguous') {
    const names = resolution.candidates.slice(0, 3).map((c) => c.displayValue).join(' or ');
    emit({
      act, targetKind, candidates: eligibleCandidates, fastPathUsed: diagSink.fastPathUsed ?? false,
      semanticStageInvoked: diagSink.semanticStageInvoked ?? false, semanticResult: diagSink.semanticResult ?? 'ambiguous',
      selectedCandidateIndex: null, selectedCandidateKind: null, resultingFocusTier: null, pendingArmed: true, finalOutcome: 'ambiguous',
    });
    return {
      handled: true,
      kind: 'ambiguous',
      reply: `Did you mean ${names}?`,
      resume: buildActiveSubjectAmbiguityResume(resolution.candidates),
    };
  }

  const candidate = resolution.candidate;

  if (isGrounding) {
    const focus = buildFocusEntry(
      { kind: candidate.kind, displayValue: candidate.displayValue, resolverKey: candidate.focus.resolverKey, referable: true },
      { status: 'committed', source: 'deterministic', referenceOnly: true },
    );
    emit({
      act, targetKind, candidates: eligibleCandidates, fastPathUsed: diagSink.fastPathUsed ?? false,
      semanticStageInvoked: diagSink.semanticStageInvoked ?? false, semanticResult: diagSink.semanticResult ?? 'selected',
      selectedCandidateIndex: candidate.index, selectedCandidateKind: candidate.kind, resultingFocusTier: focus[0]?.tier ?? null,
      pendingArmed: false, finalOutcome: 'grounded',
    });
    return { handled: true, kind: 'grounding', reply: ACTIVE_SUBJECT_GROUNDING_ACK, focus };
  }

  const kind: 'identity' | 'content' = isClosedContent ? 'content' : 'identity';
  const relation: ActiveSubjectIdentityRelation =
    isClosedIdentity ? (closedActiveSubjectIdentityRelation(t) ?? 'about') : 'about';
  const reply = kind === 'content'
    ? `You said: "${candidate.record.utterance}"`
    : realizeActiveSubjectIdentityReply(candidate.displayValue, relation);
  emit({
    act, targetKind, candidates: eligibleCandidates, fastPathUsed: diagSink.fastPathUsed ?? false,
    semanticStageInvoked: diagSink.semanticStageInvoked ?? false, semanticResult: diagSink.semanticResult ?? 'selected',
    selectedCandidateIndex: candidate.index, selectedCandidateKind: candidate.kind, resultingFocusTier: null,
    pendingArmed: false, finalOutcome: 'answered',
  });
  return kind === 'content'
    ? { handled: true, kind: 'content', reply, focus: [] }
    : { handled: true, kind: 'identity', reply, focus: [], relation };
}
