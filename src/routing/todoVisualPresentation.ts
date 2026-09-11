// Todo Visual Support V1 — project a display list from the same IDs the
// authoritative todo reader just used for speech. Not a second store.
// Completed/removed rows drop out on refresh; remaining order is the
// surviving presented-ID order. Todo complete is body-match, not ordinal,
// so this projection does not invent grocery-style position numbers.

import { getOpenListItemById, type PresentedListItem } from '../db/listRead';

export type TodoVisualRow = {
  id: string;
  body: string;
};

export class TodoPresentationHolder {
  private presentedIds: string[] | null = null;

  peek(): string[] | null {
    return this.presentedIds;
  }

  hasLive(): boolean {
    return this.presentedIds != null && this.presentedIds.length > 0;
  }

  establish(presentedIds: string[]): void {
    this.presentedIds = [...presentedIds];
  }

  clear(): void {
    this.presentedIds = null;
  }
}

export function projectTodoVisualFromPresentedIds(
  presentedIds: string[],
): TodoVisualRow[] {
  if (presentedIds.length === 0) return [];
  const rows: TodoVisualRow[] = [];
  for (const id of presentedIds) {
    const item: PresentedListItem | null = getOpenListItemById(id, 'todos');
    if (!item) continue;
    rows.push({ id: item.id, body: item.body });
  }
  return rows;
}
