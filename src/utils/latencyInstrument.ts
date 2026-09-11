// src/utils/latencyInstrument.ts
// TEMP — LATENCY / INSTANT-READY device timing instrumentation (additive only).
// Remove when the latency arc closes. No user content in logs.

const PREFIX = '[LATENCY-INSTRUMENT]';

export type CtxCompletionConsumer = 'warmup' | 'classifier' | 'ephemeral';

let appBaselineMs: number | null = null;
let chatScreenMountSeq = 0;
let turnSeq = 0;
let activeTurnId: number | null = null;
/** True after a semantic 3B completion this turn until REALIZATION_DONE. */
let semanticTurnPendingRealization = false;

/** Monotonic seq for Herald-owned ctx.completion() calls (in-memory only). */
let ctxCompletionSeq = 0;
let lastCompletionSeq: number | null = null;
let lastConsumer: CtxCompletionConsumer | null = null;
let lastCompletionEndMonoMs: number | null = null;

function monoNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function initAppLatencyBaseline(): void {
  if (appBaselineMs !== null) return;
  appBaselineMs = monoNow();
  log('APP baseline initialized', { baselineMonoMs: appBaselineMs, wallTs: Date.now() });
}

export function elapsedFromAppBaseline(): number | null {
  if (appBaselineMs === null) return null;
  return monoNow() - appBaselineMs;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = {
    event,
    monoMs: monoNow(),
    wallTs: Date.now(),
    ...fields,
  };
  const elapsed = elapsedFromAppBaseline();
  if (elapsed !== null) payload.elapsedFromAppMs = Math.round(elapsed * 100) / 100;
  console.log(`${PREFIX} ${JSON.stringify(payload)}`);
}

export function beginChatScreenMount(): number {
  chatScreenMountSeq += 1;
  return chatScreenMountSeq;
}

export function getChatScreenMountSeq(): number {
  return chatScreenMountSeq;
}

export function beginTurn(): number {
  turnSeq += 1;
  activeTurnId = turnSeq;
  semanticTurnPendingRealization = false;
  return turnSeq;
}

export function getActiveTurnId(): number | null {
  return activeTurnId;
}

export function clearActiveTurn(): void {
  activeTurnId = null;
}

/** Prior completed ctx.completion metadata (numbers/tags only; in-memory). */
export function getPrevCtxCompletionMeta(): {
  prevCompletionSeq: number | null;
  prevConsumer: CtxCompletionConsumer | null;
  msSincePrevCompletionEnd: number | null;
} {
  return {
    prevCompletionSeq: lastCompletionSeq,
    prevConsumer: lastConsumer,
    msSincePrevCompletionEnd:
      lastCompletionEndMonoMs != null
        ? Math.round((monoNow() - lastCompletionEndMonoMs) * 100) / 100
        : null,
  };
}

/**
 * Claim the next completion sequence and log START.
 * Does not mutate "last completed" state — that updates only on endCtxCompletion.
 */
export function beginCtxCompletion(consumer: CtxCompletionConsumer): number {
  ctxCompletionSeq += 1;
  const completionSeq = ctxCompletionSeq;
  try {
    log('ctx.completion START', {
      completionSeq,
      consumer,
      ...getPrevCtxCompletionMeta(),
    });
  } catch {
    // instrumentation must never alter completion behavior
  }
  return completionSeq;
}

/**
 * Extract only numeric timing/cache fields from a llama.rn completion result.
 * Defensive: missing/malformed metadata yields an empty object.
 */
export function extractCompletionTimingFields(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    const r = result as {
      timings?: {
        prompt_ms?: unknown;
        predicted_ms?: unknown;
        cache_n?: unknown;
        prompt_n?: unknown;
      };
      tokens_cached?: unknown;
      tokens_evaluated?: unknown;
      tokens_predicted?: unknown;
    } | null | undefined;
    const t = r?.timings;
    if (typeof t?.prompt_ms === 'number') out.prompt_ms = t.prompt_ms;
    if (typeof t?.predicted_ms === 'number') out.predicted_ms = t.predicted_ms;
    if (typeof t?.cache_n === 'number') out.cache_n = t.cache_n;
    if (typeof t?.prompt_n === 'number') out.prompt_n = t.prompt_n;
    if (typeof r?.tokens_cached === 'number') out.tokens_cached = r.tokens_cached;
    if (typeof r?.tokens_evaluated === 'number') out.tokens_evaluated = r.tokens_evaluated;
    if (typeof r?.tokens_predicted === 'number') out.tokens_predicted = r.tokens_predicted;
  } catch {
    // leave out empty
  }
  return out;
}

