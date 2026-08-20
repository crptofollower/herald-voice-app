// src/hooks/useLocalLLM.ts
// On-device LLM lifecycle: load, warm, ready, release.
// llmStatus becomes 'ready' when warmupClassifier completion succeeds
// (onWarmupSucceeded), not when optional canonical snapshot I/O finishes.
// Snapshot capture nests under the same exclusive hold as warmup.
// ctx.release always runs under context-release exclusivity.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { initLlama, type LlamaContext } from 'llama.rn';
import {
  getActiveModelPath,
  LARGE_MODEL,
} from '../utils/modelManager';
import { LOCAL_LLM_ENABLED } from '../constants/features';
import { warmupClassifier } from './llmLayers';
import {
  classifyModelPathKind,
  log as latLog,
  mono as latMono,
} from '../utils/latencyInstrument';
import {
  deleteCanonicalClassifierSessionFile,
  type CanonicalSessionModelIdentity,
} from '../utils/canonicalClassifierSession';
import { runExclusiveContextRelease } from '../utils/llamaContextExclusive';

// Keyed on context identity, not a once-per-process boolean: every context
// (initial load AND large-model upgrade) needs its own cold prefill warmed.
let warmedCtx: LlamaContext | null = null;

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

/** Null getCtx first (caller), then wait for owners and release exactly once. */
async function disposeLlamaContext(
  ctx: LlamaContext,
  reason: string,
): Promise<void> {
  if (warmedCtx === ctx) warmedCtx = null;
  await deleteCanonicalClassifierSessionFile().catch(() => {});
  latLog('context RELEASE', { reason });
  await runExclusiveContextRelease(async () => {
    await ctx.release();
  });
}

