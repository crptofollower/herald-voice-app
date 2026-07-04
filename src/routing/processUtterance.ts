import { routeIntent, DOMAIN_WRITERS, composeAck, allConverted } from './routeIntent';
import type { RouteDecision, CommitResult } from './routeIntent';
import type { IntentRecord } from '../hooks/llmLayers';
import { ConversationSession } from './conversationSession';

// D0 commit 2 (S54 addendum): the headless pipeline seam. UI (ChatScreen) calls
// this and renders the result; P-tests call it directly. No React, no UI, no TTS.
// Semantics identical to the pre-extraction ChatScreen blocks, including known
// Hazard E behavior — fixes land in S-CONFIRM, RED P-tests first.

export type RouteDeps = Parameters<typeof routeIntent>[1];

export type UtteranceOutcome =
  | { handled: true; source: 'pending_resume' | 'capture'; responseText: string; commits: CommitResult[] }
  | { handled: false; routeDecision: RouteDecision };

/** The single commit loop: run intents through domain writers, arm the session
 *  if a writer returned pending. Returns the composed ACK and raw results. */
export async function applyIntents(
  intents: IntentRecord[],
  rawText: string,
  session: ConversationSession,
): Promise<{ responseText: string; commits: CommitResult[] }> {
  const results: CommitResult[] = [];
  for (const intent of intents) {
    const writer = DOMAIN_WRITERS[intent.type];
    if (writer) results.push(await writer.add(intent, rawText));
  }
  const responseText = composeAck(results);
  const pending = results.find(r => r.status === 'pending');
  if (pending && pending.status === 'pending') {
    session.setPending({ pendingKey: pending.pendingKey, resume: pending.resume });
  }
  return { responseText, commits: results };
}

export async function processUtterance(
  text: string,
  session: ConversationSession,
  deps: RouteDeps,
): Promise<UtteranceOutcome> {
  // 1) Pending continuation — take-then-clear; noop-without-ack falls through
  //    to normal routing with the slot already cleared (preserved semantics).
  if (session.hasPending()) {
    const { resume } = session.takePending()!;
    const result = await resume(text);
    if (!(result.status === 'noop' && !result.ack)) {
      if (result.status === 'pending') {
        session.setPending({ pendingKey: result.pendingKey, resume: result.resume });
      }
      return { handled: true, source: 'pending_resume', responseText: composeAck([result]), commits: [result] };
    }
  }
  // 2) The single routing authority — called exactly once per utterance.
  const routeDecision = await routeIntent(text, deps);
  // 3) Converted-domain capture → commit loop.
  if (routeDecision.kind === 'capture' && allConverted(routeDecision.intents)) {
    const { responseText, commits } = await applyIntents(routeDecision.intents, text, session);
    return { handled: true, source: 'capture', responseText, commits };
  }
  return { handled: false, routeDecision };
}
