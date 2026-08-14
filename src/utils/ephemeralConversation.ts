// src/utils/ephemeralConversation.ts
// Herald Conversational Architecture Constitution §2 (pending ratification,
// 2026-08-14 addition): EPHEMERAL CONVERSATION. Generates short-lived
// conversational language when authoritative Herald systems have already
// declined ownership of an utterance. Zero write authority, zero action
// authority, zero personal-recall authority. Output is never a fact and is
// never eligible to silently become one.
//
// This module owns: the conversational prompt contract, bounded context
// formatting, the generation call, and response normalization. It does NOT
// decide whether it is Herald's turn to speak -- that authority gate lives
// entirely in the caller (ChatScreen), per the Constitution's requirement
// that Conversation never competes with deterministic routing.

import type { LlamaContext } from 'llama.rn';
import { isClassifierBusy } from '../hooks/llmLayers';

const EPHEMERAL_SYSTEM_PROMPT = `You are Herald, a warm and knowledgeable personal companion -- a friend, not a professional.
Respond naturally and briefly to what the person says, usually in one or two sentences.
Be interested without being needy -- do not ask a question after every statement. Sometimes simple acknowledgment is enough.
Do not invent facts about the person. Do not claim to remember, save, or have stored anything -- you have no memory authority here.
Do not claim to have performed an action, made a call, sent a message, or changed anything.
Do not diagnose medical conditions, provide financial recommendations, or claim professional (medical, mental-health, financial, legal) authority. If the person asks for that kind of judgment directly, state the limit naturally in one sentence and keep the conversation going -- never end the exchange with a disclaimer alone.`;

export type EphemeralTurn = { user: string; assistant: string };

export type EphemeralResult =
  | { status: 'ok'; text: string }
  | { status: 'unavailable'; reason: 'no-ctx' | 'busy' | 'empty-output' | 'error' };

// Module-scoped, not exported: this module's own single-flight guard,
// separate from and in addition to the classifier's isClassifierBusy().
// Prevents two overlapping ephemeral generations (e.g. a rapid double-tap)
// from racing each other on the same context.
let ephemeralInFlight = false;

/** Pure predicate -- no ctx, no I/O. Callers compute the inputs from their
 *  own already-established routing state; this function only encodes the
 *  authority gate itself, so it can be contract-tested in isolation. */
export function canRunEphemeralConversation(input: {
  rdTier: 1 | 2 | 3;
  hasStructuredCaptures: boolean;
  isPersonalCaptureRisk: boolean;
  hasPending: boolean;
  llmStatus: 'unavailable' | 'loading' | 'ready' | 'error';
  classifierBusy: boolean;
  ephemeralBusy: boolean;
}): boolean {
  if (input.rdTier !== 3) return false;
  if (input.hasStructuredCaptures) return false;
  if (input.isPersonalCaptureRisk) return false;
  if (input.hasPending) return false;
  if (input.llmStatus !== 'ready') return false;
  if (input.classifierBusy) return false;
  if (input.ephemeralBusy) return false;
  return true;
}

/** Production entry point. Caller MUST have already verified
 *  canRunEphemeralConversation() -- this function re-checks busy state
 *  defensively but does not re-derive routing/authority conditions. */
export async function generateEphemeralConversation(
  userText: string,
  ctx: LlamaContext | null,
  priorTurn?: EphemeralTurn,
): Promise<EphemeralResult> {
  if (!ctx) return { status: 'unavailable', reason: 'no-ctx' };
  if (isClassifierBusy() || ephemeralInFlight) return { status: 'unavailable', reason: 'busy' };

  ephemeralInFlight = true;
  try {
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: EPHEMERAL_SYSTEM_PROMPT },
    ];
    if (priorTurn) {
      messages.push({ role: 'user', content: priorTurn.user });
      messages.push({ role: 'assistant', content: priorTurn.assistant });
    }
    messages.push({ role: 'user', content: userText });

    const result = await ctx.completion({
      messages,
      n_predict: 128,
      temperature: 0.6,
      top_p: 0.9,
    });
    const text = result?.text?.trim();
    if (!text) return { status: 'unavailable', reason: 'empty-output' };
    return { status: 'ok', text };
  } catch {
    return { status: 'unavailable', reason: 'error' };
  } finally {
    ephemeralInFlight = false;
  }
}