export function useLocalLLM(): {
  status: LocalLLMStatus;
  activeModel: 'small' | 'large' | null;
  getCtx: () => LlamaContext | null;
  getModelIdentity: () => CanonicalSessionModelIdentity | null;
} {
  const [status, setStatus] = useState<LocalLLMStatus>('unavailable');
  const [activeModel, setActiveModel] = useState<'small' | 'large' | null>(null);

  const ctxRef = useRef<LlamaContext | null>(null);
  const modelPathRef = useRef<string | null>(null);
  const statusRef = useRef<LocalLLMStatus>('unavailable');
  const activeModelRef = useRef<'small' | 'large' | null>(null);
  const mountedRef = useRef(true);

  const setStatusSafe = useCallback((next: LocalLLMStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  const getModelIdentity = useCallback((): CanonicalSessionModelIdentity | null => {
    const path = modelPathRef.current;
    const kind = activeModelRef.current;
    if (!path || !kind) return null;
    return { modelKind: kind, modelPath: path };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    latLog('useLocalLLM hook effect ENTRY');

    const warmThenReady = async (
      ctx: LlamaContext,
      identity: CanonicalSessionModelIdentity,
      pathLabel?: string,
    ): Promise<boolean> => {
      if (warmedCtx === ctx) {
        latLog('llmStatus ready', { modelKind: identity.modelKind, path: pathLabel, skippedWarmup: true });
        setStatusSafe('ready');
        return true;
      }
      warmedCtx = ctx;
      const warmupT0 = latMono();
      latLog('warmupClassifier START', pathLabel ? { path: pathLabel } : {});
      let readySignaled = false;
      try {
        await warmupClassifier(ctx, identity, {
          onWarmupSucceeded: () => {
            readySignaled = true;
            if (cancelled) return;
            latLog('llmStatus ready', {
              modelKind: identity.modelKind,
              ...(pathLabel ? { path: pathLabel } : {}),
            });
            setStatusSafe('ready');
          },
        });
        latLog('warmupClassifier END', {
          durationMs: Math.round((latMono() - warmupT0) * 100) / 100,
          outcome: 'completed',
          ...(pathLabel ? { path: pathLabel } : {}),
        });
      } catch (e) {
        latLog('warmupClassifier END', {
          durationMs: Math.round((latMono() - warmupT0) * 100) / 100,
          outcome: 'error',
          ...(pathLabel ? { path: pathLabel } : {}),
          errorName: e instanceof Error ? e.name : 'unknown',
        });
        console.error('[Herald] warmupClassifier failed:', e);
        return false;
      }
      return readySignaled;
    };

    (async () => {
      if (!LOCAL_LLM_ENABLED) {
        // On-device LLM disabled (not a shipped feature; its native init is the
        // top crash suspect on non-Snapdragon devices). Stay 'unavailable' so
        // callers fall through to Railway, and never touch llama.rn.
        if (!cancelled) {
          activeModelRef.current = null;
          modelPathRef.current = null;
          setActiveModel(null);
          setStatusSafe('unavailable');
        }
        return;
      }
      try {
        const lookupT0 = latMono();
        latLog('active-model lookup START');
        const modelPath = await getActiveModelPath();
        latLog('active-model lookup END', {
          durationMs: Math.round((latMono() - lookupT0) * 100) / 100,
          found: !!modelPath,
          modelKind: modelPath ? classifyModelPathKind(modelPath) : null,
        });
        if (!modelPath) {
          if (!cancelled) {
            activeModelRef.current = null;
            modelPathRef.current = null;
            setActiveModel(null);
            setStatusSafe('unavailable');
          }
          return;
        }

        const kind = modelKindFromPath(modelPath);
        if (!cancelled) {
          activeModelRef.current = kind;
          modelPathRef.current = modelPath;
          setActiveModel(kind);
          setStatusSafe('loading');
        }

        const initT0 = latMono();
        latLog('initLlama START', { modelKind: kind });
        const ctx = await initLlama({
          model: modelPath,
          ...LLAMA_INIT_BASE,
        });
        latLog('initLlama END', {
          durationMs: Math.round((latMono() - initT0) * 100) / 100,
          modelKind: kind,
        });

        console.log('[Herald LLM] GPU:', ctx.gpu, 'reason:', ctx.reasonNoGPU);

        if (cancelled) {
          await disposeLlamaContext(ctx, 'init-cancelled');
          return;
        }

        ctxRef.current = ctx;
        const ok = await warmThenReady(ctx, { modelKind: kind, modelPath });
        if (!ok && !cancelled) {
          ctxRef.current = null;
          activeModelRef.current = null;
          modelPathRef.current = null;
          setActiveModel(null);
          setStatusSafe('error');
          await disposeLlamaContext(ctx, 'warmup-failed');
        } else if (!ok && cancelled) {
          ctxRef.current = null;
          await disposeLlamaContext(ctx, 'warmup-cancelled');
        }
      } catch (err) {
        console.error('[Herald] useLocalLLM load failed:', err);
        const leaked = ctxRef.current;
        ctxRef.current = null;
        if (leaked) {
          await disposeLlamaContext(leaked, 'load-failed').catch(() => {});
        }
        if (!cancelled) {
          activeModelRef.current = null;
          modelPathRef.current = null;
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
            latLog('large-model upgrade START');
            statusRef.current = 'loading';
            if (mountedRef.current) setStatus('loading');
            const oldCtx = ctxRef.current;
            ctxRef.current = null;
            try {
              if (oldCtx) {
                await disposeLlamaContext(oldCtx, 'upgrade-replace');
              }
              const upgradeInitT0 = latMono();
              latLog('initLlama START', { modelKind: 'large', path: 'upgrade' });
              const newCtx = await initLlama({
                model: bestPath,
                ...LLAMA_INIT_BASE,
              });
              latLog('initLlama END', {
                durationMs: Math.round((latMono() - upgradeInitT0) * 100) / 100,
                modelKind: 'large',
                path: 'upgrade',
              });
              console.log('[Herald LLM] GPU:', newCtx.gpu, 'reason:', newCtx.reasonNoGPU);
              ctxRef.current = newCtx;
              activeModelRef.current = 'large';
              modelPathRef.current = bestPath;
              if (mountedRef.current) setActiveModel('large');
              const ok = await warmThenReady(
                newCtx,
                { modelKind: 'large', modelPath: bestPath },
                'upgrade',
              );
              if (!ok) {
                ctxRef.current = null;
                activeModelRef.current = null;
                modelPathRef.current = null;
                if (mountedRef.current) setActiveModel(null);
                setStatusSafe('error');
                await disposeLlamaContext(newCtx, 'upgrade-warmup-failed');
                latLog('large-model upgrade END', { outcome: 'error' });
                return;
              }
              latLog('large-model upgrade END', { outcome: 'success' });
              console.log('[Herald LLM] Upgraded to large model');
            } catch (e) {
              latLog('large-model upgrade END', { outcome: 'error' });
              console.warn('[Herald LLM] Upgrade failed, no context available:', e);
              const leaked = ctxRef.current;
              ctxRef.current = null;
              if (leaked) {
                await disposeLlamaContext(leaked, 'upgrade-failed').catch(() => {});
              }
              activeModelRef.current = null;
              modelPathRef.current = null;
              if (mountedRef.current) setActiveModel(null);
              setStatusSafe('error');
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
      modelPathRef.current = null;
      statusRef.current = 'unavailable';
      if (ctx) {
        void disposeLlamaContext(ctx, 'mount-cleanup').catch((releaseErr) => {
          console.error('[Herald] useLocalLLM release failed:', releaseErr);
        });
      }
    };
  }, [setStatusSafe]);

  const getCtx = useCallback(() => ctxRef.current, []);

  return { status, activeModel, getCtx, getModelIdentity };
}
