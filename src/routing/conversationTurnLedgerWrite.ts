// src/routing/conversationTurnLedgerWrite.ts
// Conversation Continuity Contract V1 — Slice 2 write-policy glue.
//
// Pure mapping functions from the SMALL, CLOSED, already-existing unions
// (`CommitResult['status']`, `RouteDecision['kind']`, ephemeral-seam
// `EphemeralSeamOutcome['kind']`) to ledger fields. This is what makes
// lifecycle coverage generic: these unions do not grow when Herald gains a
// new domain writer (a new `IntentRecord` variant does not add a new
// `CommitResult.status`), so a new capability needs zero new branches here.
//
// This file deliberately does NOT attempt to extract `focus` from an
// `IntentRecord`. That would require a mapping keyed on `intent.type` (drug
// vs doctor_name vs name vs condition vs body vs items[] — no shared field
// across the 15 variants), which is exactly the kind of per-domain switch
// the CTO's critical requirement forbids concealing behind a "generic"
// label. `intentType` below is a straight, zero-enumeration field copy, not
// a semantic mapping.

import type { CommitResult, RouteDecision, DomainFocusEnvelope } from './routeIntent';
import type {
  ConversationTurnAuthorityTier,
  ConversationTurnFocusEntry,
  ConversationTurnFocusTier,
  ConversationTurnOperation,
  ConversationTurnOutcome,
} from './conversationTurnLedger';

export function commitResultOutcome(status: CommitResult['status']): ConversationTurnOutcome {
  switch (status) {
    case 'committed':
      return 'committed';
    case 'pending':
      return 'pending';
    case 'noop':
      return 'declined';
    case 'failed':
      return 'failed';
  }
}

export function captureAuthorityTier(
  source: 'deterministic' | 'llm',
): ConversationTurnAuthorityTier {
  return source === 'llm' ? 'llm_proposal' : 'deterministic';
}

/**
 * Policy table for `RouteDecision.kind` values that reach ChatScreen's
 * `handled: false` dispatch (device_read / device_action / needs_clarification
 * / backend / memory_probe / not_ready — NOT phone_repair_needed or
 * medical_read_pending, which processUtterance already absorbs into a
 * `source:'capture'` UtteranceOutcome before this dispatch is ever reached).
 *
 * Every kind must appear here explicitly, mapped to either a write policy or
 * an explicit, named exemption. This table is what the coverage-contract
 * test checks against production's own RouteDecision union — a new kind
 * added to that union without a corresponding entry here fails the test,
 * which is the exact failure class (an outcome silently gaining no ledger
 * policy) the 2026-09-08 diagnostic found.
 */
export type RouteOutcomeLedgerPolicy =
  | { record: true; operation: ConversationTurnOperation; authorityTier: ConversationTurnAuthorityTier }
  | { record: false; reason: string };

export const ROUTE_OUTCOME_LEDGER_POLICY: Record<RouteDecision['kind'], RouteOutcomeLedgerPolicy> = {
  device_read: { record: true, operation: 'read', authorityTier: 'deterministic' },
  device_action: { record: true, operation: 'action', authorityTier: 'deterministic' },
  // 'capture' never reaches this dispatch as a RouteDecision — processUtterance
  // converts it into a `source:'capture'` UtteranceOutcome first (covered by
  // the applyIntents/resolvePending hooks instead). Listed for completeness
  // of the RouteDecision['kind'] union so the coverage test is total.
  capture: { record: false, reason: 'absorbed into source:capture UtteranceOutcome before this dispatch; covered by the applyIntents/resolvePending hook instead' },
  interpretation_hold: { record: false, reason: 'absorbed into source:interpretation UtteranceOutcome; RAM WCS hold only — no ledger write authority' },
  phone_repair_needed: { record: false, reason: 'absorbed into source:capture UtteranceOutcome (pending) before this dispatch; covered by the applyIntents/resolvePending hook instead' },
  medical_read_pending: { record: false, reason: 'absorbed into source:capture UtteranceOutcome (pending) before this dispatch; covered by the applyIntents/resolvePending hook instead' },
  not_ready: { record: false, reason: 'transient waking-up state, not turn evidence — explicitly exempted' },
  // memory_probe / backend are intermediate routing states (tier-2 local
  // context probe, tier-3 authorization to call the classifier) that lead to
  // further processing whose FINAL resolution is not observable generically
  // at this call site without deeper call-graph tracing. Honest gap, not
  // silently dropped: named and asserted by the coverage-contract test.
  memory_probe: { record: false, reason: 'intermediate tier-2 routing state; final resolution not observable generically at this call site (deferred gap)' },
  backend: { record: false, reason: 'intermediate tier-3 routing state; final resolution not observable generically at this call site (deferred gap)' },
  // needs_clarification is intentionally absent from this table: its
  // ledger policy depends on `reason` and, for reason:'default', on the
  // ephemeral seam's outcome — handled by a separate hook (see ChatScreen.tsx
  // needs_clarification block), not this flat per-kind table.
  needs_clarification: { record: false, reason: 'handled by a dedicated hook keyed on reason/seamOutcome, not this flat table' },
};

