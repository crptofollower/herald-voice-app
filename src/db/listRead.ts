// Authoritative open-list presentation: one query, then speech and IDs
// from the same post-dedupe array. No second order query for positions.

import { getDB } from './schema';

export type PresentedListItem = { id: string; body: string };

export function getPresentedOpenListItems(listName: string): PresentedListItem[] {
  const db = getDB();
  const items = db.getAllSync<{ id: string; body: string }>(
    `SELECT li.id, li.body FROM list_items li
     JOIN lists l ON l.id = li.list_id
     WHERE l.name = ? AND li.checked = 0
     ORDER BY li.created_at ASC;`,
    [listName],
  );
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = i.body.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function composeOpenListSpeech(listName: string, items: PresentedListItem[]): string {
  return items.length === 0
    ? `Your ${listName} list is empty.`
    : `On your ${listName} list: ${items.map((i) => i.body).join(', ')}.`;
}

/** Fresh live row by stable ID. Same eligibility as open-list presentation. */
export function getOpenListItemById(
  id: string,
  listName: string,
): PresentedListItem | null {
  if (!id) return null;
  const db = getDB();
  return db.getFirstSync<PresentedListItem>(
    `SELECT li.id, li.body FROM list_items li
     JOIN lists l ON l.id = li.list_id
     WHERE li.id = ? AND l.name = ? AND li.checked = 0
     LIMIT 1;`,
    [id, listName],
  ) ?? null;
}

export function formatGroceryItemReadback(body: string): string {
  return `That's ${body}.`;
}
