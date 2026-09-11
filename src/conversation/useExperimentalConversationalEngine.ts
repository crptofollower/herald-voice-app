// Independent Qwen conversational engine. Independent of useLocalLLM
// and the retired classifier flag. Never warms or runs the retired classifier.
// After successful initLlama, one discarded prefill runs on this ctx before ready.

import { useCallback, useEffect, useRef, useState } from 'react';
import { initLlama, type LlamaContext } from 'llama.rn';
import { CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED } from '../constants/features';
import {
  completeExperimentalQwenConversationInit,
  EXPERIMENTAL_QWEN_INIT,
} from './experimentalQwenLlamaWorker';
import { ensureExperimentalQwenModelPath } from './experimentalQwenModel';

export type ExperimentalConversationStatus =
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'error';

export function useExperimentalConversationalEngine(): {
  status: ExperimentalConversationStatus;
  getCtx: () => LlamaContext | null;
} {
  const [status, setStatus] = useState<ExperimentalConversationStatus>('unavailable');
  const ctxRef = useRef<LlamaContext | null>(null);
  const mountedRef = useRef(true);

  const getCtx = useCallback(() => ctxRef.current, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    if (!CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED) {
      setStatus('unavailable');
      return () => {
        mountedRef.current = false;
      };
    }

    (async () => {
      setStatus('loading');
      try {
        const artifact = await ensureExperimentalQwenModelPath();
        if (cancelled) return;
        const ctx = await initLlama({
          model: artifact.path,
          ...EXPERIMENTAL_QWEN_INIT,
        });
        if (cancelled) {
          await ctx.release().catch(() => {});
          return;
        }
        const decision = await completeExperimentalQwenConversationInit(ctx, () => cancelled);
        if (decision === 'cancelled') {
          await ctx.release().catch(() => {});
          return;
        }
        ctxRef.current = ctx;
        if (mountedRef.current) setStatus('ready');
      } catch (e) {
        console.log('[CW-EXPERIMENT] load failed', String(e));
        ctxRef.current = null;
        if (mountedRef.current && !cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) void ctx.release().catch(() => {});
    };
  }, []);

  return { status, getCtx };
}
