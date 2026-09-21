// scripts/heraldTest/parseTimeFromText.test.ts
// parseTimeFromText / alarm / reminder / calendar-write — space-separated minutes.
//
// Runner: npx tsx scripts/heraldTest/parseTimeFromText.test.ts

import {
  parseTimeFromText,
  parseAlarmIntent,
  parseReminderIntent,
  parseCalendarWriteIntent,
  parseDatePhrase,
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

  // PT15: parseDatePhrase backward ("last <weekday>") extension.
  // Reference dates fixed so this never depends on the real system clock.
  // 2026-08-13 = Thursday, 2026-08-10 = Monday (both real calendar dates).
  assert(
    'PT15a "last Thursday" said on that same Thursday → 7 days back, not today',
    parseDatePhrase('last Thursday', new Date(2026, 7, 13)),
    (v) => v === '2026-08-06',
    '"2026-08-06"',
  );

  assert(
    'PT15b "last Thursday" said on the following Monday → the Thursday just past',
    parseDatePhrase('last Thursday', new Date(2026, 7, 10)),
    (v) => v === '2026-08-06',
    '"2026-08-06"',
  );

  assert(
    'PT15c regression — "next Thursday" said on that same Thursday still jumps a full week (unchanged forward behavior)',
    parseDatePhrase('next Thursday', new Date(2026, 7, 13)),
    (v) => v === '2026-08-20',
    '"2026-08-20"',
  );

  assert(
    'PT15d regression — "next Tuesday" said on Monday still resolves to tomorrow (unchanged forward behavior)',
    parseDatePhrase('next Tuesday', new Date(2026, 7, 10)),
    (v) => v === '2026-08-11',
    '"2026-08-11"',
  );

  // PT16: calendar:specific_day routing — proves parseDatePhrase's resolved
  // date actually reaches getCachedEventsForDate/formatEventsForSpecificDay
  // end to end, not just the pure-function coverage in PT15.
  // Computed relative to real "now" (parseDatePhrase is real-clock, confirmed
  // 2026-08-10) so this passes regardless of which day the gate runs on.
  {
    const { setDB } = await import('../../src/db/schema.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');

    const names = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const now = new Date();
    let diff = (names.indexOf('tuesday') - now.getDay() + 7) % 7;
    if (diff === 0) diff = 7; // "next Tuesday" always jumps a full week, per PT15c/d
    const target = new Date(now);
    target.setDate(target.getDate() + diff);
    const expectedLabel = `next ${target.toLocaleDateString([], { weekday: 'long' })}`;

    const input = 'what do I have next Tuesday';
    const d = await classifyQuery(input);
    console.log(`${DIM}PT16 routing: reason=${JSON.stringify(d.reason)} response=${JSON.stringify(d.tier1Response)}${RESET}`);
    assert(
      'PT16 "what do I have next Tuesday" → calendar:specific_day, empty-cache honest phrasing',
      { reason: d.reason, response: d.tier1Response },
      (v) => {
        const x = v as { reason?: string; response?: string };
        return x.reason === 'calendar:specific_day' &&
          x.response === `Your calendar is clear ${expectedLabel}.`;
      },
      `reason calendar:specific_day; "Your calendar is clear ${'{expectedLabel}'}."`,
    );
  }

  // PT17: calendar:specific_day_past routing, empty case — honest miss
  // from the authorized device-calendar range, calendar provenance.
  {
    const { setDB } = await import('../../src/db/schema.ts');
    const { setCalendarEventFetcher, resetCalendarEventFetcher } = await import('../../src/db/calendarCacheDB.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');
    setCalendarEventFetcher(async () => ({ status: 'ok', events: [] }));
    try {
      const d = await classifyQuery("What's on my calendar last Thursday?");
      console.log(`${DIM}PT17 routing: reason=${JSON.stringify(d.reason)} response=${JSON.stringify(d.tier1Response)}${RESET}`);
      assert(
        'PT17 "What\'s on my calendar last Thursday?" (empty) → calendar:specific_day_past, honest miss',
        { reason: d.reason, response: d.tier1Response },
        (v) => {
          const x = v as { reason?: string; response?: string };
          return x.reason === 'calendar:specific_day_past' &&
            x.response === "Your calendar is clear last Thursday.";
        },
        'reason calendar:specific_day_past; honest-miss for "last Thursday"',
      );
    } finally {
      resetCalendarEventFetcher();
    }
  }

  // PT18: calendar:specific_day_past, non-empty — device-calendar range row
  // reaches the composer with calendar provenance, not occurred-visit tense.
  {
    const { setDB } = await import('../../src/db/schema.ts');
    const { setCalendarEventFetcher, resetCalendarEventFetcher } = await import('../../src/db/calendarCacheDB.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');
    setCalendarEventFetcher(async (start: Date) => ({
      status: 'ok',
      events: [{
        id: 'apt1',
        title: 'Dentist',
        startDate: new Date(start.getTime() + 15 * 3600_000),
        endDate: new Date(start.getTime() + 16 * 3600_000),
        allDay: false,
      }],
    }));
    try {
      const d = await classifyQuery("What's on my calendar last Thursday?");
      console.log(`${DIM}PT18 routing: reason=${JSON.stringify(d.reason)} response=${JSON.stringify(d.tier1Response)}${RESET}`);
      assert(
        'PT18 "What\'s on my calendar last Thursday?" (one row) → composer speaks it, calendar provenance',
        { reason: d.reason, mentionsTitle: (d.tier1Response ?? '').includes('Dentist'), shows: (d.tier1Response ?? '').includes('Your calendar shows'), mentionsHad: (d.tier1Response ?? '').includes('You had') },
        (v) => {
          const x = v as { reason?: string; mentionsTitle?: boolean; shows?: boolean; mentionsHad?: boolean };
          return x.reason === 'calendar:specific_day_past' && x.mentionsTitle === true && x.shows === true && x.mentionsHad === false;
        },
        'reason calendar:specific_day_past; response includes "Dentist" and "Your calendar shows"',
      );
    } finally {
      resetCalendarEventFetcher();
    }
  }

  // PT19: connector-bearing calendar shape ("for" between verb and temporal)
  // — proves CALENDAR_TERSE_TEMPORAL's new weekday branch composes inside
  // the existing (?:for\s+)? group rather than only matching the
  // connector-less "what do i have" shape PT16 already covers.
  {
    const { setDB } = await import('../../src/db/schema.ts');
    setDB({
      getAllSync: (_sql: string, _params?: unknown[]) => [],
      getFirstSync: (_sql: string, _params?: unknown[]) => null,
      runSync: (_sql: string, _params?: unknown[]) => ({ changes: 0, lastInsertRowId: 0 }),
      execSync: (_sql: string) => {},
    });
    const { classifyQuery } = await import('../../src/routing/tierRouter.ts');
    const d = await classifyQuery("What's scheduled for next Tuesday?");
    console.log(`${DIM}PT19 routing: reason=${JSON.stringify(d.reason)} response=${JSON.stringify(d.tier1Response)}${RESET}`);
    assert(
      'PT19 "What\'s scheduled for next Tuesday?" → calendar:specific_day (connector-bearing shape)',
      d.reason,
      (v) => v === 'calendar:specific_day',
      'calendar:specific_day',
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
