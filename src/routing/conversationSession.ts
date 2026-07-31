import type { CommitResult } from './routeIntent';
import { CORRECTION_REPAIR_ENABLED } from '../constants/features';

// D0 (S54 addendum) + S-DISCLOSE Step 2 (C2, Gap 4 discharged by design):
// the confirm-primitive. Replaces take-then-clear with hold/resolve-in-place.
// One anchored CANCEL vocabulary; escalation ladder (domain resume → Graceful
// Confusion re-ask); destructive class never executes on ambiguity or release.
// Design of record: S_DISCLOSE_DESIGN_SPEC.md §4. Do not alter without
// one-way-door review (Spine §9, §3a is one-way-door tier).

export type PendingKind = 'standard' | 'destructive';

export type CorrectableField = {
  currentValue: string;
  buildCorrected: (newValue: string) => Omit<PendingSlot, 'kind' | 'budget'> & { prompt: string };
};

export type PendingSlot = {
  pendingKey: string;
  kind: PendingKind;
  budget: number;                                  // remaining re-asks
  resume: (userText: string) => Promise<CommitResult>;
  reaskPrompt?: string;                             // optional domain-specific re-ask override
  correctable?: CorrectableField;
};

// Single anchored CANCEL vocabulary (§4.2 sibling — cancel is checked before
// any domain resume runs, from any pending, any budget state).
export const CANCEL_RE = /^(never\s*mind|nevermind|cancel|stop|forget\s+it)[\s.,!]*$/i;

// Anchored destructive-confirm vocabulary (C2 point 2, narrow set — a filler
// "ok" must never commit a wipe). Capture-confirm retrofit is a separate
// carried item; do not widen this set without founder decision.
export const CONFIRM_YES_RE = /^(yes|yeah|yep|correct|right|10-4)[\s.,!]*$/i;
export const CONFIRM_NO_RE  = /^(no|nope|not yet|negative)[\s.,!]*$/i;

// MVP closed set only (S_CONVERSATIONAL_REPAIR_DESIGN_SPEC.md v2). Order
// matters: "it's"-bearing alternatives must be tried before bare "actually"
// or "actually it's X" would capture "it's X" instead of "X".
//
// Unicode apostrophe folding is a caller responsibility, not this function's.
// ChatScreen.sendMessage (line ~1003) calls normalizeInput before
// processUtterance is ever invoked, so on the live path text arriving here
// is already normalized. Direct callers of resolvePending/processUtterance
// (test harness included) do NOT get that normalization automatically and
// must call normalizeInput themselves first if they want curly-apostrophe
// input recognized. This is a fail-safe gap, not a fail-dangerous one: an
// unnormalized correction marker that doesn't match simply falls through to
// the existing unresolved/re-ask ladder, same as any other unparseable
// reply — it never mis-fires as a false-positive correction.
const CORRECTION_MARKER_RE =
  /^(?:no,?\s+it'?s|that'?s\s+wrong,?\s+it'?s|actually\s+it'?s|actually|i\s+meant|rather)\s+(.+)$/i;

export function extractCorrection(userText: string): string | null {
  const trimmed = userText.trim();
  const m = CORRECTION_MARKER_RE.exec(trimmed);
  if (!m) return null;
  const replacement = m[1]?.trim();
  if (!replacement) return null;
  if (CONFIRM_YES_RE.test(replacement) || CONFIRM_NO_RE.test(replacement) || CANCEL_RE.test(replacement)) {
    return null;
  }
  return replacement;
}

// Deterministic candidate matcher (Pending Disambiguation, Commit 1 — spec
// PENDING_DISAMBIGUATION_DESIGN_SPEC.md §3). Exact normalized match wins;
// otherwise a single distinct token hit wins; anything else is ambiguous or
// no-match and must re-ask, never guess. No substring/fuzzy matching in v1 —
// a false-positive match is a fabrication-class trust failure (spec §3).
export type MatchableCandidate = { label: string; ref: string; phone?: string };

const normalizeForMatch = (s: string): string =>
  s.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');

