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
  // Schema V3 fields — added by MIGRATIONS[3]
  entity_id?: string;
  importance_score?: number;   // 0-100
  valid_until?: string;        // ISO date — NULL = permanent
  context_type?: string;       // 'active' | 'historical'
}

// ─── writeFact ────────────────────────────────────────────────────────────────
//
// Writes a single fact. Deduplicates by normalized text — if the same fact
// (case-insensitive, trimmed) already exists, updates use_count only.
// Returns the fact id.

export interface WriteFactOptions {
  confidence?: Fact["confidence"];
  contextType?: "active" | "historical";
  validUntil?: string;   // ISO date — fact expires (e.g. "picking someone up today")
  entityId?: string;
  importanceScore?: number;
}

export function writeFact(
  fact: string,
  category: string,
  optionsOrConfidence: WriteFactOptions | Fact["confidence"] = "stated"
): string {
  const db = getDB();
  const normalized = fact.trim().toLowerCase();
  const today = new Date().toISOString().split("T")[0];

  // Accept legacy (string) or new options object
  const opts: WriteFactOptions =
    typeof optionsOrConfidence === "string"
      ? { confidence: optionsOrConfidence }
      : optionsOrConfidence;

  const confidence = opts.confidence ?? "stated";
  const contextType = opts.contextType ?? "historical";
  const validUntil = opts.validUntil ?? null;
  const entityId = opts.entityId ?? null;
  // importance_score: use provided, or derive from category if not given
  const importanceScore = opts.importanceScore ?? CATEGORY_IMPORTANCE[category] ?? 50;

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

  // Try to insert with v3 columns — fall back gracefully if migration hasn't run yet
  try {
    db.runSync(
      `INSERT INTO facts
         (id, fact, category, confidence, source_date, use_count,
          context_type, valid_until, entity_id, importance_score)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?);`,
      [id, fact.trim(), category, confidence, today,
       contextType, validUntil, entityId, importanceScore]
    );
  } catch {
    // V3 columns not yet available — insert base columns only
    db.runSync(
      `INSERT INTO facts (id, fact, category, confidence, source_date, use_count)
       VALUES (?, ?, ?, ?, ?, 0);`,
      [id, fact.trim(), category, confidence, today]
    );
  }
  return id;
}

// Category → default importance score mapping.
// Mirrors memory_importance table seeded in MIGRATIONS[3].
const CATEGORY_IMPORTANCE: Record<string, number> = {
  medical:       100,
  medication:     95,
  family:         85,
  relationships:  75,
  financial:      70,
  work:           60,
  schedule:       65,
  location:       50,
  travel:         45,
  life_events:    55,
  sports:         30,
  preferences:    20,
  food:           20,
  general:        10,
};

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
// Returns the top N facts, decay-weighted by recency.
// Formula: score = use_count * importance_score / MAX(1, days_since_source_date)
// This means a fact mentioned 3 times this week beats one mentioned 10 times
// six months ago — recency of relevance matters as much as frequency.
//
// Filters:
//   - Expired facts (valid_until < today) are excluded
//   - Historical context_type is included but ranked below active

export function getTopFacts(limit = 20): Fact[] {
  const db = getDB();
  try {
    // V3 query: decay weighting + expiry filter + context_type ranking
    return db.getAllSync<Fact>(
      `SELECT *,
         (COALESCE(use_count, 1) * COALESCE(importance_score, 50))
           / MAX(1.0, julianday('now') - julianday(source_date)) AS decay_score
       FROM facts
       WHERE (valid_until IS NULL OR valid_until >= date('now'))
       ORDER BY
         CASE WHEN context_type = 'active' THEN 1 ELSE 2 END ASC,
         decay_score DESC
       LIMIT ?;`,
      [limit]
    );
  } catch {
    // V3 columns not yet available — fall back to simple ordering
    return db.getAllSync<Fact>(
      "SELECT * FROM facts ORDER BY use_count DESC, source_date DESC LIMIT ?;",
      [limit]
    );
  }
}

// ─── getFactsSummary ──────────────────────────────────────────────────────────
//
// Returns a plain-text summary of known facts for Tier 2 context.
// Ordered by importance + recency decay. Expired facts excluded.
// Caps at 4 facts per category so high-volume categories (general) don't
// overwhelm the context window. Total capped at 30 facts.

export function getFactsSummary(): string {
  const facts = getTopFacts(60); // get more, then cap per category below
  if (facts.length === 0) return "";

  // Category display order — most important first
  const CATEGORY_ORDER = [
    "medical", "medication", "family", "relationships",
    "financial", "work", "schedule", "location",
    "life_events", "travel", "preferences", "sports", "food", "general",
  ];

  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    if (!grouped[f.category]) grouped[f.category] = [];
    if (grouped[f.category].length < 4) { // cap 4 per category
      grouped[f.category].push(f.fact);
    }
  }

  const lines: string[] = [];
  // Emit in importance order
  for (const cat of CATEGORY_ORDER) {
    if (grouped[cat]?.length) {
      const label = cat.charAt(0).toUpperCase() + cat.slice(1).replace("_", " ");
      lines.push(`${label}: ${grouped[cat].join("; ")}`);
    }
  }
  // Any categories not in the order list (future expansion)
  for (const [cat, items] of Object.entries(grouped)) {
    if (!CATEGORY_ORDER.includes(cat)) {
      lines.push(`${cat}: ${items.join("; ")}`);
    }
  }

  return lines.slice(0, 14).join("\n"); // max 14 category lines
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


// ─── expireTemporalFacts ──────────────────────────────────────────────────────
//
// Call on app open to clean up facts that have passed their valid_until date.
// Marks them historical rather than deleting — preserves the record.
// Example: "picking someone up at 4:30 today" should become historical tomorrow.

export function expireTemporalFacts(): void {
  const db = getDB();
  try {
    db.runSync(
      `UPDATE facts
       SET context_type = 'historical'
       WHERE valid_until IS NOT NULL
         AND valid_until < date('now')
         AND context_type = 'active';`
    );
  } catch {
    // V3 columns not yet available — no-op
  }
}

// ─── writeFactWithExpiry ──────────────────────────────────────────────────────
//
// Convenience wrapper for time-sensitive facts.
// daysValid: how many days until this fact becomes historical.
// Use for: "picking someone up today", "steak dinner tonight", event-specific context.

export function writeFactWithExpiry(
  fact: string,
  category: string,
  daysValid: number
): string {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + daysValid);
  return writeFact(fact, category, {
    contextType: "active",
    validUntil: expiry.toISOString().split("T")[0],
    confidence: "stated",
  });
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