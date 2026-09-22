// Deterministic stub nominator. Proves the closed-label interface.
// Not the probabilistic classifier. Not a phrase library.

import { detectEpisodeCapture } from './episodeCapture';
import type {
  ReminiscenceDisposition,
  ReminiscenceNominationContext,
  ReminiscenceNominator,
} from './reminiscenceDisposition';
import { hasSensitiveRecollectionBackstop } from './reminiscenceAdmission';

const CHILDHOOD =
  /^when i was a kid[, ]+(.+)$/i;

const ABOUT_TWELVE =
  /^about twelve\s*[?.!]*$/i;

const TRANSIENT_TRAFFIC =
  /^traffic was\b/i;

const THIRD_PARTY_BROTHER =
  /\bmy brother's\b/i;

function fold(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC\u0060]/g, "'").trim();
}

export function stubNominateReminiscence(
  text: string,
  ctx: ReminiscenceNominationContext,
): ReminiscenceDisposition {
  const raw = fold(text);
  if (!raw) return 'UNCERTAIN';
  if (detectEpisodeCapture(raw).length > 0) return 'UNCERTAIN';
  if (hasSensitiveRecollectionBackstop(raw)) return 'SENSITIVE';
  if (THIRD_PARTY_BROTHER.test(raw)) return 'THIRD_PARTY';
  if (TRANSIENT_TRAFFIC.test(raw)) return 'TRANSIENT';
  if (CHILDHOOD.test(raw)) return ctx.arcOpen ? 'CONTINUE_ARC' : 'AUTOBIOGRAPHICAL';
  if (ctx.arcOpen && ABOUT_TWELVE.test(raw)) return 'CONTINUE_ARC';
  return 'UNCERTAIN';
}

let nominator: ReminiscenceNominator = stubNominateReminiscence;
let nominationCalls = 0;

export function nominateReminiscence(
  text: string,
  ctx: ReminiscenceNominationContext,
): ReminiscenceDisposition {
  nominationCalls += 1;
  return nominator(text, ctx);
}

export function getReminiscenceNominationCount(): number {
  return nominationCalls;
}

export function setReminiscenceNominator(next: ReminiscenceNominator): void {
  nominator = next;
}

export function resetReminiscenceNominator(): void {
  nominator = stubNominateReminiscence;
  nominationCalls = 0;
}