export function matchCandidateToken(
  replyText: string,
  candidates: MatchableCandidate[],
): MatchableCandidate | 'ambiguous' | 'none' {
  const t = normalizeForMatch(replyText);
  if (!t) return 'none';
  const tTokens = new Set(t.split(' '));

  const exact = candidates.filter(c => normalizeForMatch(c.label) === t);
  if (exact.length === 1) return exact[0];

  const hits = candidates.filter(c =>
    normalizeForMatch(c.label).split(' ').some(tok => tTokens.has(tok)),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return 'ambiguous';
  return 'none';
}

const DEFAULT_STANDARD_BUDGET = 2;

function releaseAck(kind: PendingKind): string {
  return kind === 'destructive'
    ? "Let's leave everything as it is for now — just tell me again if you want to change anything."
    : "Let's come back to that — just tell me again anytime.";
}

const DEFAULT_REASK = "I'm not sure I'm following — can you say that again?";

export class ConversationSession {
  private pending: PendingSlot | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Sets the pending slot. kind/budget default to standard/2 when omitted —
   *  ref migrations (build order step 4) set these explicitly per domain;
   *  destructive-class callers (med-clear) MUST pass kind:'destructive', budget:1. */
  setPending(slot: Omit<PendingSlot, 'kind' | 'budget'> & Partial<Pick<PendingSlot, 'kind' | 'budget'>>): void {
    const kind = slot.kind ?? 'standard';
    this.pending = {
      pendingKey: slot.pendingKey,
      resume: slot.resume,
      reaskPrompt: slot.reaskPrompt,
      correctable: slot.correctable,
      kind,
      budget: slot.budget ?? (kind === 'destructive' ? 1 : DEFAULT_STANDARD_BUDGET),
    };
  }

  clearPending(): void {
    this.pending = null;
  }

  /** RESOLVED, CANCELLED, RELEASED, or EMERGENCY-ESCAPED (Law 0, handled by
   *  the caller BEFORE this is invoked — see processUtterance) are the only
   *  four exits. A pending never leaks to fresh routing (Law 2). */
  async resolvePending(userText: string): Promise<CommitResult> {
    const slot = this.pending;
    if (!slot) return { status: 'noop', ack: '' };

    // Cancel escape — checked first, from any budget state.
    if (CANCEL_RE.test(userText.trim())) {
      this.pending = null;
      return { status: 'noop', ack: "No problem — I won't do that." };
    }

    // Rung 1 of the escalation ladder: the domain's own resume parser.
    const result = await slot.resume(userText);

    // Domain parser could not interpret this reply → Graceful Confusion re-ask.
    // (Rung 2, the scoped classifier, lands post-Session-W per W5 — skipped here.)
    if (result.status === 'noop' && !result.ack) {
      if (CORRECTION_REPAIR_ENABLED && slot.correctable) {
        const extracted = extractCorrection(userText);
        if (extracted) {
          const corrected = slot.correctable.buildCorrected(extracted);
          this.pending = {
            pendingKey: corrected.pendingKey,
            resume: corrected.resume,
            reaskPrompt: corrected.reaskPrompt,
            correctable: corrected.correctable,
            kind: slot.kind,
            budget: slot.kind === 'destructive' ? 1 : DEFAULT_STANDARD_BUDGET,
          };
          return {
            status: 'pending',
            prompt: corrected.prompt,
            pendingKey: corrected.pendingKey,
            resume: corrected.resume,
          };
        }
      }
      slot.budget -= 1;
      if (slot.budget <= 0) {
        this.pending = null;
        return { status: 'noop', ack: releaseAck(slot.kind) };
      }
      return {
        status: 'pending',
        prompt: slot.reaskPrompt ?? DEFAULT_REASK,
        pendingKey: slot.pendingKey,
        resume: slot.resume,
      };
    }

    // Domain resume advanced to a new pending stage (e.g. a correction turn) —
    // replace the slot, preserving kind, resetting budget for the new stage.
    if (result.status === 'pending') {
      this.pending = {
        pendingKey: result.pendingKey,
        resume: result.resume,
        reaskPrompt: result.reaskPrompt,
        correctable: result.correctable,
        kind: slot.kind,
        budget: slot.kind === 'destructive' ? 1 : DEFAULT_STANDARD_BUDGET,
      };
      return result;
    }

    // RESOLVED — committed, failed, or a domain-recognized noop-with-ack (e.g.
    // an explicit "no problem, I won't add that").
    this.pending = null;
    return result;
  }
}
