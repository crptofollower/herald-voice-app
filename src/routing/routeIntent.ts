// src/routing/routeIntent.ts
// Single routing authority — pure (text, deps) → one RouteDecision.
// No dispatch, speak, React state, or device imports at module load.

import type { IntentRecord } from '../hooks/llmLayers';
import type { TierDecision, LocalContext } from './tierRouter';

type ActionIntent = NonNullable<TierDecision['actionIntent']>;

export type RouteDecision =
  | { kind: 'device_read'; tier: 1; response: string; llmWrap?: boolean; isMedical?: boolean; reason: string }
  | { kind: 'device_action'; tier: 1; actionIntent: ActionIntent; reason: string }
  | { kind: 'capture'; intent: IntentRecord; reason: string }
  | { kind: 'memory_probe'; tier: 2; context: LocalContext; reason: string }
  | { kind: 'backend'; tier: 3; reason: string }
  | { kind: 'needs_clarification'; guess?: string; reason: string };

export async function routeIntent(
  text: string,
  deps: {
    classifyQuery: (msg: string) => Promise<TierDecision>;
    classifyLLM: ((text: string) => Promise<IntentRecord | null>) | null;
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
    if (llmResult) {
      return { kind: 'capture', intent: llmResult, reason: 'llm:capture' };
    }
  }

  return { kind: 'backend', tier: 3, reason: decision.reason };
}
