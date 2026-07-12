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
