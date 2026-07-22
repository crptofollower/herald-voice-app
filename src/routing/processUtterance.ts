import { routeIntent, DOMAIN_WRITERS, composeAck, allConverted } from './routeIntent';
import type { RouteDecision, CommitResult, ResolveContactFn } from './routeIntent';
import type { IntentRecord } from '../hooks/llmLayers';
import { ConversationSession, CONFIRM_YES_RE, CONFIRM_NO_RE } from './conversationSession';
import { detectEmergency } from './emergencySignals';

// D0 commit 2 (S54 addendum): the headless pipeline seam. UI (ChatScreen) calls
// this and renders the result; P-tests call it directly. No React, no UI, no TTS.
// S-DISCLOSE build arc step 2 (S-CONFIRM absorbed into this arc, per state doc):
// pending resolution now runs through ConversationSession.resolvePending — the
// confirm-primitive (Gap 4). take-then-clear + fallthrough-on-noop is retired;
// a pending state never leaks to fresh routing (Law 2, Spine §3a).
// LLM_LIVE Build C (P5): source-gated confirm — llm-sourced captures arm a
// generic confirm pending before any DOMAIN_WRITER.add; deterministic unchanged.

export type RouteDeps = Parameters<typeof routeIntent>[1];

export type UtteranceOutcome =
  | { handled: true; source: 'pending_resume' | 'capture'; responseText: string; commits: CommitResult[] }
  | { handled: true; source: 'emergency' }
  | { handled: false; routeDecision: RouteDecision };

/** The single commit loop: run intents through domain writers, arm the session
 *  if a writer returned pending. Returns the composed ACK and raw results.
 *  `source` is required — the RouteDecision's capture source for this whole
 *  batch (one decision → one shared source). Callers must pass it explicitly;
 *  there is no default (omitting it used to silently skip the Build C gate). */
export async function applyIntents(
  intents: IntentRecord[],
  rawText: string,
  session: ConversationSession,
  ctx: { resolveContact?: ResolveContactFn } | undefined,
  source: 'deterministic' | 'llm',
): Promise<{ responseText: string; commits: CommitResult[] }> {
  const results: CommitResult[] = [];
  for (const intent of intents) {
    const writer = DOMAIN_WRITERS[intent.type];
    if (!writer) continue;
    if (source === 'llm') {
      // Build C: do not call writer.add until the user confirms.
      results.push({
        status: 'pending',
        prompt: "Say yes and I'll remember that.",
        pendingKey: `llm_confirm:${intent.type}`,
        resume: async (userText: string): Promise<CommitResult> => {
          const trimmed = userText.trim();
          if (CONFIRM_NO_RE.test(trimmed)) {
            return { status: 'noop', ack: "No problem — I won't remember that." };
          }
          if (CONFIRM_YES_RE.test(trimmed)) {
            return writer.add(intent, rawText, ctx);
          }
          return { status: 'noop', ack: '' };
        },
      });
      continue;
    }
    results.push(await writer.add(intent, rawText, ctx));
  }
  const responseText = composeAck(results);
  const pending = results.find(r => r.status === 'pending');
  if (pending && pending.status === 'pending') {
    session.setPending({ pendingKey: pending.pendingKey, resume: pending.resume, kind: pending.kind, reaskPrompt: pending.reaskPrompt });
  }
  return { responseText, commits: results };
}

export async function processUtterance(
  text: string,
  session: ConversationSession,
  deps: RouteDeps,
): Promise<UtteranceOutcome> {
  // 0) Law 0 — emergency preempts everything (Spine §3a). Checked before pending
  //    resolution, before routing, before any classifier. A held pending is
  //    RELEASED, never resumed — no re-ask, no ladder, no ack generated here
  //    (ChatScreen speaks the actual emergency reply). No route decision is
  //    ever computed for an emergency utterance.
  if (detectEmergency(text)) {
    if (session.hasPending()) session.clearPending();
    return { handled: true, source: 'emergency' };
  }
  // 1) Pending continuation — the confirm-primitive (Law 2: a pending state
  //    never leaks). resolvePending owns cancel-escape, the domain resume,
  //    the re-ask ladder, and release — it never falls through to fresh
  //    routing. Every call returns a terminal result for this turn.
  if (session.hasPending()) {
    const result = await session.resolvePending(text);
    return { handled: true, source: 'pending_resume', responseText: composeAck([result]), commits: [result] };
  }
  // 2) The single routing authority — called exactly once per utterance.
  const routeDecision = await routeIntent(text, deps);
  // 3) Converted-domain capture → commit loop.
  if (routeDecision.kind === 'capture' && allConverted(routeDecision.intents)) {
    const { responseText, commits } = await applyIntents(
      routeDecision.intents,
      text,
      session,
      { resolveContact: deps.resolveContact },
      routeDecision.source,
    );
    return { handled: true, source: 'capture', responseText, commits };
  }
  return { handled: false, routeDecision };
}
