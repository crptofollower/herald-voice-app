// src/db/recallDB.ts
// ─── Temporal recall — short-term episodic read authority (Rung 4, v1) ─────────
// ONE reader for "what did I bring up recently." Recency-ranked read over EXISTING
// timestamped rows. No schema, no embeddings, no episodes table — those are Rung 5.
// v1 reads the grocery list only (template domain); more domains union in here one
// gated commit at a time, like DOMAIN_WRITERS.
//
// Boundary (Spine §7): recalls things that became a durable row. A said-but-
// unwritten remark ("Ireland was beautiful") leaves no row — out of scope until the
// Rung 5 episodes writer. Family/entity surface EXCLUDED while F1 is live.

import { getDB } from './schema';

export interface RecallItem { body: string; createdAtMs: number; domain: string; }

// windowStartMs = earliest created_at to include (start of local day in v1).
// Mirrors the list reader's canonical active filter (checked = 0 AND removed_at IS NULL).
export function getRecentMentions(windowStartMs: number): RecallItem[] {
  const db = getDB();
  const sinceIso = new Date(windowStartMs).toISOString();
  const out: RecallItem[] = [];
  try {
    const rows = db.getAllSync<{ body: string; created_at: string }>(
      `SELECT li.body AS body, li.created_at AS created_at
         FROM list_items li JOIN lists l ON l.id = li.list_id
        WHERE l.name = 'grocery'
          AND li.checked = 0 AND li.removed_at IS NULL
          AND li.created_at >= ?
        ORDER BY li.created_at DESC`,
      [sinceIso],
    );
    for (const r of rows) {
      out.push({ body: r.body, createdAtMs: Date.parse(r.created_at) || 0, domain: 'grocery' });
    }
  } catch { /* table unavailable — honest empty */ }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

// Provenance-safe: describes the USER's action ("you put"), never Herald's ("I saved").
// No banned surveillance verbs (record/track/log/store/save/data/monitor/captured).
export function formatRecentMentions(items: RecallItem[]): string {
  if (items.length === 0) return "I don't see anything you've put on your grocery list today.";
  const b = items.map((i) => i.body);
  const list = b.length === 1 ? b[0]
    : b.length === 2 ? `${b[0]} and ${b[1]}`
    : `${b.slice(0, -1).join(', ')}, and ${b[b.length - 1]}`;
  return `Earlier today you put ${list} on your grocery list.`;
}
