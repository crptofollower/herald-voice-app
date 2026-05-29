// src/db/factDB.ts
// Herald device SQLite — facts table read/write.
// Session L — Device-First Intelligence Layer
//
// The facts table is the core memory store.
// Every piece of personal knowledge Herald learns is written here as a
// typed, categorized, structured fact — never as a raw conversation pair.
//
// Category values:
//   relationships  — family, friends, named people
//   medical        — conditions, medications, doctors, appointments
//   preferences    — food, activities, habits
//   schedule       — recurring events, routines
//   location       — home, work, frequented places
//   life_events    — milestones, notable moments
//   professional   — work, goals, projects
//   general        — anything that doesn't fit above
//
// Confidence values:
//   stated    — user explicitly said it
//   inferred  — Herald concluded it from context
//   confirmed — user confirmed Herald's inference

import { getDB } from "./schema";

export interface Fact {
  id: string;
  fact: string;
  category: string;
  confidence: "stated" | "inferred" | "confirmed";
  source_date: string;
  last_used?: string;
  use_count: number;
}

// ─── writeFact ────────────────────────────────────────────────────────────────
//
// Writes a single fact. Deduplicates by normalized text — if the same fact
// (case-insensitive, trimmed) already exists, updates use_count only.
// Returns the fact id.

export function writeFact(
  fact: string,
  category: string,
  confidence: Fact["confidence"] = "stated"
): string {
  const db = getDB();
  const normalized = fact.trim().toLowerCase();
  const today = new Date().toISOString().split("T")[0];

  // Check for existing fact with same normalized text
  const existing = db.getFirstSync<{ id: string; use_count: number }>(
    "SELECT id, use_count FROM facts WHERE LOWER(TRIM(fact)) = ? LIMIT 1;",
    [normalized]
  );

  if (existing) {
    db.runSync(
      "UPDATE facts SET use_count = ?, last_used = ? WHERE id = ?;",
      [existing.use_count + 1, new Date().toISOString(), existing.id]
    );
    return existing.id;
  }

  const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.runSync(
    `INSERT INTO facts (id, fact, category, confidence, source_date, use_count)
     VALUES (?, ?, ?, ?, ?, 0);`,
    [id, fact.trim(), category, confidence, today]
  );
  return id;
}

// ─── writeFacts ───────────────────────────────────────────────────────────────
//
// Batch write — called from herald.ts onFacts callback.
// Each item is { category, value } from the backend extraction.

export function writeFacts(
  facts: Array<{ category: string; value: string }>
): void {
  for (const f of facts) {
    if (f.value?.trim()) {
      writeFact(f.value, f.category, "stated");
    }
  }
}

// ─── getFactsByCategory ───────────────────────────────────────────────────────
//
// Returns all facts for a given category, ordered by use_count DESC.

export function getFactsByCategory(category: string): Fact[] {
  const db = getDB();
  return db.getAllSync<Fact>(
    "SELECT * FROM facts WHERE category = ? ORDER BY use_count DESC, source_date DESC;",
    [category]
  );
}

// ─── getTopFacts ──────────────────────────────────────────────────────────────
//
// Returns the top N facts across all categories, ordered by use_count DESC.
// Used to build the local context block sent to backend on Tier 2 queries.

export function getTopFacts(limit = 20): Fact[] {
  const db = getDB();
  return db.getAllSync<Fact>(
    "SELECT * FROM facts ORDER BY use_count DESC, source_date DESC LIMIT ?;",
    [limit]
  );
}

// ─── getFactsSummary ──────────────────────────────────────────────────────────
//
// Returns a plain-text summary of known facts, grouped by category.
// Used by tier1Responses.ts to answer "what do you know about me" queries
// until Phi-3 is available in Session W.

export function getFactsSummary(): string {
  const db = getDB();
  const facts = db.getAllSync<Fact>(
    "SELECT * FROM facts ORDER BY category, use_count DESC;"
  );

  if (facts.length === 0) return "";

  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    if (!grouped[f.category]) grouped[f.category] = [];
    grouped[f.category].push(f.fact);
  }

  const lines: string[] = [];
  for (const [cat, items] of Object.entries(grouped)) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`${label}: ${items.slice(0, 5).join("; ")}`);
  }
  return lines.join("\n");
}

// ─── markFactUsed ─────────────────────────────────────────────────────────────
//
// Call when a fact is surfaced in a response — increments use_count
// and updates last_used. Higher use_count = higher weight in future recalls.

export function markFactUsed(id: string): void {
  const db = getDB();
  const row = db.getFirstSync<{ use_count: number }>(
    "SELECT use_count FROM facts WHERE id = ?;",
    [id]
  );
  if (!row) return;
  db.runSync(
    "UPDATE facts SET use_count = ?, last_used = ? WHERE id = ?;",
    [row.use_count + 1, new Date().toISOString(), id]
  );
}

// ─── deleteFact ───────────────────────────────────────────────────────────────
//
// Hard delete — use only for correcting wrong facts.
// Future: soft delete with is_deleted flag when trust system matures.

export function deleteFact(id: string): void {
  const db = getDB();
  db.runSync("DELETE FROM facts WHERE id = ?;", [id]);
}

// ─── getFactCount ─────────────────────────────────────────────────────────────

export function getFactCount(): number {
  const db = getDB();
  const row = db.getFirstSync<{ count: number }>("SELECT COUNT(*) as count FROM facts;");
  return row?.count ?? 0;
}