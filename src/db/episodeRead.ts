// Deterministic episode recall. Reads only active episode rows.
// Never mutates. Never interpolates occurred_at. Never ranks by salience.

import { listActiveEpisodes } from './episodesWriter';
import { realizeEpisodePerspective } from '../utils/episodeCapture';

export const EPISODE_RECALL_LIMIT = 3;

export type EpisodeRecallIntent = { kind: 'what_remembered'; rawPhrase: string };

const EPISODE_RECALL =
  /^(?:what\s+did\s+i\s+(?:ask|have|want)\s+you\s+to\s+remember|what\s+did\s+you\s+remember|what\s+have\s+i\s+asked\s+you\s+to\s+remember|what\s+am\s+i\s+having\s+you\s+remember)\s*[.!?]*$/i;

function foldApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

export function detectEpisodeRecall(text: string): EpisodeRecallIntent | null {
  const raw = foldApostrophes(text);
  if (!raw) return null;
  if (!EPISODE_RECALL.test(raw)) return null;
  return { kind: 'what_remembered', rawPhrase: raw };
}

export function answerEpisodeRecall(): string {
  const rows = listActiveEpisodes(EPISODE_RECALL_LIMIT);
  if (rows.length === 0) {
    return "You haven't asked me to remember anything yet.";
  }
  const spoken = rows.map((row) => realizeEpisodePerspective(row.raw_phrase));
  if (spoken.length === 1) {
    return `You asked me to remember that ${spoken[0]}.`;
  }
  return `You've asked me to remember a few things: ${spoken.join('; ')}.`;
}
