// scripts/heraldTest/calendarCollect.test.ts
// Calendar collect-slot contract tests (PENDING_UNIFICATION spec, Commit B).
// The D-2 fence lives here: cancel/ambiguity during collect NEVER calls the
// write function. Write is injected as a mock — expo-calendar never runs.
//
// Runner: npx tsx scripts/heraldTest/calendarCollect.test.ts

import { buildCalendarCollectSlot } from '../../src/routing/calendarWrite.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

function mockWrite() {
  const calls: { title: string; dateStr: string; timeStr: string }[] = [];
  const fn = async (title: string, dateStr: string, timeStr: string): Promise<CommitResult> => {
    calls.push({ title, dateStr, timeStr });
    return { status: 'committed', ack: `Okay, I've added ${title}.` };
  };
  return { fn, calls };
}

function armFromPlan(session: ConversationSession, plan: ReturnType<typeof buildCalendarCollectSlot>) {
  if (!plan) throw new Error('expected a collect plan, got null');
  session.setPending(plan.slot);
  return plan;
}

export async function runCalendarCollectTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- calendarCollect Contract Tests --------------------------${RESET}\n`);

  // ── CC1: complete fields → null plan (write directly, no pending) ─────────
  {
    const { fn } = mockWrite();
    const plan = buildCalendarCollectSlot('Lunch with Shannon', '2026-07-20', '12:00', fn);
    assert('CC1 complete fields → null plan, no collect needed',
      plan, v => v === null, 'null');
  }

  // ── CC2: THE D-2 FENCE — "never mind" during title collect → zero writes ──
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '12:00', fn));
    const result = await session.resolvePending('never mind, cancel that');
    assert('CC2 cancel during title collect → cancel ack, session cleared, WRITE NEVER CALLED',
      { status: result.status, ack: result.status === 'noop' ? result.ack : '', pending: session.hasPending(), writes: calls.length },
      v => {
        const x = v as { status: string; ack: string; pending: boolean; writes: number };
        return x.status === 'noop' && /won't put anything/i.test(x.ack) && x.pending === false && x.writes === 0;
      },
      'noop cancel ack, cleared, 0 writes — an abort must never become an event');
  }

  // ── CC3: title collect happy path — verbatim title, time known → write ────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '12:00', fn));
    const result = await session.resolvePending('Lunch with Paul');
    assert('CC3 title reply + time already known → committed, verbatim title, one write',
      { status: result.status, writes: calls, pending: session.hasPending() },
      v => {
        const x = v as { status: string; writes: { title: string; timeStr: string }[]; pending: boolean };
        return x.status === 'committed' && x.writes.length === 1
          && x.writes[0].title === 'Lunch with Paul' && x.writes[0].timeStr === '12:00'
          && x.pending === false;
      },
      'committed, write called once with verbatim title + known time');
  }

  // ── CC4: title stage advances to time stage when time unknown ─────────────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '', fn));
    const advance = await session.resolvePending('Lunch with Paul');
    const done = await session.resolvePending('noon');
    assert('CC4 title → time two-stage collect → single write with both values',
      { advanceStatus: advance.status, advancePrompt: advance.status === 'pending' ? advance.prompt : '', doneStatus: done.status, writes: calls, pending: session.hasPending() },
      v => {
        const x = v as { advanceStatus: string; advancePrompt: string; doneStatus: string; writes: { title: string; timeStr: string }[]; pending: boolean };
        return x.advanceStatus === 'pending' && /what time/i.test(x.advancePrompt)
          && x.doneStatus === 'committed' && x.writes.length === 1
          && x.writes[0].title === 'Lunch with Paul' && x.writes[0].timeStr === '12:00'
          && x.pending === false;
      },
      'pending time ask after title; committed after "noon"; exactly one write 12:00');
  }

  // ── CC5: unparseable time ×2 → re-ask then release, write never called ────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('Checkup', '2026-07-20', '', fn));
    const r1 = await session.resolvePending('purple');
    const r2 = await session.resolvePending('banana');
    assert('CC5 two unparseable time replies → re-ask (with title) then honest release, 0 writes',
      { r1Status: r1.status, r1Prompt: r1.status === 'pending' ? r1.prompt : '', r2Status: r2.status, r2Ack: r2.status === 'noop' ? r2.ack : '', writes: calls.length, pending: session.hasPending() },
      v => {
        const x = v as { r1Status: string; r1Prompt: string; r2Status: string; r2Ack: string; writes: number; pending: boolean };
        return x.r1Status === 'pending' && /Checkup/.test(x.r1Prompt)
          && x.r2Status === 'noop' && /come back to that/i.test(x.r2Ack)
          && x.writes === 0 && x.pending === false;
      },
      're-ask names "Checkup"; release ack; write never called');
  }

  // ── CC6: cancel during TIME stage (after title advance) → zero writes ─────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '', fn));
    await session.resolvePending('Dentist');
    const result = await session.resolvePending('cancel');
    assert('CC6 cancel at time stage (post-advance) → cancel ack, 0 writes',
      { status: result.status, writes: calls.length, pending: session.hasPending() },
      v => {
        const x = v as { status: string; writes: number; pending: boolean };
        return x.status === 'noop' && x.writes === 0 && x.pending === false;
      },
      'cancelled cleanly mid-flow, no event written');
  }

  // ── CC7: "Appointment" placeholder title treated as missing ───────────────
  {
    const { fn } = mockWrite();
    const plan = buildCalendarCollectSlot('Appointment', '2026-07-20', '12:00', fn);
    assert('CC7 legacy "Appointment" placeholder → title collect (fabricated title never persists)',
      { isPlan: plan !== null, prompt: plan?.prompt ?? '' },
      v => {
        const x = v as { isPlan: boolean; prompt: string };
        return x.isPlan && /call this/i.test(x.prompt);
      },
      'plan with title prompt');
  }

  // ── CC8: trailing-word cancel at TIME stage → zero writes ─────────────────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '', fn));
    await session.resolvePending('Dentist');
    const result = await session.resolvePending('forget it, I changed my mind');
    assert('CC8 trailing-word cancel at time stage → cancel ack, 0 writes',
      { status: result.status, ack: result.status === 'noop' ? result.ack : '', writes: calls.length, pending: session.hasPending() },
      v => {
        const x = v as { status: string; ack: string; writes: number; pending: boolean };
        return x.status === 'noop' && /won't put anything/i.test(x.ack) && x.writes === 0 && x.pending === false;
      },
      'cancelled at time stage despite trailing words, no event');
  }

  // ── CC9: false-positive guard — "Stop & Shop run" is a valid title ────────
  {
    const { fn, calls } = mockWrite();
    const session = new ConversationSession();
    armFromPlan(session, buildCalendarCollectSlot('', '2026-07-20', '12:00', fn));
    const result = await session.resolvePending('Stop & Shop run');
    assert('CC9 "Stop & Shop run" is a title, not a cancel (bare stop excluded from collect set)',
      { status: result.status, writes: calls, pending: session.hasPending() },
      v => {
        const x = v as { status: string; writes: { title: string }[]; pending: boolean };
        return x.status === 'committed' && x.writes.length === 1 && x.writes[0].title === 'Stop & Shop run' && x.pending === false;
      },
      'committed with verbatim title Stop & Shop run');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}calendarCollect: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('calendarCollect.test.ts')) {
  runCalendarCollectTests().catch(console.error);
}
