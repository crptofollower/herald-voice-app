// Diagnostic only. File presence is not readiness.
// Ready means the existing interpreter holds a context after initLlama.

export type SemanticEngineDiagnostic = {
  schema: 'herald.journey.semantic_engine.v1';
  semanticEngineStatus: 'unavailable' | 'loading' | 'ready' | 'error' | 'unbound';
  provisioningAction: 'none' | 'ready' | 'provision' | 'wait' | null;
  ensureStatus: 'pending' | 'ready' | 'skipped' | 'cancelled' | 'error' | null;
  initLlama: 'not_started' | 'succeeded' | 'failed';
  modelFilePresent: boolean;
  contextHeld: boolean;
};

export type SemanticReadinessGate =
  | 'READY'
  | 'PENDING'
  | 'PROVISIONING_WAITING_FOR_WIFI'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_INIT_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_NOT_READY_TIMEOUT';

export const SEMANTIC_ENGINE_READINESS_TIMEOUT_MS = 25 * 60 * 1000;

export function emptySemanticEngineDiagnostic(): SemanticEngineDiagnostic {
  return {
    schema: 'herald.journey.semantic_engine.v1',
    semanticEngineStatus: 'unbound',
    provisioningAction: null,
    ensureStatus: null,
    initLlama: 'not_started',
    modelFilePresent: false,
    contextHeld: false,
  };
}

export function classifySemanticEngineReadiness(diagnostic: SemanticEngineDiagnostic): SemanticReadinessGate {
  if (
    diagnostic.semanticEngineStatus === 'ready'
    && diagnostic.initLlama === 'succeeded'
    && diagnostic.contextHeld
  ) {
    return 'READY';
  }
  if (diagnostic.provisioningAction === 'wait') return 'PROVISIONING_WAITING_FOR_WIFI';
  if (diagnostic.ensureStatus === 'error') return 'MODEL_DOWNLOAD_FAILED';
  if (diagnostic.initLlama === 'failed' || diagnostic.semanticEngineStatus === 'error') return 'MODEL_INIT_FAILED';
  if (diagnostic.semanticEngineStatus === 'unavailable' && diagnostic.ensureStatus === 'skipped') return 'MODEL_UNAVAILABLE';
  return 'PENDING';
}
