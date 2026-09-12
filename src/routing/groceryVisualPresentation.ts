// src/routing/groceryVisualPresentation.ts
// Project display rows from durable open grocery IDs. Not an authority.
// Incomplete projection fails closed. No visual ordinals.

import { getOpenListItemById, type PresentedListItem } from '../db/listRead';

export type GroceryVisualRow = {
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
    rows.push({ id: item.id, body: item.body });
  }
  return rows;
}
