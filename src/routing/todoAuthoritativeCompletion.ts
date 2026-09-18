// Shared post-write to-do completion: exact-ID authority only.
// Not a second writer. Voice confirmation remains on the existing todo writer.

import {
  getPresentedOpenListItems,
  markOpenListItemRemovedById,
  type PresentedListItem,
} from '../db/listRead';

export function completeOpenTodoItemByExactId(
  id: string,
): { ok: false } | { ok: true; removed: PresentedListItem; remaining: PresentedListItem[] } {
  const removed = markOpenListItemRemovedById(id, 'todos');
  if (!removed) return { ok: false };
  return { ok: true, removed, remaining: getPresentedOpenListItems('todos') };
}
