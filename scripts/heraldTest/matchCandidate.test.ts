// scripts/heraldTest/matchCandidate.test.ts
// Token-based matchCandidate contract (contact_call disambiguation).
// Exercises matchCandidate via the contact_call writer's top-level resume
// (name-match branch) — the helper itself is scoped inside the writer.
//
// Runner: npx tsx scripts/heraldTest/matchCandidate.test.ts

import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

type CallCandidate = { name: string; relationship?: string; phone: string; importance: number };

function dialPhone(result: CommitResult): string | undefined {
  return result.status === 'committed' && result.effect?.kind === 'dial' ? result.effect.phone : undefined;
}

async function disambiguatePending(candidates: CallCandidate[]): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const intent: IntentRecord = {
    type: 'contact_call',
    contact: 'David',
    candidates,
    raw: 'call David',
  };
  const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  return result;
}

export async function runMatchCandidateTests(): Promise<{ passed: number; failed: number; total: number }> {
  let passed = 0;
  let failed = 0;
  const assert = (label: string, value: unknown, pred: (v: any) => boolean, detail: string) => {
    if (pred(value)) {
      passed++;
      console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}${detail}${RESET}\n`);
    } else {
      failed++;
      console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${detail}${RESET}\n      ${RED}got: ${JSON.stringify(value)}${RESET}\n`);
    }
  };

  console.log(`\n${BOLD}-- matchCandidate Contract Tests ---------------------------${RESET}\n`);

  const clevenger: CallCandidate = { name: 'David Clevenger', phone: '5552222222', importance: 5 };
  const mossholder: CallCandidate = { name: 'David Mossholder', phone: '5551111111', importance: 9 };
  const pair = [mossholder, clevenger];

  // 1. Single last-name token matches full candidate name (existing behavior)
  {
    const pending = await disambiguatePending(pair);
    const result = await pending.resume('Clevenger');
    assert('T-MC-1 "Clevenger" matches "David Clevenger"',
      dialPhone(result),
      v => v === '5552222222',
      'dial David Clevenger');
  }

  // 2. Full first+last reply matches (the fix)
  {
    const pending = await disambiguatePending(pair);
    const result = await pending.resume('David Clevenger');
    assert('T-MC-2 "David Clevenger" matches "David Clevenger"',
      dialPhone(result),
      v => v === '5552222222',
      'dial David Clevenger');
  }

  // 3. Reversed token order matches
  {
    const pending = await disambiguatePending(pair);
    const result = await pending.resume('Clevenger David');
    assert('T-MC-3 "Clevenger David" matches "David Clevenger"',
      dialPhone(result),
      v => v === '5552222222',
      'dial David Clevenger');
  }

  // 4. Shared first name across two candidates → ambiguous, never auto-pick
  {
    const pending = await disambiguatePending(pair);
    const result = await pending.resume('David');
    assert('T-MC-4 "David" with two David candidates → no match',
      result,
      v => v.status === 'noop' && v.ack === '',
      'noop empty ack — re-ask, never silent dial');
  }

  // 5. Zero candidates match
  {
    const pending = await disambiguatePending(pair);
    const result = await pending.resume('Smith');
    assert('T-MC-5 reply matching zero candidates → no match',
      result,
      v => v.status === 'noop' && v.ack === '',
      'noop empty ack');
  }

  // 6. Distinct relationship word selects the single hit
  {
    const byRel: CallCandidate[] = [
      { name: 'David Mossholder', relationship: 'brother', phone: '5551111111', importance: 9 },
      { name: 'David Clevenger', relationship: 'friend', phone: '5552222222', importance: 5 },
    ];
    const pending = await disambiguatePending(byRel);
    const result = await pending.resume('brother');
    assert('T-MC-6 "brother" selects Mossholder (single relationship hit)',
      dialPhone(result),
      v => v === '5551111111',
      'dial David Mossholder');
  }

  // 7. Leading filler article stripped before tokenizing
  {
    const byRel: CallCandidate[] = [
      { name: 'David Mossholder', relationship: 'brother', phone: '5551111111', importance: 9 },
      { name: 'David Clevenger', relationship: 'friend', phone: '5552222222', importance: 5 },
    ];
    const pending = await disambiguatePending(byRel);
    const result = await pending.resume('the friend');
    assert('T-MC-7 "the friend" selects Clevenger (leading article stripped)',
      dialPhone(result),
      v => v === '5552222222',
      'dial David Clevenger');
  }

  // 8. Shared relationship across two candidates → ambiguous, never auto-pick
  {
    const bothDaughters: CallCandidate[] = [
      { name: 'Emily', relationship: 'daughter', phone: '5550100101', importance: 9 },
      { name: 'Anna', relationship: 'daughter', phone: '5550200202', importance: 3 },
    ];
    const pending = await disambiguatePending(bothDaughters);
    const result = await pending.resume('daughter');
    assert('T-MC-8 "daughter" with two daughters → no match',
      result,
      v => v.status === 'noop' && v.ack === '',
      'noop empty ack — re-ask, never silent dial');
  }

  console.log(`${BOLD}matchCandidate: ${passed} passed / ${failed} failed / ${passed + failed} total${RESET}\n`);
  return { passed, failed, total: passed + failed };
}

if (process.argv[1]?.endsWith('matchCandidate.test.ts')) {
  const r = await runMatchCandidateTests();
  process.exit(r.failed > 0 ? 1 : 0);
}
