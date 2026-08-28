// scripts/heraldTest/upcomingMedicalRead.test.ts
// Locks UPCOMING MEDICAL APPOINTMENT RECALL (2026-08-09): the forward-looking
// medical_visit reader getUpcomingAppointments + its classifyQuery dispatch.
// Named first-turn miss falls through to existing Calendar evidence (2026-08-28).
// Named-doctor selection tests the COMPLETE stored name against the utterance
// (no extracted-hint truncation); list caps at three then "plus N more".
//
// Runner: npx tsx scripts/heraldTest/upcomingMedicalRead.test.ts

import Database from 'better-sqlite3';
import { setDB, getDB } from '../../src/db/schema.ts';
import { getUpcomingAppointments, getMedicalRecords } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, visit_outcome TEXT,
    outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT, start_ms INTEGER, end_ms INTEGER,
    all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT
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

// YYYY-MM-DD offset from today (local), so tests are date-relative and stable.
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function insertUpcoming(db: Database.Database, doctor: string | null, visitDate: string, status = 'upcoming') {
  const id = `mr_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, status, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, visitDate, doctor, status, new Date().toISOString());
  return id;
}

function seedCacheEvent(title: string, daysAhead: number, hour = 11) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  const startMs = d.getTime();
  getDB().runSync(
    `INSERT OR REPLACE INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [`cal_${startMs}`, title, startMs, startMs + 3600_000, 0, null, new Date().toISOString()],
  );
  return startMs;
}

async function withFakeCalendarEvents<T>(
  events: { id: string; title: string; startDate: string | Date }[],
  fn: () => Promise<T>,
): Promise<T> {
  setCalendarEventFetcher(async () => ({ status: 'ok' as const, events: events as any }));
  try {
    return await fn();
  } finally {
    resetCalendarEventFetcher();
  }
}

async function withUnavailableCalendar<T>(fn: () => Promise<T>): Promise<T> {
  setCalendarEventFetcher(async () => ({ status: 'unavailable' as const, reason: 'permission-denied' }));
  try {
    return await fn();
  } finally {
    resetCalendarEventFetcher();
  }
}

