// scripts/heraldTest/calendarUnresolvableDate.test.ts
// hasUnresolvableDate guard — month+day / fuzzy future / weekday refusal.
//
// Runner: npx tsx scripts/heraldTest/calendarUnresolvableDate.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const REFUSAL =
  'I can only tell you about today, tomorrow, this week, or next week right now.';

// Minimal replica — calendar_cache only (schema v2 Unix-ms shape). Same pattern
// as doctorRead.test.ts freshDB(); empty table is enough for CUD1–8.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL,
    all_day   INTEGER DEFAULT 0,
    notes     TEXT,
    cached_at TEXT NOT NULL
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

export async function runCalendarUnresolvableDateTests() {
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

  console.log(`\n${BOLD}-- calendarUnresolvableDate Contract Tests --------------------${RESET}\n`);

  freshDB();

  // CUD1–3: NEW — month+day / fuzzy future must refuse, not fall through to today
  {
    const d = await classifyQuery("What's on my calendar August 12th");
    assert(
      'CUD1 "August 12th" → honest refusal (not today\'s schedule)',
      d,
      (v) => {
        const x = v as { tier1Response?: string; reason?: string };
        return x.tier1Response === REFUSAL && x.reason === 'calendar:unresolved_weekday';
      },
      `tier1Response === REFUSAL, reason calendar:unresolved_weekday`,
    );
  }

  {
    const d = await classifyQuery("What's on my calendar in a couple weeks");
    assert(
      'CUD2 "couple weeks" → honest refusal',
      d,
      (v) => {
        const x = v as { tier1Response?: string; reason?: string };
        return x.tier1Response === REFUSAL && x.reason === 'calendar:unresolved_weekday';
      },
      `tier1Response === REFUSAL, reason calendar:unresolved_weekday`,
    );
  }

  {
    const d = await classifyQuery("What's on my calendar next month");
    assert(
      'CUD3 "next month" → honest refusal (FUZZY_FUTURE)',
      d,
      (v) => {
        const x = v as { tier1Response?: string; reason?: string };
        return x.tier1Response === REFUSAL && x.reason === 'calendar:unresolved_weekday';
      },
      `tier1Response === REFUSAL, reason calendar:unresolved_weekday`,
    );
  }

  // CUD4–7: REGRESSION — supported windows still route to real calendar buckets
  {
    const d = await classifyQuery("What's on my calendar today");
    assert(
      'CUD4 "today" → calendar:today (not refusal)',
      d,
      (v) => {
        const x = v as { tier1Response?: string; reason?: string };
        return x.reason === 'calendar:today' && x.tier1Response !== REFUSAL;
      },
      'reason: calendar:today, response !== REFUSAL',
    );
  }

  {
    const d = await classifyQuery("What's on my calendar tomorrow");
    assert(
      'CUD5 "tomorrow" → calendar:tomorrow',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:tomorrow',
      'reason: calendar:tomorrow',
    );
  }

  {
    const d = await classifyQuery("What's on my calendar this week");
    assert(
      'CUD6 "this week" → calendar:week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }

  {
    const d = await classifyQuery("What's on my calendar next week");
    assert(
      'CUD7 "next week" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }

  // CUD9+: composable calendar-read auth — read evidence ∧ scope; bare temporal ≠ auth
  const isCalendarReadReason = (v: unknown) => {
    const r = (v as { reason?: string }).reason ?? '';
    return r === 'calendar:today' || r === 'calendar:tomorrow'
      || r === 'calendar:week' || r === 'calendar:next_week'
      || r === 'calendar:unresolved_weekday';
  };
  const isCalendarWrite = (v: unknown) =>
    (v as { reason?: string }).reason === 'action:calendar_write';

  // Positive reads — including "schedule for" noun phrases (must not hit write)
  {
    const d = await classifyQuery("What's my schedule for tomorrow?");
    assert(
      'CUD9 "What\'s my schedule for tomorrow?" → calendar:tomorrow (not write)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:tomorrow' && !isCalendarWrite(v),
      'reason: calendar:tomorrow',
    );
  }
  {
    const d = await classifyQuery('Show me my schedule for this week.');
    assert(
      'CUD10 "Show me my schedule for this week." → calendar:week (not write)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week' && !isCalendarWrite(v),
      'reason: calendar:week',
    );
  }
  {
    const d = await classifyQuery("What's my schedule for next week?");
    assert(
      'CUD11 "What\'s my schedule for next week?" → calendar:next_week (not write)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week' && !isCalendarWrite(v),
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('What is on my calendar next week?');
    assert(
      'CUD12 "What is on my calendar next week?" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('What do I have scheduled next week?');
    assert(
      'CUD13 "What do I have scheduled next week?" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('My schedule next week.');
    assert(
      'CUD14 "My schedule next week." → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('Calendar next week.');
    assert(
      'CUD15 "Calendar next week." → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('What do I have next week?');
    assert(
      'CUD16 "What do I have next week?" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery('Show me this week.');
    assert(
      'CUD17 "Show me this week." → calendar:week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }

  // Positive writes
  {
    const d = await classifyQuery('Schedule lunch tomorrow.');
    assert(
      'CUD18 "Schedule lunch tomorrow." → calendar_write',
      d,
      (v) => isCalendarWrite(v),
      'reason: action:calendar_write',
    );
  }
  {
    const d = await classifyQuery('Schedule a dentist appointment.');
    assert(
      'CUD19 "Schedule a dentist appointment." → calendar_write',
      d,
      (v) => isCalendarWrite(v),
      'reason: action:calendar_write',
    );
  }
  {
    const d = await classifyQuery('Add this to my schedule.');
    assert(
      'CUD20 "Add this to my schedule." → calendar_write',
      d,
      (v) => isCalendarWrite(v),
      'reason: action:calendar_write',
    );
  }
  {
    const d = await classifyQuery('Put this on my calendar.');
    assert(
      'CUD21 "Put this on my calendar." → calendar_write',
      d,
      (v) => isCalendarWrite(v),
      'reason: action:calendar_write',
    );
  }

  // Narrative negatives — bare temporal must not authorize a calendar read
  {
    const d = await classifyQuery('My son is going to New Mexico next week.');
    assert(
      'CUD22 "My son is going to New Mexico next week." → no calendar read',
      d,
      (v) => !isCalendarReadReason(v),
      'reason not a calendar read',
    );
  }
  {
    const d = await classifyQuery('My son is going to New Mexico this week.');
    assert(
      'CUD23 "My son is going to New Mexico this week." → no calendar read',
      d,
      (v) => !isCalendarReadReason(v),
      'reason not a calendar read',
    );
  }
  {
    const d = await classifyQuery('My daughter is visiting in the coming week.');
    assert(
      'CUD24 "My daughter is visiting in the coming week." → no calendar read',
      d,
      (v) => !isCalendarReadReason(v),
      'reason not a calendar read',
    );
  }

  // Exclusion — bare this-week must block today-only collapse
  {
    const d = await classifyQuery("What's on my calendar today, this week is packed.");
    assert(
      'CUD25 "What\'s on my calendar today, this week is packed." → calendar:week (not today-only)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }
  {
    const d = await classifyQuery('Anything on my calendar today or this week?');
    assert(
      'CUD26 "Anything on my calendar today or this week?" → calendar:week (not today-only)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }

  // CUD27–30: weak fragments must not authorize when embedded in declaratives
  {
    const d = await classifyQuery("Grandma's birthday is on my calendar for next week.");
    assert(
      'CUD27 "Grandma\'s birthday is on my calendar for next week." → no calendar read / no calendar data',
      d,
      (v) => {
        const x = v as { reason?: string; tier1Response?: string; actionIntent?: { type?: string } };
        return !isCalendarReadReason(v)
          && x.actionIntent?.type !== 'calendar_write'
          && !((x.reason ?? '').startsWith('calendar:'));
      },
      'no calendar read dispatch and no calendar data',
    );
  }
  {
    const d = await classifyQuery('My schedule is packed next week.');
    assert(
      'CUD28 "My schedule is packed next week." → no calendar read / no calendar data',
      d,
      (v) => {
        const x = v as { reason?: string; actionIntent?: { type?: string } };
        return !isCalendarReadReason(v)
          && x.actionIntent?.type !== 'calendar_write'
          && !((x.reason ?? '').startsWith('calendar:'));
      },
      'no calendar read dispatch and no calendar data',
    );
  }
  {
    const d = await classifyQuery("It's on my schedule for this week.");
    assert(
      'CUD29 "It\'s on my schedule for this week." → no calendar read / no calendar data',
      d,
      (v) => {
        const x = v as { reason?: string; actionIntent?: { type?: string } };
        return !isCalendarReadReason(v)
          && x.actionIntent?.type !== 'calendar_write'
          && !((x.reason ?? '').startsWith('calendar:'));
      },
      'no calendar read dispatch and no calendar data',
    );
  }
  {
    const d = await classifyQuery('My schedule is full this week, unfortunately.');
    assert(
      'CUD30 "My schedule is full this week, unfortunately." → no calendar read / no calendar data',
      d,
      (v) => {
        const x = v as { reason?: string; actionIntent?: { type?: string } };
        return !isCalendarReadReason(v)
          && x.actionIntent?.type !== 'calendar_write'
          && !((x.reason ?? '').startsWith('calendar:'));
      },
      'no calendar read dispatch and no calendar data',
    );
  }

  // CUD31–33: week's-schedule whole-utterance reads (week scope from the phrase itself)
  {
    const d = await classifyQuery("What's my week's schedule?");
    assert(
      'CUD31 "What\'s my week\'s schedule?" → calendar:week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }
  {
    const d = await classifyQuery("Week's schedule?");
    assert(
      'CUD32 "Week\'s schedule?" → calendar:week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }
  {
    const d = await classifyQuery("My week's schedule.");
    assert(
      'CUD33 "My week\'s schedule." → calendar:week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:week',
      'reason: calendar:week',
    );
  }

  // CUD34: bare today-default (no temporal marker)
  {
    const d = await classifyQuery("What's on my calendar?");
    assert(
      'CUD34 "What\'s on my calendar?" → calendar:today (today-default)',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:today',
      'reason: calendar:today',
    );
  }

  // CUD35–37: strong/generic fragments must not authorize when embedded in narratives
  const noCalendarDispatch = (v: unknown) => {
    const x = v as { reason?: string; actionIntent?: { type?: string } };
    return !isCalendarReadReason(v)
      && x.actionIntent?.type !== 'calendar_write'
      && !((x.reason ?? '').startsWith('calendar:'));
  };
  {
    const d = await classifyQuery(
      'Any appointments I had got cancelled, so next week is wide open.',
    );
    assert(
      'CUD35 "Any appointments I had got cancelled…" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }
  {
    const d = await classifyQuery(
      'I asked her to show me the venue, and next week works for everyone.',
    );
    assert(
      'CUD36 "I asked her to show me the venue…" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }
  {
    const d = await classifyQuery(
      "Is there anything I should know before next week's trip?",
    );
    assert(
      'CUD37 "Is there anything I should know before next week\'s trip?" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }

  // CUD38–39: anchored positives for formerly-free generic openers
  {
    const d = await classifyQuery('Do I have anything scheduled next week?');
    assert(
      'CUD38 "Do I have anything scheduled next week?" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }
  {
    const d = await classifyQuery("What's scheduled next week?");
    assert(
      'CUD39 "What\'s scheduled next week?" → calendar:next_week',
      d,
      (v) => (v as { reason?: string }).reason === 'calendar:next_week',
      'reason: calendar:next_week',
    );
  }

  // CUD40–43: generic FREE fragments must not authorize competing-topic questions
  {
    const d = await classifyQuery('What do I have to pack for the trip next week?');
    assert(
      'CUD40 "What do I have to pack for the trip next week?" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }
  {
    const d = await classifyQuery('Do I have anything else to bring before next week?');
    assert(
      'CUD41 "Do I have anything else to bring before next week?" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }
  {
    const d = await classifyQuery("What's going on with the Hendersons next week?");
    assert(
      'CUD42 "What\'s going on with the Hendersons next week?" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }
  {
    const d = await classifyQuery("What's happening at work next week, any layoffs?");
    assert(
      'CUD43 "What\'s happening at work next week, any layoffs?" → no calendar read/write/data',
      d,
      noCalendarDispatch,
      'no calendar read dispatch, no calendar data, no calendar write',
    );
  }

  // CUD8: REGRESSION — original named-weekday refusal still fires
  {
    const d = await classifyQuery("What's on my calendar Saturday");
    assert(
      'CUD8 "Saturday" → calendar:unresolved_weekday refusal',
      d,
      (v) => {
        const x = v as { tier1Response?: string; reason?: string };
        return x.tier1Response === REFUSAL && x.reason === 'calendar:unresolved_weekday';
      },
      `tier1Response === REFUSAL, reason calendar:unresolved_weekday`,
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}calendarUnresolvableDate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('calendarUnresolvableDate.test.ts')) {
  runCalendarUnresolvableDateTests().catch(console.error);
}
