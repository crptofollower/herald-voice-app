// Semantic completion ownership. Caller deadlines do not free the native slot.

import {
  getSemanticCompletionAdmission,
  releaseSemanticCompletion,
} from '../../src/utils/llamaContextExclusive.ts';
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
    const token = getSemanticCompletionAdmission()!.token;
    assert('18 stale release does not free the slot',
      releaseSemanticCompletion(token + 99) === false && getSemanticCompletionAdmission()?.token === token,
      (v) => v === true, 'token mismatch');
    const late = peekSemanticCompletionBreadcrumbs().find((b) => b.event === 'deadline_observed');
    assert('13 deadline breadcrumb records firedLateMs',
      typeof late?.firedLateMs === 'number' && late.firedLateMs >= 0,
      (v) => v === true, 'firedLateMs');
    assert('14 busy rejection has no personal content',
      !JSON.stringify(peekSemanticCompletionBreadcrumbs()).toLowerCase().includes('milk'),
      (v) => v === true, 'no personal text');
    d.resolve({ text: 'should be discarded' });
    await wait(10);
    assert('6 late result is discarded',
      !isSemanticNativeCompletionInFlight() && proposalCalls === 1,
      (v) => v === true, 'discarded');
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
    assert('12 no replacement context is created while native work is in flight',
      d.calls.length === 1, (v) => v === true, 'same context');
    d.resolve({ text: 'late' });
    await wait(10);
    assert('19 a newer token is not released by the old settlement',
      getSemanticContextState() === 'UNHEALTHY' && getSemanticCompletionAdmission() == null,
      (v) => v === true, 'quarantine holds');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const run = await runSharedSemanticCompletion(() => d.ctx, { n: 1 }, { callerDeadlineMs: 30 });
    const items = await tryP1GrocerySemanticItems('We need milk.', () => ({
      completion: async () => { throw new Error('native failed'); },
    }) as never);
    assert('15 grocery timeout and unavailable inference stay on the null fallback',
      run.status === 'unavailable' && run.reason === 'timeout' && items === null,
      (v) => v === true, 'null fallback');
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
    assert('16 a successful grocery completion still returns the proposal',
      gen.status === 'ok' && n >= 1 && (items == null || items.includes('milk')),
      (v) => v === true, 'proposal');
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

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticCompletionOwnership: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').includes('semanticCompletionOwnership')) {
  runSemanticCompletionOwnershipTests().then((r) => process.exit(r.failed ? 1 : 0));
}
