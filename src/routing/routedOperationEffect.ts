// Routed Operation Effect Contract V1.
// Describes the effect of an already-selected RouteDecision. Does not
// authorize execution, dispatch, writers, or pending mutation.
//
// Assignment authority is classifyRoutedEffect / withRoutedEffect at the
// public routeIntent return. processUtterance may consume only
// mayPreserveExistingClarification (effect === 'read_only').

import type { IntentRecord } from '../hooks/llmLayers';
import type { TierDecision } from './tierRouter';
import type { RouteDecision } from './routeIntent';
import { UNRESOLVED_LIST_REFERENT_REASON } from './operationalListContinuity';
import { UNRESOLVED_LIST_ADD_SUPERSESSION_REASON } from './sameUtteranceListAddRepair';

export type RoutedEffectClass =
  | 'read_only'
  | 'mutating'
  | 'external_effect'
  | 'competing_write'
  | 'pending_arming';

type ActionIntentType = NonNullable<TierDecision['actionIntent']>['type'];

function assertNever(x: never): never {
  throw new Error(`routedOperationEffect: unhandled variant ${String(x)}`);
}

/**
 * Closed ActionIntent → effect. Adding a union member without a key here
 * is a compile error (`satisfies Record<ActionIntentType, …>`).
 */
export const ACTION_INTENT_EFFECT = {
  time: 'read_only',
  date: 'read_only',
  note_read: 'read_only',
  list_read: 'read_only',
  todo_read: 'read_only',
  household_read: 'read_only',
  timer: 'external_effect',
  alarm: 'external_effect',
  sms: 'external_effect',
  call: 'external_effect',
  navigation: 'external_effect',
  photo_open: 'external_effect',
  app_open: 'external_effect',
  list_add: 'mutating',
  todo_add: 'mutating',
  note_capture: 'mutating',
  reminder: 'mutating',
  calendar_write: 'mutating',
  medical_capture: 'mutating',
  list_update: 'mutating',
  profile_update: 'mutating',
  medical_remove: 'competing_write',
  list_remove: 'competing_write',
  list_clear: 'competing_write',
  household_remove: 'competing_write',
  todo_complete: 'pending_arming',
  medical_clear: 'pending_arming',
} as const satisfies Record<ActionIntentType, RoutedEffectClass>;

/**
 * Deterministic capture primary-intent → effect. LLM / recovery captures
 * are confirmation-armed in applyIntents and classified from `source`.
 */
export const CAPTURE_INTENT_EFFECT = {
  list_add: 'mutating',
  todo_add: 'mutating',
  contact_call: 'external_effect',
  pass: 'competing_write',
  insurance_capture: 'pending_arming',
  medical_capture: 'pending_arming',
  medical_visit: 'pending_arming',
  medical_visit_upcoming: 'pending_arming',
  doctor_intro_capture: 'pending_arming',
  service_capture: 'pending_arming',
  family_capture: 'pending_arming',
  phone_capture: 'pending_arming',
  address_capture: 'pending_arming',
  emergency_contact: 'pending_arming',
  diagnosis_capture: 'pending_arming',
  todo_complete: 'pending_arming',
} as const satisfies Record<IntentRecord['type'], RoutedEffectClass>;

/** device_read reasons that processUtterance arms as list-add-item clarification. */
export const DEVICE_READ_PENDING_ARMING_REASONS = [
  UNRESOLVED_LIST_REFERENT_REASON,
  UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
] as const;

export const NEEDS_CLARIFICATION_PENDING_ARMING_REASONS = [
  'ambiguous_operational_list',
] as const;

function isDeviceReadPendingArmingReason(reason: string): boolean {
  return (DEVICE_READ_PENDING_ARMING_REASONS as readonly string[]).includes(reason);
}

function isNeedsClarificationPendingArmingReason(reason: string): boolean {
  return (NEEDS_CLARIFICATION_PENDING_ARMING_REASONS as readonly string[]).includes(reason);
}

function classifyDeviceRead(reason: string): RoutedEffectClass {
  if (isDeviceReadPendingArmingReason(reason)) return 'pending_arming';
  return 'read_only';
}

function classifyNeedsClarification(reason: string): RoutedEffectClass {
  if (isNeedsClarificationPendingArmingReason(reason)) return 'pending_arming';
  // Conversational miss / decline: not a completed read. Not a preservation
  // candidate. Not an automatic supersede predicate — only READ_ONLY is.
  return 'competing_write';
}

function classifyCapture(decision: Extract<RouteDecision, { kind: 'capture' }>): RoutedEffectClass {
  const primary = decision.intents[0];
  if (primary?.type === 'contact_call') return 'external_effect';
  if (decision.source === 'llm' || decision.source === 'deterministic_recovery') {
    return 'pending_arming';
  }
  if (!primary) return 'competing_write';
  return CAPTURE_INTENT_EFFECT[primary.type];
}

/** Pure. Does not inspect utterance text. */
export function classifyRoutedEffect(decision: RouteDecision): RoutedEffectClass {
  switch (decision.kind) {
    case 'device_read':
      return classifyDeviceRead(decision.reason);
    case 'device_action':
      return ACTION_INTENT_EFFECT[decision.actionIntent.type];
    case 'capture':
      return classifyCapture(decision);
    case 'phone_repair_needed':
      return 'pending_arming';
    case 'medical_read_pending':
      return 'pending_arming';
    case 'needs_clarification':
      return classifyNeedsClarification(decision.reason);
    case 'backend':
      return 'external_effect';
    case 'interpretation_hold':
      return 'competing_write';
    case 'not_ready':
      return 'competing_write';
    case 'memory_probe':
      return 'competing_write';
    default:
      return assertNever(decision);
  }
}

export function mayPreserveExistingClarification(decision: RouteDecision): boolean {
  return classifyRoutedEffect(decision) === 'read_only';
}

export function withRoutedEffect<T extends RouteDecision>(
  decision: T,
): T & { effect: RoutedEffectClass } {
  return { ...decision, effect: classifyRoutedEffect(decision) };
}
