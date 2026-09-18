import type { DbDiff, ListItemRow } from '../journeyHarness.ts';

export type DeltaCounts = {
  medications_added: number;
  medications_removed: number;
  medications_changed: number;
  medical_records_added: number;
  medical_records_removed: number;
  medical_records_changed: number;
  lists_added: number;
  lists_removed: number;
  lists_changed: number;
  list_items_added: number;
  list_items_removed: number;
  list_items_changed: number;
};

export function countAuthoritativeDelta(diff: DbDiff): DeltaCounts {
  return {
    medications_added: diff.added.length,
    medications_removed: diff.removed.length,
    medications_changed: diff.changed.length,
    medical_records_added: diff.medical_records_added.length,
    medical_records_removed: diff.medical_records_removed.length,
    medical_records_changed: diff.medical_records_changed.length,
    lists_added: diff.lists_added.length,
    lists_removed: diff.lists_removed.length,
    lists_changed: diff.lists_changed.length,
    list_items_added: diff.list_items_added.length,
    list_items_removed: diff.list_items_removed.length,
    list_items_changed: diff.list_items_changed.length,
  };
}

export function isExactZeroDelta(diff: DbDiff): boolean {
  return Object.values(countAuthoritativeDelta(diff)).every((n) => n === 0);
}

export function openItems(items: ListItemRow[], listName: string): ListItemRow[] {
  return items.filter((i) => i.list_name === listName && i.checked === 0 && !i.removed_at);
}

export function bodies(items: ListItemRow[], listName: string): string[] {
  return openItems(items, listName).map((i) => i.body);
}