/** Log END + update in-memory last-completion cursor. Never throws to callers. */
export function endCtxCompletion(
  completionSeq: number,
  consumer: CtxCompletionConsumer,
  durationMs: number,
  result?: unknown,
): void {
  try {
    const timingFields = extractCompletionTimingFields(result);
    log('ctx.completion END', {
      completionSeq,
      consumer,
      durationMs: Math.round(durationMs * 100) / 100,
      ...timingFields,
    });
    lastCompletionSeq = completionSeq;
    lastConsumer = consumer;
    lastCompletionEndMonoMs = monoNow();
  } catch {
    // instrumentation must never alter completion behavior
  }
}

/** Classify model path without logging full filesystem paths. */
export function classifyModelPathKind(path: string): 'small' | 'large' | 'unknown' {
  if (/3b|3B/.test(path)) return 'large';
  if (/1b|1B/.test(path)) return 'small';
  return 'unknown';
}

export function mono(): number {
  return monoNow();
}

function markSemanticTurnPendingRealization(): void {
  semanticTurnPendingRealization = true;
}

function safeSemanticLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    log(event, { turnId: getActiveTurnId(), ...fields });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logSemanticDispatchEligibility(fields: {
  eligible: boolean;
  reason: string;
  tier: number;
  routeReason: string;
}): void {
  markSemanticTurnPendingRealization();
  safeSemanticLog('SEMANTIC_DISPATCH_ELIGIBILITY', fields);
}

export function logSemanticDispatchInferenceStart(): void {
  markSemanticTurnPendingRealization();
  safeSemanticLog('SEMANTIC_DISPATCH_INFERENCE_START');
}

export function logSemanticDispatchInferenceEnd(
  durationMs: number,
  result: unknown,
  outcome: 'ok' | 'parse_fail' | 'error',
): void {
  safeSemanticLog('SEMANTIC_DISPATCH_INFERENCE_END', {
    durationMs: Math.round(durationMs * 100) / 100,
    outcome,
    ...extractCompletionTimingFields(result),
  });
}

export type SemanticSpecialistName = 'todo' | 'grocery' | 'medication';
export type SemanticSpecialistOutcome = 'ok' | 'parse_fail' | 'timeout' | 'error';

export function logSemanticSpecialistInferenceStart(specialist: SemanticSpecialistName): void {
  markSemanticTurnPendingRealization();
  safeSemanticLog('SEMANTIC_SPECIALIST_INFERENCE_START', { specialist });
}

/** Leftover serial medication probe was not eligible (non-default owner). No utterance text. */
export function logSemanticMedicationSerialSkip(fields: {
  reason: 'non_default_route';
  tier: number;
  routeReason: string;
}): void {
  safeSemanticLog('SEMANTIC_MEDICATION_SERIAL_SKIP', {
    specialist: 'medication',
    ...fields,
  });
}

export function logSemanticSpecialistInferenceEnd(
  specialist: SemanticSpecialistName,
  durationMs: number,
  result: unknown,
  outcome: SemanticSpecialistOutcome,
): void {
  safeSemanticLog('SEMANTIC_SPECIALIST_INFERENCE_END', {
    specialist,
    durationMs: Math.round(durationMs * 100) / 100,
    outcome,
    ...extractCompletionTimingFields(result),
  });
}

export function logSemanticGroundingDone(fields: Record<string, unknown>): void {
  safeSemanticLog('SEMANTIC_GROUNDING_DONE', fields);
}

export function logSemanticAdmissionDone(fields: Record<string, unknown>): void {
  safeSemanticLog('SEMANTIC_ADMISSION_DONE', fields);
}

export function boundDiagnosticStrings(values: string[], maxItems = 8, maxChars = 80): string[] {
  return values.slice(0, maxItems).map((v) => (v.length > maxChars ? v.slice(0, maxChars) : v));
}