// ─────────────────────────────────────────────────────────────────────────
// Semantic Focus Contract V1 — Slice 3 (carrier/schema) + Slice 4 (proof in
// medical_capture / list_add / todo_add only).
//
// ARCHITECTURAL AMENDMENT — AUTHORITY HAS ONE OWNER. A domain/capability
// (writer or read-dispatcher) owns semantic IDENTITY only — what this turn
// is about, its kind, display value, role, and a stable resolver reference
// IF ONE GENUINELY EXISTS. A domain never supplies, claims, or influences
// its own authority tier — DomainFocusEnvelope below has no field for one.
// classifyFocusAuthority()/buildFocusEntry() in THIS file are the ONLY
// place in the codebase that construct a ConversationTurnFocusEntry's
// `tier`, and they derive it exclusively from objective lifecycle facts:
// commit status, deterministic-vs-LLM capture source, and whether a
// resolverKey is actually present. No domain-specific branch appears
// anywhere below — every function here is generic over any domain that
// correctly emits a DomainFocusEnvelope.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The ONLY function in the codebase permitted to decide `tier`. Pure,
 * domain-agnostic — takes exactly the objective lifecycle facts the CTO's
 * amendment names (commit status, capture source, resolver-key presence)
 * and nothing else. A domain cannot influence this even indirectly: there
 * is no parameter through which one could pass an opinion about its own
 * authority.
 *
 * `status:'committed'` with NO resolverKey does NOT reach 'authoritative'
 * — satisfies the trust requirement that a committed status alone is
 * never sufficient without a verified reference to back it.
 */
export function classifyFocusAuthority(facts: {
  /** Writer lifecycle, or `'presented'` for a successful read (not a commit).
   *  `'presented'` never satisfies `status === 'committed'`; existing writer
   *  classification is unchanged. */
  status: CommitResult['status'] | Extract<ConversationTurnOutcome, 'presented'>;
  source: 'deterministic' | 'llm';
  resolverKey: string | undefined;
  /** Active Subject / Reference Continuity V1: true only when this focus
   *  came from GROUNDING a reference to an already-established candidate
   *  (resolving "he" to Dr. Smith) rather than from a domain writer
   *  claiming a fresh fact. Checked first, before the commit-lifecycle
   *  facts below — a resolved reference is conversational evidence, never
   *  authoritative or a proposal, regardless of status/resolverKey. */
  referenceOnly?: boolean;
}): ConversationTurnFocusTier {
  if (facts.referenceOnly) return 'conversational';
  const hasResolverKey = typeof facts.resolverKey === 'string' && facts.resolverKey.length > 0;
  if (facts.status === 'committed' && hasResolverKey) return 'authoritative';
  if (facts.source === 'llm') return 'llm_proposal';
  return 'deterministic_unconfirmed';
}

/**
 * Wraps a domain's optional DomainFocusEnvelope into the ledger's
 * ConversationTurnFocusEntry[] shape, attaching the ONE authoritative
 * `tier` this file computes. Missing envelope (domain attached none) is
 * legal and yields `[]` — mirrors Slice 2's "missing focus stays legal"
 * behavior exactly; a writer that doesn't (yet) populate semantic focus
 * never has its commit blocked, degraded, or otherwise affected by this
 * function's absence of input.
 */
export function buildFocusEntry(
  envelope: DomainFocusEnvelope | undefined,
  facts: {
    status: CommitResult['status'] | Extract<ConversationTurnOutcome, 'presented'>;
    source: 'deterministic' | 'llm';
    referenceOnly?: boolean;
  },
): ConversationTurnFocusEntry[] {
  if (!envelope) return [];
  const tier = classifyFocusAuthority({
    status: facts.status,
    source: facts.source,
    resolverKey: envelope.resolverKey,
    referenceOnly: facts.referenceOnly,
  });
  return [
    {
      kind: envelope.kind,
      displayValue: envelope.displayValue,
      resolverKey: envelope.resolverKey,
      referable: envelope.referable,
      role: envelope.role,
      tier,
    },
  ];
}

/**
 * Ledger focus for a writer result. Preserves the domain's primary envelope
 * (collection/list identity for grocery add) and appends secondary item
 * entries from structured committed names only. Duplicate displayValues
 * already present on the primary envelope are not repeated. Item extras are
 * not independently referable — recap/list-read authority is unchanged.
 */
export function buildCommitLedgerFocus(
  result: CommitResult,
  facts: {
    source: 'deterministic' | 'llm';
    referenceOnly?: boolean;
  },
): ConversationTurnFocusEntry[] {
  const primary = buildFocusEntry(result.focus, {
    status: result.status,
    source: facts.source,
    referenceOnly: facts.referenceOnly ?? result.referenceOnly,
  });
  if (result.status !== 'committed') return primary;
  const names = result.committed;
  if (!Array.isArray(names) || names.length === 0) return primary;
  const seen: Record<string, true> = {};
  for (const entry of primary) {
    seen[`${entry.kind}:${entry.displayValue.trim().toLowerCase()}`] = true;
  }
  const extras: ConversationTurnFocusEntry[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const displayValue = raw.trim();
    if (!displayValue) continue;
    const key = `item:${displayValue.toLowerCase()}`;
    if (seen[key]) continue;
    seen[key] = true;
    extras.push(
      ...buildFocusEntry(
        { kind: 'item', displayValue, referable: false, role: 'secondary' },
        { status: result.status, source: facts.source, referenceOnly: facts.referenceOnly },
      ),
    );
  }
  return primary.concat(extras);
}

/** Orchestration-layer helper: attach continuity identity to an existing ledger write. */
export function continuityLedgerFocus(
  envelope: DomainFocusEnvelope | undefined,
  referenceOnly: boolean,
): ConversationTurnFocusEntry[] {
  return buildFocusEntry(envelope, {
    // Not a writer commit. Narrative short-circuits on referenceOnly.
    // Doctor visit-history is a successful read → ledger outcome 'presented',
    // which classifies as deterministic_unconfirmed when a resolverKey exists.
    status: 'presented',
    source: 'deterministic',
    referenceOnly,
  });
}
