// Authoritative open-list presentation: one query, then speech and IDs
// from the same post-dedupe array. No second order query for positions.

import { getDB } from './schema';
import { realizeGroceryListReadAct } from '../conversation/groceryListReadRealization';
import { mono, logSqliteReadOpStart, logSqliteReadOpEnd } from '../utils/latencyInstrument';

export type PresentedListItem = { id: string; body: string };

export function getPresentedOpenListItems(listName: string): PresentedListItem[] {
  logSqliteReadOpStart(listName, 'read');
  const t0 = mono();
  const db = getDB();
  const items = db.getAllSync<{ id: string; body: string }>(
    `SELECT li.id, li.body FROM list_items li
     JOIN lists l ON l.id = li.list_id
     WHERE l.name = ? AND li.checked = 0
     ORDER BY li.created_at ASC;`,
    [listName],
  );
  const seen = new Set<string>();
  const out = items.filter((i) => {
    const key = i.body.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  logSqliteReadOpEnd(listName, 'read', mono() - t0, 'ok', out.length);
  return out;
}

export function composeOpenListSpeech(listName: string, items: PresentedListItem[]): string {
  if (listName === 'grocery') {
    return items.length === 0
      ? realizeGroceryListReadAct({ kind: 'empty' })
      : realizeGroceryListReadAct({ kind: 'count', itemCount: items.length });
  }
  return items.length === 0
    ? `Your ${listName} list is empty.`
    : `On your ${listName} list: ${items.map((i) => i.body).join(', ')}.`;
}

/** Exact historic ChatScreen todo_read copy. Do not swap onto composeOpenListSpeech. */
export function composeTodoOpenSpeech(items: PresentedListItem[]): string {
  return items.length === 0
    ? `You're all clear — nothing on your to-do list.`
    : `You've got ${items.length} open: ${items.map((i) => i.body).join(', ')}.`;
}

/** Transcript hide when the todo card is live. TTS still speaks this copy. */
export function isTodoOpenListSpeech(text: string): boolean {
  return /^You've got \d+ open: /.test(text.trim());
}

// Historic ChatScreen todo_complete scorer. Highest score wins; ties keep the
// first item in iteration order (`score > bestScore` only). Do not "improve".
const TODO_COMPLETE_STOP_WORDS = new Set([
  'i', 'the', 'a', 'an', 'to', 'of', 'and', 'or', 'my', 'me', 'it',
  'that', 'this', 'have', 'had', 'been', 'was', 'did', 'do',
]);

export function matchTodoCompleteItem(
  raw: string,
  items: PresentedListItem[],
): PresentedListItem | null {
  const rawLower = raw.toLowerCase();
  const keywords = rawLower.split(/\W+/).filter((w) => w.length > 2 && !TODO_COMPLETE_STOP_WORDS.has(w));
  let bestMatch: PresentedListItem | null = null;
  let bestScore = 0;
  for (const item of items) {
    const itemLower = item.body.toLowerCase();
    const score = keywords.filter((k) => itemLower.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }
  if (!bestMatch || bestScore === 0) return null;
  return bestMatch;
}

/** Fresh live row by stable ID. Same eligibility as open-list presentation. */
export function getOpenListItemById(
  id: string,
  listName: string,
): PresentedListItem | null {
  if (!id) return null;
  logSqliteReadOpStart(listName, 'read');
  const t0 = mono();
  const db = getDB();
  const row = db.getFirstSync<PresentedListItem>(
    `SELECT li.id, li.body FROM list_items li
     JOIN lists l ON l.id = li.list_id
     WHERE li.id = ? AND l.name = ? AND li.checked = 0
     LIMIT 1;`,
    [id, listName],
  ) ?? null;
  logSqliteReadOpEnd(listName, 'read', mono() - t0, 'ok', row ? 1 : 0);
  return row;
}

export function formatGroceryItemReadback(body: string): string {
  return `That's ${body}.`;
}

/** Soft-delete one currently-open list row by stable ID. No body/LIKE match. */
export function markOpenListItemRemovedById(
  id: string,
  listName: string,
): PresentedListItem | null {
  logSqliteReadOpStart(listName, 'remove');
  const t0 = mono();
  const row = getOpenListItemById(id, listName);
  if (!row) {
    logSqliteReadOpEnd(listName, 'remove', mono() - t0, 'failed', 0);
    return null;
  }
  const db = getDB();
  db.runSync(
    `UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ? AND checked = 0;`,
    [new Date().toISOString(), id],
  );
  logSqliteReadOpEnd(listName, 'remove', mono() - t0, 'ok', 1);
  return row;
}
