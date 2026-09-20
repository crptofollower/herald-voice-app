// Recent Action Recall V1 — speech for a committed list-add operation.
// Bodies come only from ledger committed-item evidence. This module never
// reads SQLite and never claims the items are still on the list.

export type RecentAddRecallAct = { kind: 'added'; items: readonly string[] };

function joinSpokenBodies(items: readonly string[]): string {
  const bodies = items.map((i) => i.trim()).filter((s) => s.length > 0);
  if (bodies.length === 0) return '';
  if (bodies.length === 1) return bodies[0];
  if (bodies.length === 2) return `${bodies[0]} and ${bodies[1]}`;
  return `${bodies.slice(0, -1).join(', ')}, and ${bodies[bodies.length - 1]}`;
}

export function realizeRecentAddRecallAct(act: RecentAddRecallAct): string | null {
  const joined = joinSpokenBodies(act.items);
  if (!joined) return null;
  return `You added ${joined}.`;
}
