// Slice B2. Reference, recap, and continuation use the shared semantic lifecycle.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateActiveSubjectSelectionProposal } from '../../src/routing/activeSubjectReference.ts';
import { generateRecapInterpretationProposal } from '../../src/routing/immediateSemanticRecap.ts';
import {
  completeBoundedInterpretation,
  proposeReferenceContinuation,
} from '../../src/routing/semanticProvider.ts';
import { withLlamaContextExclusive } from '../../src/utils/llamaContextExclusive.ts';
import {
  getSemanticContextState,
  peekSemanticCompletionBreadcrumbs,
  resetSemanticCompletionLifecycleForTests,
  runSharedSemanticCompletion,
} from '../../src/utils/semanticCompletionLifecycle.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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

export async function runSemanticReferenceDeadlineB2Tests() {
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

  console.log(`\n${BOLD}-- Reference and recap caller deadlines --${RESET}\n`);
  const src = fs.readFileSync(path.join(ROOT, 'src/routing/semanticProvider.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export async function completeBoundedInterpretation'), src.indexOf('const SPEECH_COMPLETION_PROMPT'));
  assert('1 completeBoundedInterpretation uses the shared lifecycle',
    fn.includes('runSharedSemanticCompletion') && !fn.includes('ctx.completion(') && src.includes('REFERENCE_SEMANTIC_TIMEOUT_MS = 8000'),
    (v) => v === true, 'shared lifecycle');

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const run = await completeBoundedInterpretation('active_reference', d.ctx, { n: 1 }, { timeoutMs: 30 });
    assert('2 active-reference stall returns and leaves DRAINING',
      run.status === 'unavailable' && getSemanticContextState() === 'DRAINING', (v) => v === true, 'DRAINING');
    assert('3 active-reference timeout binds no referent',
      run.status === 'unavailable' && !('value' in run), (v) => v === true, 'no value');
    d.resolve({ text: '{"applicable":true,"selectedIndex":0,"ambiguous":false,"confidence":0.9}' });
    await wait(15);
    assert('4 late active-reference result is discarded',
      run.status === 'unavailable'
      && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
      (v) => v === true, 'discarded');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const ctx = {
      completion: async () => ({ text: '{"applicable":false,"selectedIndex":null,"ambiguous":false,"confidence":0.2}' }),
    };
    const gen = await generateActiveSubjectSelectionProposal('how is the weather', [], () => ctx as never);
    assert('5 in-time active-reference proposal is unchanged',
      gen.status === 'ok' && gen.proposal.applicable === false, (v) => v === true, 'not applicable');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const proposed = await completeBoundedInterpretation('reference_continuation', d.ctx, { n: 1 }, { timeoutMs: 30 });
    assert('6 reference-continuation stall falls back',
      proposed.status === 'unavailable' && getSemanticContextState() === 'DRAINING', (v) => v === true, 'unavailable draining');
    assert('7 reference-continuation unavailable does not bind',
      proposed.status === 'unavailable', (v) => v === true, 'unavailable');
    d.resolve({ text: 'applicable' });
    await wait(15);
    assert('7b late continuation result stays unbound',
      proposed.status === 'unavailable' && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
      (v) => v === true, 'discarded');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const ctx = { completion: async () => ({ text: 'applicable' }) };
    const proposed = await proposeReferenceContinuation('What about him?', ctx as never, { groundedPeople: true });
    assert('8 in-time reference continuation still proposes applicable',
      proposed?.applicable === true, (v) => v === true, 'applicable');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const gen = await completeBoundedInterpretation('recap', d.ctx, { n: 1 }, { timeoutMs: 30 });
    assert('9 recap stall skips enrichment within the deadline',
      gen.status === 'unavailable' && getSemanticContextState() === 'DRAINING', (v) => v === true, 'unavailable');
    d.resolve({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.9}' });
    await wait(15);
    assert('10 late recap is discarded',
      gen.status === 'unavailable'
      && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
      (v) => v === true, 'discarded');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const holder = deferred();
    await runSharedSemanticCompletion(() => holder.ctx, { n: 1 }, { callerDeadlineMs: 20 });
    let calls = 0;
    const ctx = {
      completion: async () => { calls += 1; return { text: 'applicable' }; },
    };
    const active = await generateActiveSubjectSelectionProposal('him', [], () => ctx as never);
    const cont = await proposeReferenceContinuation('What about that?', ctx as never);
    const recap = await generateRecapInterpretationProposal('again', [], () => ctx as never);
    assert('11 draining blocks all three paths with zero native calls',
      calls === 0 && active.status === 'unavailable' && cont === null && recap.status === 'unavailable',
      (v) => v === true, 'zero');
    holder.resolve({ text: '{"ok":true}' });
    await wait(10);
  }

  resetSemanticCompletionLifecycleForTests();
  {
    let calls = 0;
    let release: (() => void) | null = null;
    const held = withLlamaContextExclusive('classifier', 'try', () => new Promise<void>((resolve) => { release = resolve; }));
    await wait(5);
    const run = await completeBoundedInterpretation('recap', {
      completion: async () => { calls += 1; return { text: 'no' }; },
    }, { n: 1 }, { timeoutMs: 30 });
    assert('12 classifier ownership fails the semantic request fast',
      run.status === 'unavailable' && calls === 0, (v) => v === true, 'busy');
    release?.();
    await held;
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const run = await completeBoundedInterpretation('active_reference', d.ctx, { n: 1 }, { timeoutMs: 20 });
    d.resolve({ text: '{"applicable":true,"selectedIndex":0}' });
    await wait(15);
    assert('13 timeout cannot deliver a referent or focus mutation',
      run.status === 'unavailable' && !('value' in run), (v) => v === true, 'no mutation');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticReferenceDeadlineB2: ${passed}/${total} passed${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').includes('semanticReferenceDeadlineB2')) {
  runSemanticReferenceDeadlineB2Tests().then((r) => process.exit(r.failed ? 1 : 0));
}
