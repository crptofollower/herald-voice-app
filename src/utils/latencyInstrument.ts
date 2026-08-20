// src/utils/latencyInstrument.ts
// TEMP — LATENCY / INSTANT-READY device timing instrumentation (additive only).
// Remove when the latency arc closes. No user content in logs.

const PREFIX = '[LATENCY-INSTRUMENT]';

export type CtxCompletionConsumer = 'warmup' | 'classifier' | 'ephemeral';

let appBaselineMs: number | null = null;
let chatScreenMountSeq = 0;
let turnSeq = 0;
let activeTurnId: number | null = null;

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
