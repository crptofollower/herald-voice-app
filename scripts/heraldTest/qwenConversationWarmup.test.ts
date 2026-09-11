// Conversational Latency V1 / Slice D.1 — one-shot experimental Qwen warmup.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  completeExperimentalQwenConversationInit,
  createExperimentalQwenLlamaWorker,
  EXPERIMENTAL_QWEN_GENERATION,
  EXPERIMENTAL_QWEN_INIT,
  EXPERIMENTAL_QWEN_SYSTEM_PROMPT,
  EXPERIMENTAL_QWEN_WARMUP_N_PREDICT,
  EXPERIMENTAL_QWEN_WARMUP_USER_TEXT,
  warmupExperimentalQwenConversation,
} from '../../src/conversation/experimentalQwenLlamaWorker.ts';
import { generateViaSelectedWorker } from '../../src/conversation/conversationalWorker.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = readFileSync(join(HERE, '../../src/conversation/useExperimentalConversationalEngine.ts'), 'utf8');
const ADAPTER = readFileSync(join(HERE, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
const CHAT = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');
const SHADOW = readFileSync(join(HERE, '../../src/dev/useListRemoveInterpretationShadowEngine.ts'), 'utf8');
const SEMANTIC = readFileSync(join(HERE, '../../src/hooks/useMedicationSemanticInterpreterEngine.ts'), 'utf8');

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

export async function runQwenConversationWarmupTests() {
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

  console.log(`\n${BOLD}-- Qwen conversation warmup (Slice D.1) --------------------${RESET}\n`);

  {
    let calls = 0;
    let seen: { messages?: { role: string; content: string }[]; n_predict?: number; jinja?: boolean; enable_thinking?: boolean } | null = null;
    const ctx = {
      completion: async (opts: typeof seen) => {
        calls += 1;
        seen = opts;
        return {
          content: 'discard-me',
          timings: { prompt_ms: 12, predicted_ms: 0, cache_n: 0, prompt_n: 40 },
          tokens_predicted: 0,
        };
      },
    };
    const { result, lines } = await captureLatencyLines(() => warmupExperimentalQwenConversation(ctx as never));
    const joined = lines.join('\n');
    assert('QWW-1 successful warmup calls completion once', calls, (v) => v === 1, '1');
    assert('QWW-2 warmup outcome is ok', result.outcome, (v) => v === 'ok', 'ok');
    assert(
      'QWW-3 warmup uses the experimental conversation ctx instance',
      seen !== null && calls === 1,
      (v) => v === true,
      'same ctx.completion',
    );
    assert(
      'QWW-4 warmup return discards model output',
      result,
      (v) => typeof v === 'object' && v !== null && !('replyText' in v) && !('content' in v),
      'no replyText/content',
    );
    assert(
      'QWW-12 warmup messages are production system + synthetic user',
      seen?.messages,
      (v) => {
        const msgs = v as { role: string; content: string }[];
        return msgs.length === 2
          && msgs[0].role === 'system'
          && msgs[0].content === EXPERIMENTAL_QWEN_SYSTEM_PROMPT
          && msgs[1].role === 'user'
          && msgs[1].content === EXPERIMENTAL_QWEN_WARMUP_USER_TEXT;
      },
      'system + ok',
    );
    assert(
      'QWW-13 warmup n_predict is prefill-only and production generate stays 128',
      seen?.n_predict === EXPERIMENTAL_QWEN_WARMUP_N_PREDICT
        && EXPERIMENTAL_QWEN_WARMUP_N_PREDICT === 0
        && EXPERIMENTAL_QWEN_GENERATION.n_predict === 128,
      (v) => v === true,
      '0 vs 128',
    );
    assert(
      'QWW-14 warmup uses production chat-template flags',
      seen?.jinja === true && seen?.enable_thinking === false,
      (v) => v === true,
      'jinja true thinking false',
    );
    assert(
      'QWW-16 warmup emits START then END with timings',
      /QWEN_WARMUP_START/.test(joined)
        && /QWEN_WARMUP_END/.test(joined)
        && /"outcome":"ok"/.test(joined)
        && /"prompt_ms":12/.test(joined)
        && joined.indexOf('QWEN_WARMUP_START') < joined.indexOf('QWEN_WARMUP_END'),
      (v) => v === true,
      'start/end timings',
    );
    assert(
      'QWW-17 warmup does not emit conversation inference',
      /CONVERSATION_INFERENCE_/.test(joined),
      (v) => v === false,
      'no CONVERSATION_INFERENCE',
    );
  }

  {
    const ctx = {
      completion: async () => {
        throw new Error('warmup boom');
      },
    };
    const { result, lines } = await captureLatencyLines(() => warmupExperimentalQwenConversation(ctx as never));
    assert('QWW-6a warmup failure outcome is error', result.outcome, (v) => v === 'error', 'error');
    assert(
      'QWW-6b failed warmup still logs END',
      lines.join('\n'),
      (v) => /QWEN_WARMUP_END/.test(String(v)) && /"outcome":"error"/.test(String(v)),
      'END error',
    );
    const worker = createExperimentalQwenLlamaWorker({
      getCtx: () => ({
        completion: async () => ({ content: 'Still here.' }),
      }) as never,
      enabled: true,
    });
    const out = await generateViaSelectedWorker(worker, { userText: 'hello', hotEntries: [] });
    assert(
      'QWW-6c failed warmup leaves ctx usable for conversation',
      out.status === 'ok' && out.status === 'ok' && out.text === 'Still here.',
      (v) => v === true,
      'ok Still here.',
    );
  }

  {
    let calls = 0;
    const ctx = {
      completion: async () => {
        calls += 1;
        return { content: 'x' };
      },
    };
    const published = await completeExperimentalQwenConversationInit(ctx as never, () => false);
    const cancelled = await completeExperimentalQwenConversationInit(ctx as never, () => true);
    assert('QWW-15a init helper publishes after warmup', published, (v) => v === 'publish', 'publish');
    assert('QWW-15b init helper respects cancel after warmup', cancelled, (v) => v === 'cancelled', 'cancelled');
    assert('QWW-2b each init completion warms once', calls, (v) => v === 2, '2');
  }

  {
    let published = false;
    let completionStarted = false;
    let generateDuringWarmup: string | null = null;
    let resolveWarmup: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      resolveWarmup = resolve;
    });
    const ctx = {
      completion: async () => {
        completionStarted = true;
        await held;
        return { content: 'warm' };
      },
    };
    const holder: { current: typeof ctx | null } = { current: null };
    const worker = createExperimentalQwenLlamaWorker({
      getCtx: () => (holder.current as never),
      enabled: true,
    });
    const initP = completeExperimentalQwenConversationInit(ctx as never, () => false).then((decision) => {
      if (decision === 'publish') holder.current = ctx;
      published = decision === 'publish';
    });
    await Promise.resolve();
    assert('QWW-F1 warmup starts before ctx is published', completionStarted && holder.current === null, (v) => v === true, 'in-flight unpublished');
    const raced = await generateViaSelectedWorker(worker, { userText: 'race', hotEntries: [] });
    generateDuringWarmup = raced.status;
    resolveWarmup?.();
    await initP;
    assert('QWW-F2 first generate cannot race in-progress warmup', generateDuringWarmup, (v) => v === 'unavailable', 'unavailable');
    assert('QWW-F3 ctx is published only after warmup', published && holder.current === ctx, (v) => v === true, 'published');
    const after = await generateViaSelectedWorker(worker, { userText: 'hi', hotEntries: [] });
    assert('QWW-F4 conversation works after publish', after.status === 'ok', (v) => v === true, 'ok');
  }

  assert(
    'QWW-5 warmup/adapter does not write conversation history/memory/pending',
    ADAPTER,
    (v) => {
      const src = String(v);
      return !src.includes('addMessage')
        && !src.includes('medicalDB')
        && !src.includes('setPending')
        && !src.includes('runSync')
        && !src.includes("from '../db/schema")
        && !src.includes('enqueueSentence')
        && !src.includes('speak(');
    },
    'no writers/history/TTS',
  );
  assert(
    'QWW-7 failed init does not warmup',
    HOOK,
    (v) => {
      const src = String(v);
      const catchIdx = src.indexOf('} catch (e) {');
      const warmupIdx = src.indexOf('completeExperimentalQwenConversationInit');
      const initIdx = src.indexOf('initLlama');
      return warmupIdx > initIdx && catchIdx > warmupIdx && !src.slice(catchIdx).includes('completeExperimentalQwenConversationInit');
    },
    'warmup after initLlama, not in catch',
  );
  assert(
    'QWW-8 unmount still releases published ctx',
    HOOK,
    (v) => {
      const src = String(v);
      return src.includes('ctxRef.current = null')
        && src.includes('void ctx.release()')
        && src.includes("if (decision === 'cancelled')")
        && src.includes('await ctx.release()');
    },
    'release on unmount and cancel',
  );
  assert(
    'QWW-9 production generation n_predict unchanged',
    EXPERIMENTAL_QWEN_GENERATION.n_predict,
    (v) => v === 128,
    '128',
  );
  assert(
    'QWW-9b init params unchanged',
    EXPERIMENTAL_QWEN_INIT.n_ctx === 2048 && EXPERIMENTAL_QWEN_INIT.n_gpu_layers === 0,
    (v) => v === true,
    '2048 / 0',
  );
  assert(
    'QWW-10 semantic 3B engine is untouched',
    SEMANTIC.includes('warmupExperimentalQwenConversation')
      || HOOK.includes('useMedicationSemanticInterpreterEngine')
      || HOOK.includes('getMedicationSemanticInterpreterCtx'),
    (v) => v === false,
    'false',
  );
  assert(
    'QWW-11 list-remove shadow engine is untouched',
    SHADOW.includes('warmupExperimentalQwenConversation')
      || HOOK.includes('useListRemoveInterpretationShadowEngine')
      || HOOK.includes('SHADOW_QWEN_INIT'),
    (v) => v === false,
    'false',
  );
  assert(
    'QWW-18 ctx is published and marked ready only after warmup',
    HOOK,
    (v) => {
      const src = String(v);
      const w = src.indexOf('completeExperimentalQwenConversationInit');
      const pub = src.indexOf('ctxRef.current = ctx');
      const ready = src.indexOf("setStatus('ready')");
      return w !== -1 && pub > w && ready > pub
        && /\}, \[\]\);/.test(src);
    },
    'warmup → publish → ready; effect []',
  );
  assert(
    'QWW-18b hook has a single warmup call site',
    (HOOK.match(/await completeExperimentalQwenConversationInit/g) || []).length,
    (v) => v === 1,
    '1',
  );
  assert(
    'QWW-24 ChatScreen still withholds conversation until ready',
    CHAT.includes("experimentalConvStatus === 'ready' ? 'ready' : llmStatus")
      && CHAT.includes("experimentalConvStatus !== 'ready'"),
    (v) => v === true,
    'ready gate',
  );
  assert(
    'QWW-20 warmup uses the shared production message builder',
    ADAPTER.includes('buildExperimentalQwenMessages(EXPERIMENTAL_QWEN_WARMUP_USER_TEXT, [])')
      && ADAPTER.includes('buildExperimentalQwenMessages(')
      && ADAPTER.includes('request.userText'),
    (v) => v === true,
    'shared builder',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}QwenConversationWarmup: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('qwenConversationWarmup.test.ts')) {
  runQwenConversationWarmupTests().catch(console.error);
}
