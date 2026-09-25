// Slice B1. Capability and medication use the shared 8000ms caller deadline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCapabilityProposal } from '../../src/routing/capabilityRouting.ts';
import {
  admitMedicationSemanticProposal,
  generateMedicationSemanticProposal,
} from '../../src/routing/medicationSemanticInterpretation.ts';
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

export async function runSemanticCallerDeadlineB1Tests() {
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

  console.log(`\n${BOLD}-- Capability and medication caller deadlines --${RESET}\n`);
  const capSrc = fs.readFileSync(path.join(ROOT, 'src/routing/capabilityRouting.ts'), 'utf8');
  const medSrc = fs.readFileSync(path.join(ROOT, 'src/routing/medicationSemanticInterpretation.ts'), 'utf8');
  assert('production deadlines stay 8000ms',
    capSrc.includes('CAPABILITY_SEMANTIC_TIMEOUT_MS = 8000')
    && medSrc.includes('MEDICATION_SEMANTIC_TIMEOUT_MS = 8000'),
    (v) => v === true, '8000');

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const gen = await generateCapabilityProposal('what is on my list', () => d.ctx as never, { timeoutMs: 30 });
    assert('1 capability stall returns timeout',
      gen.status === 'unavailable' && gen.reason === 'timeout', (v) => v === true, 'timeout');
    assert('2 capability timeout leaves the context DRAINING',
      getSemanticContextState() === 'DRAINING', (v) => v === true, 'DRAINING');
    assert('3 capability timeout admits no capability',
      gen.status !== 'ok', (v) => v === true, 'no proposal');
    const valid = { text: JSON.stringify({ capability: 'other', confidence: 'high' }) };
    d.resolve(valid);
    await wait(15);
    assert('12 capability late result does not change the caller result',
      gen.status === 'unavailable' && gen.reason === 'timeout'
      && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
      (v) => v === true, 'discarded');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const ctx = {
      completion: async () => ({ text: JSON.stringify({ capability: 'other', confidence: 'high' }) }),
    };
    const gen = await generateCapabilityProposal('hello', () => ctx as never, { timeoutMs: 30 });
    assert('4 in-time capability completion still returns the proposal',
      gen.status === 'ok' && gen.proposal.capability === 'other', (v) => v === true, 'other');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const d = deferred();
    const gen = await generateMedicationSemanticProposal('I take lisinopril.', () => d.ctx as never, { timeoutMs: 30 });
    assert('5 medication stall returns unavailable timeout',
      gen.status === 'unavailable' && getSemanticContextState() === 'DRAINING',
      (v) => v === true, 'unavailable draining');
    assert('6 medication timeout leaves native ownership DRAINING',
      getSemanticContextState() === 'DRAINING', (v) => v === true, 'DRAINING');
    assert('7 medication timeout produces no admission',
      gen.status !== 'ok', (v) => v === true, 'no proposal');
    d.resolve({ text: JSON.stringify({ mentions: ['lisinopril'], predicate: 'take', focus: 'lisinopril', confidence: 0.92 }) });
    await wait(15);
    assert('12 medication late result does not change the caller result',
      gen.status === 'unavailable'
      && peekSemanticCompletionBreadcrumbs().some((b) => b.event === 'late_result_discarded'),
      (v) => v === true, 'discarded');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const ctx = {
      completion: async () => ({
        text: JSON.stringify({ mentions: ['lisinopril'], predicate: 'take', focus: 'lisinopril', confidence: 0.92 }),
      }),
    };
    const gen = await generateMedicationSemanticProposal('I take lisinopril.', () => ctx as never, { timeoutMs: 30 });
    const admission = gen.status === 'ok'
      ? admitMedicationSemanticProposal('I take lisinopril.', gen.proposal, { hasPending: false })
      : null;
    assert('8 in-time medication completion still returns the proposal',
      gen.status === 'ok' && gen.proposal.focus === 'lisinopril' && admission?.decision === 'CLARIFY',
      (v) => v === true, 'proposal');
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const holder = deferred();
    await runSharedSemanticCompletion(() => holder.ctx, { n: 1 }, { callerDeadlineMs: 20 });
    let calls = 0;
    const cap = await generateCapabilityProposal('what is on my list', () => ({
      completion: async () => { calls += 1; return { text: '{"capability":"other","confidence":"high"}' }; },
    }) as never, { timeoutMs: 30 });
    const med = await generateMedicationSemanticProposal('I take lisinopril.', () => ({
      completion: async () => { calls += 1; return { text: '{"focus":"lisinopril"}' }; },
    }) as never, { timeoutMs: 30 });
    assert('9 draining capability makes zero native calls',
      cap.status === 'unavailable' && calls === 0, (v) => v === true, 'zero');
    assert('10 draining medication makes zero native calls',
      med.status === 'unavailable' && calls === 0, (v) => v === true, 'zero');
    holder.resolve({ text: '{"ok":true}' });
    await wait(10);
  }

  resetSemanticCompletionLifecycleForTests();
  {
    const thrown = await generateCapabilityProposal('hello', () => ({
      completion: async () => { throw new Error('native failed'); },
    }) as never, { timeoutMs: 30 });
    const busyHolder = deferred();
    const held = runSharedSemanticCompletion(() => busyHolder.ctx, { n: 1 });
    await wait(5);
    const busy = await generateCapabilityProposal('hello', () => busyHolder.ctx as never, { timeoutMs: 30 });
    busyHolder.resolve({ text: '{"ok":true}' });
    await held;
    assert('11 capability timeout busy and error all fail closed',
      thrown.status === 'unavailable' && thrown.reason === 'error'
      && busy.status === 'unavailable' && busy.reason === 'in_flight',
      (v) => v === true, 'unavailable');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}SemanticCallerDeadlineB1: ${passed}/${total} passed${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').includes('semanticCallerDeadlineB1')) {
  runSemanticCallerDeadlineB1Tests().then((r) => process.exit(r.failed ? 1 : 0));
}
