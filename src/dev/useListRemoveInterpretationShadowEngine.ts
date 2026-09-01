// Independent llama.rn Qwen context for list_remove interpretation shadow.
// Must never share KV/cache with the conversational experimental engine.

import { useCallback, useEffect, useRef, useState } from 'react';
import { initLlama, type LlamaContext } from 'llama.rn';
import { LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED } from '../constants/features';
import { ensureExperimentalQwenModelPath } from '../conversation/experimentalQwenModel';
import { SHADOW_QWEN_INIT } from './listRemoveInterpretationShadow';

export type ShadowEngineStatus = 'unavailable' | 'loading' | 'ready' | 'error';

export function useListRemoveInterpretationShadowEngine(): {
  status: ShadowEngineStatus;
  getCtx: () => LlamaContext | null;
} {
  const [status, setStatus] = useState<ShadowEngineStatus>('unavailable');
  const ctxRef = useRef<LlamaContext | null>(null);

  const getCtx = useCallback(() => ctxRef.current, []);

  useEffect(() => {
    let cancelled = false;
    if (!LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED) {
      setStatus('unavailable');
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      setStatus('loading');
      try {
        const artifact = await ensureExperimentalQwenModelPath();
        if (cancelled) return;
        const ctx = await initLlama({
          model: artifact.path,
          ...SHADOW_QWEN_INIT,
        });
        if (cancelled) {
          await ctx.release().catch(() => {});
          return;
        }
        ctxRef.current = ctx;
        setStatus('ready');
      } catch (e) {
        console.warn('HERALD_INTERPRETATION_SHADOW ' + JSON.stringify({
          event: 'independent_ctx_init_failed',
          error: String(e),
          fallback_to_conversational_ctx: false,
        }));
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
