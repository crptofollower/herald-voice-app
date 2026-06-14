// src/db/topicDB.ts
// Herald device SQLite — local topic tracking for briefing personalization.
// Topics are extracted from user messages (no LLM) and surfaced to the backend
// only as comma-separated strings on proactive polls — never persisted server-side.

import { getDB } from "./schema";

const GENERIC_WORDS = new Set([
  "what", "when", "how", "herald", "open", "call", "text", "set", "add", "remind",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
  "by", "from", "as", "is", "was", "are", "were", "be", "been", "being", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "must",
  "shall", "can", "need", "dare", "ought", "used", "that", "this", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "which", "who", "whom", "whose",
  "where", "why", "all", "each", "every", "both", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "about", "also", "into", "over", "after", "before", "between", "through",
  "during", "without", "again", "further", "then", "once", "here", "there", "any", "my", "your",
  "his", "her", "its", "our", "their", "me", "him", "them", "us",
]);

function ensureTable(): void {
  getDB().execSync(`
    CREATE TABLE IF NOT EXISTS local_topics (
      topic TEXT PRIMARY KEY,
      mention_count INTEGER DEFAULT 1,
      last_mentioned TEXT,
      created_at TEXT
    );
  `);
}

function recencyWeight(lastMentioned: string): number {
  const then = new Date(lastMentioned).getTime();
  const days = (Date.now() - then) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 2.0;
  if (days <= 30) return 1.5;
  if (days <= 90) return 1.0;
  return 0.3;
}

export function recordTopicMention(topic: string): void {
  const trimmed = topic.trim();
  if (!trimmed) return;
  if (GENERIC_WORDS.has(trimmed.toLowerCase())) return;

  ensureTable();
  const db = getDB();
  const now = new Date().toISOString();

  const existing = db.getFirstSync<{ mention_count: number }>(
    "SELECT mention_count FROM local_topics WHERE topic = ? LIMIT 1;",
    [trimmed]
  );

  if (existing) {
    db.runSync(
      "UPDATE local_topics SET mention_count = ?, last_mentioned = ? WHERE topic = ?;",
      [existing.mention_count + 1, now, trimmed]
    );
  } else {
    db.runSync(
      "INSERT INTO local_topics (topic, mention_count, last_mentioned, created_at) VALUES (?, 1, ?, ?);",
      [trimmed, now, now]
    );
  }
}

export function getActiveTopics(minMentions = 3): string[] {
  ensureTable();
  const db = getDB();

  try {
    const rows = db.getAllSync<{
      topic: string;
      mention_count: number;
      last_mentioned: string;
    }>(
      "SELECT topic, mention_count, last_mentioned FROM local_topics WHERE mention_count >= ?;",
      [minMentions]
    );

    return rows
      .filter((row) => {
        const weight = recencyWeight(row.last_mentioned);
        if (weight <= 0.3 && row.mention_count < 10) return false;
        return true;
      })
      .map((row) => ({
        topic: row.topic,
        score: row.mention_count * recencyWeight(row.last_mentioned),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => r.topic);
  } catch {
    return [];
  }
}

export function extractTopicsFromMessage(message: string): string[] {
  if (!message?.trim()) return [];

  const topics: string[] = [];
  const seen = new Set<string>();

  const addTopic = (candidate: string, minLen: number) => {
    const cleaned = candidate.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (cleaned.length < minLen) return;
    const lower = cleaned.toLowerCase();
    if (STOP_WORDS.has(lower) || GENERIC_WORDS.has(lower)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    topics.push(cleaned);
  };

  for (const word of message.split(/\s+/)) {
    if (/^[A-Z]{2,5}$/.test(word)) {
      addTopic(word, 2);
      continue;
    }
    if (/^[A-Z][a-zA-Z]{3,}$/.test(word)) {
      addTopic(word, 4);
    }
  }

  return topics.slice(0, 2);
}
