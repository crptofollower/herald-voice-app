// src/conversation/groceryListReadRealization.ts
// Conversational Response Realization V1 — Grocery list READ speech only.
//
// AUTHORITATIVE OPEN-LIST RESULT -> BOUNDED RESPONSE ACT -> DETERMINISTIC
// REALIZATION. Item bodies are shown on the visual surface, not spoken in
// full. This module never invents items and never appends a closer.

export type GroceryListReadAct =
  | { kind: 'empty' }
  | { kind: 'count'; itemCount: number };

export function realizeGroceryListReadAct(act: GroceryListReadAct): string {
  if (act.kind === 'empty') return 'Your grocery list is empty.';
  if (act.itemCount === 1) return "You've got one thing.";
  return `You've got ${act.itemCount} things.`;
}

export function isGroceryListReadSummarySpeech(text: string): boolean {
  return text === 'Your grocery list is empty.'
    || /^You've got one thing\.$/.test(text)
    || /^You've got \d+ things\.$/.test(text);
}
