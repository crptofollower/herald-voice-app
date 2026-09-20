// src/conversation/groceryListReadRealization.ts
// Grocery list READ speech only.
//
// AUTHORITATIVE OPEN-LIST RESULT -> BOUNDED RESPONSE ACT -> DETERMINISTIC
// REALIZATION. Bodies come only from the presented SQLite open-list array.
// This module never invents items and never appends a closer.

export type GroceryListReadAct =
  | { kind: 'empty' }
  | { kind: 'items'; items: readonly string[] };

function joinSpokenBodies(items: readonly string[]): string {
  const bodies = items.map((i) => i.trim()).filter((s) => s.length > 0);
  if (bodies.length === 0) return '';
  if (bodies.length === 1) return bodies[0];
  if (bodies.length === 2) return `${bodies[0]} and ${bodies[1]}`;
  return `${bodies.slice(0, -1).join(', ')}, and ${bodies[bodies.length - 1]}`;
}

export function realizeGroceryListReadAct(act: GroceryListReadAct): string {
  if (act.kind === 'empty') return 'Your grocery list is empty.';
  const joined = joinSpokenBodies(act.items);
  if (!joined) return 'Your grocery list is empty.';
  return `You've got ${joined}.`;
}

export function isGroceryListReadSummarySpeech(text: string): boolean {
  const t = text.trim();
  if (t === 'Your grocery list is empty.') return true;
  return /^You've got .+\.$/.test(t) && !/^You've got \d+ open:/.test(t);
}
