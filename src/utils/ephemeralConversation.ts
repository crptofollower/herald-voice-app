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
import { withLlamaContextExclusive } from './llamaContextExclusive';
import { getActiveTurnId, beginCtxCompletion, endCtxCompletion, log as latLog, mono as latMono } from './latencyInstrument';
import { IMPERATIVE_ACTION_RE } from './instructionSignals';
import type { HotRingEntry } from './hotNarrativeRing';

// Conversation Ownership Fence (design review 2026-08-15, three rounds;
// amended same day -- Gap A / Gap B corrections below).
// Distinguishes utterances safe for ephemeral conversation from those that
// implicitly request authoritative truth or an unresolved action. Neither
// check enumerates topics/vocabulary -- both look only at grammatical/
// speech-act shape.
//
// IMPERATIVE_ACTION_RE is defense-in-depth: every case it would catch is
// already claimed upstream by tier-1 action routing (action:call has no
// anchor and matches "call NAME" anywhere in an utterance -- confirmed by
// source trace, see design review; personReference.test.ts extends this
// regression proof). This check only fires if that upstream routing
// somehow misses a case; it never duplicates authority.
//
// OPINION_SEEKING_RE narrows INTERROGATIVE_RE: a question addressed at
// Herald's judgment/reaction ("do you think", "what would you do", "how
// does that sound") is conversational, not fact-seeking. "do you
// remember/know" is deliberately excluded -- that's a factual-recall verb.
const OPINION_SEEKING_RE =
  /\b(do|don'?t)\s+you\s+(think|believe|feel|reckon|suppose)\b|\bwhat\s+would\s+you\s+do\b|\bhow\s+does\s+(?:that|this|it)\s+sound\b|\bcan\s+you\s+believe\b|\bwasn'?t\s+(?:that|it)\b|\bwouldn'?t\s+(?:that|it)\s+be\b/i;

const INTERROGATIVE_RE =
  /\?\s*$|^\s*(who|what|when|where|why|how|do|does|did|is|are|was|were|can|could|would|will|should)\b/i;

// --- 2026-08-15 amendment: Gap A (tell-me framing) and Gap B (embedded
// action clauses). Both were named gaps in the original design review, not
// new authority -- see the session handoff. Neither introduces topic/
// vocabulary knowledge; both stay structural.

// Gap B: IMPERATIVE_ACTION_RE was start-of-utterance-anchored only, so an
// action request hidden after a narrative clause ("Hunter's coming
// Saturday, remind me to call him Friday.") was missed. The fix is not a
// broader verb list -- it's evaluating the existing action check at the
// start of EACH clause, using the narrowest safe clause boundary (comma /
// semicolon only). This still catches nothing that isn't already an
// IMPERATIVE_ACTION_RE match; it only widens WHERE in the utterance that
// match is allowed to start. A bare reference to a past/reported action
// ("Hunter reminded me to call him.") is untouched, because "reminded"
// does not satisfy "remind\s+me" and no clause begins with an action verb.

// Gap A: a "tell me" / "can you tell me" / "please tell me" request is
// fact-seeking-shaped, not conversational-shaped, but was previously
// invisible to both IMPERATIVE_ACTION_RE (doesn't start with a routing
// verb) and INTERROGATIVE_RE (rarely ends in "?"), so it fell through to
// the eligible default. The fix strips the wrapper and classifies only the
// complement -- and fails CLOSED: a complement is eligible only if it
// positively matches a recognized conversational shape. This is
// deliberately the inverse of the rest of the predicate (which defaults
// open) because "tell me X" is structurally a request, and an
// unrecognized request defaults to ineligible, not eligible.
//
// COMPLEMENT_OPINION_RE covers judgment/reaction complements ("what you
// think", "what you would do", "how that sounds"). COMPLEMENT_SOCIAL_RE is
// the one deliberately small, explicitly-enumerated exception this
// mechanism needs ("about yourself/your day", "something funny/
// interesting/nice") -- these are open-ended small-talk requests with no
// factual-question grammar to generalize from. Per session discipline: if
// this list starts needing to grow to cover new failures, that is a signal
// to stop and report back, not to keep appending phrases.
const TELL_ME_WRAPPER_RE =
  /^\s*(please\s+)?(can\s+you\s+)?tell\s+me\b\s*/i;

const COMPLEMENT_OPINION_RE =
  /\bwhat\s+you\s+(think|feel|believe|would\s+do)\b|\bhow\s+(?:that|this|it)\s+sounds?(?:\s+to\s+you)?\b/i;

const COMPLEMENT_SOCIAL_RE =
  /^(about\s+(yourself|your\s+day)|something\s+(funny|interesting|nice))\b/i;

/** Pure predicate -- no I/O. True if this otherwise-unclaimed utterance is
 *  safe to hand to ephemeral conversation.
 *  hasAuthorizedImmediateContext: the one-slot prior pair is populated
 *  (ephemeral success or authorized chit_chat device_read). Default false
 *  preserves the original one-argument fence. */
export function isEligibleForEphemeralConversation(
  text: string,
  hasAuthorizedImmediateContext = false,
): boolean {
  const t = text.trim();

  // Gap B: action-imperative check now runs per clause, not just at the
  // start of the whole utterance. Bounded separators only.
  const clauses = t.split(/[,;]/);
  for (const clause of clauses) {
    if (IMPERATIVE_ACTION_RE.test(clause.trim())) return false;
  }

  // Gap A: tell-me wrapper is evaluated on its own, fail-closed on the
  // complement, before falling through to the general interrogative/
  // opinion check below.
  const tellMeMatch = t.match(TELL_ME_WRAPPER_RE);
  if (tellMeMatch) {
    // Step 4 (2026-08-20): a live authorized context slot is itself an
    // authority-state fact — the immediately preceding turn was a non-personal
    // exchange Herald authored (ephemeral success, or a non-medical chit_chat
    // read; those are the slot's only two writers). "Tell me more" continuing
    // such an exchange is a continuation, not a fact request. With NO slot the
    // enumerated complements remain the only door, so opening-turn behavior is
    // unchanged and the fail-closed default stands.
    if (hasAuthorizedImmediateContext) return true;
    const complement = t.slice(tellMeMatch[0].length).trim();
    return COMPLEMENT_OPINION_RE.test(complement) || COMPLEMENT_SOCIAL_RE.test(complement);
  }

  if (INTERROGATIVE_RE.test(t) && !OPINION_SEEKING_RE.test(t)) {
    // Step 4 (2026-08-20): supersedes 7b-A's verb∧manner conjunction, which
    // could only be extended by growing word lists — the exact move this file
    // forbids. The division is architectural: the LLM handles conversational
    // language; Herald handles authority and boundaries. Authority is already
    // established upstream — reaching here requires reason:'default', meaning
    // every deterministic owner declined, the classifier itself returned
    // unclear/none, it is not live-data, and it is not a personal-memory recall
    // question (routeIntent Site-A fence). Combined with a live authorized
    // slot, that is sufficient; Herald does not additionally need to recognise
    // that "it"/"that"/"more" constitute anaphora.
    // Action and tell-me already returned above. canRunEphemeralConversation
    // (personal-capture, pending, emergency, busy, llmStatus) is unchanged and
    // remains authoritative.
    return hasAuthorizedImmediateContext;
  }
  return true;
}

const EPHEMERAL_SYSTEM_PROMPT = `You are Herald, a warm and knowledgeable personal companion -- a friend, not a professional.
Respond naturally and briefly to what the person says, usually in one or two sentences.
Be interested without being needy -- do not ask a question after every statement. Sometimes simple acknowledgment is enough.
Do not invent facts about the person. Do not claim to remember, save, or have stored anything -- you have no memory authority here.
Do not claim to have performed an action, made a call, sent a message, or changed anything.
Do not diagnose medical conditions, provide financial recommendations, or claim professional (medical, mental-health, financial, legal) authority. If the person asks for that kind of judgment directly, state the limit naturally in one sentence and keep the conversation going -- never end the exchange with a disclaimer alone.`;

export type EphemeralTurn = { user: string; assistant: string };

/** Pure prompt assembly — exported for Structural Test M (payload inspection). */
export function buildEphemeralPromptMessages(
  userText: string,
  hotEntries: HotRingEntry[],
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: EPHEMERAL_SYSTEM_PROMPT },
  ];
  for (const e of hotEntries) {
    messages.push({ role: 'user', content: e.user });
    if (e.assistantHotPolicy === 'include') {
      messages.push({ role: 'assistant', content: e.assistant });
    }
  }
  messages.push({ role: 'user', content: userText });
  return messages;
}

