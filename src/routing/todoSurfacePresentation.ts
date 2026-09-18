// To-do capability-surface presentation. Open rows are a SQLite projection
// of list name `todos`. Overlay is RAM-only and never a writer.

import { getPresentedOpenListItems } from '../db/listRead';
import type { UtteranceOutcome } from './processUtterance';
import {
  mergeGrocerySurfaceRows,
  overlayAfterSuccessfulOpenDepartures,
  type GroceryCompletedOverlayRow,
  type GroceryMergedRow,
  type GrocerySurfaceOpenRow,
} from './grocerySurfacePresentation';

export type TodoSurfaceOpenRow = GrocerySurfaceOpenRow;
export type TodoCompletedOverlayRow = GroceryCompletedOverlayRow;
export type TodoMergedRow = GroceryMergedRow;

export function projectTodoOpenRowsFromSqlite(): TodoSurfaceOpenRow[] {
  return getPresentedOpenListItems('todos').map((item) => ({
    id: item.id,
    body: item.body,
  }));
}

export const mergeTodoSurfaceRows = mergeGrocerySurfaceRows;
export const overlayTodoAfterSuccessfulOpenDepartures = overlayAfterSuccessfulOpenDepartures;

export function todoOutcomeIdentifiesSurface(outcome: UtteranceOutcome): boolean {
  if (outcome.handled) {
    if (outcome.source === 'emergency') return false;
    if (outcome.capabilitySurface === 'todo') return true;
    for (const commit of outcome.commits) {
      if (commit.status === 'pending' && commit.pendingKey === 'todo_complete') return true;
      if (
        (commit.status === 'committed' || commit.status === 'noop')
        && commit.focus?.kind === 'item'
        && typeof commit.focus.resolverKey === 'string'
        && commit.focus.resolverKey.startsWith('todo_')
      ) {
        return true;
      }
    }
    return false;
  }

  const decision = outcome.routeDecision;
  if (decision.kind === 'device_read' && decision.presentedTodoIds !== undefined) {
    return true;
  }
  if (decision.kind === 'device_action') {
    const action = decision.actionIntent;
    if (!action) return false;
    return action.type === 'todo_complete' || action.type === 'todo_add';
  }
  return false;
}
