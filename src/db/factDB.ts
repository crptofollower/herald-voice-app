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
// contactsDB imported lazily to avoid circular dependency
let _extractContact: ((fact: string) => void) | null = null;
export function _registerContactExtractor(fn: (fact: string) => void): void {
  _extractContact = fn;
}

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

export interface WriteFactOptions {
  confidence?: "stated" | "inferred" | "confirmed";
  contextType?: "active" | "historical" | "corrected";
  validUntil?: string;
  importanceScore?: number;
  entityId?: string;
}

export function writeFact(
  fact: string,
  category: string,
  options?: Fact["confidence"] | WriteFactOptions
): string {
  const db = getDB();
  const normalized = fact.trim().toLowerCase();
  const today = new Date().toISOString().split("T")[0];
  const confidence: Fact["confidence"] =
    typeof options === "string" ? options :
    options?.confidence ?? "stated";
  const contextType = typeof options === "object" ? (options.contextType ?? "historical") : "historical";
  const validUntil  = typeof options === "object" ? (options.validUntil ?? null) : null;
  const importanceScore = typeof options === "object" ? (options.importanceScore ?? 50) : 50;

  // Deduplication — two passes:
  // Pass 1: exact normalized match (fast, covers most cases)
  // Pass 2: key-term overlap — "father-in-law named David" vs "David is father-in-law"
  //   Extract significant words (4+ chars, not stop words) and check if an
  //   existing fact in the same category shares >60% of them.
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

  // Pass 2: fuzzy dedup within same category
  const STOP_WORDS = new Set(["that","this","with","from","have","your","named","about","they","been","were","their","what","which","when","will","said","also","into","over","than","then","some","such","even","most","only","just","like","made","very","after","used","know","does","both","look","more","tell","well","also","come","back","first","give","good","here","hold","last","left","long","make","much","need","open","part","same","seem","show","take","took","went","want","ways","well"]);
  const keyTerms = (s: string) =>
    s.toLowerCase().split(/\W+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));

  const newTerms = keyTerms(fact);
  if (newTerms.length >= 2) {
    const categoryFacts = db.getAllSync<{ id: string; fact: string; use_count: number }>(
      "SELECT id, fact, use_count FROM facts WHERE category = ? LIMIT 50;",
      [category]
    );
    for (const cf of categoryFacts) {
      const existingTerms = keyTerms(cf.fact);
      if (existingTerms.length === 0) continue;
      const overlap = newTerms.filter(t => existingTerms.includes(t)).length;
      const similarity = overlap / Math.max(newTerms.length, existingTerms.length);
      if (similarity >= 0.6) {
        // Close enough — treat as same fact, increment use_count
        db.runSync(
          "UPDATE facts SET use_count = ?, last_used = ? WHERE id = ?;",
          [cf.use_count + 1, new Date().toISOString(), cf.id]
        );
        return cf.id;
      }
    }
  }

  const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  db.runSync(
    `INSERT INTO facts (id, fact, category, confidence, source_date, use_count, context_type, valid_until, importance_score)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?);`,
    [id, fact.trim(), category, confidence, today, contextType, validUntil, importanceScore]
  );
  return id;
}

// ─── TEMPORAL_PATTERNS ───────────────────────────────────────────────────────
//
// Detects time-sensitive facts that should expire automatically.
// "picking someone up today" should not appear in memory tomorrow.
// "steak dinner tonight" is noise after midnight.
// Match → write with 1-day expiry and context_type: active.

const TEMPORAL_PATTERNS = /\b(today|tonight|this evening|this afternoon|this morning|right now|later today|in a bit|shortly|soon|this week|this weekend|tomorrow)\b/i;
const NEAR_TERM_PATTERNS = /\b(this week|this weekend|next few days)\b/i;

const CATEGORY_IMPORTANCE: Record<string, number> = {
  medical: 100, medications: 95, medication: 95,
  relationships: 85, family: 85,
  financial: 70, location: 65,
  professional: 60, schedule: 55,
  preferences: 40, life_events: 35, general: 10,
};

// ─── writeFacts ───────────────────────────────────────────────────────────────
//
// Batch write — called from herald.ts onFacts callback.
// Each item is { category, value } from the backend extraction.
// Auto-detects temporal facts and applies appropriate expiry.

