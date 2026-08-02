// scripts/heraldTest/suspendCoordinator.test.ts
// createSuspendCoordinator — end/timeout/late-end/unmount contract.
//
// Runner: npx tsx scripts/heraldTest/suspendCoordinator.test.ts

import { createSuspendCoordinator } from '../../src/hooks/suspendCoordinator.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function makeFakeScheduler() {
  let scheduled: { fn: () => void } | null = null;
  return {
    scheduleTimeout: (fn: () => void) => {
      scheduled = { fn };
      return { clear: () => { scheduled = null; } };
    },
    fire: () => { const s = scheduled; scheduled = null; s?.fn(); },
    isScheduled: () => scheduled !== null,
  };
}

export async function runSuspendCoordinatorTests() {
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

  console.log(`\n${BOLD}-- createSuspendCoordinator Contract Tests --${RESET}\n`);

  // SC1: onNativeEnd() before timeout -> confirmed:true
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    const p = coord.beginSuspend(() => {});
    coord.onNativeEnd();
    const got = await p;
    assert('SC1 native end confirms true', got, (v: any) => v.confirmed === true, '{confirmed:true}');
  }

  // SC2: timeout fires before end -> confirmed:false, onTimeout called
  {
    const sched = makeFakeScheduler();
    let timedOut = false;
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => { timedOut = true; });
    const p = coord.beginSuspend(() => {});
    sched.fire();
    const got = await p;
    assert('SC2 timeout confirms false and fires onTimeout',
      { confirmed: (got as any).confirmed, timedOut },
      (v: any) => v.confirmed === false && v.timedOut === true,
      '{confirmed:false, timedOut:true}');
  }

  // SC3: late onNativeEnd() after timeout already resolved is a no-op
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    const p = coord.beginSuspend(() => {});
    sched.fire();
    const got = await p;
    coord.onNativeEnd(); // late -- must not throw, must not re-resolve anything downstream
    assert('SC3 timeout wins; late end after resolution does not throw or change the result',
      got, (v: any) => v.confirmed === false, '{confirmed:false}');
  }

  // SC4: stopFn throwing synchronously resolves false immediately, timer cleared
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    const p = coord.beginSuspend(() => { throw new Error('native stop failed'); });
    const got = await p;
    assert('SC4 synchronous stopFn throw resolves confirmed:false',
      { confirmed: (got as any).confirmed, stillScheduled: sched.isScheduled() },
      (v: any) => v.confirmed === false && v.stillScheduled === false,
      '{confirmed:false, stillScheduled:false}');
  }

  // SC5: cancel() (unmount) resolves a pending suspend with confirmed:false
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    const p = coord.beginSuspend(() => {});
    coord.cancel();
    const got = await p;
    assert('SC5 cancel() resolves pending suspend confirmed:false',
      { confirmed: (got as any).confirmed, stillScheduled: sched.isScheduled() },
      (v: any) => v.confirmed === false && v.stillScheduled === false,
      '{confirmed:false, stillScheduled:false}');
  }

  // SC6: cancel() with nothing pending is a safe no-op
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    let threw = false;
    try { coord.cancel(); } catch { threw = true; }
    assert('SC6 cancel() with nothing pending does not throw', threw, (v) => v === false, 'false');
  }

  // SC7: a second beginSuspend() while one is pending resolves the FIRST as confirmed:false
  {
    const sched = makeFakeScheduler();
    const coord = createSuspendCoordinator(999, sched.scheduleTimeout, () => {});
    const p1 = coord.beginSuspend(() => {});
    const p2 = coord.beginSuspend(() => {});
    coord.onNativeEnd(); // resolves p2, the current pending
    const [got1, got2] = await Promise.all([p1, p2]);
    assert('SC7 starting a new suspend resolves the abandoned prior one to false',
      { first: (got1 as any).confirmed, second: (got2 as any).confirmed },
      (v: any) => v.first === false && v.second === true,
      '{first:false, second:true}');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}suspendCoordinator: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('suspendCoordinator.test.ts')) {
  runSuspendCoordinatorTests().catch(console.error);
}
