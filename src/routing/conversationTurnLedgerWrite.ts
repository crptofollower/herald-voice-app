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

import type { CommitResult, RouteDecision } from './routeIntent';
import type {
  ConversationTurnAuthorityTier,
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
