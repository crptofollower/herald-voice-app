// scripts/heraldTest/llamaContextExclusive.test.ts
// Shared LlamaContext exclusivity gate — try/wait/retirement/release.
// Runner: npx tsx scripts/heraldTest/llamaContextExclusive.test.ts

import {
  beginLlamaContextRetirement,
  getLlamaContextExclusiveOwner,
  isLlamaContextBusy,
  isLlamaContextRetiring,
  runExclusiveContextRelease,
  withLlamaContextExclusive,
} from '../../src/utils/llamaContextExclusive.ts';
import { classifyWithLLM } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runLlamaContextExclusiveTests(): Promise<{
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

  console.log(`\n${BOLD}-- LlamaContext Exclusive Gate Tests -----------------------${RESET}\n`);

  assert('idle: not busy', isLlamaContextBusy(), (v) => v === false, 'false');
  assert('idle: owner null', getLlamaContextExclusiveOwner(), (v) => v === null, 'null');
  assert('idle: not retiring', isLlamaContextRetiring(), (v) => v === false, 'false');

  // try: second claim while first holds → busy (sync claim before await)
  {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const p1 = withLlamaContextExclusive('classifier', 'try', async () => {
      await gate;
      return 'a';
    });
    const second = await withLlamaContextExclusive('ephemeral', 'try', async () => 'b');
    assert(
      'try: second owner gets busy while first holds',
      second,
      (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === false && (v as { reason?: string }).reason === 'busy',
      "{ ok: false, reason: 'busy' }",
    );
    assert('held by classifier during first try', getLlamaContextExclusiveOwner(), (v) => v === 'classifier', 'classifier');
    release();
    const first = await p1;
    assert('first try completes', first, (v) => typeof v === 'object' && v !== null && (v as { ok: boolean; value?: string }).ok === true && (v as { value?: string }).value === 'a', "{ ok: true, value: 'a' }");
    assert('idle after release', isLlamaContextBusy(), (v) => v === false, 'false');
  }

  // wait queues behind try holder
  {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pTry = withLlamaContextExclusive('classifier', 'try', async () => {
      order.push('try-start');
      await gate;
      order.push('try-end');
      return 1;
    });
    const pWait = withLlamaContextExclusive('session-save', 'wait', async () => {
      order.push('wait-run');
      return 2;
    });
    await Promise.resolve();
    assert('wait has not run while try holds', order.slice(), (v) => Array.isArray(v) && (v as string[]).join(',') === 'try-start', 'try-start');
    release();
    const [tryRes, waitRes] = await Promise.all([pTry, pWait]);
    assert('try then wait order', order.join(','), (v) => v === 'try-start,try-end,wait-run', 'try-start,try-end,wait-run');
    assert('try ok', tryRes, (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === true, 'ok');
    assert('wait ok', waitRes, (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === true, 'ok');
  }

  // try fails while wait holds
  {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pWait = withLlamaContextExclusive('probe', 'wait', async () => {
      await gate;
      return 'probe';
    });
    await Promise.resolve();
    const tryDuring = await withLlamaContextExclusive('classifier', 'try', async () => 'nope');
    assert(
      'try busy while wait/probe holds',
      tryDuring,
      (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === false,
      'busy',
    );
    release();
    await pWait;
  }

  // readiness signaled after warmup completion before nested save work returns;
  // no other owner can interleave while classifier still holds (incl. save helper).
  {
    const order: string[] = [];
    let releaseNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve; });
    const identity = { modelKind: 'small' as const, modelPath: '/mock/model.gguf' };

    // Simulate production shape: completion then onWarmupSucceeded then nested
    // capture under the SAME classifier hold (no re-acquire).
    const p = withLlamaContextExclusive('classifier', 'try', async () => {
      order.push('warmup-complete');
      order.push('ready-signal');
      order.push('capture-start');
      assert(
        'owner still classifier during nested capture',
        getLlamaContextExclusiveOwner(),
        (v) => v === 'classifier',
        'classifier',
      );
      const sneaky = await withLlamaContextExclusive('ephemeral', 'try', async () => 'no');
      assert(
        'no interleave: try busy during nested canonical capture',
        sneaky,
        (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === false,
        'busy',
      );
      order.push('capture-held');
      await nestedGate;
      order.push('capture-end');
    });

    for (let i = 0; i < 20 && !order.includes('capture-held'); i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
    assert(
      'ready signaled before capture completes',
      order.slice(),
      (v) => Array.isArray(v) && (v as string[]).includes('ready-signal') && !(v as string[]).includes('capture-end'),
      'ready-signal before capture-end',
    );
    releaseNested();
    await p;
    assert(
      'order: warmup → ready → capture under one hold',
      order.join(','),
      (v) => v === 'warmup-complete,ready-signal,capture-start,capture-held,capture-end',
      'warmup-complete,ready-signal,capture-start,capture-held,capture-end',
    );

    // classifyWithLLM fires onWarmupSucceeded on successful warmup completion
    let readyFromClassify = false;
    const out = await classifyWithLLM(
      'warmup ping',
      { id: 99, completion: async () => ({ text: '[{"type":"pass"}]' }) } as any,
      { contacts: [], lists: [] },
      {
        modelIdentity: identity,
        onWarmupSucceeded: () => { readyFromClassify = true; },
      },
    );
    assert('classify warmup status ok', out.status, (v) => v === 'ok', 'ok');
    assert('onWarmupSucceeded fired (ready independent of snapshot I/O)', readyFromClassify, (v) => v === true, 'true');
  }

  // release waits behind held owner
  {
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holdGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = withLlamaContextExclusive('classifier', 'try', async () => {
      order.push('hold');
      await holdGate;
      order.push('hold-done');
    });
    const releaseP = runExclusiveContextRelease(async () => {
      order.push('release');
    });
    await Promise.resolve();
    assert('release has not run while holder active', order.slice(), (v) => Array.isArray(v) && (v as string[]).join(',') === 'hold', 'hold');
    assert('retiring while waiting to release', isLlamaContextRetiring(), (v) => v === true, 'true');
    const tryDuringRetire = await withLlamaContextExclusive('ephemeral', 'try', async () => 'x');
    assert(
      'try refused while context retiring',
      tryDuringRetire,
      (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === false,
      'busy',
    );
    releaseHolder();
    await Promise.all([holder, releaseP]);
    assert(
      'release ran after holder',
      order.join(','),
      (v) => v === 'hold,hold-done,release',
      'hold,hold-done,release',
    );
    assert('not retiring after release', isLlamaContextRetiring(), (v) => v === false, 'false');
  }

  // beginRetirement alone blocks try even when idle
  {
    beginLlamaContextRetirement();
    const tryIdle = await withLlamaContextExclusive('classifier', 'try', async () => 'no');
    assert(
      'try refused after beginRetirement while idle',
      tryIdle,
      (v) => typeof v === 'object' && v !== null && (v as { ok: boolean }).ok === false,
      'busy',
    );
    let released = false;
    await runExclusiveContextRelease(async () => { released = true; });
    assert('release ran after idle retirement', released, (v) => v === true, 'true');
    assert('retirement cleared', isLlamaContextRetiring(), (v) => v === false, 'false');
  }

  // warmup-failure dispose path: exclusive release invokes release exactly once
  {
    let releaseCount = 0;
    await runExclusiveContextRelease(async () => { releaseCount += 1; });
    assert('warmup-failure-style release runs exactly once', releaseCount, (v) => v === 1, '1');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LlamaContextExclusive: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('llamaContextExclusive.test.ts')) {
  runLlamaContextExclusiveTests().catch(console.error);
}
