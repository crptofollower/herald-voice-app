// Conversational Latency V1 / Slice E.2 — Qwen runtime diagnostic benchmark.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QWEN_RUNTIME_DIAGNOSTIC_BENCHMARK_ENABLED } from '../../src/constants/features.ts';
import {
  completeExperimentalQwenConversationInit,
  createExperimentalQwenLlamaWorker,
  EXPERIMENTAL_QWEN_GENERATION,
  EXPERIMENTAL_QWEN_INIT,
  EXPERIMENTAL_QWEN_WARMUP_N_PREDICT,
  warmupExperimentalQwenConversation,
} from '../../src/conversation/experimentalQwenLlamaWorker.ts';
import {
  collectQwenRuntimeInitDiagFields,
  emitQwenRuntimeInitDiag,
  QWEN_RUNTIME_BENCH_NR,
  QWEN_RUNTIME_BENCH_PL,
  QWEN_RUNTIME_BENCH_PP,
  QWEN_RUNTIME_BENCH_TG,
  QWEN_RUNTIME_INIT_DIAG_FIELD_KEYS,
  QWEN_RUNTIME_THREAD_PROBE_CANDIDATES,
  QWEN_RUNTIME_THREAD_PROBE_OMISSION_REASON,
  runQwenRuntimeDiagnosticAfterWarmup,
  selectThreadProbeCandidates,
} from '../../src/conversation/qwenRuntimeDiagnostic.ts';
import { generateViaSelectedWorker } from '../../src/conversation/conversationalWorker.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = readFileSync(join(HERE, '../../src/conversation/useExperimentalConversationalEngine.ts'), 'utf8');
const ADAPTER = readFileSync(join(HERE, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
const DIAG = readFileSync(join(HERE, '../../src/conversation/qwenRuntimeDiagnostic.ts'), 'utf8');
const INSTR = readFileSync(join(HERE, '../../src/utils/latencyInstrument.ts'), 'utf8');
const FEATURES = readFileSync(join(HERE, '../../src/constants/features.ts'), 'utf8');
const CHAT = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');

const CONFIGURED = {
  n_ctx: EXPERIMENTAL_QWEN_INIT.n_ctx,
  n_gpu_layers: EXPERIMENTAL_QWEN_INIT.n_gpu_layers,
  model: 'Qwen3-1.7B-Q4_K_M.gguf',
};

function captureLatencyLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.includes('[LATENCY-INSTRUMENT]')) lines.push(line);
    orig.apply(console, args as []);
  };
  return fn().then((result) => {
    console.log = orig;
    return { result, lines };
  }, (err) => {
    console.log = orig;
    throw err;
  });
}

function parsePayload(line: string): Record<string, unknown> {
  const idx = line.indexOf('{');
  return JSON.parse(line.slice(idx)) as Record<string, unknown>;
}

export async function runQwenRuntimeDiagnosticTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Qwen runtime diagnostic benchmark (Slice E.2) -----------${RESET}\n`);

  {
    const fields = collectQwenRuntimeInitDiagFields({
      androidLib: 'rnllama_jni_v8_2_dotprod_i8mm',
      gpu: false,
      reasonNoGPU: 'GPU backend is not available',
      devices: ['CPU'],
      systemInfo: 'system_info: n_threads = 4',
      prompt: 'secret user text',
      model: { path: '/data/user/0/com.herald/files/private.gguf' },
    } as never, CONFIGURED);
    const keys = Object.keys(fields);
    assert(
      'E2-1 init diag fields are the allowed technical set',
      keys.every((k) => (QWEN_RUNTIME_INIT_DIAG_FIELD_KEYS as readonly string[]).includes(k))
        && fields.modelFile === 'Qwen3-1.7B-Q4_K_M.gguf'
        && fields.n_ctx === 2048
        && fields.n_gpu_layers === 0
        && fields.androidLib === 'rnllama_jni_v8_2_dotprod_i8mm'
        && !keys.includes('prompt')
        && !JSON.stringify(fields).includes('/data/user')
        && !JSON.stringify(fields).includes('secret user'),
      (v) => v === true,
      'whitelist only',
    );
  }

  {
    const ctx = {
      androidLib: 'rnllama_jni_v8',
      gpu: false,
      reasonNoGPU: 'GPU backend is not available',
      devices: ['CPU'],
      systemInfo: 'n_threads = 4',
    };
    const { lines } = await captureLatencyLines(async () => {
      emitQwenRuntimeInitDiag(ctx, CONFIGURED);
      emitQwenRuntimeInitDiag(ctx, CONFIGURED);
      return null;
    });
    const initLines = lines.filter((l) => l.includes('QWEN_RUNTIME_INIT_DIAG'));
    assert('E2-1b init diag emits once per ctx', initLines.length, (v) => v === 1, '1');
    const payload = parsePayload(initLines[0]);
    const extraKeys = Object.keys(payload).filter((k) =>
      !['event', 'monoMs', 'wallTs', 'elapsedFromAppMs', 'model', ...QWEN_RUNTIME_INIT_DIAG_FIELD_KEYS].includes(k),
    );
    assert('E2-1c logged init payload has no extra data keys', extraKeys, (v) => (v as string[]).length === 0, '[]');
  }

  {
    let benchCalls = 0;
    let warmupCalls = 0;
    const ctx = {
      completion: async () => {
        warmupCalls += 1;
        return { content: 'discard-me', tokens_predicted: 0 };
      },
      bench: async (pp: number, tg: number, pl: number, nr: number) => {
        benchCalls += 1;
        return {
          nThreads: 4,
          nThreadsBatch: 4,
          nBatch: 2048,
          nUBatch: 512,
          nGpuLayers: 0,
          flashAttn: 0,
          tPp: 1.2,
          speedPp: 213,
          tTg: 0.4,
          speedTg: 80,
          pp,
          tg,
          pl,
        };
      },
    };
    const { result, lines } = await captureLatencyLines(() =>
      completeExperimentalQwenConversationInit(ctx as never, () => false));
    const joined = lines.join('\n');
    assert('E2-2 complete-init publishes after warmup+diag', result, (v) => v === 'publish', 'publish');
    assert('E2-2b bench runs once per ctx lifetime', benchCalls, (v) => v === 1, '1');
    await runQwenRuntimeDiagnosticAfterWarmup(ctx, {
      enabled: true,
      restoreWarmupKv: () => warmupExperimentalQwenConversation(ctx as never),
    });
    assert('E2-2c second diagnostic is a no-op', benchCalls, (v) => v === 1, '1');
    assert(
      'E2-3 warmup runs before bench',
      warmupCalls >= 1 && joined.indexOf('QWEN_WARMUP_START') < joined.indexOf('QWEN_RUNTIME_BENCH_BASELINE'),
      (v) => v === true,
      'warmup then bench',
    );
    assert(
      'E2-3b bench shape is 256/32/1/1',
      QWEN_RUNTIME_BENCH_PP === 256
        && QWEN_RUNTIME_BENCH_TG === 32
        && QWEN_RUNTIME_BENCH_PL === 1
        && QWEN_RUNTIME_BENCH_NR === 1
        && /"pp":256/.test(joined)
        && /"tg":32/.test(joined),
      (v) => v === true,
      '256/32/1/1',
    );
    assert(
      'E2-3c bench logs actual runtime numbers when returned',
      /"nThreads":4/.test(joined)
        && /"nBatch":2048/.test(joined)
        && /"nUBatch":512/.test(joined)
        && /"speedPp":213/.test(joined)
        && /"speedTg":80/.test(joined),
      (v) => v === true,
      'bench fields',
    );
    assert(
      'E2-5 diagnostic text is discarded',
      !joined.includes('discard-me') && warmupCalls === 2,
      (v) => v === true,
      'no content; restore warmup once',
    );
  }

  {
    let warmupCalls = 0;
    const ctx = {
      completion: async () => {
        warmupCalls += 1;
        return { content: 'x' };
      },
      bench: async () => {
        throw new Error('bench boom');
      },
    };
    const { result, lines } = await captureLatencyLines(() =>
      completeExperimentalQwenConversationInit(ctx as never, () => false));
    assert('E2-4 bench failure still publishes Qwen', result, (v) => v === 'publish', 'publish');
    assert(
      'E2-4c failed bench still restores warmup KV',
      (lines.join('\n').match(/QWEN_WARMUP_START/g) || []).length,
      (v) => v === 2,
      '2',
    );
    const worker = createExperimentalQwenLlamaWorker({
      getCtx: () => ctx as never,
      enabled: true,
    });
    const out = await generateViaSelectedWorker(worker, { userText: 'hello', hotEntries: [] });
    assert(
      'E2-4b bench failure logs error and leaves generate available',
      /"outcome":"error"/.test(lines.join('\n')) && out.status === 'ok',
      (v) => v === true,
      'error + ok generate',
    );
  }

  {
    const ctx = {
      completion: async (opts: { n_threads?: number }) => {
        if (opts && 'n_threads' in opts) throw new Error('production n_threads leaked');
        return { content: 'Still here.' };
      },
    };
    const worker = createExperimentalQwenLlamaWorker({
      getCtx: () => ctx as never,
      enabled: true,
    });
    const out = await generateViaSelectedWorker(worker, { userText: 'hello', hotEntries: [] });
    assert(
      'E2-10 production generate still omits n_threads',
      out.status === 'ok' && EXPERIMENTAL_QWEN_GENERATION.n_predict === 128 && !('n_threads' in EXPERIMENTAL_QWEN_GENERATION),
      (v) => v === true,
      'no n_threads',
    );
  }

  assert(
    'E2-11 selector skips candidates above reported capability',
    selectThreadProbeCandidates(4),
    (v) => JSON.stringify(v) === JSON.stringify([2, 4]),
    '[2,4]',
  );
  assert(
    'E2-12 selector skips all when capability is unknown/non-positive',
    selectThreadProbeCandidates(0).length === 0
      && selectThreadProbeCandidates(Number.NaN).length === 0
      && selectThreadProbeCandidates(6).join(',') === '2,4,6'
      && QWEN_RUNTIME_THREAD_PROBE_CANDIDATES.join(',') === '2,4,6,8',
    (v) => v === true,
    'cap filter',
  );

  {
    const ctx = {
      completion: async () => ({ content: 'probe-text-must-not-log' }),
      bench: async () => ({ nThreads: 4, nBatch: 2048, nUBatch: 512 }),
    };
    const { lines } = await captureLatencyLines(() =>
      runQwenRuntimeDiagnosticAfterWarmup(ctx, {
        enabled: true,
        restoreWarmupKv: () => warmupExperimentalQwenConversation(ctx as never),
      }));
    const joined = lines.join('\n');
    assert(
      'E2-thread-omitted does not run per-completion n_threads probes',
      /QWEN_RUNTIME_THREAD_PROBE_OMITTED/.test(joined)
        && joined.includes(QWEN_RUNTIME_THREAD_PROBE_OMISSION_REASON)
        && !joined.includes('probe-text-must-not-log')
        && !/QWEN_RUNTIME_THREAD_PROBE"/.test(joined),
      (v) => v === true,
      'omitted',
    );
  }

  {
    let published = false;
    let resolveBench: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      resolveBench = resolve;
    });
    const ctx = {
      completion: async () => ({ content: 'warm' }),
      bench: async () => {
        await held;
        return { nThreads: 4 };
      },
    };
    const holder: { current: typeof ctx | null } = { current: null };
    const worker = createExperimentalQwenLlamaWorker({
      getCtx: () => holder.current as never,
      enabled: true,
    });
    const initP = completeExperimentalQwenConversationInit(ctx as never, () => false).then((decision) => {
      if (decision === 'publish') holder.current = ctx;
      published = decision === 'publish';
    });
    await Promise.resolve();
    await Promise.resolve();
    const raced = await generateViaSelectedWorker(worker, { userText: 'race', hotEntries: [] });
    resolveBench?.();
    await initP;
    assert('E2-13 generate cannot share ctx during diagnostic bench', raced.status, (v) => v === 'unavailable', 'unavailable');
    assert('E2-13b ctx publishes only after diagnostic', published && holder.current === ctx, (v) => v === true, 'published');
  }

  {
    let restore = 0;
    let resolveBench: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      resolveBench = resolve;
    });
    const ctx = {
      bench: async () => {
        await held;
        return { nThreads: 2 };
      },
    };
    let cancelled = false;
    const run = runQwenRuntimeDiagnosticAfterWarmup(ctx, {
      enabled: true,
      isCancelled: () => cancelled,
      restoreWarmupKv: async () => {
        restore += 1;
      },
    });
    cancelled = true;
    resolveBench?.();
    await run;
    assert('E2-14 cancel after bench start skips KV restore', restore, (v) => v === 0, '0');
  }

  assert(
    'E2-15 D.1 warmup n_predict remains 0',
    EXPERIMENTAL_QWEN_WARMUP_N_PREDICT === 0
      && ADAPTER.includes('n_predict: EXPERIMENTAL_QWEN_WARMUP_N_PREDICT'),
    (v) => v === true,
    '0',
  );
  assert(
    'E2-16 production init/generate config unchanged',
    EXPERIMENTAL_QWEN_INIT.n_ctx === 2048
      && EXPERIMENTAL_QWEN_INIT.n_gpu_layers === 0
      && EXPERIMENTAL_QWEN_GENERATION.n_predict === 128
      && !('n_threads' in EXPERIMENTAL_QWEN_INIT)
      && !('n_batch' in EXPERIMENTAL_QWEN_INIT)
      && !('n_ubatch' in EXPERIMENTAL_QWEN_INIT),
    (v) => v === true,
    'unchanged',
  );
  assert(
    'E2-6 diagnostic module has no SQLite/history writes',
    DIAG,
    (v) => {
      const src = String(v);
      return !src.includes('runSync')
        && !src.includes('addMessage')
        && !src.includes('setPending')
        && !src.includes('enqueueSentence');
    },
    'no writes',
  );
  assert(
    'E2-7 diagnostic does not import routing',
    DIAG.includes('routeIntent') || DIAG.includes('../routing/'),
    (v) => v === false,
    'false',
  );
  assert(
    'E2-8 diagnostic does not invoke semantic 3B',
    DIAG.includes('getMedicationSemanticInterpreterCtx')
      || DIAG.includes('useMedicationSemanticInterpreterEngine'),
    (v) => v === false,
    'false',
  );
  assert(
    'E2-9 diagnostic does not mutate pending/discourse/recovery',
    DIAG.includes('pending') || DIAG.includes('discourse') || DIAG.includes('recovery'),
    (v) => v === false,
    'false',
  );
  assert(
    'E2-gate diagnostic flag is on for the device build',
    QWEN_RUNTIME_DIAGNOSTIC_BENCHMARK_ENABLED === true
      && FEATURES.includes('QWEN_RUNTIME_DIAGNOSTIC_BENCHMARK_ENABLED'),
    (v) => v === true,
    'true',
  );
  assert(
    'E2-lifecycle hook emits init diag after initLlama before warmup helper',
    HOOK,
    (v) => {
      const src = String(v);
      const initIdx = src.indexOf('initLlama');
      const diagIdx = src.indexOf('emitQwenRuntimeInitDiag');
      const warmIdx = src.indexOf('await completeExperimentalQwenConversationInit');
      const pub = src.indexOf('ctxRef.current = ctx');
      return initIdx !== -1 && diagIdx > initIdx && warmIdx > diagIdx && pub > warmIdx;
    },
    'init→diag→warmup/bench→publish',
  );
  assert(
    'E2-location fence diagnostic does not import location/netinfo',
    DIAG.includes('useLocation') || DIAG.includes('expo-location') || DIAG.includes('NetInfo'),
    (v) => v === false,
    'false',
  );
  assert(
    'E2-chat still gates conversation on ready',
    CHAT.includes("experimentalConvStatus === 'ready' ? 'ready' : llmStatus"),
    (v) => v === true,
    'ready gate',
  );
  assert(
    'E2-instrument events exist',
    INSTR.includes("log('QWEN_RUNTIME_INIT_DIAG'")
      && INSTR.includes("log('QWEN_RUNTIME_BENCH_BASELINE'")
      && INSTR.includes("log('QWEN_RUNTIME_THREAD_PROBE_OMITTED'"),
    (v) => v === true,
    'events',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}QwenRuntimeDiagnostic: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('qwenRuntimeDiagnostic.test.ts')) {
  runQwenRuntimeDiagnosticTests().catch(console.error);
}
