// Pre-dispatch eligibility for Semantic Capability Dispatch.
// Answers only whether a tier-3/default utterance could plausibly require
// semantic interpretation. Does not select a capability, destination, or write.

import {
  detectMedicalEvent,
  hasMedicationDomainEvidence,
  isCatalogMedicationReadUtterance,
  isMedicationQuestionShape,
  isReadShapedUtterance,
} from '../utils/detectMedicalEvent';
import {
  LIST_ADD_SIGNALS,
  TODO_ADD_PREFIX,
  TODO_ADD_SIGNALS,
} from '../utils/instructionSignals';
import {
  GROCERY_CONTEXT_MARKER,
  OBLIGATION_MODAL_FAMILY,
  OPERATIONAL_ACQUISITION_SHAPE,
} from './operationalListContinuity';
import { isPersonalMemoryRecallQuestion } from './personalMemoryRecall';
import { isExplicitInstructionToHerald } from './speechActAuthority';

export type SemanticDispatchEligibilityReason =
  | 'instruction'
  | 'list_add'
  | 'todo_obligation'
  | 'acquisition'
  | 'obligation_family'
  | 'bare_need'
  | 'grocery_context'
  | 'medical_event'
  | 'medication_domain'
  | 'catalog_read'
  | 'medication_query'
  | 'read_shaped'
  | 'memory_recall'
  | 'none';

export type SemanticDispatchEligibility = {
  eligible: boolean;
  reason: SemanticDispatchEligibilityReason;
};

/** Same modal family already inside OPERATIONAL_ACQUISITION_SHAPE, without destination. */
const BARE_NEED_FAMILY = /\bneed\s+(?!to\b)/i;

export function evaluateSemanticDispatchEligibility(text: string): SemanticDispatchEligibility {
  const t = text.trim();
  if (!t) return { eligible: false, reason: 'none' };

  if (isExplicitInstructionToHerald(t)) return { eligible: true, reason: 'instruction' };
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return { eligible: true, reason: 'list_add' };
  if (TODO_ADD_PREFIX.test(t) || TODO_ADD_SIGNALS.some((p) => p.test(t))) {
    return { eligible: true, reason: 'todo_obligation' };
  }
  if (OPERATIONAL_ACQUISITION_SHAPE.test(t)) return { eligible: true, reason: 'acquisition' };
  if (OBLIGATION_MODAL_FAMILY.test(t)) return { eligible: true, reason: 'obligation_family' };
  if (BARE_NEED_FAMILY.test(t)) return { eligible: true, reason: 'bare_need' };
  if (GROCERY_CONTEXT_MARKER.test(t)) return { eligible: true, reason: 'grocery_context' };
  if (detectMedicalEvent(t)) return { eligible: true, reason: 'medical_event' };
  if (hasMedicationDomainEvidence(t)) return { eligible: true, reason: 'medication_domain' };
  if (isCatalogMedicationReadUtterance(t)) return { eligible: true, reason: 'catalog_read' };
  if (isMedicationQuestionShape(t)) return { eligible: true, reason: 'medication_query' };
  if (isReadShapedUtterance(t)) return { eligible: true, reason: 'read_shaped' };
  if (isPersonalMemoryRecallQuestion(t)) return { eligible: true, reason: 'memory_recall' };
  return { eligible: false, reason: 'none' };
}
