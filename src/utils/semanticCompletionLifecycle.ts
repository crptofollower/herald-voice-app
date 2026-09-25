// Shared llama.rn 3B semantic completion ownership for callers of
// runSharedSemanticCompletion. This does not yet cover every Herald
// ctx.completion site. A caller deadline abandons the user-turn wait only.
// Native ownership stays until ctx.completion settles. Late results are discarded.

import { log as latencyLog } from './latencyInstrument';
import {
  getSemanticCompletionAdmission,
  isLlamaContextBusy,
  releaseSemanticCompletion,
  tryAdmitSemanticCompletion,
  resetSemanticCompletionAdmissionForTests,
} from './llamaContextExclusive';

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

export type SemanticContextState = 'READY' | 'OWNED' | 'DRAINING' | 'UNHEALTHY';

export type SemanticCompletionBreadcrumb = {
  event: string;
  operation: string | null;
  generation: number | null;
  contextState: SemanticContextState;
  firedLateMs?: number;
};

export const SEMANTIC_NATIVE_RECOVERY_HORIZON_MS = 30_000;
const SHARED_CONTEXT_ID = 'shared-semantic';

let contextState: SemanticContextState = 'READY';
let activeToken: number | null = null;
let activeOperation: string | null = null;
let activeGeneration: number | null = null;
let callerAbandoned = false;
let nativeSettled = true;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryHorizonMs = SEMANTIC_NATIVE_RECOVERY_HORIZON_MS;
const breadcrumbs: SemanticCompletionBreadcrumb[] = [];

function note(event: string, extra?: { firedLateMs?: number }): void {
  const crumb: SemanticCompletionBreadcrumb = {
    event,
    operation: activeOperation,
    generation: activeGeneration,
    contextState,
    ...(extra?.firedLateMs != null ? { firedLateMs: extra.firedLateMs } : {}),
  };
  breadcrumbs.push(crumb);
  latencyLog('SEMANTIC_COMPLETION_LIFECYCLE', {
    lifecycleEvent: crumb.event,
    operation: crumb.operation,
    generation: crumb.generation,
    contextState: crumb.contextState,
    ...(crumb.firedLateMs != null ? { firedLateMs: crumb.firedLateMs } : {}),
  });
}

export function isSemanticNativeCompletionInFlight(): boolean {
  return !nativeSettled && activeToken != null;
}

export function getSemanticContextState(): SemanticContextState {
  return contextState;
}

export function peekSemanticCompletionBreadcrumbs(): readonly SemanticCompletionBreadcrumb[] {
  return breadcrumbs;
}

export function resetSemanticCompletionLifecycleForTests(opts?: { recoveryHorizonMs?: number }): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = null;
  if (activeToken != null) releaseSemanticCompletion(activeToken);
  contextState = 'READY';
  activeToken = null;
  activeOperation = null;
  activeGeneration = null;
  callerAbandoned = false;
  nativeSettled = true;
  recoveryHorizonMs = opts?.recoveryHorizonMs ?? SEMANTIC_NATIVE_RECOVERY_HORIZON_MS;
  breadcrumbs.length = 0;
  resetSemanticCompletionAdmissionForTests();
}

function releaseIfCurrent(token: number): void {
  if (activeToken !== token) return;
  const released = releaseSemanticCompletion(token);
  if (!released) return;
  activeToken = null;
  nativeSettled = true;
  callerAbandoned = false;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (contextState === 'UNHEALTHY') {
    note('slot_released_unhealthy');
    activeOperation = null;
    activeGeneration = null;
    return;
  }
  contextState = 'READY';
  note('context_ready');
  note('slot_released');
  activeOperation = null;
  activeGeneration = null;
}

