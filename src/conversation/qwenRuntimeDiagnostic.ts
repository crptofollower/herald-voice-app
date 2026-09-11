// TEMP — Latency V1 / Slice E.2. Diagnostic-only Qwen runtime measurement.
// Does not change production init/generate params or emit conversation text.

import { QWEN_RUNTIME_DIAGNOSTIC_BENCHMARK_ENABLED } from '../constants/features';
import {
  logQwenRuntimeBenchBaseline,
  logQwenRuntimeInitDiag,
  logQwenRuntimeThreadProbeOmitted,
  mono as latMono,
} from '../utils/latencyInstrument';

export const QWEN_RUNTIME_BENCH_PP = 256;
export const QWEN_RUNTIME_BENCH_TG = 32;
export const QWEN_RUNTIME_BENCH_PL = 1;
export const QWEN_RUNTIME_BENCH_NR = 1;

export const QWEN_RUNTIME_THREAD_PROBE_CANDIDATES = [2, 4, 6, 8] as const;

/** Per-completion n_threads mutates llama.rn common_params but does not
 *  reattach the ggml threadpool created at initLlama. Fair thread
 *  comparison on the production ctx is therefore unsafe. */
export const QWEN_RUNTIME_THREAD_PROBE_OMISSION_REASON =
  'completion_n_threads_does_not_reattach_ggml_threadpool';

const INIT_DIAG_RAN = new WeakSet<object>();
const POST_WARMUP_DIAG_RAN = new WeakSet<object>();

const BENCH_NUMERIC_KEYS = [
  'nKvMax',
  'nBatch',
  'nUBatch',
  'flashAttn',
  'isPpShared',
  'nGpuLayers',
  'nThreads',
  'nThreadsBatch',
  'pp',
  'tg',
  'pl',
  'nKv',
  'tPp',
  'speedPp',
  'tTg',
  'speedTg',
  't',
  'speed',
] as const;

export const QWEN_RUNTIME_INIT_DIAG_FIELD_KEYS = [
  'androidLib',
  'gpu',
  'reasonNoGPU',
  'devices',
  'systemInfo',
  'n_ctx',
  'n_gpu_layers',
  'modelFile',
] as const;

export type QwenRuntimeInitDiagSource = {
  androidLib?: unknown;
  gpu?: unknown;
  reasonNoGPU?: unknown;
  devices?: unknown;
  systemInfo?: unknown;
};

export function selectThreadProbeCandidates(maxAvailableThreads: number): number[] {
  if (!Number.isFinite(maxAvailableThreads) || maxAvailableThreads < 1) return [];
  return QWEN_RUNTIME_THREAD_PROBE_CANDIDATES.filter((n) => n <= maxAvailableThreads);
}

function boundSystemInfo(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > 4000 ? value.slice(0, 4000) : value;
}

function boundDeviceNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    out.push(item.length > 64 ? item.slice(0, 64) : item);
    if (out.length >= 16) break;
  }
  return out;
}

export function collectQwenRuntimeInitDiagFields(
  ctx: QwenRuntimeInitDiagSource,
  configured: { n_ctx: number; n_gpu_layers: number; model: string },
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    n_ctx: configured.n_ctx,
    n_gpu_layers: configured.n_gpu_layers,
    modelFile: configured.model,
  };
  if (typeof ctx.androidLib === 'string') fields.androidLib = ctx.androidLib;
  if (typeof ctx.gpu === 'boolean') fields.gpu = ctx.gpu;
  if (typeof ctx.reasonNoGPU === 'string') fields.reasonNoGPU = ctx.reasonNoGPU;
  const devices = boundDeviceNames(ctx.devices);
  if (devices) fields.devices = devices;
  const systemInfo = boundSystemInfo(ctx.systemInfo);
  if (systemInfo !== undefined) fields.systemInfo = systemInfo;
  return fields;
}

export function collectQwenRuntimeBenchFields(result: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (result == null || typeof result !== 'object') return fields;
  const row = result as Record<string, unknown>;
  for (const key of BENCH_NUMERIC_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
  }
  return fields;
}

export function emitQwenRuntimeInitDiag(
  ctx: QwenRuntimeInitDiagSource,
  configured: { n_ctx: number; n_gpu_layers: number; model: string },
): void {
  if (INIT_DIAG_RAN.has(ctx)) return;
  INIT_DIAG_RAN.add(ctx);
  logQwenRuntimeInitDiag(collectQwenRuntimeInitDiagFields(ctx, configured));
}

export async function runQwenRuntimeDiagnosticAfterWarmup(
  ctx: {
    bench?: (pp: number, tg: number, pl: number, nr: number) => Promise<unknown>;
  },
  options?: {
    isCancelled?: () => boolean;
    enabled?: boolean;
    restoreWarmupKv?: () => Promise<unknown>;
  },
): Promise<void> {
  const enabled = options?.enabled ?? QWEN_RUNTIME_DIAGNOSTIC_BENCHMARK_ENABLED;
  if (!enabled) return;
  if (POST_WARMUP_DIAG_RAN.has(ctx)) return;
  POST_WARMUP_DIAG_RAN.add(ctx);

  const isCancelled = options?.isCancelled ?? (() => false);
  if (isCancelled()) return;

  let benchTouchedKv = false;
  try {
    if (typeof ctx.bench !== 'function') {
      logQwenRuntimeBenchBaseline({
        outcome: 'skipped_no_bench_api',
        pp: QWEN_RUNTIME_BENCH_PP,
        tg: QWEN_RUNTIME_BENCH_TG,
        pl: QWEN_RUNTIME_BENCH_PL,
        nr: QWEN_RUNTIME_BENCH_NR,
      });
    } else {
      const t0 = latMono();
      try {
        benchTouchedKv = true;
        const result = await ctx.bench(
          QWEN_RUNTIME_BENCH_PP,
          QWEN_RUNTIME_BENCH_TG,
          QWEN_RUNTIME_BENCH_PL,
          QWEN_RUNTIME_BENCH_NR,
        );
        logQwenRuntimeBenchBaseline({
          outcome: 'ok',
          durationMs: Math.round((latMono() - t0) * 100) / 100,
          pp: QWEN_RUNTIME_BENCH_PP,
          tg: QWEN_RUNTIME_BENCH_TG,
          pl: QWEN_RUNTIME_BENCH_PL,
          nr: QWEN_RUNTIME_BENCH_NR,
          ...collectQwenRuntimeBenchFields(result),
        });
      } catch {
        logQwenRuntimeBenchBaseline({
          outcome: 'error',
          durationMs: Math.round((latMono() - t0) * 100) / 100,
          pp: QWEN_RUNTIME_BENCH_PP,
          tg: QWEN_RUNTIME_BENCH_TG,
          pl: QWEN_RUNTIME_BENCH_PL,
          nr: QWEN_RUNTIME_BENCH_NR,
        });
      }
    }
  } finally {
    logQwenRuntimeThreadProbeOmitted({
      outcome: 'omitted',
      reason: QWEN_RUNTIME_THREAD_PROBE_OMISSION_REASON,
      candidates: [...QWEN_RUNTIME_THREAD_PROBE_CANDIDATES],
    });
    if (benchTouchedKv && !isCancelled() && options?.restoreWarmupKv) {
      try {
        await options.restoreWarmupKv();
      } catch {
        // Restore is best-effort; conversation still publishes.
      }
    }
  }
}
