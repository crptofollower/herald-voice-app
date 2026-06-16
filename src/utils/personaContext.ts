// src/utils/personaContext.ts
// Personality mirroring system — passive observation writer + persona context builder.
// writeObservation: call once per completed turn from ChatScreen.sendMessage.
// buildPersonaContext: compile persona block for LLM injection at inference time.
// Uses existing factDB.writeObservation for upsert + confidence boost logic.
// Tables: observations, behavior_patterns, facts, local_profile, medications (schema v3+)

import { getDB } from '../db/schema';
import { writeObservation } from '../db/factDB';
import { generateId } from './id';
import type { SQLiteDatabase } from 'expo-sqlite';

export interface ConversationTurn {
  userText: string;
  assistantText: string;
  intentReason?: string;
  timestampMs: number;
  wasCorrection?: boolean;
}

const CORRECTION_RE =
  /\b(no|nope|wrong|not what i meant|that's not|incorrect|you got it wrong)\b/i;

function bucketHour(ms: number): string {
  const h = new Date(ms).getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function avgWordLength(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return words.reduce((n, w) => n + w.length, 0) / words.length;
}

function contractionRate(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  return words.filter((w) => /'/.test(w)).length / words.length;
}

function upsertBehaviorPattern(
  db: SQLiteDatabase,
  pattern: string,
  domain: string,
  confidenceDelta: number,
): void {
  const now = new Date().toISOString();
  try {
    const existing = db.getFirstSync<{ id: string; confidence: number }>(
      `SELECT id, confidence FROM behavior_patterns
       WHERE LOWER(TRIM(pattern)) = LOWER(TRIM(?)) LIMIT 1;`,
      [pattern],
    );
    if (existing) {
      db.runSync(
        `UPDATE behavior_patterns SET confidence = ?, updated_at = ? WHERE id = ?;`,
        [Math.min(1, existing.confidence + confidenceDelta), now, existing.id],
      );
    } else {
      db.runSync(
        `INSERT INTO behavior_patterns (id, pattern, domain, confidence, observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [generateId('bp'), pattern.trim(), domain,
         Math.min(1, 0.4 + confidenceDelta), now, now],
      );
    }
  } catch { /* pre-V3 safety */ }
}

/** Call once per completed turn — fires passively, never blocks UI. */
export function writeTurnObservation(turn: ConversationTurn): void {
  const db = getDB();
  const user = turn.userText.trim();
  if (user.length < 3) return;

  const avgLen = avgWordLength(user);
  const contra = contractionRate(user);
  const wordCount = user.split(/\s+/).filter(Boolean).length;
  const hourBucket = bucketHour(turn.timestampMs);

  // Style signal — vocabulary + contraction rate
  writeObservation(
    `avg_word_len:${avgLen.toFixed(1)};contractions:${contra.toFixed(2)};words:${wordCount}`,
    'style',
    user.slice(0, 200),
    0.35,
  );

  // Schedule habit
  upsertBehaviorPattern(db, `Often talks in the ${hourBucket}`, 'schedule', 0.08);

  // Topic frequency from router reason
  if (turn.intentReason) {
    upsertBehaviorPattern(
      db,
      `Uses ${turn.intentReason.replace(/[:_]/g, ' ')}`,
      'topics',
      0.1,
    );
  }

  // Correction pattern — high confidence signal
  if (turn.wasCorrection || CORRECTION_RE.test(user)) {
    writeObservation(
      'User corrected Herald — prefer confirm-before-write on similar intents',
      'correction',
      user.slice(0, 200),
      0.7,
    );
  }

  // Response length preference
  const assistantWords = turn.assistantText.trim().split(/\s+/).filter(Boolean).length;
  if (assistantWords > 0) {
    const pref = assistantWords < 15 ? 'short' : assistantWords < 40 ? 'medium' : 'long';
    upsertBehaviorPattern(db, `Receives ${pref} responses`, 'preference', 0.05);
  }
}

/** Compile persona block for LLM injection. Sync, never throws. */
export function buildPersonaContext(db: SQLiteDatabase): string {
  const lines: string[] = [];

  try {
    const profileRows = db.getAllSync<{ key: string; value: string }>(
      `SELECT key, value FROM local_profile
       WHERE value IS NOT NULL AND TRIM(value) != '';`,
    );
    const profile = Object.fromEntries(profileRows.map((r) => [r.key, r.value]));
    if (profile.name) lines.push(`User name: ${profile.name}.`);
    if (profile.city) lines.push(`Location: ${profile.city}.`);
    if (profile.persona) lines.push(`Preferred persona tone: ${profile.persona}.`);
  } catch { /* noop */ }

  try {
    const facts = db.getAllSync<{ fact: string }>(
      `SELECT fact FROM facts
       WHERE confidence IN ('stated','confirmed','inferred')
       ORDER BY importance_score DESC, created_at DESC LIMIT 5;`,
    );
    if (facts.length > 0) {
      lines.push(`Known facts: ${facts.map((f) => f.fact).join('; ')}.`);
    }
  } catch { /* noop */ }

  try {
    const meds = db.getAllSync<{ name: string }>(
      `SELECT name FROM medications WHERE is_active = 1
       ORDER BY created_at DESC LIMIT 5;`,
    );
    if (meds.length > 0) {
      lines.push(
        `Active medications (names only — never invent doses): ${meds.map((m) => m.name).join(', ')}.`,
      );
    }
  } catch { /* noop */ }

  try {
    const patterns = db.getAllSync<{ pattern: string }>(
      `SELECT pattern FROM behavior_patterns
       WHERE confidence >= 0.55
       ORDER BY confidence DESC, updated_at DESC LIMIT 3;`,
    );
    if (patterns.length > 0) {
      lines.push(`Observed habits: ${patterns.map((p) => p.pattern).join('; ')}.`);
    }
  } catch { /* noop */ }

  try {
    const styleObs = db.getFirstSync<{ observation: string }>(
      `SELECT observation FROM observations
       WHERE category = 'style'
       ORDER BY created_at DESC LIMIT 1;`,
    );
    if (styleObs?.observation) {
      lines.push(`Recent style signal: ${styleObs.observation}.`);
    }
  } catch { /* noop */ }

  if (lines.length === 0) {
    return 'You are Herald, a warm personal companion. Be concise and honest.';
  }

  return [
    'You are Herald, a warm personal companion with a perfect memory.',
    "Mirror the user's vocabulary lightly. Never invent medical numbers.",
    ...lines,
  ].join(' ');
}
