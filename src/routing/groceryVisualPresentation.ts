// src/routing/groceryVisualPresentation.ts
// Grocery Visual Support V1 — project a display list from the live ordered
// presentation IDs. Not an authority: every row is a currently-open grocery
// item resolved by durable ID. Incomplete projection fails closed.

import { getOpenListItemById, type PresentedListItem } from '../db/listRead';

export type GroceryVisualRow = {
  position: number;
  id: string;
  body: string;
};

export function projectGroceryVisualFromPresentedIds(
  presentedIds: string[],
): GroceryVisualRow[] | null {
  if (presentedIds.length === 0) return [];
  const rows: GroceryVisualRow[] = [];
  for (let i = 0; i < presentedIds.length; i++) {
    const id = presentedIds[i];
    const item: PresentedListItem | null = getOpenListItemById(id, 'grocery');
    if (!item) return null;
    rows.push({ position: i + 1, id: item.id, body: item.body });
  }
  return rows;
}
