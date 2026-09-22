// Slice-1 proof scaffolding behind the closed nominator.
// Childhood shape and sensitive tokens remain proof backstop only.
// Not product language architecture. Not a phrase library.

import { detectEpisodeCapture } from './episodeCapture';

const ADMISSION =
  /^when i was a kid[, ]+(.+)$/i;

const DONT_SAVE =
  /^(?:please\s+)?(?:don't|do not)\s+(?:remember|save)(?:\s+that|\s+what i just said)\s*[?.!]*$/i;

const DONT_KEEP_STORY =
  /^(?:please\s+)?(?:don't|do not)\s+keep\s+this\s+story\s*[?.!]*$/i;

const RECOLLECTION_READ =
  /^what did i say about when i was a kid\s*[?.!]*$/i;

const SENSITIVE_FAIL_CLOSED =
  /\b(?:doctor|dr\.|medication|medications|meds|insulin|cancer|diagnosis|hospital|prescription|pills?|blood pressure|lawyer|attorney|lawsuit|court|bank|mortgage|401k|salary|ssn|social security|password|credit card|rape|sexual|suicide)\b/i;

function fold(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

export function foldReminiscenceText(text: string): string {
  return fold(text);
}

export function hasSensitiveRecollectionBackstop(text: string): boolean {
  return SENSITIVE_FAIL_CLOSED.test(fold(text));
}

export function detectReminiscenceAdmission(text: string): string | null {
  const raw = fold(text);
  if (!raw) return null;
  if (detectEpisodeCapture(raw).length > 0) return null;
  if (hasSensitiveRecollectionBackstop(raw)) return null;
  const m = raw.match(ADMISSION);
  if (!m?.[1]?.trim()) return null;
  return raw;
}

export function detectDontSaveReminiscence(text: string): boolean {
  return DONT_SAVE.test(fold(text));
}

export function detectDontKeepThisStory(text: string): boolean {
  return DONT_KEEP_STORY.test(fold(text));
}

export function detectReminiscenceRecall(text: string): boolean {
  return RECOLLECTION_READ.test(fold(text));
}