export type SemanticWriteLiftSpecialist = 'todo' | 'grocery' | 'medication';
export type SemanticWriteLiftReason =
  | 'ok'
  | 'wrong_capability'
  | 'missing_write'
  | 'missing_op'
  | 'wrong_family_op'
  | 'missing_candidates'
  | 'empty_candidates'
  | 'missing_mentions'
  | 'empty_mentions'
  | 'missing_predicate'
  | 'missing_focus'
  | 'missing_score'
  | 'malformed_payload';

export function logSemanticWriteLift(fields: {
  specialist: SemanticWriteLiftSpecialist;
  selectedCapability: string;
  outcome: 'ok' | 'fail';
  reason: SemanticWriteLiftReason;
}): void {
  safeSemanticLog('SEMANTIC_WRITE_LIFT', fields);
  try {
    console.warn(`[HERALD_SEMANTIC_WRITE_LIFT_DIAG] ${JSON.stringify(fields)}`);
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logSemanticRecapInferenceStart(): void {
  safeSemanticLog('SEMANTIC_RECAP_INFERENCE_START', { model: 'semantic-3b' });
}

export function logSemanticRecapInferenceEnd(
  durationMs: number,
  result: unknown,
  outcome: 'ok' | 'parse_fail' | 'error',
): void {
  safeSemanticLog('SEMANTIC_RECAP_INFERENCE_END', {
    durationMs: Math.round(durationMs * 100) / 100,
    outcome,
    model: 'semantic-3b',
    ...extractCompletionTimingFields(result),
  });
}

export function logActiveSubjectInferenceStart(): void {
  safeSemanticLog('ACTIVE_SUBJECT_INFERENCE_START', { model: 'semantic-3b' });
}

export function logActiveSubjectInferenceEnd(
  durationMs: number,
  result: unknown,
  outcome: 'ok' | 'parse_fail' | 'error',
): void {
  safeSemanticLog('ACTIVE_SUBJECT_INFERENCE_END', {
    durationMs: Math.round(durationMs * 100) / 100,
    outcome,
    model: 'semantic-3b',
    ...extractCompletionTimingFields(result),
  });
}

/** Idle experimental Qwen conversation prefill. No turn id, no user text. */
export function logQwenWarmupStart(): void {
  try {
    log('QWEN_WARMUP_START', { model: 'experimental-qwen' });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logQwenWarmupEnd(
  durationMs: number,
  result: unknown,
  outcome: 'ok' | 'error',
): void {
  try {
    log('QWEN_WARMUP_END', {
      durationMs: Math.round(durationMs * 100) / 100,
      outcome,
      model: 'experimental-qwen',
      ...extractCompletionTimingFields(result),
    });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logQwenRuntimeInitDiag(fields: Record<string, unknown>): void {
  try {
    log('QWEN_RUNTIME_INIT_DIAG', { model: 'experimental-qwen', ...fields });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logQwenRuntimeBenchBaseline(fields: Record<string, unknown>): void {
  try {
    log('QWEN_RUNTIME_BENCH_BASELINE', { model: 'experimental-qwen', ...fields });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logQwenRuntimeThreadProbeOmitted(fields: Record<string, unknown>): void {
  try {
    log('QWEN_RUNTIME_THREAD_PROBE_OMITTED', { model: 'experimental-qwen', ...fields });
  } catch {
    // instrumentation must never alter completion behavior
  }
}

export function logConversationInferenceStart(worker: string): void {
  safeSemanticLog('CONVERSATION_INFERENCE_START', { worker, model: worker });
}

export function logConversationInferenceEnd(
  durationMs: number,
  result: unknown,
  outcome: 'ok' | 'unavailable' | 'error',
  worker: string,
): void {
  safeSemanticLog('CONVERSATION_INFERENCE_END', {
    durationMs: Math.round(durationMs * 100) / 100,
    outcome,
    worker,
    model: worker,
    ...extractCompletionTimingFields(result),
  });
}

/** Immediately before speak/dispatchRead on a turn that ran semantic 3B. */
export function logRealizationDoneIfSemanticTurn(): void {
  if (!semanticTurnPendingRealization) return;
  semanticTurnPendingRealization = false;
  safeSemanticLog('REALIZATION_DONE');
}
