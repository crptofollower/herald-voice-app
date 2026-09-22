// Shared llama.rn 3B semantic completion ownership.
// Caller deadlines may return unavailable; native ownership is held until
// ctx.completion settles. No second completion while unsettled.

import { isLlamaContextBusy } from './llamaContextExclusive';

export type SemanticCompletionUnavailableReason =
  | 'no_ctx'
  | 'in_flight'
  | 'busy'
  | 'timeout'
  | 'error';

export type SemanticCompletionRun =
  | { status: 'ok'; value: unknown }
  | { status: 'unavailable'; reason: SemanticCompletionUnavailableReason };

export type SemanticCompletionContext = {
  completion: (params: unknown) => Promise<unknown> | unknown;
};

export type SemanticCompletionRunOptions = {
  callerDeadlineMs?: number;
  onAcquired?: () => void;
};

let nativeGeneration = 0;
let nativeInFlight = false;

export function isSemanticNativeCompletionInFlight(): boolean {
  return nativeInFlight;
}

export function resetSemanticCompletionLifecycleForTests(): void {
  nativeGeneration += 1;
  nativeInFlight = false;
}

export async function runSharedSemanticCompletion(
  getCtx: (() => SemanticCompletionContext | null) | undefined,
  params: unknown,
  opts?: SemanticCompletionRunOptions,
): Promise<SemanticCompletionRun> {
  if (typeof getCtx !== 'function') {
    return { status: 'unavailable', reason: 'no_ctx' };
  }
  const ctx = getCtx();
  if (!ctx || typeof ctx.completion !== 'function') {
    return { status: 'unavailable', reason: 'no_ctx' };
  }
  if (nativeInFlight) {
    return { status: 'unavailable', reason: 'in_flight' };
  }
  if (isLlamaContextBusy()) {
    return { status: 'unavailable', reason: 'busy' };
  }

  nativeInFlight = true;
  const generation = ++nativeGeneration;
  const release = () => {
    if (nativeGeneration === generation) nativeInFlight = false;
  };

  opts?.onAcquired?.();

  let nativePromise: Promise<unknown>;
  try {
    nativePromise = Promise.resolve(ctx.completion(params)).finally(release);
  } catch {
    release();
    return { status: 'unavailable', reason: 'error' };
  }
  void nativePromise.catch(() => {});

  const deadlineMs = opts?.callerDeadlineMs;
  if (deadlineMs == null) {
    try {
      const value = await nativePromise;
      return { status: 'ok', value };
    } catch {
      return { status: 'unavailable', reason: 'error' };
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), deadlineMs);
  });
  try {
    const value = await Promise.race([nativePromise, timed]);
    if (timer) clearTimeout(timer);
    return { status: 'ok', value };
  } catch (e) {
    if (timer) clearTimeout(timer);
    const reason = String(e).includes('timeout') ? 'timeout' : 'error';
    return { status: 'unavailable', reason };
  }
}
