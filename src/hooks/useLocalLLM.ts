// src/hooks/useLocalLLM.ts
// On-device LLM lifecycle: load, infer, release.
// Falls through to Railway on any failure (inferLocal returns null).

import { useCallback, useEffect, useRef, useState } from 'react';
import { initLlama, type LlamaContext } from 'llama.rn';
import {
  getActiveModelPath,
  LARGE_MODEL,
} from '../utils/modelManager';

export type LocalLLMStatus =
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'error';

const INFERENCE_TIMEOUT_MS = 8_000;

const STOP_TOKENS = ['\n\n', '<|end|>', '<|eot_id|>'];

function modelKindFromPath(path: string): 'small' | 'large' {
  return path.includes(LARGE_MODEL.filename) ? 'large' : 'small';
}

export function useLocalLLM(): {
  status: LocalLLMStatus;
  inferLocal: (prompt: string, maxTokens?: number) => Promise<string | null>;
  activeModel: 'small' | 'large' | null;
} {
  const [status, setStatus] = useState<LocalLLMStatus>('unavailable');
  const [activeModel, setActiveModel] = useState<'small' | 'large' | null>(null);

  const ctxRef = useRef<LlamaContext | null>(null);
  const statusRef = useRef<LocalLLMStatus>('unavailable');
  const mountedRef = useRef(true);

  const setStatusSafe = useCallback((next: LocalLLMStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const modelPath = await getActiveModelPath();
        if (!modelPath) {
          if (!cancelled) {
            setActiveModel(null);
            setStatusSafe('unavailable');
          }
          return;
        }

        const kind = modelKindFromPath(modelPath);
        if (!cancelled) {
          setActiveModel(kind);
          setStatusSafe('loading');
        }

        const ctx = await initLlama({
          model: modelPath,
          n_ctx: 2048,
          n_gpu_layers: 99,
        });

        if (cancelled) {
          await ctx.release();
          return;
        }

        ctxRef.current = ctx;
        setStatusSafe('ready');
      } catch (err) {
        console.error('[Herald] useLocalLLM load failed:', err);
        ctxRef.current = null;
        if (!cancelled) {
          setActiveModel(null);
          setStatusSafe('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      const ctx = ctxRef.current;
      ctxRef.current = null;
      statusRef.current = 'unavailable';
      if (ctx) {
        void ctx.release().catch((releaseErr) => {
          console.error('[Herald] useLocalLLM release failed:', releaseErr);
        });
      }
    };
  }, [setStatusSafe]);

  const inferLocal = useCallback(
    async (prompt: string, maxTokens = 256): Promise<string | null> => {
      if (statusRef.current !== 'ready') return null;

      const ctx = ctxRef.current;
      if (!ctx) return null;

      const trimmed = prompt.trim();
      if (!trimmed) return null;

      try {
        const completionPromise = ctx.completion({
          messages: [{ role: 'user', content: trimmed }],
          n_predict: maxTokens,
          temperature: 0.7,
          stop: STOP_TOKENS,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('local inference timeout')),
            INFERENCE_TIMEOUT_MS,
          );
        });

        const result = await Promise.race([completionPromise, timeoutPromise]);
        const text = result?.text?.trim();
        return text && text.length > 0 ? text : null;
      } catch (err) {
        console.warn('[Herald] inferLocal failed, falling through to Railway:', err);
        return null;
      }
    },
    [],
  );

  return { status, inferLocal, activeModel };
}
