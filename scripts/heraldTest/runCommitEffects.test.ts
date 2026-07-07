// scripts/heraldTest/runCommitEffects.test.ts
// Contract tests for src/utils/commitEffects.ts (S_CONTACT C-2).
// Exercises the real runCommitEffects — not a mirror.
//
// Runner: npx tsx scripts/heraldTest/runCommitEffects.test.ts

import { runCommitEffects } from '../../src/utils/commitEffects.ts';
import type { CommitEffectDeps } from '../../src/utils/commitEffects.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

function makeDeps(overrides: Partial<CommitEffectDeps> = {}) {
  const calls = {
    openURL: [] as string[],
    maps: [] as string[],
    failures: [] as string[],
  };
  const deps: CommitEffectDeps = {
    openURL: async (url) => { calls.openURL.push(url); },
    handleMapsAction: async (address) => { calls.maps.push(address); },
    onEffectFailure: (failAck) => { calls.failures.push(failAck); },
    ...overrides,
  };
  return { deps, calls };
}

export async function runRunCommitEffectsTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- runCommitEffects Contract Tests -------------------------${RESET}\n`);

  // ── T-RCE-1: undefined / empty → no-op ────────────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects(undefined, deps);
    await runCommitEffects([], deps);
    assert('T-RCE-1 undefined and empty commits → no Linking or maps calls',
      calls,
      v => v.openURL.length === 0 && v.maps.length === 0 && v.failures.length === 0,
      'no side effects');
  }

  // ── T-RCE-2: committed without effect → no-op ─────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([{ status: 'committed', ack: 'Got it.' }], deps);
    assert('T-RCE-2 committed with no effect → no-op',
      calls,
      v => v.openURL.length === 0 && v.maps.length === 0,
      'no device calls');
  }

  // ── T-RCE-3: dial effect → tel: URL ───────────────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([{
      status: 'committed',
      ack: 'Calling.',
      effect: { kind: 'dial', phone: '(555) 123-4567', failAck: 'Could not dial.' },
    }], deps);
    assert('T-RCE-3 dial → tel: with digits only',
      calls.openURL,
      v => Array.isArray(v) && v.length === 1 && v[0] === 'tel:5551234567',
      '["tel:5551234567"]');
  }

  // ── T-RCE-4: sms without body ───────────────────────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([{
      status: 'committed',
      ack: 'Opening SMS.',
      effect: { kind: 'sms', phone: '5559998888', failAck: 'SMS failed.' },
    }], deps);
    assert('T-RCE-4 sms without body → sms:phone only',
      calls.openURL,
      v => Array.isArray(v) && v[0] === 'sms:5559998888',
      '["sms:5559998888"]');
  }

  // ── T-RCE-5: sms with encoded body ────────────────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([{
      status: 'committed',
      ack: 'Opening SMS.',
      effect: { kind: 'sms', phone: '5551112222', body: 'hello there', failAck: 'SMS failed.' },
    }], deps);
    assert('T-RCE-5 sms with body → encoded query string',
      calls.openURL,
      v => Array.isArray(v) && v[0] === 'sms:5551112222?body=hello%20there',
      'body encoded');
  }

  // ── T-RCE-6: navigate → handleMapsAction ──────────────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([{
      status: 'committed',
      ack: 'Opening directions.',
      effect: { kind: 'navigate', address: '123 Main St', failAck: 'Maps failed.' },
    }], deps);
    assert('T-RCE-6 navigate → handleMapsAction with address',
      calls.maps,
      v => Array.isArray(v) && v[0] === '123 Main St',
      '["123 Main St"]');
  }

  // ── T-RCE-7: dial failure → failAck ───────────────────────────────────────
  {
    const { deps, calls } = makeDeps({
      openURL: async () => { throw new Error('dial blocked'); },
    });
    await runCommitEffects([{
      status: 'committed',
      ack: 'Calling.',
      effect: { kind: 'dial', phone: '5550000000', failAck: 'Could not place the call.' },
    }], deps);
    assert('T-RCE-7 dial throw → onEffectFailure with failAck',
      calls.failures,
      v => Array.isArray(v) && v[0] === 'Could not place the call.',
      'failAck on dial error');
  }

  // ── T-RCE-8: sms failure → failAck ────────────────────────────────────────
  {
    const { deps, calls } = makeDeps({
      openURL: async () => { throw new Error('sms blocked'); },
    });
    await runCommitEffects([{
      status: 'committed',
      ack: 'Opening SMS.',
      effect: { kind: 'sms', phone: '5550000000', failAck: 'Could not open messages.' },
    }], deps);
    assert('T-RCE-8 sms throw → onEffectFailure with failAck',
      calls.failures,
      v => Array.isArray(v) && v[0] === 'Could not open messages.',
      'failAck on sms error');
  }

  // ── T-RCE-9: navigate failure → failAck ─────────────────────────────────────
  {
    const { deps, calls } = makeDeps({
      handleMapsAction: async () => { throw new Error('maps blocked'); },
    });
    await runCommitEffects([{
      status: 'committed',
      ack: 'Opening directions.',
      effect: { kind: 'navigate', address: '999 Oak Ave', failAck: 'Could not open maps.' },
    }], deps);
    assert('T-RCE-9 navigate throw → onEffectFailure with failAck',
      calls.failures,
      v => Array.isArray(v) && v[0] === 'Could not open maps.',
      'failAck on navigate error');
  }

  // ── T-RCE-10: pending and noop in array → skipped ───────────────────────────
  {
    const { deps, calls } = makeDeps();
    await runCommitEffects([
      { status: 'pending', prompt: 'Which one?', pendingKey: 'x', resume: async () => ({ status: 'noop', ack: '' }) },
      { status: 'noop', ack: 'Noted.' },
      {
        status: 'committed',
        ack: 'Done.',
        effect: { kind: 'dial', phone: '5551234567', failAck: 'fail' },
      },
    ] as CommitResult[], deps);
    assert('T-RCE-10 pending/noop skipped; only committed effect runs',
      calls.openURL,
      v => Array.isArray(v) && v.length === 1 && v[0] === 'tel:5551234567',
      'one dial after skip');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}runCommitEffects: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('runCommitEffects.test.ts')) {
  runRunCommitEffectsTests().catch(console.error);
}