export function writeFacts(
  facts: Array<{ category: string; value: string }>
): void {
  for (const f of facts) {
    if (!f.value?.trim()) continue;

    if (TEMPORAL_PATTERNS.test(f.value)) {
      // "today/tonight/this evening" — expires end of today
      writeFact(f.value, f.category, {
        confidence: "stated",
        contextType: "active",
        validUntil: (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; })(),
        importanceScore: CATEGORY_IMPORTANCE[f.category] ?? 50,
      });
    } else if (NEAR_TERM_PATTERNS.test(f.value)) {
      // "this week/weekend" — expires in 7 days
      const exp = new Date();
      exp.setDate(exp.getDate() + 7);
      writeFact(f.value, f.category, {
        confidence: "stated",
        contextType: "active",
        validUntil: exp.toISOString().split("T")[0],
        importanceScore: CATEGORY_IMPORTANCE[f.category] ?? 50,
      });
    } else {
      // Permanent fact — no expiry, historical by default
      writeFact(f.value, f.category, {
        confidence: "stated",
        contextType: "historical",
        importanceScore: CATEGORY_IMPORTANCE[f.category] ?? 50,
      });
    }

    // Extract contacts from relationship facts
    if (_extractContact && f.category === 'relationships') {
      try { _extractContact(f.value); } catch {}
    }
  }
}

// ─── getFactsByCategory ───────────────────────────────────────────────────────
//
// Returns facts for a category, decay-weighted and expiry-filtered.
// Consistent with getTopFacts() so no code path returns stale facts.

export function getFactsByCategory(category: string, limit = 20): Fact[] {
  const db = getDB();
  try {
    return db.getAllSync<Fact>(
      `SELECT *,
         (COALESCE(use_count, 1) * COALESCE(importance_score, 50))
           / MAX(1.0, julianday('now') - julianday(source_date)) AS decay_score
       FROM facts
       WHERE category = ?
         AND (valid_until IS NULL OR valid_until > date('now'))
       ORDER BY
         CASE WHEN context_type = 'active' THEN 1 ELSE 2 END ASC,
         decay_score DESC
       LIMIT ?;`,
      [category, limit]
    );
  } catch {
    return db.getAllSync<Fact>(
      "SELECT * FROM facts WHERE category = ? AND (valid_until IS NULL OR valid_until > date('now')) ORDER BY use_count DESC, source_date DESC LIMIT ?;",
      [category, limit]
    );
  }
}

// ─── getTopFacts ──────────────────────────────────────────────────────────────
//
// Returns the top N facts across all categories, ordered by use_count DESC.
// Used to build the local context block sent to backend on Tier 2 queries.

export function getTopFacts(limit = 20): Fact[] {
  const db = getDB();
  return db.getAllSync<Fact>(
    `SELECT * FROM facts
     WHERE (valid_until IS NULL OR valid_until > date('now'))
     ORDER BY use_count DESC, source_date DESC LIMIT ?;`,
    [limit]
  );
}

// ─── getFactsSummary ──────────────────────────────────────────────────────────
//
// Returns a plain-text summary of known facts, grouped by category.
// Used by tier1Responses.ts to answer "what do you know about me" queries
// until Phi-3 is available in Session W.

const CATEGORY_PRIORITY: Record<string, number> = {
  medical: 1, medications: 2, medication: 2,
  relationships: 3, family: 3,
  financial: 4, location: 5,
  professional: 6, schedule: 7,
  preferences: 8, life_events: 9, general: 10,
};

