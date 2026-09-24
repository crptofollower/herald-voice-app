// Shared 3B semantic completion lifecycle — native ownership until settlement.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSemanticNativeCompletionInFlight,
  resetSemanticCompletionLifecycleForTests,
  runSharedSemanticCompletion,
} from '../../src/utils/semanticCompletionLifecycle.ts';
import { generateRecollectionSemanticProposal } from '../../src/routing/recollectionSemanticNomination.ts';
import { generateGrocerySemanticProposal } from '../../src/routing/grocerySemanticDecomposition.ts';
import { generateTodoSemanticProposal } from '../../src/routing/todoSemanticCapture.ts';
import { generateMedicationSemanticProposal } from '../../src/routing/medicationSemanticInterpretation.ts';
import { generateCapabilityProposal } from '../../src/routing/capabilityRouting.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function deferredCompletion() {
  const calls: unknown[] = [];
  let settle: ((value: unknown) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  const ctx = {
    completion: (params: unknown) => {
      calls.push(params);
      return new Promise((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
    },
  };
  return {
    ctx,
    calls,
    resolve: (value: unknown) => { settle?.(value); },
    reject: (err: Error) => { fail?.(err); },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

export async function runSemanticCompletionLifecycleV1Tests() {
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

  console.log(`\n${BOLD}-- Shared 3B Semantic Completion Lifecycle V1 ---------------${RESET}\n`);

  resetSemanticCompletionLifecycleForTests();

  {
    let n = 0;
    const ctx = {
      completion: async () => {
        n += 1;
        return { text: '{"ok":true}' };
      },
    };
    const a = await runSharedSemanticCompletion(() => ctx, { n: 1 });
    const b = await runSharedSemanticCompletion(() => ctx, { n: 2 });
    assert('A normal completion releases ownership so a second request executes',
      a.status === 'ok' && b.status === 'ok' && n === 2
        && isSemanticNativeCompletionInFlight() === false,
      (v) => v === true, 'two native completions after settle');
  }

  resetSemanticCompletionLifecycleForTests();

  {
    const d = deferredCompletion();
    const first = generateRecollectionSemanticProposal('The summer I turned eight we slept on the porch.', () => d.ctx, {
      timeoutMs: 40,
    });
    await tick();
    const timed = await first;
    const held = isSemanticNativeCompletionInFlight();
    const before = d.calls.length;
    const grocery = await generateGrocerySemanticProposal('add milk', () => d.ctx);
    const todo = await generateTodoSemanticProposal('remind me to call the bank', () => d.ctx);
    const med = await generateMedicationSemanticProposal('I take eliquis', () => d.ctx);
    const cap = await generateCapabilityProposal('what medications am I on', () => d.ctx);
    assert('B caller timeout keeps native ownership; second request does not call completion',
      timed.status === 'unavailable' && timed.reason === 'timeout'
        && held === true
        && grocery.status === 'unavailable' && grocery.reason === 'in_flight'
        && todo.status === 'unavailable' && todo.reason === 'in_flight'
        && med.status === 'unavailable'
        && cap.status === 'unavailable' && cap.reason === 'in_flight'
        && d.calls.length === before
        && before === 1,
      (v) => v === true, 'timeout + in_flight, one native call');
    d.resolve({ text: '{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}' });
    await tick();
    assert('C ownership releases only after original completion settles',
      isSemanticNativeCompletionInFlight() === false,
      (v) => v === true, 'inFlight false after settle');
    let laterCalls = 0;
    const laterCtx = {
      completion: async () => {
        laterCalls += 1;
        return { text: '{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}' };
      },
    };
    const later = await generateRecollectionSemanticProposal('The summer I turned eight we slept on the porch.', () => laterCtx, {
      timeoutMs: 200,
    });
    assert('C later request may execute after settlement',
      later.status === 'ok' && laterCalls === 1,
      (v) => v === true, 'second native completion after settle');
  }

  resetSemanticCompletionLifecycleForTests();

  {
    let n = 0;
    const ctx = {
      completion: async () => {
        n += 1;
        if (n === 1) throw new Error('native failed');
        return { text: '{"ok":true}' };
      },
    };
    const a = await runSharedSemanticCompletion(() => ctx, { n: 1 });
    const b = await runSharedSemanticCompletion(() => ctx, { n: 2 });
    assert('D native rejection releases ownership; subsequent request can execute',
      a.status === 'unavailable' && a.reason === 'error'
        && b.status === 'ok' && n === 2,
      (v) => v === true, 'error then retry');
  }

  resetSemanticCompletionLifecycleForTests();

  {
    let called = 0;
    const run = await runSharedSemanticCompletion(() => null, { n: 1 });
    const rec = await generateRecollectionSemanticProposal('hello', () => null);
    assert('E context unavailable fails closed with no completion',
      run.status === 'unavailable' && run.reason === 'no_ctx'
        && rec.status === 'unavailable' && rec.reason === 'no_ctx'
        && called === 0
        && isSemanticNativeCompletionInFlight() === false,
      (v) => v === true, 'no_ctx');
  }

  resetSemanticCompletionLifecycleForTests();

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const files = [
    'src/utils/semanticCompletionLifecycle.ts',
    'src/routing/recollectionSemanticNomination.ts',
    'src/routing/grocerySemanticDecomposition.ts',
    'src/routing/todoSemanticCapture.ts',
    'src/routing/medicationSemanticInterpretation.ts',
    'src/routing/capabilityRouting.ts',
  ].map((rel) => ({ rel, src: fs.readFileSync(path.join(root, rel), 'utf8') }));

  assert('consumers use the shared primitive and recollection/grocery/todo do not Promise.race native completion',
    files.every((f) => f.rel.endsWith('semanticCompletionLifecycle.ts')
      || f.src.includes('runSharedSemanticCompletion')
      || f.src.includes('runSpecialistInference'))
      && !files.filter((f) => /recollection|grocery|todo/.test(f.rel)).some((f) => f.src.includes('Promise.race')),
    (v) => v === true, 'shared owner, no consumer race');

  assert('shared primitive never calls stopCompletion',
    !files[0].src.includes('stopCompletion'),
    (v) => v === true, 'no stopCompletion');

  assert('caller deadline remains 8000ms evidence value, not raised',
    files.find((f) => f.rel.includes('grocery'))!.src.includes('GROCERY_SEMANTIC_TIMEOUT_MS = 8000')
      && files.find((f) => f.rel.includes('todo'))!.src.includes('TODO_SEMANTIC_TIMEOUT_MS = 8000')
      && files.find((f) => f.rel.includes('recollection'))!.src.includes('RECOLLECTION_SEMANTIC_TIMEOUT_MS = 8000'),
    (v) => v === true, '8000 caller deadline');

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticCompletionLifecycleV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('semanticCompletionLifecycle')) {
  runSemanticCompletionLifecycleV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