export async function runUpcomingMedicalReadTests() {
  const failures: { label: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label });
    }
  }

  console.log(`\n${BOLD}-- Upcoming Medical Appointment Recall --${RESET}\n`);

  // U1 — no upcoming rows → honest none
  {
    freshDB();
    const d = await classifyQuery('what doctor appointments do I have coming up');
    assert('U1 empty → Herald-local miss only', d.tier1Response,
      (v) => typeof v === 'string' && /don't have any upcoming doctor appointments saved yet/i.test(v)
        && !/coming up/i.test(v as string),
      "I don't have any upcoming doctor appointments saved yet.");
    assert('U1b reason is empty-read', (d as any).reason, (v) => v === 'medical:upcoming_read_empty', 'medical:upcoming_read_empty');
  }

  // U2 — one upcoming → "You see Dr. Smith on ..."
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(5));
    const d = await classifyQuery('what doctor appointments do I have coming up');
    assert('U2 one → You see', d.tier1Response,
      (v) => typeof v === 'string' && /^You see Dr\. Smith on /.test(v as string), 'You see Dr. Smith on <date>.');
    assert('U2b reason is list-read', (d as any).reason, (v) => v === 'medical:upcoming_read_list', 'medical:upcoming_read_list');
  }

  // U3 — two upcoming → list, soonest first, "then"
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Patel', dayOffset(10));
    insertUpcoming(db, 'Dr. Smith', dayOffset(3));
    const d = await classifyQuery('what medical appointments do I have coming up');
    assert('U3 two → You have ... then ...', d.tier1Response,
      (v) => typeof v === 'string' && /^You have Dr\. Smith on .*, then Dr\. Patel on /.test(v as string),
      'You have Dr. Smith ..., then Dr. Patel ...');
  }

  // U4 — five upcoming → cap at three + "plus 2 more"
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. A', dayOffset(1));
    insertUpcoming(db, 'Dr. B', dayOffset(2));
    insertUpcoming(db, 'Dr. C', dayOffset(3));
    insertUpcoming(db, 'Dr. D', dayOffset(4));
    insertUpcoming(db, 'Dr. E', dayOffset(5));
    const d = await classifyQuery('what doctor appointments do I have coming up');
    assert('U4 caps at three, states remainder', d.tier1Response,
      (v) => typeof v === 'string' && /plus 2 more\.$/.test(v as string), '... plus 2 more.');
    assert('U4b only three names spoken', d.tier1Response,
      (v) => typeof v === 'string' && (v as string).includes('Dr. A') && (v as string).includes('Dr. C') && !(v as string).includes('Dr. D'),
      'Dr. A..Dr. C present, Dr. D absent');
  }

  // U5 — past-dated 'upcoming' row excluded by >= today filter (reader level)
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Past', dayOffset(-3));
    insertUpcoming(db, 'Dr. Future', dayOffset(3));
    const rows = getUpcomingAppointments();
    assert('U5 reader excludes past-dated upcoming', rows.map(r => r.doctorName).join(','),
      (v) => v === 'Dr. Future', 'Dr. Future only');
  }

  // U6 — 'noted' (retrospective) row excluded by status filter
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Noted', dayOffset(3), 'noted');
    const rows = getUpcomingAppointments();
    assert('U6 reader excludes noted rows', rows.length, (v) => v === 0, '0');
  }

  // U7 — named-doctor match → nearest with that doctor only
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(4));
    insertUpcoming(db, 'Dr. Patel', dayOffset(2));
    const d = await classifyQuery('when do I see Dr Smith');
    assert('U7 named match → that doctor', d.tier1Response,
      (v) => typeof v === 'string' && /^You see Dr\. Smith on /.test(v as string), 'You see Dr. Smith on <date>.');
    assert('U7b reason named', (d as any).reason, (v) => v === 'medical:upcoming_read_named', 'medical:upcoming_read_named');
  }

  // U8 — named-doctor miss (others exist) → calendar bounded miss, no leak
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Patel', dayOffset(2));
    await withFakeCalendarEvents([], async () => {
      const d = await classifyQuery('when do I see Dr Smith');
      assert('U8 named miss → calendar bounded miss', d.tier1Response,
        (v) => typeof v === 'string' && /don't see anything with Dr Smith on your calendar in the next 6 months/i.test(v),
        "I don't see anything with Dr Smith on your calendar in the next 6 months.");
      assert('U8b miss does not leak Patel', d.tier1Response,
        (v) => typeof v === 'string' && !(v as string).includes('Patel'), 'no Patel');
    });
  }

  // U9 — verbatim name with a period/apostrophe spoken exactly as stored
  {
    const db = freshDB();
    insertUpcoming(db, "Dr. O'Brien", dayOffset(3));
    const d = await classifyQuery("when do I see Dr O'Brien");
    assert('U9 verbatim apostrophe name', d.tier1Response,
      (v) => typeof v === 'string' && (v as string).includes("Dr. O'Brien"), "contains Dr. O'Brien verbatim");
  }

  // U10 — row with no doctor name → date-only variant, no invented name
  {
    const db = freshDB();
    insertUpcoming(db, null, dayOffset(3));
    const d = await classifyQuery('what doctor appointments do I have coming up');
    assert('U10 no name → your doctor, no fabrication', d.tier1Response,
      (v) => typeof v === 'string' && /your doctor on /.test(v as string) && !/Dr\./.test(v as string),
      'You see your doctor on <date>.');
  }

  // U11 — 'next' single query → nearest only, single reason
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Late', dayOffset(9));
    insertUpcoming(db, 'Dr. Soon', dayOffset(2));
    const d = await classifyQuery('when is my next doctor appointment');
    assert('U11 next → nearest only', d.tier1Response,
      (v) => typeof v === 'string' && (v as string).includes('Dr. Soon') && !(v as string).includes('Dr. Late'),
      'Dr. Soon only');
    assert('U11b reason next', (d as any).reason, (v) => v === 'medical:upcoming_read_next', 'medical:upcoming_read_next');
  }

  // U12 — longest-complete-match preference (two stored names, one is a
  // superset supported by the utterance)
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(6));
    insertUpcoming(db, 'Dr. Smithson', dayOffset(4));
    const d = await classifyQuery('when do I see Dr Smithson');
    assert('U12 longest complete match wins', d.tier1Response,
      (v) => typeof v === 'string' && (v as string).includes('Dr. Smithson'), 'Dr. Smithson');
    assert('U12b does not select the shorter Smith', d.tier1Response,
      (v) => typeof v === 'string' && !/Dr\. Smith on/.test(v as string), 'not Dr. Smith');
  }

  // U13 (regression) — past "who did I see" still routes to visit_read
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(3));
    const d = await classifyQuery('who did I see');
    assert('U13 past query still visit_read', (d as any).reason,
      (v) => v === 'medical:visit_read', 'medical:visit_read');
  }

  // U14 — named-doctor query, two upcoming visits with that doctor → both
  // spoken, "and again" connector (2026-08-10, multi-visit named-recall).
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(2));
    insertUpcoming(db, 'Dr. Smith', dayOffset(9));
    const d = await classifyQuery('when do I see Dr Smith');
    assert('U14 named multi (2) → both spoken, and again', d.tier1Response,
      (v) => typeof v === 'string' && /^You see Dr\. Smith on .*, and again .*\.$/.test(v as string),
      'You see Dr. Smith on <date1>, and again <date2>.');
    assert('U14b reason unchanged by count', (d as any).reason,
      (v) => v === 'medical:upcoming_read_named', 'medical:upcoming_read_named');
  }

  // U15 — named-doctor query, three upcoming visits → "then again ... and again ..."
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(2));
    insertUpcoming(db, 'Dr. Smith', dayOffset(9));
    insertUpcoming(db, 'Dr. Smith', dayOffset(15));
    const d = await classifyQuery('when do I see Dr Smith');
    assert('U15 named multi (3) → then again, and again', d.tier1Response,
      (v) => typeof v === 'string' && /^You see Dr\. Smith on .*, then again .*, and again .*\.$/.test(v as string),
      'You see Dr. Smith on <d1>, then again <d2>, and again <d3>.');
  }

  // U16 — named-doctor query, five upcoming visits → caps at three, states remainder
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(2));
    insertUpcoming(db, 'Dr. Smith', dayOffset(9));
    insertUpcoming(db, 'Dr. Smith', dayOffset(15));
    insertUpcoming(db, 'Dr. Smith', dayOffset(20));
    insertUpcoming(db, 'Dr. Smith', dayOffset(30));
    const d = await classifyQuery('when do I see Dr Smith');
    assert('U16 named multi (5) caps at three, states remainder', d.tier1Response,
      (v) => typeof v === 'string' && /and 2 more after that\.$/.test(v as string),
      '... and 2 more after that.');
    assert('U16b exactly two "then again" clauses, no "and again"', d.tier1Response,
      (v) => typeof v === 'string' &&
        ((v as string).match(/then again/g) || []).length === 2 &&
        !/and again/.test(v as string),
      'exactly two "then again" clauses before the overflow tail, no "and again"');
  }

  // U17 — mixed-doctor guard: a shorter-name decoy doctor also passes the
  // substring filter and falls chronologically BETWEEN two of the target
  // doctor's visits. The guard (sameDoctor filter, 2026-08-10) must exclude
  // the decoy entirely rather than let it appear inside the spoken list —
  // U12 proves the guard picks the right single doctor; this proves it
  // still excludes a decoy once the winning doctor has multiple rows.
  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(5));
    insertUpcoming(db, 'Dr. Smithson', dayOffset(2));
    insertUpcoming(db, 'Dr. Smithson', dayOffset(9));
    const d = await classifyQuery('when do I see Dr Smithson');
    assert('U17 mixed-doctor guard excludes decoy despite chronological overlap', d.tier1Response,
      (v) => typeof v === 'string' &&
        /^You see Dr\. Smithson on .*, and again .*\.$/.test(v as string) &&
        !/Dr\. Smith on/.test(v as string),
      'You see Dr. Smithson on <d1>, and again <d2>. (no Dr. Smith clause)');
  }

  {
    freshDB();
    await withFakeCalendarEvents([], async () => {
      const d = await classifyQuery('When is my next appointment with Dr. Smith?');
      assert('ND-A next appointment with Dr. Smith reaches named calendar miss',
        { reason: (d as any).reason, resp: d.tier1Response },
        v => v.reason === 'medical:upcoming_read_named_calendar_miss'
          && /don't see anything with Dr\. Smith on your calendar in the next 6 months/i.test(v.resp),
        'named upcoming authority + bounded calendar miss');
    });
  }

  {
    freshDB();
    await withFakeCalendarEvents([], async () => {
      const d = await classifyQuery('When am I seeing Dr. Smith again?');
      assert('ND-B seeing Dr. Smith again reaches named upcoming authority',
        (d as any).reason,
        v => v === 'medical:upcoming_read_named_calendar_miss',
        'medical:upcoming_read_named_calendar_miss');
    });
  }

  {
    freshDB();
    seedCacheEvent('Dr. Smith', 2);
    const d = await classifyQuery('When is my next appointment with Dr. Smith?');
    assert('ND-C/D named medical miss uses calendar evidence with provenance',
      { reason: (d as any).reason, resp: d.tier1Response },
      v => v.reason === 'medical:upcoming_read_named_calendar'
        && typeof v.resp === 'string' && v.resp.startsWith('Your calendar shows Dr. Smith on '),
      'Your calendar shows Dr. Smith …');
  }

  {
    freshDB();
    await withUnavailableCalendar(async () => {
      const d = await classifyQuery('When is my appointment with Dr. Smith?');
      assert('ND-E calendar unavailable is not absence',
        { reason: (d as any).reason, resp: d.tier1Response },
        v => v.reason === 'medical:upcoming_read_named_calendar_unavailable'
          && v.resp === "I couldn't check your calendar right now.",
        "I couldn't check your calendar right now.");
    });
  }

  {
    const db = freshDB();
    insertUpcoming(db, 'Dr. Smith', dayOffset(12));
    seedCacheEvent('Dr. Smith', 2);
    const d = await classifyQuery('When do I see Dr. Smith?');
    assert('ND-H medical upcoming still wins before Calendar',
      d.tier1Response,
      v => typeof v === 'string' && /^You see Dr\. Smith on /.test(v) && !/Your calendar shows/.test(v),
      'confirmed-memory You see …');
  }

  {
    freshDB();
    const before = getMedicalRecords().length;
    seedCacheEvent('Dr. Smith', 3);
    await classifyQuery('When is my next appointment with Dr. Smith?');
    assert('ND-I calendar evidence is not written to medical_records',
      getMedicalRecords().length,
      v => v === before,
      'medical_records row count unchanged');
  }

  {
    freshDB();
    const d = await classifyQuery('Do I have any future doctor appointments?');
    assert('ND-J generic empty is Herald-local, not universal absence',
      d.tier1Response,
      v => typeof v === 'string'
        && /don't have any upcoming doctor appointments saved yet/i.test(v)
        && !/coming up/i.test(v),
      "I don't have any upcoming doctor appointments saved yet.");
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}UpcomingMedicalRead: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) + `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('upcomingMedicalRead.test.ts')) {
  runUpcomingMedicalReadTests().catch(console.error);
}
