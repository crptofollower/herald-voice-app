// scripts/heraldTest/llmLayers.test.ts
// classifyWithLLM decode-config contract — greedy/deterministic completion params.
// Pins temperature/top_k/seed so the on-device classifier cannot silently
// drift back to sampling. One assertion; mock ctx.completion captures params.

import { classifyWithLLM } from '../../src/hooks/llmLayers.ts';

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
