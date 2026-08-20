// scripts/heraldTest/llmLoadingNotReady.test.ts
// Step 0: when llmStatus==='loading' and llmReady===false, tier-3 fallthrough
// must be kind:'not_ready' (honest waking-up), not needs_clarification.
// Runner: npx tsx scripts/heraldTest/llmLoadingNotReady.test.ts

import { routeIntent } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runLlmLoadingNotReadyTests(): Promise<{
  passed: number;
  failed: number;
  total: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- LLM Loading → not_ready (Step 0) -----------------------${RESET}\n`);

  const nonsense = 'asdf qwer zxcv nonsense phrase';

  {
    const decision = await routeIntent(nonsense, {
      classifyQuery: async () => ({ tier: 3, reason: 'default' }),
      classifyLLM: async () => ({ status: 'ok', intents: [] }),
      llmReady: false,
      llmStatus: 'loading',
    });
    assert(
      'loading + !llmReady → not_ready (not needs_clarification)',
      decision,
      (v) => typeof v === 'object' && v !== null && (v as { kind: string }).kind === 'not_ready'
        && String((v as { reason?: string }).reason).includes('loading'),
      "{ kind: 'not_ready', reason includes loading }",
    );
  }

  {
    const decision = await routeIntent(nonsense, {
      classifyQuery: async () => ({ tier: 3, reason: 'default' }),
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
    });
    assert(
      'unavailable + !llmReady → needs_clarification (flag-off path preserved)',
      decision,
      (v) => typeof v === 'object' && v !== null && (v as { kind: string }).kind === 'needs_clarification',
      "{ kind: 'needs_clarification' }",
    );
  }

  {
    let classifyCalled = false;
    const decision = await routeIntent(nonsense, {
      classifyQuery: async () => ({ tier: 3, reason: 'live:data' }),
      classifyLLM: async () => {
        classifyCalled = true;
        return { status: 'ok', intents: [] };
      },
      llmReady: false,
      llmStatus: 'loading',
    });
    assert(
      'loading + live:data → backend (network still allowed)',
      decision,
      (v) => typeof v === 'object' && v !== null && (v as { kind: string }).kind === 'backend',
      "{ kind: 'backend' }",
    );
    assert('loading + live:data did not call classifyLLM', classifyCalled, (v) => v === false, 'false');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LlmLoadingNotReady: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('llmLoadingNotReady.test.ts')) {
  runLlmLoadingNotReadyTests().catch(console.error);
}