export function getFactsSummary(): string {
  const db = getDB();
  const facts = db.getAllSync<Fact>(
    `SELECT * FROM facts
     WHERE (valid_until IS NULL OR valid_until > date('now'))
       AND (context_type IS NULL OR context_type != 'corrected')
     ORDER BY
       COALESCE(importance_score, 50) DESC,
       use_count DESC
     LIMIT 60;`
  );
  if (facts.length === 0) return "";

  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    if (!grouped[f.category]) grouped[f.category] = [];
    if (grouped[f.category].length < 4) grouped[f.category].push(f.fact);
  }

  // Sort categories by priority — medical always first
  const sorted = Object.entries(grouped).sort(([a], [b]) => {
    const pa = CATEGORY_PRIORITY[a] ?? 99;
    const pb = CATEGORY_PRIORITY[b] ?? 99;
    return pa - pb;
  });

  const lines: string[] = [];
  let totalFacts = 0;
  for (const [cat, items] of sorted) {
    if (totalFacts >= 30) break;
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    const slice = items.slice(0, Math.min(4, 30 - totalFacts));
    lines.push(`${label}: ${slice.join("; ")}`);
    totalFacts += slice.length;
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

// ─── correctFact ──────────────────────────────────────────────────────────────
//
// Preferred correction path — marks old fact as corrected and writes the
// replacement. Preserves history so the trust system can learn from errors.
// The corrected fact is excluded from all future reads by context_type filter.

export function correctFact(oldId: string, newFact: string, category: string): string {
  const db = getDB();
  try {
    // Mark old fact as corrected — excluded from reads via context_type
    db.runSync(
      "UPDATE facts SET context_type = 'corrected', last_used = ? WHERE id = ?;",
      [new Date().toISOString(), oldId]
    );
  } catch {
    // V3 columns not available — fall back to hard delete
    db.runSync("DELETE FROM facts WHERE id = ?;", [oldId]);
  }
  // Write the corrected fact as active
  return writeFact(newFact, category, {
    confidence: "confirmed",
    contextType: "active",
  });
}

// ─── deleteFact ───────────────────────────────────────────────────────────────
//
// Hard delete — use only when a fact is completely wrong and worthless.
// Prefer correctFact() to preserve history for trust system learning.

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

// ─── Observations — pre-fact staging ─────────────────────────────────────────
//
// Herald notices something but isn't confident enough to commit to facts yet.
// Observations accumulate; when confidence threshold is met or user confirms,
// they graduate to facts via promoteObservation().

export function writeObservation(
  observation: string,
  category: string,
  sourceMsg?: string,
  confidence = 0.4
): string {
  const db = getDB();

  // Check if this observation already exists — boost confidence instead of duping
  const normalized = observation.trim().toLowerCase();
  const existing = db.getFirstSync<{ id: string; confidence: number }>(
    "SELECT id, confidence FROM observations WHERE LOWER(TRIM(observation)) = ? LIMIT 1;",
    [normalized]
  );

  if (existing) {
    // Confidence boost: repeated observation means Herald is more sure
    const boosted = Math.min(1.0, existing.confidence + 0.15);
    db.runSync(
      "UPDATE observations SET confidence = ? WHERE id = ?;",
      [boosted, existing.id]
    );
    // Auto-promote if confidence crosses threshold
    if (boosted >= 0.75) {
      promoteObservation(existing.id);
    }
    return existing.id;
  }

  const id = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  try {
    db.runSync(
      `INSERT INTO observations (id, observation, category, confidence, source_msg, created_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, observation.trim(), category, confidence, sourceMsg ?? null, now]
    );
  } catch {
    // observations table not yet available (pre-V3) — no-op
  }
  return id;
}

export function promoteObservation(observationId: string): string | null {
  const db = getDB();
  try {
    const obs = db.getFirstSync<{ observation: string; category: string }>(
      "SELECT observation, category FROM observations WHERE id = ?;",
      [observationId]
    );
    if (!obs) return null;

    // Graduate to facts table as inferred fact
    const factId = writeFact(obs.observation, obs.category, {
      confidence: "inferred",
      contextType: "historical",
    });

    // Remove from staging
    db.runSync("DELETE FROM observations WHERE id = ?;", [observationId]);
    return factId;
  } catch {
    return null;
  }
}

export function getPendingObservations(minConfidence = 0.5): Array<{
  id: string; observation: string; category: string; confidence: number;
}> {
  const db = getDB();
  try {
    return db.getAllSync(
      `SELECT id, observation, category, confidence
       FROM observations
       WHERE confidence >= ?
       ORDER BY confidence DESC;`,
      [minConfidence]
    );
  } catch {
    return [];
  }
}

// ─── extractFactsLocally ──────────────────────────────────────────────────────
//
// Pattern-based fact extraction — no LLM, no network, under 5ms.
// Runs BEFORE every network call in sendMessage().
// Writes personal facts to device SQLite immediately.
// Railway extraction is additive — it refines what device already captured.
// Works fully offline.

const LOCAL_PATTERNS: Array<{
  pattern: RegExp;
  category: string;
  extract: (m: RegExpMatchArray) => string;
  importance: number;
}> = [
  // Family relationships
  { pattern: /\bmy (wife|husband|spouse)(?:'s name)? is (\w+)/i,       category: 'relationships', extract: m => `${m[1]}: ${m[2]}`,        importance: 90 },
  { pattern: /\bmy (son|daughter|child)(?:'s name)? is (\w+)/i,        category: 'relationships', extract: m => `${m[1]}: ${m[2]}`,        importance: 90 },
  { pattern: /\bmy (mom|dad|mother|father)(?:'s name)? is (\w+)/i,     category: 'relationships', extract: m => `${m[1]}: ${m[2]}`,        importance: 85 },
  { pattern: /\bmy (brother|sister)(?:'s name)? is (\w+)/i,            category: 'relationships', extract: m => `${m[1]}: ${m[2]}`,        importance: 80 },
  { pattern: /\b(\w+) is my (wife|husband|son|daughter|mom|dad)\b/i,   category: 'relationships', extract: m => `${m[2]}: ${m[1]}`,        importance: 90 },

  // Medical
  { pattern: /\bmy doctor is (Dr\.?\s*\w+(?:\s+\w+)?)/i,              category: 'medical',       extract: m => `doctor: ${m[1]}`,          importance: 95 },
  { pattern: /\bi('m| am) (taking|on) (\w+(?:\s+\w+)?)\b/i,           category: 'medications',   extract: m => `medication: ${m[3]}`,      importance: 95 },
  { pattern: /\bi('m| am) allergic to (\w+(?:\s+\w+)?)\b/i,           category: 'medical',       extract: m => `allergy: ${m[2]}`,         importance: 95 },
  { pattern: /\bdiagnosed with (\w+(?:\s+\w+)?)\b/i,                   category: 'medical',       extract: m => `condition: ${m[1]}`,       importance: 95 },

  // Location
  { pattern: /\bi live in ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,         category: 'location',      extract: m => `lives in: ${m[1]}`,        importance: 85 },
  { pattern: /\bi('m| am) from ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,    category: 'location',      extract: m => `from: ${m[2]}`,            importance: 75 },

  // Work
  { pattern: /\bi work (?:at|for) ([\w\s]+?)(?:\.|,|$)/i,             category: 'work',          extract: m => `employer: ${m[1].trim()}`, importance: 80 },
  { pattern: /\bi('m| am) an? (nurse|doctor|teacher|engineer|manager|director|lawyer|accountant|developer|contractor|consultant|retired|veteran)(?:\b)/i, category: 'work', extract: m => `role: ${m[2].trim()}`, importance: 70 },

  // Preferences
  { pattern: /\bi (love|really like|enjoy) ([\w\s]+?)(?:\.|,|$)/i,    category: 'preferences',   extract: m => `likes: ${m[2].trim()}`,    importance: 60 },
  { pattern: /\bi (hate|don't like|dislike) ([\w\s]+?)(?:\.|,|$)/i,   category: 'preferences',   extract: m => `dislikes: ${m[2].trim()}`, importance: 60 },

  // People
  { pattern: /\b(\w+) is my (friend|colleague|boss|neighbor|pastor|coach)\b/i, category: 'relationships', extract: m => `${m[2]}: ${m[1]}`, importance: 75 },
];

export function extractFactsLocally(userMessage: string): void {
  if (!userMessage || userMessage.trim().length < 5) return;

  for (const { pattern, category, extract, importance } of LOCAL_PATTERNS) {
    const match = userMessage.match(pattern);
    if (!match) continue;
    const value = extract(match).trim();
    if (!value || value.length < 3 || value.length > 120) continue;
    try {
      writeFact(value, category, {
        confidence: 'stated',
        importanceScore: importance,
        contextType: 'active',
      });
    } catch {
      // Silent — never block the message send
    }
  }
}
