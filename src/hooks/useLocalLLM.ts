// src/hooks/useLocalLLM.ts
// On-device LLM lifecycle: load, infer, release.
// Load failure is silent: status becomes 'error'; callers treat it as flag-off.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { initLlama, type LlamaContext } from 'llama.rn';
import {
  getActiveModelPath,
  LARGE_MODEL,
} from '../utils/modelManager';
import { LOCAL_LLM_ENABLED } from '../constants/features';
import { warmupClassifier } from './llmLayers';

let warmupDone = false;

export type LocalLLMStatus =
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'error';

const LLAMA_INIT_BASE = {
  n_ctx: 2048,
  n_gpu_layers: 0,
};

function modelKindFromPath(path: string): 'small' | 'large' {
  return path.includes(LARGE_MODEL.filename) ? 'large' : 'small';
}

export function useLocalLLM(): {
  status: LocalLLMStatus;
  activeModel: 'small' | 'large' | null;
  getCtx: () => LlamaContext | null;
} {
  const [status, setStatus] = useState<LocalLLMStatus>('unavailable');
  const [activeModel, setActiveModel] = useState<'small' | 'large' | null>(null);

  const ctxRef = useRef<LlamaContext | null>(null);
  const statusRef = useRef<LocalLLMStatus>('unavailable');
  const activeModelRef = useRef<'small' | 'large' | null>(null);
  const mountedRef = useRef(true);

  const setStatusSafe = useCallback((next: LocalLLMStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    (async () => {
      if (!LOCAL_LLM_ENABLED) {
        // On-device LLM disabled (not a shipped feature; its native init is the
        // top crash suspect on non-Snapdragon devices). Stay 'unavailable' so
        // callers fall through to Railway, and never touch llama.rn.
        if (!cancelled) {
          activeModelRef.current = null;
          setActiveModel(null);
          setStatusSafe('unavailable');
        }
        return;
      }
      try {
        const modelPath = await getActiveModelPath();
        if (!modelPath) {
          if (!cancelled) {
            activeModelRef.current = null;
            setActiveModel(null);
            setStatusSafe('unavailable');
          }
          return;
        }

        const kind = modelKindFromPath(modelPath);
        if (!cancelled) {
          activeModelRef.current = kind;
          setActiveModel(kind);
          setStatusSafe('loading');
        }

        const ctx = await initLlama({
          model: modelPath,
          ...LLAMA_INIT_BASE,
        });

        console.log('[Herald LLM] GPU:', ctx.gpu, 'reason:', ctx.reasonNoGPU);

        if (cancelled) {
          await ctx.release();
          return;
        }

        ctxRef.current = ctx;
        setStatusSafe('ready');
        if (!warmupDone) {
          warmupDone = true;
          void warmupClassifier(ctx);
        }
      } catch (err) {
        console.error('[Herald] useLocalLLM load failed:', err);
        ctxRef.current = null;
        if (!cancelled) {
          activeModelRef.current = null;
          setActiveModel(null);
          setStatusSafe('error');
        }
      }
    })();

    const appStateSubscription = AppState.addEventListener(
      'change',
      async (nextState) => {
        if (nextState !== 'active') return;
        if (statusRef.current !== 'ready') return;

        try {
          const bestPath = await getActiveModelPath();
          if (!bestPath) return;
          const isLarge = bestPath.includes(LARGE_MODEL.filename);
          const currentlyLarge = activeModelRef.current === 'large';
          if (isLarge && !currentlyLarge) {
            console.log('[Herald LLM] Upgrading to large model...');
            statusRef.current = 'loading';
            if (mountedRef.current) setStatus('loading');
            try {
              await ctxRef.current?.release();
              ctxRef.current = null;
              const newCtx = await initLlama({
                model: bestPath,
                ...LLAMA_INIT_BASE,
              });
              console.log('[Herald LLM] GPU:', newCtx.gpu, 'reason:', newCtx.reasonNoGPU);
              ctxRef.current = newCtx;
              activeModelRef.current = 'large';
              if (mountedRef.current) setActiveModel('large');
              statusRef.current = 'ready';
              if (mountedRef.current) setStatus('ready');
              console.log('[Herald LLM] Upgraded to large model');
            } catch (e) {
              console.warn('[Herald LLM] Upgrade failed:', e);
              statusRef.current = 'ready';
              if (mountedRef.current) setStatus('ready');
            }
          }
        } catch (e) {
          console.warn('[Herald LLM] Upgrade check failed:', e);
        }
      },
    );

    return () => {
      appStateSubscription.remove();
      cancelled = true;
      mountedRef.current = false;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      activeModelRef.current = null;
      statusRef.current = 'unavailable';
      if (ctx) {
        void ctx.release().catch((releaseErr) => {
          console.error('[Herald] useLocalLLM release failed:', releaseErr);
        });
      }
    };
  }, [setStatusSafe]);

  const getCtx = useCallback(() => ctxRef.current, []);

  return { status, activeModel, getCtx };
}
