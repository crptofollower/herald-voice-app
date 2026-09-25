// B3a. Two fixed lifecycle records share one native-compute gate.

import { proposeSpeechCompletion } from '../../src/routing/semanticProvider.ts';
import { classifySemanticEngineReadiness, emptySemanticEngineDiagnostic } from '../../src/dev/semanticEngineReadiness.ts';
import {
  beginCtxCompletion,
  endCtxCompletion,
  getPrevCtxCompletionMeta,
} from '../../src/utils/latencyInstrument.ts';
import { releaseSemanticCompletion } from '../../src/utils/llamaContextExclusive.ts';
import {
  getKeyedSemanticContextState,
  getSemanticContextState,
  peekSemanticCompletionBreadcrumbs,
  resetSemanticCompletionLifecycleForTests,
  runKeyedSemanticCompletion,
  runSharedSemanticCompletion,
} from '../../src/utils/semanticCompletionLifecycle.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  const calls: unknown[] = [];
  let settle: ((v: unknown) => void) | null = null;
  return {
    ctx: {
      completion: (params: unknown) => {
        calls.push(params);
        return new Promise((resolve) => { settle = resolve; });
      },
    },
    calls,
    resolve: (v: unknown) => settle?.(v),
  };
}

export async function runSemanticContextKeyedOwnershipTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${JSON.stringify(got)}\n       expected: ${expected}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Context-keyed semantic ownership --${RESET}\n`);
  resetSemanticCompletionLifecycleForTests({ recoveryHorizonMs: 40 });
  assert('1 shared-semantic begins READY', getSemanticContextState() === 'READY', (v) => v === true, 'READY');

  const shared = deferred();
  const sharedRun = await runSharedSemanticCompletion(() => shared.ctx, { n: 1 }, { callerDeadlineMs: 20 });
  assert('2 shared deadline moves only shared-semantic to DRAINING',
    sharedRun.reason === 'timeout' && getSemanticContextState() === 'DRAINING', (v) => v === true, 'DRAINING');
  assert('3 classifier record stays READY while shared drains',
    getKeyedSemanticContextState('classifier') === 'READY', (v) => v === true, 'READY');
  const sharedToken = shared.calls.length;
  shared.resolve({ text: '{"ok":true}' });
  await wait(15);
  assert('9 shared late result is still discarded',
    sharedRun.status === 'unavailable'
    && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
    (v) => v === true, 'discarded');
  assert('8 a settled shared token cannot be reused as a live owner',
    sharedToken === 1 && releaseSemanticCompletion(1) === false && getSemanticContextState() === 'READY',
    (v) => v === true, 'released');

  resetSemanticCompletionLifecycleForTests({ recoveryHorizonMs: 40 });
  const classifier = deferred();
  const classifierRun = await runKeyedSemanticCompletion('classifier', () => classifier.ctx, { n: 1 }, { callerDeadlineMs: 20 });
  assert('4 classifier DRAINING leaves shared-semantic READY',
    classifierRun.reason === 'timeout'
    && getKeyedSemanticContextState('classifier') === 'DRAINING'
    && getSemanticContextState() === 'READY',
    (v) => v === true, 'isolated');
  await wait(50);
  assert('5 classifier UNHEALTHY leaves shared-semantic READY',
    getKeyedSemanticContextState('classifier') === 'UNHEALTHY' && getSemanticContextState() === 'READY',
    (v) => v === true, 'shared ready');
  const ready = emptySemanticEngineDiagnostic();
  ready.semanticEngineStatus = 'ready';
  ready.initLlama = 'succeeded';
  ready.contextHeld = true;
  ready.semanticContextHeld = true;
  ready.semanticCompletionState = 'READY';
  ready.semanticUsable = true;
  assert('11 shared readiness ignores classifier UNHEALTHY',
    classifySemanticEngineReadiness(ready) === 'READY' && getSemanticContextState() === 'READY',
    (v) => v === true, 'READY');
  classifier.resolve({ text: '{"ok":true}' });
  await wait(10);

  resetSemanticCompletionLifecycleForTests();
  const owner = deferred();
  const held = runSharedSemanticCompletion(() => owner.ctx, { n: 1 });
  await wait(5);
  let classifierCalls = 0;
  const refused = await runKeyedSemanticCompletion('classifier', () => ({
    completion: () => { classifierCalls += 1; return { text: 'no' }; },
  }), { n: 2 });
  assert('6 shared native owner refuses classifier admission',
    refused.status === 'unavailable' && classifierCalls === 0 && getKeyedSemanticContextState('classifier') === 'READY',
    (v) => v === true, 'refused');
  owner.resolve({ text: '{"ok":true}' });
  await held;

  resetSemanticCompletionLifecycleForTests();
  const classOwner = deferred();
  const classHeld = runKeyedSemanticCompletion('classifier', () => classOwner.ctx, { n: 1 });
  await wait(5);
  let sharedCalls = 0;
  const sharedRefused = await runSharedSemanticCompletion(() => ({
    completion: () => { sharedCalls += 1; return { text: 'no' }; },
  }), { n: 2 });
  assert('7 classifier native owner refuses shared admission',
    sharedRefused.status === 'unavailable' && sharedCalls === 0 && getSemanticContextState() === 'READY',
    (v) => v === true, 'refused');
  classOwner.resolve({ text: '{"ok":true}' });
  await classHeld;

  resetSemanticCompletionLifecycleForTests({ recoveryHorizonMs: 30 });
  const unhealthy = deferred();
  await runSharedSemanticCompletion(() => unhealthy.ctx, { n: 1 }, { callerDeadlineMs: 15 });
  await wait(50);
  assert('10 shared UNHEALTHY does not change the classifier record',
    getSemanticContextState() === 'UNHEALTHY' && getKeyedSemanticContextState('classifier') === 'READY',
    (v) => v === true, 'classifier ready');
  unhealthy.resolve({ text: '{"ok":true}' });
  await wait(10);

  endCtxCompletion(beginCtxCompletion('ephemeral'), 'ephemeral', 1, { timings: { prompt_ms: 1 } });
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
    original(...args);
  };
  const speech = await proposeSpeechCompletion('Jane Q Public takes lisinopril', {
    completion: async () => ({
      text: 'complete',
      timings: { prompt_ms: 3, predicted_ms: 4, cache_n: 5, prompt_n: 6 },
    }),
  } as never);
  const unrecognized = await proposeSpeechCompletion('hello', {
    completion: async () => ({ text: 'maybe Jane' }),
  } as never);
  console.log = original;
  const joined = lines.filter((l) => l.includes('speech')).join('\n');
  assert('12 speech logs omit transcript and model text',
    joined.includes('"consumer":"speech"') && joined.includes('prompt_ms')
    && !joined.includes('Jane') && !joined.includes('lisinopril') && !joined.includes('Reply with one word'),
    (v) => v === true, 'no text');
  assert('13 speech result and classifier cursor stay unchanged',
    speech === 'complete' && unrecognized === 'uncertain' && getPrevCtxCompletionMeta().prevConsumer === 'ephemeral',
    (v) => v === true, 'ephemeral cursor');

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticContextKeyedOwnership: ${passed}/${total} passed${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').includes('semanticContextKeyedOwnership')) {
  runSemanticContextKeyedOwnershipTests().then((r) => process.exit(r.failed ? 1 : 0));
}