export type EphemeralResult =
  | { status: 'ok'; text: string }
  | { status: 'unavailable'; reason: 'no-ctx' | 'busy' | 'empty-output' | 'error' };

/** Pure predicate -- no ctx, no I/O. Callers compute the inputs from their
 *  own already-established routing state; this function only encodes the
 *  authority gate itself, so it can be contract-tested in isolation.
 *  classifierBusy / ephemeralBusy both mean "shared context exclusive hold"
 *  from the caller's point of view (same isLlamaContextBusy under the hood). */
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
  hotEntries: HotRingEntry[] = [],
): Promise<EphemeralResult> {
  const turnId = getActiveTurnId();
  console.log('[ephemeralConversation] ENTER');
  if (!ctx) {
    latLog('generateEphemeralConversation skipped', { turnId, reason: 'no-ctx' });
    console.log('[ephemeralConversation] UNAVAILABLE_NO_CTX');
    return { status: 'unavailable', reason: 'no-ctx' };
  }

  const gate = await withLlamaContextExclusive('ephemeral', 'try', async () => {
    const ephemeralT0 = latMono();
    latLog('generateEphemeralConversation START', { turnId });
    let completionSeq: number | null = null;
    let completionEnded = false;
    try {
      const messages = buildEphemeralPromptMessages(userText, hotEntries);

      console.log('[ephemeralConversation] COMPLETION_START');
      const t0 = Date.now();
      completionSeq = beginCtxCompletion('ephemeral');
      const completionT0 = latMono();
      const result = await ctx.completion({
        messages,
        n_predict: 128,
        temperature: 0.6,
        top_p: 0.9,
      });
      endCtxCompletion(completionSeq, 'ephemeral', latMono() - completionT0, result);
      completionEnded = true;
      const ms = Date.now() - t0;
      const text = result?.text?.trim();
      if (!text) {
        latLog('generateEphemeralConversation END', {
          turnId,
          durationMs: Math.round((latMono() - ephemeralT0) * 100) / 100,
          outcome: 'empty-output',
        });
        console.log('[ephemeralConversation] UNAVAILABLE_EMPTY_OUTPUT', JSON.stringify({ ms }));
        return { status: 'unavailable' as const, reason: 'empty-output' as const };
      }
      latLog('generateEphemeralConversation END', {
        turnId,
        durationMs: Math.round((latMono() - ephemeralT0) * 100) / 100,
        outcome: 'ok',
        responseLen: text.length,
      });
      console.log('[ephemeralConversation] OK', JSON.stringify({ ms, len: text.length }));
      return { status: 'ok' as const, text };
    } catch (e) {
      if (completionSeq != null && !completionEnded) {
        endCtxCompletion(completionSeq, 'ephemeral', latMono() - ephemeralT0, undefined);
      }
      latLog('generateEphemeralConversation END', {
        turnId,
        durationMs: Math.round((latMono() - ephemeralT0) * 100) / 100,
        outcome: 'error',
      });
      console.log('[ephemeralConversation] ERROR', JSON.stringify({ error: String(e) }));
      return { status: 'unavailable' as const, reason: 'error' as const };
    } finally {
      console.log('[ephemeralConversation] EXIT');
    }
  });

  if (!gate.ok) {
    latLog('generateEphemeralConversation skipped', { turnId, reason: 'busy' });
    console.log('[ephemeralConversation] UNAVAILABLE_BUSY', JSON.stringify({ reason: 'exclusive-busy' }));
    return { status: 'unavailable', reason: 'busy' };
  }
  return gate.value;
}
