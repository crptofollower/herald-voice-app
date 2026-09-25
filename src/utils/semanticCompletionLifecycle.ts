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
export type SemanticContextId = 'shared-semantic' | 'classifier';
const SHARED_CONTEXT_ID: SemanticContextId = 'shared-semantic';

type ContextRecord = {
  id: SemanticContextId;
  contextState: SemanticContextState;
  activeToken: number | null;
  activeOperation: string | null;
  activeGeneration: number | null;
  callerAbandoned: boolean;
  nativeSettled: boolean;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recoveryHorizonMs: number;
};

function freshRecord(id: SemanticContextId, horizonMs: number): ContextRecord {
  return {
    id,
    contextState: 'READY',
    activeToken: null,
    activeOperation: null,
    activeGeneration: null,
    callerAbandoned: false,
    nativeSettled: true,
    recoveryTimer: null,
    recoveryHorizonMs: horizonMs,
  };
}

const records: Record<SemanticContextId, ContextRecord> = {
  'shared-semantic': freshRecord('shared-semantic', SEMANTIC_NATIVE_RECOVERY_HORIZON_MS),
  classifier: freshRecord('classifier', SEMANTIC_NATIVE_RECOVERY_HORIZON_MS),
};

const breadcrumbs: SemanticCompletionBreadcrumb[] = [];

function note(record: ContextRecord, event: string, extra?: { firedLateMs?: number }): void {
  const crumb: SemanticCompletionBreadcrumb = {
    event,
    operation: record.activeOperation,
    generation: record.activeGeneration,
    contextState: record.contextState,
    ...(extra?.firedLateMs != null ? { firedLateMs: extra.firedLateMs } : {}),
  };
  breadcrumbs.push(crumb);
  latencyLog('SEMANTIC_COMPLETION_LIFECYCLE', {
    lifecycleEvent: crumb.event,
    operation: crumb.operation,
    generation: crumb.generation,
    contextId: record.id,
    contextState: crumb.contextState,
    ...(crumb.firedLateMs != null ? { firedLateMs: crumb.firedLateMs } : {}),
  });
}

export function isSemanticNativeCompletionInFlight(): boolean {
  const record = records[SHARED_CONTEXT_ID];
  return !record.nativeSettled && record.activeToken != null;
}

export function getSemanticContextState(): SemanticContextState {
  return records[SHARED_CONTEXT_ID].contextState;
}

export function getKeyedSemanticContextState(id: SemanticContextId): SemanticContextState {
  return records[id].contextState;
}

export function peekSemanticCompletionBreadcrumbs(): readonly SemanticCompletionBreadcrumb[] {
  return breadcrumbs;
}

export function resetSemanticCompletionLifecycleForTests(opts?: { recoveryHorizonMs?: number }): void {
  const horizon = opts?.recoveryHorizonMs ?? SEMANTIC_NATIVE_RECOVERY_HORIZON_MS;
  for (const id of ['shared-semantic', 'classifier'] as const) {
    const record = records[id];
    if (record.recoveryTimer) clearTimeout(record.recoveryTimer);
    if (record.activeToken != null) releaseSemanticCompletion(record.activeToken);
    records[id] = freshRecord(id, horizon);
  }
  breadcrumbs.length = 0;
  resetSemanticCompletionAdmissionForTests();
}

function releaseIfCurrent(record: ContextRecord, token: number): void {
  if (record.activeToken !== token) return;
  const released = releaseSemanticCompletion(token);
  if (!released) return;
  record.activeToken = null;
  record.nativeSettled = true;
  record.callerAbandoned = false;
  if (record.recoveryTimer) {
    clearTimeout(record.recoveryTimer);
    record.recoveryTimer = null;
  }
  if (record.contextState === 'UNHEALTHY') {
    note(record, 'slot_released_unhealthy');
    record.activeOperation = null;
    record.activeGeneration = null;
    return;
  }
  record.contextState = 'READY';
  note(record, 'context_ready');
  note(record, 'slot_released');
  record.activeOperation = null;
  record.activeGeneration = null;
}

export async function runSharedSemanticCompletion(
  getCtx: (() => SemanticCompletionContext | null) | undefined,
  params: unknown,
  opts?: SemanticCompletionRunOptions,
): Promise<SemanticCompletionRun> {
  return runKeyedSemanticCompletion(SHARED_CONTEXT_ID, getCtx, params, opts);
}

