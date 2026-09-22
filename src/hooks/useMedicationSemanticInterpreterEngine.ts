// src/hooks/useMedicationSemanticInterpreterEngine.ts
// Independent llama.rn context for the certified Semantic Interpretation V1
// medication interpreter. Bounded production runtime wiring, authorized
// 2026-09-07 (Herald CTO design review — Semantic Interpretation V1 bounded
// runtime wiring, consolidated design).
//
// Mirrors src/dev/useListRemoveInterpretationShadowEngine.ts's lifecycle
// shape exactly (flag-gated useEffect, ref-held context, cancellation-safe
// init, release-on-unmount) — the one existing, already-proven precedent in
// this codebase for "an independent model context owned by its own hook,
// never shared with the classifier context."
//
// CERTIFIED ARTIFACT ONLY. This hook loads LARGE_MODEL
// ('llama-3.2-3b-instruct-q4_k_m.gguf', bartowski/Llama-3.2-3B-Instruct-GGUF
// Q4_K_M) and nothing else. It does not import SMALL_MODEL or
// getActiveModelPath from modelManager.ts — there is no code path by which
// this hook can substitute the uncertified 1B model or "whatever happens to
// be active" for the general classifier.
//
// Provisioning of that certified file is independent of the retired
// classifier download gate. The shared semantic context is initialized when
// any semantic consumer requires it (medication / capability dispatch /
// grocery). If the model is absent and WiFi is unavailable, status remains
// unavailable and this hook waits for permitted WiFi in the same session,
// then provisions and inits. It never falls back to SMALL_MODEL or a second
// context.
//
// Must never share KV/cache with the shared classifier context
// (useLocalLLM), the experimental conversational engine, or the list-remove
// interpretation shadow engine — four independent native resources, four
// independent owners, by design.

import { useCallback, useEffect, useRef, useState } from 'react';
import { initLlama, type LlamaContext } from 'llama.rn';
import {
  GROCERY_SEMANTIC_DECOMPOSITION_ENABLED,
  MEDICATION_SEMANTIC_INTERPRETATION_ENABLED,
  SEMANTIC_CAPABILITY_DISPATCH_ENABLED,
} from '../constants/features';
import { getModelDir, LARGE_MODEL } from '../utils/modelManager';
import { ensureSemanticLargeModel } from '../utils/semanticModelProvisioning';
import { semanticConsumersRequireContext } from '../utils/semanticProvisioningPolicy';

export type MedicationSemanticInterpreterEngineStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export const MEDICATION_INTERPRETER_INIT = {
  n_ctx: 512,
  n_gpu_layers: 0,
} as const;

const SEMANTIC_CONSUMERS = {
  medicationSemanticEnabled: MEDICATION_SEMANTIC_INTERPRETATION_ENABLED,
  capabilityDispatchEnabled: SEMANTIC_CAPABILITY_DISPATCH_ENABLED,
  grocerySemanticEnabled: GROCERY_SEMANTIC_DECOMPOSITION_ENABLED,
};

function logInterpreterEngine(event: string, extra: Record<string, unknown> = {}) {
  console.warn('[medicationSemanticInterpreterEngine] ' + JSON.stringify({ event, ...extra }));
}

export function useMedicationSemanticInterpreterEngine(): {
  status: MedicationSemanticInterpreterEngineStatus;
  getCtx: () => LlamaContext | null;
} {
  const [status, setStatus] = useState<MedicationSemanticInterpreterEngineStatus>('unavailable');
  const ctxRef = useRef<LlamaContext | null>(null);

  const getCtx = useCallback(() => ctxRef.current, []);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    if (!semanticConsumersRequireContext(SEMANTIC_CONSUMERS)) {
      setStatus('unavailable');
      return () => {
        cancelled = true;
        abort.abort();
      };
    }

    (async () => {
      logInterpreterEngine('independent_ctx_init_begin');
      try {
        const ensured = await ensureSemanticLargeModel({
          consumers: SEMANTIC_CONSUMERS,
          signal: abort.signal,
          onAction: (action) => {
            if (cancelled) return;
            if (action === 'wait' || action === 'none') setStatus('unavailable');
            else setStatus('loading');
          },
        });
        if (cancelled || abort.signal.aborted) {
          logInterpreterEngine('independent_ctx_cancelled', { at: 'after_ensure' });
          return;
        }
        if (ensured.status !== 'ready') {
          logInterpreterEngine('independent_ctx_unavailable', { reason: ensured.status });
          if (!cancelled) {
            setStatus(ensured.status === 'error' ? 'error' : 'unavailable');
          }
          return;
        }
        const modelPath = `${getModelDir()}/${LARGE_MODEL.filename}`;
        const ctx = await initLlama({
          model: modelPath,
          ...MEDICATION_INTERPRETER_INIT,
        });
        if (cancelled) {
          logInterpreterEngine('independent_ctx_cancelled', { at: 'after_initLlama' });
          await ctx.release().catch(() => {});
          return;
        }
        ctxRef.current = ctx;
        setStatus('ready');
        logInterpreterEngine('independent_ctx_ready');
      } catch (e) {
        logInterpreterEngine('independent_ctx_init_failed', { error: String(e) });
        ctxRef.current = null;
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.release().catch(() => {});
    };
  }, []);

  return { status, getCtx };
}