export async function runSharedSemanticCompletion(
  getCtx: (() => SemanticCompletionContext | null) | undefined,
  params: unknown,
  opts?: SemanticCompletionRunOptions,
): Promise<SemanticCompletionRun> {
  if (contextState === 'DRAINING' || contextState === 'UNHEALTHY' || contextState === 'OWNED') {
    note(contextState === 'UNHEALTHY' ? 'rejected_unhealthy' : contextState === 'DRAINING' ? 'rejected_draining' : 'rejected_busy');
    return { status: 'unavailable', reason: contextState === 'READY' ? 'busy' : 'in_flight' };
  }
  note('semantic_requested');
  if (typeof getCtx !== 'function') return { status: 'unavailable', reason: 'no_ctx' };
  const ctx = getCtx();
  if (!ctx || typeof ctx.completion !== 'function') return { status: 'unavailable', reason: 'no_ctx' };
  if (isLlamaContextBusy() || getSemanticCompletionAdmission()) {
    note('rejected_busy');
    return { status: 'unavailable', reason: 'busy' };
  }

  const operation = `op-${breadcrumbs.length + 1}`;
  const admitted = tryAdmitSemanticCompletion({ contextId: SHARED_CONTEXT_ID, operation });
  if (!admitted.ok) {
    note('rejected_busy');
    return { status: 'unavailable', reason: 'busy' };
  }

  activeToken = admitted.admission.token;
  activeOperation = admitted.admission.operation;
  activeGeneration = admitted.admission.generation;
  contextState = 'OWNED';
  callerAbandoned = false;
  nativeSettled = false;
  const token = admitted.admission.token;
  note('slot_acquired');
  try {
    opts?.onAcquired?.();
  } catch {
    note('lifecycle_error');
    releaseIfCurrent(token);
    return { status: 'unavailable', reason: 'error' };
  }
  const deadlineMs = opts?.callerDeadlineMs;
  const deadlineArmedAt = Date.now();
  if (deadlineMs != null) note('deadline_armed');

  let timer: ReturnType<typeof setTimeout> | null = null;
  let callerSettled = false;
  let resolveCaller: (run: SemanticCompletionRun) => void = () => {};
  const caller = new Promise<SemanticCompletionRun>((resolve) => {
    resolveCaller = (run) => {
      if (callerSettled) return;
      callerSettled = true;
      resolve(run);
    };
  });

  if (deadlineMs != null) {
    timer = setTimeout(() => {
      const deadlineObservedAt = Date.now();
      const firedLateMs = Math.max(0, deadlineObservedAt - (deadlineArmedAt + deadlineMs));
      note('deadline_observed', { firedLateMs });
      if (nativeSettled || activeToken !== token) return;
      callerAbandoned = true;
      contextState = 'DRAINING';
      note('caller_abandoned');
      note('native_still_in_flight');
      resolveCaller({ status: 'unavailable', reason: 'timeout' });
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => {
        if (activeToken === token && !nativeSettled) {
          contextState = 'UNHEALTHY';
          note('context_unhealthy');
        }
      }, recoveryHorizonMs);
    }, deadlineMs);
  }

  note('native_invoke_started');
  let nativePromise: Promise<unknown>;
  try {
    nativePromise = Promise.resolve(ctx.completion(params));
  } catch {
    if (timer) clearTimeout(timer);
    releaseIfCurrent(token);
    return { status: 'unavailable', reason: 'error' };
  }

  nativePromise.then(
    (value) => {
      if (activeToken !== token) return;
      nativeSettled = true;
      if (timer) clearTimeout(timer);
      if (callerAbandoned) {
        note('late_native_settlement');
        note('late_result_discarded');
        releaseIfCurrent(token);
        return;
      }
      note('native_settled');
      resolveCaller({ status: 'ok', value });
      releaseIfCurrent(token);
    },
    (e) => {
      if (activeToken !== token) return;
      nativeSettled = true;
      if (timer) clearTimeout(timer);
      if (callerAbandoned) {
        note('late_native_settlement');
        note('late_result_discarded');
        releaseIfCurrent(token);
        return;
      }
      resolveCaller({
        status: 'unavailable',
        reason: String(e).includes('timeout') ? 'timeout' : 'error',
      });
      releaseIfCurrent(token);
    },
  );

  return caller;
}
