// scripts/heraldTest/llmLayers.test.ts
// classifyWithLLM decode-config contract — greedy/deterministic completion params.
// Pins temperature/top_k/seed so the on-device classifier cannot silently
// drift back to sampling. One assertion; mock ctx.completion captures params.

import {
  classifyWithLLM,
  truncateClassifierRawForLog,
  buildClassifierCompletionSurfaceLogPayload,
  CLASSIFIER_RAW_LOG_MAX,
} from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runLlmLayersContractTests(): Promise<{ passed: number; failed: number; total: number; failures: string[] }> {
  const failures: string[] = [];
  let passed = 0;

  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- LLM Layers Contract Tests -----------------------------${RESET}\n`);

  // ── classifyWithLLM decodes greedily (temperature/top_k/seed pinned) ───────
  {
    let captured: Record<string, unknown> | null = null;
    const fakeCtx = {
      completion: async (params: Record<string, unknown>) => {
        captured = params;
        return { text: '{"type":"pass"}' };
      },
    };
    await classifyWithLLM('test input', fakeCtx as any, { contacts: [], lists: [] });
    assert(
      'classifyWithLLM decodes greedily (temperature/top_k/seed pinned)',
      { temperature: captured?.temperature, top_k: captured?.top_k, seed: captured?.seed },
      (v) => v.temperature === 0 && v.top_k === 1 && v.seed === 0,
      '{ temperature: 0, top_k: 1, seed: 0 }',
    );
    assert(
      'Run C: normal classify omits response_format (schema isolation)',
      captured?.response_format,
      (rf) => rf === undefined,
      'undefined (no json_schema constraint)',
    );
  }

  // classifyWithLLM claims the shared exclusive gate synchronously (try mode
  // sets heldBy before any await). A concurrent classify must get not_ready.
  {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowCtx = {
      completion: async () => { await gate; return { text: '{"type":"pass"}' }; },
    };
    const p1 = classifyWithLLM('first', slowCtx as any, { contacts: [], lists: [] });
    const second = await classifyWithLLM('second', slowCtx as any, { contacts: [], lists: [] });
    assert(
      'exclusive gate claimed synchronously — concurrent classify gets in-flight',
      { status: second.status, reason: second.status === 'not_ready' ? second.reason : undefined },
      (v) => v.status === 'not_ready' && v.reason === 'in-flight',
      "{ status: 'not_ready', reason: 'in-flight' }",
    );
    release({ text: '{"type":"pass"}' });
    await p1;
  }

  // TEMP classifierRaw diagnostic — logging only; parse outcome unchanged.
  {
    const rawJson = '[{"type":"pass"}]';
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
      origLog(...args);
    };
    try {
      const fakeCtx = {
        completion: async () => ({ text: rawJson }),
      };
      const out = await classifyWithLLM('Who do I call for plumbing?', fakeCtx as any, { contacts: [], lists: [] });
      assert(
        'LL-CR1 classifierRaw logged on successful non-warmup completion',
        logs.some((line) => line.includes('[classifierRaw]') && line.includes('rawJson')),
        (v) => v === true,
        'contains [classifierRaw] with rawJson field',
      );
      assert(
        'LL-CR1 classify outcome unchanged after classifierRaw log',
        out.status === 'ok' && (out.intents?.length ?? 0) === 0,
        (v) => v === true,
        'status ok, pass filtered',
      );

      const warmupLogs: string[] = [];
      console.log = (...args: unknown[]) => {
        warmupLogs.push(args.map(String).join(' '));
        origLog(...args);
      };
      await classifyWithLLM('warmup ping', fakeCtx as any, { contacts: [], lists: [] });
      assert(
        'LL-CR2 warmup completion does not emit classifierRaw',
        warmupLogs.every((line) => !line.includes('[classifierRaw]')),
        (v) => v === true,
        'no [classifierRaw] during warmup',
      );
    } finally {
      console.log = origLog;
    }

    const longRaw = `[{"type":"pass"}]${'x'.repeat(CLASSIFIER_RAW_LOG_MAX + 50)}`;
    const truncated = truncateClassifierRawForLog(longRaw);
    assert(
      'LL-CR3 classifierRaw truncates at CLASSIFIER_RAW_LOG_MAX',
      truncated !== null && truncated.length <= CLASSIFIER_RAW_LOG_MAX + 1,
      (v) => v === true,
      `<= ${CLASSIFIER_RAW_LOG_MAX + 1} chars`,
    );
  }

  // TEMP classifierCompletionSurface diagnostic — logging only; parse outcome unchanged.
  {
    const header = '<|start_header_id|>assistant<|end_header_id|>';
    const readJson = '[{"type":"read","domain":"HOUSEHOLD","entity_type":"service_provider","entity":"plumbing","requested_information":"IDENTITY","raw_phrase":"Who do I call for plumbing?","confidence":"high"}]';
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
      origLog(...args);
    };
    try {
      const fakeResult = {
        tokens_predicted: 3,
        stopped_word: true,
        stopping_word: '\n\n',
        text: header,
        content: readJson,
        accumulated_text: `${header}${readJson}`,
      };
      const fakeCtx = {
        completion: async () => fakeResult,
      };
      const out = await classifyWithLLM('Who do I call for plumbing?', fakeCtx as any, { contacts: [], lists: [] });
      const surfaceLine = logs.find((line) => line.includes('[classifierCompletionSurface]'));
      assert(
        'LL-CS1 completion surface logged on non-warmup classify',
        surfaceLine != null,
        (v) => v === true,
        'contains [classifierCompletionSurface]',
      );
      const payload = surfaceLine
        ? JSON.parse(surfaceLine.slice(surfaceLine.indexOf('{')))
        : null;
      assert(
        'LL-CS2 surface payload includes tokens_predicted and stop fields',
        payload?.tokens_predicted === 3
          && payload?.stopped_word === true
          && payload?.stopping_word === '\n\n',
        (v) => v === true,
        'tokens_predicted 3, stopped_word true, stopping_word newline pair',
      );
      assert(
        'LL-CS3 surface payload includes truncated text/content/accumulated_text',
        payload?.text === header
          && payload?.content === readJson
          && payload?.accumulated_text === `${header}${readJson}`,
        (v) => v === true,
        'all three text surfaces present',
      );
      assert(
        'LL-CS4 classify outcome still driven by result.text only',
        out.status === 'ok' && (out.readIntents?.length ?? 0) === 0 && out.readLabeled === false,
        (v) => v === true,
        'text-only parse unchanged (header-only text, no readLabeled)',
      );

      const warmupLogs: string[] = [];
      console.log = (...args: unknown[]) => {
        warmupLogs.push(args.map(String).join(' '));
        origLog(...args);
      };
      await classifyWithLLM('warmup ping', fakeCtx as any, { contacts: [], lists: [] });
      assert(
        'LL-CS5 warmup does not emit classifierCompletionSurface',
        warmupLogs.every((line) => !line.includes('[classifierCompletionSurface]')),
        (v) => v === true,
        'no [classifierCompletionSurface] during warmup',
      );
    } finally {
      console.log = origLog;
    }

    const longSurface = 'y'.repeat(CLASSIFIER_RAW_LOG_MAX + 80);
    const surfacePayload = buildClassifierCompletionSurfaceLogPayload({
      tokens_predicted: 1,
      stopped_word: false,
      stopping_word: '',
      text: longSurface,
      content: longSurface,
      accumulated_text: longSurface,
    });
    assert(
      'LL-CS6 surface text fields truncate at CLASSIFIER_RAW_LOG_MAX',
      surfacePayload.text != null
        && surfacePayload.content != null
        && surfacePayload.accumulated_text != null
        && surfacePayload.text.length <= CLASSIFIER_RAW_LOG_MAX + 1
        && surfacePayload.content.length <= CLASSIFIER_RAW_LOG_MAX + 1
        && surfacePayload.accumulated_text.length <= CLASSIFIER_RAW_LOG_MAX + 1,
      (v) => v === true,
      `each surface field <= ${CLASSIFIER_RAW_LOG_MAX + 1} chars`,
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LLM Layers Contract: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('llmLayers.test.ts')) {
  runLlmLayersContractTests().catch(console.error);
}
