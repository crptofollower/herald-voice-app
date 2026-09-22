// Narrow explicit episodic memory capture.
// Closed leading memory-request cue + remainder. No LLM. No generic save-all.
// Episode row only — no entities, edges, or evidence.

import type { IntentRecord } from '../hooks/llmLayers';
import type { CommitResult } from '../routing/routeIntent';
import { CONFIRM_NO_RE, CONFIRM_YES_RE } from '../routing/conversationSession';
import { now } from '../utils/heraldClock';
import { MONTHS, parseDatePhrase } from '../utils/parseTime';
import {
  getEpisodeById,
  writeEpisode,
  type EpisodePrecision,
} from '../db/episodesWriter';

const MEMORY_CUE =
  /^(?:remember\s+(?:that|when)|(?:don't|do\s+not)\s+forget\s+that|make\s+a\s+note\s+that|note\s+that)\s+(.+)$/i;

const MONTH_ALT = MONTHS.join('|');
const YEAR_SHAPE = /\b(?:last\s+year|this\s+year|in\s+(?:19|20)\d{2}|(?:19|20)\d{2})\b/i;
const MONTH_WITH_DAY = new RegExp(`\\b(?:${MONTH_ALT})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i');
const BARE_MONTH = new RegExp(`\\b(?:in\\s+)?(?:${MONTH_ALT})\\b`, 'i');
const WEEKDAY_SHAPE =
  /\b(?:next|this|last|on)?\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(?:today|tomorrow)\b/i;

function foldApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

function stripTrailingPunct(text: string): string {
  return text.replace(/[.!?\s]+$/g, '').trim();
}

function derivePrecision(clause: string, occurredAt: string | null): EpisodePrecision {
  if (YEAR_SHAPE.test(clause) && !WEEKDAY_SHAPE.test(clause) && !MONTH_WITH_DAY.test(clause)) {
    return 'year';
  }
  if (BARE_MONTH.test(clause) && !MONTH_WITH_DAY.test(clause) && !WEEKDAY_SHAPE.test(clause)) {
    return 'month';
  }
  if (occurredAt) return 'day';
  return 'unknown';
}

function confirmClause(remainder: string): string {
  const clause = stripTrailingPunct(remainder);
  if (/^we\b/i.test(clause)) return clause.replace(/^we\b/i, 'you');
  if (/^i\b/i.test(clause)) return clause.replace(/^i\b/i, 'you');
  return clause;
}

export function detectEpisodeCapture(text: string): IntentRecord[] {
  const raw = foldApostrophes(text);
  if (!raw) return [];
  const m = raw.match(MEMORY_CUE);
  if (!m) return [];
  const remainder = stripTrailingPunct(m[1] ?? '');
  if (!remainder) return [];
  return [{
    type: 'episode_capture',
    rawPhrase: remainder,
    raw,
  }];
}

export async function addEpisodeCapture(
  intent: IntentRecord,
  rawPhrase: string,
): Promise<CommitResult> {
  if (intent.type !== 'episode_capture') {
    return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
  }
  const remainder = (intent.rawPhrase || '').trim();
  const raw = (intent.raw || rawPhrase).trim();
  if (!remainder || !raw) {
    return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
  }
  const prompt = `Want me to remember that ${confirmClause(remainder)}?`;
  return {
    status: 'pending',
    prompt,
    pendingKey: 'episode_capture',
    kind: 'standard',
    resume: async (userText: string): Promise<CommitResult> => {
      const t = userText.trim();
      if (CONFIRM_NO_RE.test(t)) {
        return { status: 'noop', ack: "No problem — I won't remember that." };
      }
      if (!CONFIRM_YES_RE.test(t)) {
        return { status: 'noop', ack: '' };
      }
      try {
        const occurredAt = parseDatePhrase(remainder, now());
        const occurredPrecision = derivePrecision(remainder, occurredAt);
        const written = writeEpisode({
          rawPhrase: remainder,
          occurredAt,
          occurredPrecision,
        });
        if (!written.ok) {
          return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
        }
        const verified = getEpisodeById(written.episodeId);
        if (!verified || verified.removed_at) {
          return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
        }
        return { status: 'committed', ack: "I'll remember that." };
      } catch {
        return { status: 'failed', ack: "I had trouble holding onto that — say it once more?" };
      }
    },
  };
}
