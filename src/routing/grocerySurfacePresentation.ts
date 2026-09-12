// Grocery capability-surface presentation. Open rows are a SQLite projection.
// Completed overlay is RAM-only and never a writer, speech source, or OPR source.

import { getPresentedOpenListItems } from '../db/listRead';
import type { UtteranceOutcome } from './processUtterance';

export type GrocerySurfaceOpenRow = { id: string; body: string };
export type GroceryCompletedOverlayRow = { id: string; body: string };
export type GroceryMergedRow = {
  id: string;
  body: string;
  status: 'open' | 'completed';
};

export type GrocerySurfaceState = {
  openRows: GrocerySurfaceOpenRow[];
  overlay: GroceryCompletedOverlayRow[];
  orderIds: string[];
};

export function projectGroceryOpenRowsFromSqlite(): GrocerySurfaceOpenRow[] {
  return getPresentedOpenListItems('grocery').map((item) => ({
    id: item.id,
    body: item.body,
  }));
}

export function mergeGrocerySurfaceRows(
  openRows: GrocerySurfaceOpenRow[],
  overlay: GroceryCompletedOverlayRow[],
  previousOrderIds: string[],
): { rows: GroceryMergedRow[]; orderIds: string[] } {
  const openById = new Map(openRows.map((row) => [row.id, row]));
  const overlayById = new Map(overlay.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const rows: GroceryMergedRow[] = [];

  const consider = (id: string) => {
    if (seen.has(id)) return;
    const open = openById.get(id);
    if (open) {
      seen.add(id);
      rows.push({ id, body: open.body, status: 'open' });
      return;
    }
    const done = overlayById.get(id);
    if (done) {
      seen.add(id);
      rows.push({ id, body: done.body, status: 'completed' });
    }
  };

  for (const id of previousOrderIds) consider(id);
  for (const row of openRows) consider(row.id);
  for (const row of overlay) consider(row.id);

  return { rows, orderIds: rows.map((row) => row.id) };
}

export function overlayAfterSuccessfulOpenDepartures(
  previousOpen: GrocerySurfaceOpenRow[],
  nextOpen: GrocerySurfaceOpenRow[],
  existingOverlay: GroceryCompletedOverlayRow[],
): GroceryCompletedOverlayRow[] {
  const nextIds = new Set(nextOpen.map((row) => row.id));
  const overlayIds = new Set(existingOverlay.map((row) => row.id));
  const next = [...existingOverlay];
  for (const row of previousOpen) {
    if (!nextIds.has(row.id) && !overlayIds.has(row.id)) {
      next.push({ id: row.id, body: row.body });
      overlayIds.add(row.id);
    }
  }
  return next;
}

function groceryListName(value: string | undefined): boolean {
  return (value ?? 'grocery').toLowerCase() === 'grocery';
}

export function groceryOutcomeIdentifiesSurface(outcome: UtteranceOutcome): boolean {
  if (outcome.handled) {
    if (outcome.source === 'emergency') return false;
    if (outcome.capabilitySurface === 'grocery') return true;
    for (const commit of outcome.commits) {
      if (commit.focus?.kind === 'collection' && commit.focus.displayValue === 'grocery list') {
        return commit.status === 'committed' || commit.status === 'noop';
      }
    }
    return false;
  }

  const decision = outcome.routeDecision;
  if (decision.kind === 'device_read' && decision.presentedGroceryIds !== undefined) {
    return true;
  }
  if (decision.kind === 'device_action') {
    const action = decision.actionIntent;
    if (!action) return false;
    if (
      action.type === 'list_add'
      || action.type === 'list_remove'
      || action.type === 'list_update'
      || action.type === 'list_clear'
    ) {
      return groceryListName(action.listName);
    }
  }
  return false;
}

export function remainingCountFromOpenRows(openRows: GrocerySurfaceOpenRow[]): number {
  return openRows.length;
}
