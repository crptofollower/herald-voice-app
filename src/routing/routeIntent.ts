// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';
import { writeServiceProvider } from '../utils/householdCapture';

type ActionIntent = NonNullable<TierDecision['actionIntent']>;

export type RouteDecision =
  | { kind: 'device_read'; tier: 1; response: string; llmWrap?: boolean; isMedical?: boolean; reason: string }
  | { kind: 'device_action'; tier: 1; actionIntent: ActionIntent; reason: string }
  | { kind: 'capture'; intents: IntentRecord[]; source: 'deterministic' | 'llm'; reason: string }
  | { kind: 'memory_probe'; tier: 2; context: LocalContext; reason: string }
  | { kind: 'backend'; tier: 3; reason: string }
  | { kind: 'needs_clarification'; guess?: string; reason: string }
  | { kind: 'passthrough'; reason: string }; // TEMPORARY — deleted when all domains converted

// ─── Routing authority scaffolding (Commit 1) ────────────────────────────────
// CommitResult: the only gate for ACK strings. A string is never spoken for a
// write that was not verified. Added here; wired to domains one commit at a time.

export type CommitResult =
  | { status: 'committed'; ack: string }
  | { status: 'pending';   prompt: string; pendingKey: string }
  | { status: 'noop';      ack: string }
  | { status: 'failed';    ack: string };

export interface DomainWriter {
  add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult>;
  remove(item: string): Promise<CommitResult>;
  clear(): Promise<CommitResult>;
}

// Registry: empty now. One domain added per conversion commit.
export const DOMAIN_WRITERS: Partial<Record<string, DomainWriter>> = {
  service_capture: {
    async add(intent: IntentRecord, rawPhrase: string): Promise<CommitResult> {
      if (intent.type !== 'service_capture') {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      const { category, name, phone } = intent;
      const PLACEHOLDER_NAMES = new Set(['unknown','unnamed','none','n/a','someone',
        'somebody','that','this','it','he','she','they','him','her','them']);
      const isRealName = (v: string) => typeof v === 'string' && v.trim().length >= 2
        && !PLACEHOLDER_NAMES.has(v.trim().toLowerCase());
      if (!category?.trim()) {
        return { status: 'failed', ack: "I couldn't hold onto that — say it once more?" };
      }
      if (!isRealName(name)) {
        const prompt = phone
          ? `Who's your ${category} at ${phone}?`
          : `I didn't catch the name — who's your ${category}?`;
        return { status: 'pending', prompt, pendingKey: 'pendingServiceCapture' };
      }
      const spId = writeServiceProvider(category, name, phone);
      if (!spId) {
        return { status: 'failed', ack: "Hmm — I couldn't hold onto that just now. Mind telling me once more?" };
      }
      const numberPart = phone ? ` — you can reach them at ${phone}` : '';
      return { status: 'committed', ack: `Got it — ${name} is your ${category}${numberPart}.` };
    },
    async remove(item: string): Promise<CommitResult> {
      return { status: 'noop', ack: `Noted.` };
    },
    async clear(): Promise<CommitResult> {
      return { status: 'noop', ack: `Noted.` };
    },
  },
};

// allConverted: returns true when every intent in a capture decision has a
// registered writer. Gates the new dispatch path; false = legacy path runs.
export function allConverted(intents: IntentRecord[]): boolean {
  return intents.every(i => i.type in DOMAIN_WRITERS);
}

// composeAck: builds the spoken ACK from verified CommitResults only.
// v1: one result → its ack. Multiple: join committed/noop acks naturally.
// A pending result surfaces its prompt; never presents pending as committed.
export function composeAck(results: CommitResult[]): string {
  if (results.length === 0) return "I couldn't hold onto that — say it once more?";
  if (results.length === 1) return results[0].status === 'pending'
    ? results[0].prompt
    : results[0].ack;
  const pending = results.find(r => r.status === 'pending');
  if (pending) return pending.prompt;
  return results.map(r => r.status !== 'pending' ? r.ack : '').filter(Boolean).join(' ');
}

// passthrough: temporary variant added to RouteDecision during rollout.
// Unconverted domains return this; legacy islands handle them as today.
// Deleted in the final cleanup commit when DOMAIN_WRITERS is complete.
// ─────────────────────────────────────────────────────────────────────────────

export async function routeIntent(
  text: string,
  deps: {
    classifyQuery: (msg: string) => Promise<TierDecision>;
    classifyLLM: ((text: string) => Promise<IntentRecord[]>) | null;
    llmReady: boolean;
  },
): Promise<RouteDecision> {
  const decision = await deps.classifyQuery(text);

  if (decision.tier === 1 && typeof decision.tier1Response === 'string') {
    return {
      kind: 'device_read',
      tier: 1,
      response: decision.tier1Response,
      llmWrap: decision.llmWrap,
      isMedical: decision.isMedical,
      reason: decision.reason,
    };
  }

  if (decision.tier === 1 && decision.actionIntent) {
    return {
      kind: 'device_action',
      tier: 1,
      actionIntent: decision.actionIntent,
      reason: decision.reason,
    };
  }

  if (decision.tier === 2) {
    return {
      kind: 'memory_probe',
      tier: 2,
      context: decision.localContext ?? { intent: 'memory_probe' },
      reason: decision.reason,
    };
  }

  if (deps.llmReady && deps.classifyLLM) {
    const llmResult = await deps.classifyLLM(text);
    if (llmResult.length > 0) {
      return { kind: 'capture', intents: llmResult, source: 'llm', reason: 'llm:capture' };
    }
  }

  return { kind: 'backend', tier: 3, reason: decision.reason };
}
