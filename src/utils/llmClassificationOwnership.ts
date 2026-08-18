// LAT-ARC-B (2026-08-18): explicit contract answering "has this utterance
// already passed through a real local-LLM classification this turn?" —
// pure, so it can be unit-tested against every RouteDecision kind without a
// ChatScreen harness. Deliberately does NOT infer from routeDecision.kind
// alone: 'backend' is reachable both with and without a prior LLM attempt
// (depends on llmReady at routing time), so kind alone would be a fragile
// signal. 'capture' + source:'llm' is already an unambiguous, pre-existing
// field and needs no new flag.
//
// Consumers: ChatScreen.tsx's two classifyWithLLM call sites (the online
// tier-3 gap attempt, and the offline-gated fallback attempt) — both must
// skip re-classification when this returns true, since the classifier is
// deterministic (temp 0) and a second call on the identical utterance can
// only reproduce the first call's result at pure latency cost.

import type { RouteDecision } from '../routing/routeIntent';

export function alreadyClassifiedByRouteIntent(routeDecision: RouteDecision): boolean {
  if (routeDecision.kind === 'capture' && routeDecision.source === 'llm') return true;
  if (routeDecision.kind === 'backend' && routeDecision.llmAlreadyClassified === true) return true;
  return false;
}

// PRE-B F1 (2026-08-18): positive backend-stream authority only. ChatScreen
// must call this immediately before any askHeraldStream setup — fallthrough
// is never network authority. Does not interpret utterances; enforces the
// RouteDecision kind routeIntent already emitted upstream.
export function mayInvokeBackendStream(routeDecision: RouteDecision): boolean {
  return routeDecision.kind === 'backend';
}
