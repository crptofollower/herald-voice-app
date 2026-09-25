// Semantic completion ownership. Caller deadlines do not free the native slot.

import {
  getSemanticCompletionAdmission,
  releaseSemanticCompletion,
  runExclusiveContextRelease,
  withLlamaContextExclusive,
} from '../../src/utils/llamaContextExclusive.ts';
import { classifyWithLLM, warmupClassifier } from '../../src/hooks/llmLayers.ts';
import { classifySemanticEngineReadiness, emptySemanticEngineDiagnostic } from '../../src/dev/semanticEngineReadiness.ts';
import {
  getSemanticContextState,
  isSemanticNativeCompletionInFlight,
  peekSemanticCompletionBreadcrumbs,
  resetSemanticCompletionLifecycleForTests,
  runSharedSemanticCompletion,
} from '../../src/utils/semanticCompletionLifecycle.ts';
import {
  generateGrocerySemanticProposal,
  tryP1GrocerySemanticItems,
} from '../../src/routing/grocerySemanticDecomposition.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function deferred() {
  const calls: unknown[] = [];
  let settle: ((v: unknown) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  return {
    ctx: {
      completion: (params: unknown) => {
        calls.push(params);
        return new Promise((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
      },
    },
    calls,
    resolve: (v: unknown) => settle?.(v),
    reject: (e: Error) => fail?.(e),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSemanticCompletionOwnershipTests() {
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

  console.log(`\n${BOLD}-- Semantic Completion Ownership --${RESET}\n`);
  resetSemanticCompletionLifecycleForTests();

  {
    const d = deferred();
    const first = runSharedSemanticCompletion(() => d.ctx, { n: 1 });
    await wait(5);
    assert('1 first completion acquires ownership',
      getSemanticContextState() === 'OWNED' && isSemanticNativeCompletionInFlight() && d.calls.length === 1,
      (v) => v === true, 'owned');
    const second = await runSharedSemanticCompletion(() => d.ctx, { n: 2 });
    assert('2 occupied slot fails fast and does not call native completion',
      second.status === 'unavailable' && d.calls.length === 1,
      (v) => v === true, 'no second call');
    d.resolve({ text: '{"ok":true}' });
    await first;
    await wait(5);
  }

  resetSemanticCompletionLifecycleForTests({ recoveryHorizonMs: 40 });
  {
    const d = deferred();
    let proposalCalls = 0;
    const run = await runSharedSemanticCompletion(() => d.ctx, { n: 1 }, {
      callerDeadlineMs: 30,
      onAcquired: () => { proposalCalls += 1; },
    });
    assert('3 caller deadline returns without native settlement',
      run.status === 'unavailable' && run.reason === 'timeout' && isSemanticNativeCompletionInFlight(),
      (v) => v === true, 'timeout while native held');
    assert('4 timeout moves the context to DRAINING', getSemanticContextState() === 'DRAINING', (v) => v === true, 'DRAINING');
    assert('5 native slot stays owned during DRAINING',
      getSemanticCompletionAdmission() != null, (v) => v === true, 'slot held');
    const admission = getSemanticCompletionAdmission();
    assert('5b admission is present before token checks', admission != null, (v) => v === true, 'admission');
    const token = admission?.token ?? -1;
    assert('18 stale release does not free the slot',
      releaseSemanticCompletion(token + 99) === false && getSemanticCompletionAdmission()?.token === token,
      (v) => v === true, 'token mismatch');
    const late = peekSemanticCompletionBreadcrumbs().find((b) => b.event === 'deadline_observed');
    assert('13 deadline breadcrumb records firedLateMs',
      typeof late?.firedLateMs === 'number' && late.firedLateMs >= 0,
      (v) => v === true, 'firedLateMs');
    const validLate = { text: JSON.stringify({ capability: 'grocery_capture', candidates: ['milk'], confidence: 0.9 }) };
    d.resolve(validLate);
    await wait(10);
    assert('6 late valid result never reaches the consumer',
      run.status === 'unavailable' && run.reason === 'timeout' && !('value' in run),
      (v) => v === true, 'timeout only');
    assert('7 late completion does not invoke another proposal callback', proposalCalls === 1, (v) => v === true, 'once');
    assert('8 settlement after abandonment releases ownership',
      getSemanticCompletionAdmission() == null, (v) => v === true, 'released');
    assert('9 healthy context returns READY only after settlement',
      getSemanticContextState() === 'READY', (v) => v === true, 'READY');
  }

  resetSemanticCompletionLifecycleForTests({ recoveryHorizonMs: 40 });
  {
    const d = deferred();
    await runSharedSemanticCompletion(() => d.ctx, { n: 1 }, { callerDeadlineMs: 20 });
    await wait(70);
    assert('10 recovery horizon marks the context UNHEALTHY',
      getSemanticContextState() === 'UNHEALTHY' && isSemanticNativeCompletionInFlight(),
      (v) => v === true, 'UNHEALTHY');
    const before = d.calls.length;
    const refused = await runSharedSemanticCompletion(() => d.ctx, { n: 2 });
    assert('11 UNHEALTHY context refuses inference',
      refused.status === 'unavailable' && d.calls.length === before,
      (v) => v === true, 'refused');
    assert('12 UNHEALTHY lifecycle refuses native semantic invocation',
      refused.status === 'unavailable' && d.calls.length === before,
      (v) => v === true, 'refused');
    d.resolve({ text: 'late' });
    await wait(10);
    assert('19a quarantine remains after the abandoned settlement',
      getSemanticContextState() === 'UNHEALTHY' && getSemanticCompletionAdmission() == null,
      (v) => v === true, 'quarantine holds');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const first = deferred();
    const abandoned = await runSharedSemanticCompletion(() => first.ctx, { n: 1 }, { callerDeadlineMs: 20 });
    const oldToken = getSemanticCompletionAdmission()?.token ?? -1;
    first.resolve({ text: '{"stale":true}' });
    await wait(15);
    const second = deferred();
    const newer = runSharedSemanticCompletion(() => second.ctx, { n: 2 });
    await wait(5);
    const newToken = getSemanticCompletionAdmission()?.token ?? -1;
    assert('19 stale token cannot release the newer owner',
      abandoned.reason === 'timeout' && oldToken !== newToken && releaseSemanticCompletion(oldToken) === false
      && getSemanticCompletionAdmission()?.token === newToken && second.calls.length === 1,
      (v) => v === true, 'newer token held');
    second.resolve({ text: '{"ok":true}' });
    await newer;
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const run = await runSharedSemanticCompletion(() => d.ctx, { n: 1 }, { callerDeadlineMs: 30 });
    const personal = 'Jane Q Public takes lisinopril and call Shannon';
    const busy = await runSharedSemanticCompletion(() => d.ctx, { utterance: personal });
    const crumbs = JSON.stringify(peekSemanticCompletionBreadcrumbs());
    assert('14 busy and timeout breadcrumbs omit personal fixture text',
      busy.status === 'unavailable' && !crumbs.includes('Jane') && !crumbs.includes('lisinopril') && !crumbs.includes('Shannon'),
      (v) => v === true, 'no personal text');
    let groceryCalls = 0;
    const items = await tryP1GrocerySemanticItems('We need milk.', () => ({
      completion: async () => {
        groceryCalls += 1;
        return { text: JSON.stringify({ capability: 'grocery_capture', candidates: ['milk'], confidence: 0.9 }) };
      },
    }) as never);
    assert('15 grocery draining refusal makes zero native calls and falls back',
      run.status === 'unavailable' && run.reason === 'timeout' && items === null && groceryCalls === 0,
      (v) => v === true, 'null fallback, zero calls');
    d.resolve({ text: 'late' });
    await wait(5);
  }

  resetSemanticCompletionLifecycleForTests();
  {
    let n = 0;
    const ctx = {
      completion: async () => {
        n += 1;
        return { text: JSON.stringify({ capability: 'grocery_capture', candidates: ['milk'], confidence: 0.9 }) };
      },
    };
    const gen = await generateGrocerySemanticProposal('We need milk.', () => ctx as never);
    const items = await tryP1GrocerySemanticItems('We need milk.', () => ctx as never);
    assert('16 a successful grocery completion returns the semantic items',
      gen.status === 'ok' && n === 2 && items != null && items.includes('milk'),
      (v) => v === true, 'milk');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const ctx = {
      completion: async () => { throw new Error('native failed'); },
    };
    const run = await runSharedSemanticCompletion(() => ctx, { n: 1 });
    assert('17 native rejection releases ownership',
      run.status === 'unavailable' && run.reason === 'error' && !isSemanticNativeCompletionInFlight() && getSemanticContextState() === 'READY',
      (v) => v === true, 'released');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const run = await runSharedSemanticCompletion(() => d.ctx, { n: 1 }, {
      onAcquired: () => { throw new Error('callback exploded'); },
    });
    assert('L onAcquired throw releases the slot and fails closed',
      run.status === 'unavailable' && run.reason === 'error' && d.calls.length === 0
      && getSemanticContextState() === 'READY' && getSemanticCompletionAdmission() == null
      && !JSON.stringify(peekSemanticCompletionBreadcrumbs()).includes('callback exploded'),
      (v) => v === true, 'released error');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const held = runSharedSemanticCompletion(() => d.ctx, { n: 1 });
    await wait(5);
    let classifierCalls = 0;
    const classifier = await withLlamaContextExclusive('classifier', 'try', async () => { classifierCalls += 1; });
    let ephemeralCalls = 0;
    const ephemeral = await withLlamaContextExclusive('ephemeral', 'try', async () => { ephemeralCalls += 1; });
    assert('B2 classifier try is refused while semantic owns the gate',
      classifier.ok === false && classifierCalls === 0, (v) => v === true, 'refused');
    assert('B2 ephemeral try is refused while semantic owns the gate',
      ephemeral.ok === false && ephemeralCalls === 0, (v) => v === true, 'refused');
    let releaseStarted = false;
    const release = runExclusiveContextRelease(async () => { releaseStarted = true; });
    await wait(20);
    assert('B2 context release waits through an active semantic drain',
      releaseStarted === false && isSemanticNativeCompletionInFlight(), (v) => v === true, 'still draining');
    d.resolve({ text: '{"ok":true}' });
    await held;
    await release;
    assert('B2 context release proceeds after semantic settlement',
      releaseStarted === true && getSemanticContextState() === 'READY', (v) => v === true, 'released');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    let semanticCalls = 0;
    let releaseClassifier: (() => void) | null = null;
    const held = withLlamaContextExclusive('classifier', 'try', () => new Promise<void>((resolve) => {
      releaseClassifier = resolve;
    }));
    await wait(5);
    const refused = await runSharedSemanticCompletion(() => ({
      completion: () => { semanticCalls += 1; return { text: '{"ok":true}' }; },
    }), { n: 1 });
    assert('B2 semantic admission is refused while classifier owns the gate',
      refused.status === 'unavailable' && semanticCalls === 0, (v) => v === true, 'busy');
    releaseClassifier?.();
    await held;
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const held = runSharedSemanticCompletion(() => d.ctx, { n: 1 });
    await wait(5);
    const turn = await classifyWithLLM('add milk', { completion: async () => ({ text: '[{"type":"pass"}]' }) } as never, { contacts: [], lists: [] });
    assert('C normal classifier turn stays non-queuing under semantic ownership',
      turn.status === 'not_ready' && turn.reason === 'in-flight', (v) => v === true, 'in-flight');
    let warmupCalls = 0;
    const warmup = warmupClassifier({
      completion: async () => {
        warmupCalls += 1;
        return { text: '[{"type":"pass"}]' };
      },
    } as never);
    await wait(20);
    assert('B warmup stays pending and does not treat ownership as classifier failure',
      warmupCalls === 0, (v) => v === true, 'waiting');
    d.resolve({ text: '{"ok":true}' });
    await held;
    await warmup;
    assert('B warmup runs after the semantic slot is released',
      warmupCalls === 1 && getSemanticContextState() === 'READY', (v) => v === true, 'warmed');
  }

  {
    const held = emptySemanticEngineDiagnostic();
    held.semanticEngineStatus = 'ready';
    held.initLlama = 'succeeded';
    held.contextHeld = true;
    held.semanticContextHeld = true;
    held.modelFilePresent = true;
    held.semanticCompletionState = 'DRAINING';
    held.semanticUsable = false;
    assert('M held plus DRAINING is not proof-ready',
      classifySemanticEngineReadiness(held) === 'PENDING', (v) => v === true, 'PENDING');
    held.semanticCompletionState = 'UNHEALTHY';
    assert('N held plus UNHEALTHY is not proof-ready',
      classifySemanticEngineReadiness(held) === 'PENDING', (v) => v === true, 'PENDING');
    held.semanticCompletionState = 'READY';
    held.semanticUsable = true;
    assert('O held plus READY is proof-ready',
      classifySemanticEngineReadiness(held) === 'READY', (v) => v === true, 'READY');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
      original(...args);
    };
    const d = deferred();
    const run = await runSharedSemanticCompletion(() => d.ctx, { secret: 'Jane Q Public lisinopril' }, { callerDeadlineMs: 20 });
    d.resolve({ text: '{"ok":true}' });
    await wait(10);
    console.log = original;
    const joined = lines.filter((l) => l.includes('SEMANTIC_COMPLETION_LIFECYCLE')).join('\n');
    assert('P lifecycle breadcrumbs reach the latency diagnostic',
      run.reason === 'timeout'
      && joined.includes('semantic_requested')
      && joined.includes('slot_acquired')
      && joined.includes('native_invoke_started')
      && joined.includes('deadline_observed')
      && joined.includes('firedLateMs')
      && joined.includes('caller_abandoned')
      && joined.includes('DRAINING')
      && joined.includes('late_result_discarded')
      && joined.includes('slot_released')
      && joined.includes('READY')
      && !joined.includes('Jane')
      && !joined.includes('lisinopril'),
      (v) => v === true, 'device breadcrumb');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticCompletionOwnership: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').includes('semanticCompletionOwnership')) {
  runSemanticCompletionOwnershipTests().then((r) => process.exit(r.failed ? 1 : 0));
}
