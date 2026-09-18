// scripts/heraldTest/heraldClock.test.ts
// Focused contract for the medical local-date clock. Wired from run.mjs
// (exactly 9 tests). Standalone: npx tsx scripts/heraldTest/heraldClock.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalRecord, getUpcomingAppointments, getLastVisit } from '../../src/db/medicalDB.ts';
import { setNow, resetNow, todayLocalISO } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
    created_at TEXT
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

function localNoon(y: number, monthIndex: number, day: number): Date {
  return new Date(y, monthIndex, day, 12, 0, 0);
}

function deviceLocalToday(): string {
  return new Date().toLocaleDateString('en-CA');
}

export async function runHeraldClockTests() {
  try {
    return await runHeraldClockTestsBody();
  } finally {
    resetNow();
  }
}

async function runHeraldClockTestsBody() {
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

  console.log(`\n${BOLD}-- HeraldClock medical local-date contract --------------------${RESET}\n`);

  {
    freshDB();
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-07-20', status: 'noted' });
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-09-15', status: 'upcoming' });
    setNow(localNoon(2026, 7, 10));
    try {
      const upcoming = getUpcomingAppointments();
      const last = getLastVisit('Alvarez');
      assert('before appointment date → upcoming includes 2026-09-15',
        upcoming.map((r) => r.visitDate),
        (v) => Array.isArray(v) && v.includes('2026-09-15'),
        'includes 2026-09-15');
      assert('before appointment date → noted historical visit unchanged',
        last?.visitDate, (v) => v === '2026-07-20', '2026-07-20');
    } finally {
      resetNow();
    }
  }

  {
    freshDB();
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-07-20', status: 'noted' });
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-09-15', status: 'upcoming' });
    setNow(localNoon(2026, 8, 15));
    try {
      const upcoming = getUpcomingAppointments();
      const last = getLastVisit('Alvarez');
      assert('appointment date → still upcoming',
        upcoming.map((r) => r.visitDate),
        (v) => Array.isArray(v) && v.includes('2026-09-15'),
        'includes 2026-09-15');
      assert('appointment date → noted historical visit unchanged',
        last?.visitDate, (v) => v === '2026-07-20', '2026-07-20');
    } finally {
      resetNow();
    }
  }

  {
    freshDB();
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-07-20', status: 'noted' });
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-09-15', status: 'upcoming' });
    setNow(localNoon(2026, 8, 16));
    try {
      const upcoming = getUpcomingAppointments();
      const last = getLastVisit('Alvarez');
      assert('day after appointment → not upcoming',
        upcoming.map((r) => r.visitDate),
        (v) => Array.isArray(v) && !v.includes('2026-09-15'),
        'excludes 2026-09-15');
      assert('day after appointment → noted historical visit unchanged',
        last?.visitDate, (v) => v === '2026-07-20', '2026-07-20');
    } finally {
      resetNow();
    }
  }

  {
    const got = todayLocalISO();
    const expected = deviceLocalToday();
    assert('no override → current real local date',
      { got, expected },
      (v) => {
        const x = v as { got: string; expected: string };
        return x.got === x.expected;
      },
      `todayLocalISO === device local YYYY-MM-DD (${expected})`);
  }

  {
    setNow(localNoon(2026, 7, 10));
    try {
      assert('override is active before reset', todayLocalISO(),
        (v) => v === '2026-08-10', '2026-08-10');
    } finally {
      resetNow();
    }
    const after = todayLocalISO();
    const expected = deviceLocalToday();
    assert('leak check: override reset before subsequent suites',
      { after, expected, utcSlice: new Date().toISOString().slice(0, 10) },
      (v) => {
        const x = v as { after: string; expected: string; utcSlice: string };
        return x.after === x.expected && x.after.length === 10;
      },
      `todayLocalISO === device local today (${expected}), not leftover override`);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}HeraldClock: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('heraldClock.test.ts')) {
  runHeraldClockTests().catch(console.error);
}