export async function runKeyedSemanticCompletion(
  contextId: SemanticContextId,
  getCtx: (() => SemanticCompletionContext | null) | undefined,
  params: unknown,
  opts?: SemanticCompletionRunOptions,
): Promise<SemanticCompletionRun> {
  const record = records[contextId];
  if (record.contextState === 'DRAINING' || record.contextState === 'UNHEALTHY' || record.contextState === 'OWNED') {
    note(record, record.contextState === 'UNHEALTHY' ? 'rejected_unhealthy' : record.contextState === 'DRAINING' ? 'rejected_draining' : 'rejected_busy');
    return { status: 'unavailable', reason: 'in_flight' };
  }
  note(record, 'semantic_requested');
  if (typeof getCtx !== 'function') return { status: 'unavailable', reason: 'no_ctx' };
  const ctx = getCtx();
  if (!ctx || typeof ctx.completion !== 'function') return { status: 'unavailable', reason: 'no_ctx' };
  if (isLlamaContextBusy() || getSemanticCompletionAdmission()) {
    note(record, 'rejected_busy');
    return { status: 'unavailable', reason: 'busy' };
  }

  const operation = `op-${breadcrumbs.length + 1}`;
  const admitted = tryAdmitSemanticCompletion({ contextId, operation });
  if (!admitted.ok) {
    note(record, 'rejected_busy');
    return { status: 'unavailable', reason: 'busy' };
  }

  record.activeToken = admitted.admission.token;
  record.activeOperation = admitted.admission.operation;
  record.activeGeneration = admitted.admission.generation;
  record.contextState = 'OWNED';
  record.callerAbandoned = false;
  record.nativeSettled = false;
  const token = admitted.admission.token;
  note(record, 'slot_acquired');
  try {
    opts?.onAcquired?.();
  } catch {
    note(record, 'lifecycle_error');
    releaseIfCurrent(record, token);
    return { status: 'unavailable', reason: 'error' };
  }
  const deadlineMs = opts?.callerDeadlineMs;
  const deadlineArmedAt = Date.now();
  if (deadlineMs != null) note(record, 'deadline_armed');

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
      note(record, 'deadline_observed', { firedLateMs });
      if (record.nativeSettled || record.activeToken !== token) return;
      record.callerAbandoned = true;
      record.contextState = 'DRAINING';
      note(record, 'caller_abandoned');
      note(record, 'native_still_in_flight');
      resolveCaller({ status: 'unavailable', reason: 'timeout' });
      if (record.recoveryTimer) clearTimeout(record.recoveryTimer);
      record.recoveryTimer = setTimeout(() => {
        if (record.activeToken === token && !record.nativeSettled) {
          record.contextState = 'UNHEALTHY';
          note(record, 'context_unhealthy');
        }
      }, record.recoveryHorizonMs);
    }, deadlineMs);
  }

  note(record, 'native_invoke_started');
  let nativePromise: Promise<unknown>;
  try {
    nativePromise = Promise.resolve(ctx.completion(params));
  } catch {
    if (timer) clearTimeout(timer);
    releaseIfCurrent(record, token);
    return { status: 'unavailable', reason: 'error' };
  }

  nativePromise.then(
    (value) => {
      if (record.activeToken !== token) return;
      record.nativeSettled = true;
      if (timer) clearTimeout(timer);
      if (record.callerAbandoned) {
        note(record, 'late_native_settlement');
        note(record, 'late_result_discarded');
        releaseIfCurrent(record, token);
        return;
      }
      note(record, 'native_settled');
      resolveCaller({ status: 'ok', value });
      releaseIfCurrent(record, token);
    },
    (e) => {
      if (record.activeToken !== token) return;
      record.nativeSettled = true;
      if (timer) clearTimeout(timer);
      if (record.callerAbandoned) {
        note(record, 'late_native_settlement');
        note(record, 'late_result_discarded');
        releaseIfCurrent(record, token);
        return;
      }
      resolveCaller({
        status: 'unavailable',
        reason: String(e).includes('timeout') ? 'timeout' : 'error',
      });
      releaseIfCurrent(record, token);
    },
  );

  return caller;
}
