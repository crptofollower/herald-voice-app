// scripts/heraldTest/doctorRead.test.ts
// Doctor-read contract — Build 72.
// Locks medical:doctor_read as its own reader (§4a): empty → honest miss
// (never a medication summary), seeded doctor_name returned verbatim, singular
// "who is my doctor" stays on doctor_read (not medical:summary), and med
// phrasing still routes medical:summary (regression on the removed patterns).
//
// Runner: npx tsx scripts/heraldTest/doctorRead.test.ts
// Gate:   wired from run.mjs — must be green before Build 72 closes.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalContact } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Hand-maintained replica of the medical tables classifyQuery/getDoctorSummary
// touch. Same caveat as medicalContract / diagnosisContract: if production DDL
// drifts, update this — device is the real migration proof.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dosage TEXT,
    frequency TEXT,
    prescribing_doctor TEXT,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT,
    removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY,
    name TEXT,
    specialty TEXT,
    phone TEXT,
    address TEXT,
    is_primary INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT,
    removed_at TEXT
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

export async function runDoctorReadTests() {
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

  console.log(`\n${BOLD}-- Doctor-Read Contract Tests -----------------------------${RESET}\n`);

  // ── DR1: empty DB — honest miss, never a medication summary ───────────────
  {
    freshDB();
    const d = await classifyQuery('who are my doctors');
    assert(
      'DR1 empty → medical:doctor_read; "don\'t have a doctor"; no "medication"',
      { reason: d.reason, response: d.tier1Response },
      (v) => {
        const r = v as { reason?: string; response?: string };
        return r.reason === 'medical:doctor_read'
          && typeof r.response === 'string'
          && /don't have your doctors/i.test(r.response)
          && !/medication/i.test(r.response);
      },
      'reason medical:doctor_read; contains "don\'t have a doctor"; no "medication"',
    );
  }

  // ── DR2: seeded doctor_name — verbatim in the spoken reply ────────────────
  {
    freshDB();
    writeMedicalContact({ name: 'Dr. Sarver', is_primary: 0 });
    const d = await classifyQuery('who are my doctors');
    assert('DR2 seeded Dr. Sarver appears in response', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Dr. Sarver'),
      'contains "Dr. Sarver"');
  }

  // ── DR3: singular "who is my doctor" — doctor_read, not summary ───────────
  {
    freshDB();
    const d = await classifyQuery('who is my doctor');
    assert('DR3 singular routes medical:doctor_read (not summary)', d.reason,
      (v) => v === 'medical:doctor_read', 'medical:doctor_read');
  }

  // ── DR4: med phrasing still medical:summary (regression guard) ────────────
  {
    freshDB();
    const d = await classifyQuery('what medication am I on');
    assert('DR4 med phrasing still routes medical:summary', d.reason,
      (v) => v === 'medical:summary', 'medical:summary');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}DoctorRead: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('doctorRead.test.ts')) {
  runDoctorReadTests().catch(console.error);
}
