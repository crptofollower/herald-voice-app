// Rung 5 Step 5 — sole episodes mutation authority.
// Episode row only. Never creates entities, edges, evidence, or domain facts.

import { getDB } from './schema';
import { now } from '../utils/heraldClock';

export const EPISODE_SOURCE_USER_UTTERANCE = 'user_utterance';

export const EPISODE_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;
export type EpisodePrecision = (typeof EPISODE_PRECISIONS)[number];

const ACTIVE_PREDICATE = 'removed_at IS NULL';

export type EpisodeWriteInput = {
  rawPhrase: string;
  occurredAt: string | null;
  occurredPrecision: EpisodePrecision;
};

export type EpisodeWriteResult =
  | { ok: true; action: 'inserted' | 'unchanged'; episodeId: string }
  | { ok: false; reason: 'missing_provenance' | 'invalid_precision' | 'not_found' };

export type EpisodeRow = {
  id: string;
  raw_phrase: string;
  occurred_at: string | null;
  occurred_precision: string | null;
  captured_at: string;
  category: string | null;
  domain: string | null;
  salience: number | null;
  sentiment: string | null;
  source: string;
  score: number | null;
  embedding_ref: string | null;
  removed_at: string | null;
};

function nowUtcZ(): string {
  return now().toISOString();
}

function loadEpisode(id: string): EpisodeRow | null {
  const db = getDB();
  return db.getFirstSync<EpisodeRow>(
    `SELECT id, raw_phrase, occurred_at, occurred_precision, captured_at,
            category, domain, salience, sentiment, source, score, embedding_ref, removed_at
     FROM episodes WHERE id = ? LIMIT 1;`,
    [id],
  ) ?? null;
}

function findActiveDuplicate(rawPhrase: string, occurredAt: string | null): EpisodeRow | null {
  const db = getDB();
  if (occurredAt == null) {
    return db.getFirstSync<EpisodeRow>(
      `SELECT id, raw_phrase, occurred_at, occurred_precision, captured_at,
              category, domain, salience, sentiment, source, score, embedding_ref, removed_at
       FROM episodes
       WHERE raw_phrase = ? AND occurred_at IS NULL AND ${ACTIVE_PREDICATE}
       LIMIT 1;`,
      [rawPhrase],
    ) ?? null;
  }
  return db.getFirstSync<EpisodeRow>(
    `SELECT id, raw_phrase, occurred_at, occurred_precision, captured_at,
            category, domain, salience, sentiment, source, score, embedding_ref, removed_at
     FROM episodes
     WHERE raw_phrase = ? AND occurred_at = ? AND ${ACTIVE_PREDICATE}
     LIMIT 1;`,
    [rawPhrase, occurredAt],
  ) ?? null;
}

export function writeEpisode(input: EpisodeWriteInput): EpisodeWriteResult {
  const rawPhrase = (input.rawPhrase ?? '').trim();
  if (!rawPhrase) return { ok: false, reason: 'missing_provenance' };
  if (!EPISODE_PRECISIONS.includes(input.occurredPrecision)) {
    return { ok: false, reason: 'invalid_precision' };
  }
  const occurredAt = input.occurredAt?.trim() || null;
  const existing = findActiveDuplicate(rawPhrase, occurredAt);
  if (existing) return { ok: true, action: 'unchanged', episodeId: existing.id };

  const db = getDB();
  const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.runSync(
    `INSERT INTO episodes
       (id, raw_phrase, occurred_at, occurred_precision, captured_at,
        category, domain, salience, sentiment, source, score, embedding_ref, removed_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'general', NULL, NULL, ?, NULL, NULL, NULL);`,
    [id, rawPhrase, occurredAt, input.occurredPrecision, nowUtcZ(), EPISODE_SOURCE_USER_UTTERANCE],
  );
  const verified = loadEpisode(id);
  if (!verified || verified.removed_at) return { ok: false, reason: 'not_found' };
  return { ok: true, action: 'inserted', episodeId: id };
}

export function softRemoveEpisode(id: string): boolean {
  const edgeId = (id ?? '').trim();
  if (!edgeId) return false;
  const db = getDB();
  const result = db.runSync(
    `UPDATE episodes SET removed_at = ? WHERE id = ? AND removed_at IS NULL;`,
    [nowUtcZ(), edgeId],
  );
  return (result?.changes ?? 0) > 0;
}

export function getEpisodeById(id: string): EpisodeRow | null {
  return loadEpisode(id);
}

export function listActiveEpisodes(limit?: number): EpisodeRow[] {
  const db = getDB();
  const sql =
    `SELECT id, raw_phrase, occurred_at, occurred_precision, captured_at,
            category, domain, salience, sentiment, source, score, embedding_ref, removed_at
     FROM episodes
     WHERE ${ACTIVE_PREDICATE}
     ORDER BY captured_at DESC, id DESC`;
  if (typeof limit === 'number' && limit >= 0) {
    return db.getAllSync<EpisodeRow>(`${sql} LIMIT ?;`, [limit]);
  }
  return db.getAllSync<EpisodeRow>(`${sql};`);
}
