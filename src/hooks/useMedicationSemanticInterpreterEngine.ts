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
// be active" for the general classifier. If LARGE_MODEL is not yet
// downloaded on this device (a real, ordinary, indefinite-duration state —
// see modelDownloadService.ts's WiFi-gated background phase 2), this hook
// stays 'unavailable' permanently for the session. It never falls back.
//
// Must never share KV/cache with the shared classifier context
// (useLocalLLM), the experimental conversational engine, or the list-remove
// interpretation shadow engine — four independent native resources, four
// independent owners, by design.

import { useCallback, useEffect, useRef, useState } from 'react';
import { initLlama, type LlamaContext } from 'llama.rn';
import { MEDICATION_SEMANTIC_INTERPRETATION_ENABLED } from '../constants/features';
import { getModelDir, isModelDownloaded, LARGE_MODEL } from '../utils/modelManager';

export type MedicationSemanticInterpreterEngineStatus = 'unavailable' | 'loading' | 'ready' | 'error';

const MEDICATION_INTERPRETER_INIT = {
  n_ctx: 512,
  n_gpu_layers: 0,
} as const;

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
    if (!MEDICATION_SEMANTIC_INTERPRETATION_ENABLED) {
      setStatus('unavailable');
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      setStatus('loading');
      logInterpreterEngine('independent_ctx_init_begin');
      try {
        const downloaded = await isModelDownloaded(LARGE_MODEL.filename);
        if (!downloaded) {
          // Certified artifact absent on this device. Never substitute
          // SMALL_MODEL or resolve via getActiveModelPath() — those may
          // silently select the uncertified 1B model. Stay unavailable.
          logInterpreterEngine('independent_ctx_unavailable', { reason: 'certified_model_absent' });
          if (!cancelled) setStatus('unavailable');
          return;
        }
        if (cancelled) {
          logInterpreterEngine('independent_ctx_cancelled', { at: 'after_presence_check' });
          return;
        }
        // getModelDir() already strips its own trailing slash (modelManager.ts's
        // internal joinPath does this for every path it returns); a single
        // '/' + filename join here is exactly equivalent to modelManager's own
        // joinPath(getModelDir(), filename) for this one-segment case.
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
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.release().catch(() => {});
    };
  }, []);

  return { status, getCtx };
}
