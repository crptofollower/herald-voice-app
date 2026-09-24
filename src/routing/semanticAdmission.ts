// Deterministic admission for a semantic capability proposal.
// The proposal may name a capability. It does not become a read, write,
// or external action until this function admits it.
// Confidence can only downgrade. It never grants admission.
// This module does not parse reply prose and does not touch pending or writers.

import {
  CAPABILITY_IDS,
  CAPABILITY_RISK_CLASS,
  admitCapabilityProposal,
  type CapabilityProposal,
} from './capabilityRouting';
import type { SemanticDispatchEligibility, SemanticDispatchEligibilityReason } from './semanticDispatchEligibility';

const CAPABILITY_ID_SET = new Set<string>(CAPABILITY_IDS);

/** Closed eligibility reasons that may host a grocery/list read. */
const LIST_READ_REASONS = new Set<SemanticDispatchEligibilityReason>([
  'list_add',
  'grocery_context',
  'acquisition',
]);

/** Closed eligibility reasons that may host a to-do read. */
const TODO_READ_REASONS = new Set<SemanticDispatchEligibilityReason>([
  'todo_obligation',
  'obligation_family',
]);

export type DispatchedReadAdmission =
  | { decision: 'ADMIT_READ'; capability: 'medication.read_summary' | 'list.read' | 'todo.read' }
  | { decision: 'ABSTAIN'; reason: string };

export function admitDispatchedSemanticRead(
  proposal: CapabilityProposal,
  eligibility: SemanticDispatchEligibility,
  utterance: string,
): DispatchedReadAdmission {
  if (!CAPABILITY_ID_SET.has(proposal.capability)) {
    return { decision: 'ABSTAIN', reason: 'unknown_capability' };
  }
  // Downgrade only. A high bucket is not evidence.
  if (proposal.confidence === 'low') {
    return { decision: 'ABSTAIN', reason: 'low_confidence' };
  }
  const risk = CAPABILITY_RISK_CLASS[proposal.capability];
  if (risk === 'external' || risk === 'write' || risk === 'none') {
    return { decision: 'ABSTAIN', reason: `not_a_personal_read:${proposal.capability}` };
  }
  if (proposal.capability === 'list.read') {
    if (CAPABILITY_RISK_CLASS['list.read'] !== 'read') {
      return { decision: 'ABSTAIN', reason: 'risk_class_not_read' };
    }
    if (!LIST_READ_REASONS.has(eligibility.reason)) {
      return { decision: 'ABSTAIN', reason: 'domain_incompatible' };
    }
    return { decision: 'ADMIT_READ', capability: 'list.read' };
  }
  if (proposal.capability === 'todo.read') {
    if (CAPABILITY_RISK_CLASS['todo.read'] !== 'read') {
      return { decision: 'ABSTAIN', reason: 'risk_class_not_read' };
    }
    if (!TODO_READ_REASONS.has(eligibility.reason)) {
      return { decision: 'ABSTAIN', reason: 'domain_incompatible' };
    }
    return { decision: 'ADMIT_READ', capability: 'todo.read' };
  }
  if (proposal.capability === 'medication.read_summary') {
    const admitted = admitCapabilityProposal(proposal, utterance);
    if (admitted.decision === 'ADMIT_READ') {
      return { decision: 'ADMIT_READ', capability: 'medication.read_summary' };
    }
    return { decision: 'ABSTAIN', reason: admitted.reason };
  }
  return { decision: 'ABSTAIN', reason: `capability_not_admitted:${proposal.capability}` };
}
