// Canonical Conversation State — Slice 1 facade.
// Owns Working Focus lifetime decisions and live Presented Set identity
// for ordinal admission. Not Truth & Authority. Not Pending Authority.
// Not a writer. Not a reader.

import { interpretPositionReference, isPositionMutationLanguage } from './positionReference';
import { parseMedicationOrdinalIndex } from './medicationPresentation';
import { parseCalendarTimeInquiry } from './calendarPresentation';
import { parseGroceryNamedCollectionRead } from './groceryNamedCollectionReentry';
import { hasGroceryNamedMutationCue } from './groceryPositionalMutation';
import type { MedicationPresentationHolder } from './medicationPresentation';
import type { OrderedPresentationHolder } from './orderedPresentation';
import type { CalendarPresentationHolder } from './calendarPresentation';
import type { TodoPresentationHolder } from './todoVisualPresentation';
import type { RouteDecision } from './routeIntent';

export type PresentedSetDomain = 'medication' | 'grocery' | 'calendar' | 'todo';

export type PresentedSet = {
  setId: string;
  domain: PresentedSetDomain;
  orderedMemberIds: readonly string[];
  version: number;
  validity: 'live' | 'superseded';
  surface: 'voice';
};

export type OrdinalAdmission =
  | { kind: 'none' }
  | { kind: 'clarify' }
  | {
      kind: 'unique';
      domain: PresentedSetDomain;
      setId: string;
      position: number;
      memberId: string;
      mutation: boolean;
    };

type DetectedOrdinal = {
  position: number;
  mutation: boolean;
  domainHint: PresentedSetDomain | null;
};

export function presentedSet(domain: PresentedSetDomain, orderedMemberIds: readonly string[], validity: PresentedSet['validity'] = 'live'): PresentedSet {
  return {
    setId: `${domain}:${orderedMemberIds.join('|')}`,
    domain,
    orderedMemberIds,
    version: 1,
    validity,
    surface: 'voice',
  };
}

export function collectLivePresentedSets(input: {
  medication?: MedicationPresentationHolder | null;
  ordered?: OrderedPresentationHolder | null;
  calendar?: CalendarPresentationHolder | null;
  todo?: TodoPresentationHolder | null;
}): PresentedSet[] {
  const sets: PresentedSet[] = [];
  const medication = input.medication?.hasLive() ? input.medication.peek() : null;
  if (medication && medication.medicationIds.length > 0) {
    sets.push(presentedSet('medication', medication.medicationIds));
  }
  const ordered = input.ordered?.hasLive() ? input.ordered.peek() : null;
  if (ordered?.owner === 'grocery' && ordered.presentedIds.length > 0) {
    sets.push(presentedSet('grocery', ordered.presentedIds));
  }
  const calendar = input.calendar?.hasLive() ? input.calendar.peek() : null;
  if (calendar && calendar.eventIds.length > 0) {
    sets.push(presentedSet('calendar', calendar.eventIds));
  }
  const todoIds = input.todo?.hasLive() ? input.todo.peek() : null;
  if (todoIds && todoIds.length > 0) {
    sets.push(presentedSet('todo', todoIds));
  }
  return sets;
}

function detectStructuralOrdinal(text: string): DetectedOrdinal | 'ambiguous' | null {
  const mutation = isPositionMutationLanguage(text);
  const namedGrocery = !mutation && parseGroceryNamedCollectionRead(text).kind === 'position';
  const namedGroceryMutation = mutation && hasGroceryNamedMutationCue(text);
  const domainHint: PresentedSetDomain | null = namedGrocery || namedGroceryMutation ? 'grocery' : null;
  const positions = new Set<number>();
  const interpreted = interpretPositionReference(text);
  if (interpreted.kind === 'ambiguous' && interpreted.reason !== 'relative' && interpreted.reason !== 'other_anaphor') {
    return 'ambiguous';
  }
  if (interpreted.kind === 'position_reference' && interpreted.positions.length === 1) {
    positions.add(interpreted.positions[0]);
  } else if (interpreted.kind === 'position_reference' && interpreted.positions.length > 1) {
    return 'ambiguous';
  }
  const medicationIndex = parseMedicationOrdinalIndex(text);
  if (medicationIndex !== null) positions.add(medicationIndex + 1);
  const calendarPosition = parseCalendarTimeInquiry(text);
  if (calendarPosition !== null) positions.add(calendarPosition);
  if (positions.size > 1) return 'ambiguous';
  if (positions.size === 0) return null;
  return { position: [...positions][0], mutation, domainHint };
}

/**
 * Silent ordinal bind only when exactly one live set has a member at that
 * position. A superseded set is not eligible. Recency, UI surface, and
 * model confidence are not inputs.
 */
export function admitStructuralOrdinal(text: string, sets: readonly PresentedSet[]): OrdinalAdmission {
  const detected = detectStructuralOrdinal(text);
  if (detected === 'ambiguous') return { kind: 'clarify' };
  if (!detected) return { kind: 'none' };
  const live = sets.filter((set) => set.validity === 'live' && set.orderedMemberIds.length >= detected.position);
  const eligible = detected.domainHint ? live.filter((set) => set.domain === detected.domainHint) : live;
  if (eligible.length > 1) return { kind: 'clarify' };
  if (eligible.length === 1) {
    const set = eligible[0];
    return {
      kind: 'unique',
      domain: set.domain,
      setId: set.setId,
      position: detected.position,
      memberId: set.orderedMemberIds[detected.position - 1],
      mutation: detected.mutation,
    };
  }
  return { kind: 'none' };
}

/** A verified side activity must not replace Working Focus. It also must not be authorized by that focus. */
export function isFocusPreservingSideActivity(route: RouteDecision): boolean {
  if (route.kind === 'capture') {
    return route.intents.length > 0 && route.intents.every((intent) => intent.type === 'list_add' || intent.type === 'todo_add');
  }
  if (route.kind === 'device_action') {
    return route.actionIntent.type === 'list_add' || route.actionIntent.type === 'todo_add';
  }
  if (route.kind !== 'device_read') return false;
  return route.presentedGroceryIds !== undefined
    || route.presentedTodoIds !== undefined
    || route.presentedMedicationIds !== undefined
    || route.presentedCalendarEventIds !== undefined
    || route.reason.startsWith('calendar:');
}
