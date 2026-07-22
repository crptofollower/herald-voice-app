// scripts/heraldTest/parseTimeFromText.test.ts
// parseTimeFromText / alarm / reminder / calendar-write — space-separated minutes.
//
// Runner: npx tsx scripts/heraldTest/parseTimeFromText.test.ts

import {
  parseTimeFromText,
  parseAlarmIntent,
  parseReminderIntent,
  parseCalendarWriteIntent,
} from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runParseTimeFromTextTests() {
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

  console.log(`\n${BOLD}-- parseTimeFromText Contract Tests (space-separated minutes) --${RESET}\n`);

  assert(
    'PT1 "at 3 15" → hour 15 (PM bump), minute 15',
    parseTimeFromText('at 3 15'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 15;
    },
    '{ hour: 15, minute: 15 }',
  );

  assert(
    'PT2 "at 3 45" → hour 15, minute 45',
    parseTimeFromText('at 3 45'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 45;
    },
    '{ hour: 15, minute: 45 }',
  );

  assert(
    'PT3 "at 3:15" colon form still → hour 15, minute 15',
    parseTimeFromText('at 3:15'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 15;
    },
    '{ hour: 15, minute: 15 }',
  );

  assert(
    'PT4 "at 3" no minutes → hour 15, minute 0',
    parseTimeFromText('at 3'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 0;
    },
    '{ hour: 15, minute: 0 }',
  );

  assert(
    'PT5 "at 3 75" invalid minutes → minute 0 (not 75)',
    parseTimeFromText('at 3 75'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 0;
    },
    '{ hour: 15, minute: 0 }',
  );

  assert(
    'PT6 parseAlarmIntent "set an alarm for 7 15" → time "07:15"',
    parseAlarmIntent('set an alarm for 7 15')?.time,
    (v) => v === '07:15',
    '"07:15"',
  );

  assert(
    'PT7 parseReminderIntent "remind me to call mom at 3 15" → time "15:15"',
    parseReminderIntent('remind me to call mom at 3 15')?.time,
    (v) => v === '15:15',
    '"15:15"',
  );

  assert(
    'PT8 parseCalendarWriteIntent "add dentist to my calendar at 3 15" → time segment "15:15"',
    parseCalendarWriteIntent('add dentist to my calendar at 3 15')?.split('|')[2],
    (v) => v === '15:15',
    '"15:15"',
  );

  // Absolute AM/PM path: space-separated minutes (was colon-only; overflowed as hour=30)
  assert(
    'PT11 "10 30 a.m." → hour 10, minute 30',
    parseTimeFromText('10 30 a.m.'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 10 && t?.minute === 30;
    },
    '{ hour: 10, minute: 30 }',
  );

  assert(
    'PT12 "Friday at 10 30 a.m." → hour 10, minute 30',
    parseTimeFromText('Friday at 10 30 a.m.'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 10 && t?.minute === 30;
    },
    '{ hour: 10, minute: 30 }',
  );

  assert(
    'PT13 "3 45 pm" → hour 15, minute 45',
    parseTimeFromText('3 45 pm'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 45;
    },
    '{ hour: 15, minute: 45 }',
  );

  // Pre-fix absolute matched "30 a.m." as hour 30. Space minutes + guard: no matchable
  // absolute input yields hour > 23; invalid minutes hit the guard (null).
  assert(
    'PT14 absolute overflow shapes never return hour > 23',
    {
      spaceAm: parseTimeFromText('10 30 a.m.'),
      fridaySpaceAm: parseTimeFromText('Friday at 10 30 a.m.'),
      spacePm: parseTimeFromText('3 45 pm'),
      invalidMinutes: parseTimeFromText('3 75 pm'),
    },
    (v) => {
      const x = v as {
        spaceAm: { hour: number; minute: number } | null;
        fridaySpaceAm: { hour: number; minute: number } | null;
        spacePm: { hour: number; minute: number } | null;
        invalidMinutes: { hour: number; minute: number } | null;
      };
      const ok = (t: { hour: number; minute: number } | null) =>
        t != null && t.hour >= 0 && t.hour <= 23 && t.minute >= 0 && t.minute <= 59;
      return (
        ok(x.spaceAm) &&
        ok(x.fridaySpaceAm) &&
        ok(x.spacePm) &&
        x.invalidMinutes === null
      );
    },
    'valid space+am/pm → hour≤23; "3 75 pm" → null (guard)',
  );

  // PT9: appointment-called title frame + must not fall through to calendar_tomorrow read
  {
    const { setDB } = await import('../../src/db/schema.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');
    const input =
      'Add an appointment called Monday checkup with Dr Catherer tomorrow at 10 A.M';
    const value = parseCalendarWriteIntent(input);
    const title = value?.split('|')[0] ?? null;
    // Printed for review — locked to observed extract (cleanup leaves trailing "tomorrow").
    console.log(`${DIM}PT9 extracted title: ${JSON.stringify(title)}${RESET}`);
    const d = await classifyQuery(input);
    assert(
      'PT9 appointment-called → calendar_write; title "Monday checkup with Dr Catherer tomorrow"',
      { reason: d.reason, type: (d as { actionIntent?: { type?: string } }).actionIntent?.type, title },
      (v) => {
        const x = v as { reason?: string; type?: string; title?: string | null };
        return (
          x.reason === 'action:calendar_write' &&
          x.type === 'calendar_write' &&
          x.title === 'Monday checkup with Dr Catherer tomorrow'
        );
      },
      'reason action:calendar_write; title "Monday checkup with Dr Catherer tomorrow"',
    );
  }

  // PT10: "make an appointment with Dr …" must stay medical future-visit capture
  // (pre-session behavior). If this flips to calendar_write, that is a regression.
  {
    const { setDB } = await import('../../src/db/schema.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');
    const input = 'I need to make an appointment with Dr. Sarver next month';
    const parsed = parseCalendarWriteIntent(input);
    const d = await classifyQuery(input);
    const actionType = (d as { actionIntent?: { type?: string; value?: string; event?: { type?: string; tense?: string; doctor_name?: string } } }).actionIntent?.type;
    const event = (d as { actionIntent?: { event?: { type?: string; tense?: string; doctor_name?: string } } }).actionIntent?.event;
    console.log(
      `${DIM}PT10 routing: tier=${d.tier} reason=${JSON.stringify(d.reason)} ` +
      `actionType=${JSON.stringify(actionType)} value=${JSON.stringify((d as { actionIntent?: { value?: string } }).actionIntent?.value)} ` +
      `parseCalendarWriteIntent=${JSON.stringify(parsed)} ` +
      `event=${JSON.stringify(event)}${RESET}`,
    );
    assert(
      'PT10 "make an appointment with Dr. Sarver next month" → medical_capture (not calendar_write)',
      { reason: d.reason, actionType, eventType: event?.type, eventTense: event?.tense, doctor: event?.doctor_name },
      (v) => {
        const x = v as {
          reason?: string;
          actionType?: string;
          eventType?: string;
          eventTense?: string;
          doctor?: string;
        };
        return (
          x.reason === 'action:medical_capture' &&
          x.actionType === 'medical_capture' &&
          x.eventType === 'visit' &&
          x.eventTense === 'future' &&
          x.doctor === 'Dr. Sarver'
        );
      },
      'reason action:medical_capture; future visit Dr. Sarver',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}parseTimeFromText: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('parseTimeFromText.test.ts')) {
  runParseTimeFromTextTests().catch(console.error);
}
