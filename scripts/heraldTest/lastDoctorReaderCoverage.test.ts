// scripts/heraldTest/lastDoctorReaderCoverage.test.ts
// Locks the last-doctor authoritative-reader coverage repair (2026-09-06).
// Root cause: recency-qualified questions ("what doctor did I see LAST",
// "who did I see MOST RECENTLY") were shadowed by visit_read's broader bare
// "did I see" patterns (checked before VISIT_HISTORY_READ), and several
// natural MOST-RECENT phrasings ("what was my last doctor visit", "tell me
// my most recent doctor visit", the embedded-question word order "who my
// last doctor WAS") matched neither reader at all — proven in
// HERALD_LAST_DOCTOR_READ_DIAGNOSTIC_2026-09-06.md, repaired per
// HERALD_LAST_DOCTOR_AUTHORITATIVE_READER_COVERAGE_REPAIR_2026-09-06.md.
// VISIT_HISTORY_READ is now checked before visit_read, both readers reuse
// detectMedicalEvent's existing afterLeadingReadRequestWrapper, and
// getLastVisit/database/schema are untouched.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

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
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

function freshDBWithOneVisit() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
  return db;
}

export async function runLastDoctorReaderCoverageTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Last-Doctor Authoritative Reader Coverage --${RESET}\n`);

  // ── MOST-RECENT — must reach medical:visit_history_read / getLastVisit ──
  const mostRecent: [string, string][] = [
    ['MR1', 'Who was the last doctor I saw?'],
    ['MR2', 'What doctor did I see last?'],
    ['MR3', 'Who did I see most recently?'],
    ['MR4', 'What was my last doctor visit?'],
    ['MR5', 'Tell me my most recent doctor visit.'],
    ['MR6', 'When did I last see Dr. Smith?'],
    ['MR7', 'Who was the last physician I saw?'],
    ['MR8', 'Can you tell me what the last doctor was I saw'],
    ['MR9', 'No I was asking you if you can tell me who my last doctor was that I saw'],
    ['MR10', 'Do you know who my last doctor was?'],
    ['MR11', 'I wanted to know when I last saw Dr. Smith.'],
  ];
  for (const [id, text] of mostRecent) {
    freshDBWithOneVisit();
    const d = await classifyQuery(text);
    assert(`${id} routes medical:visit_history_read — "${text}"`, d.reason,
      (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
    assert(`${id} names Dr. Smith from history (getLastVisit reached, unmodified)`, d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Dr. Smith') && !/don't have a visit/i.test(v),
      'includes "Dr. Smith"');
  }

  // ── ENUMERATION — must remain medical:visit_read ────────────────────────
  const enumeration: [string, string][] = [
    ['ENUM12', 'Who have I seen?'],
    ['ENUM13', 'Who did I see?'],
    ['ENUM14', 'What doctors have I seen?'],
    ['ENUM15', 'Which doctors did I see?'],
  ];
  for (const [id, text] of enumeration) {
    freshDBWithOneVisit();
    const d = await classifyQuery(text);
    assert(`${id} routes medical:visit_read (enumeration) — "${text}"`, d.reason,
      (v) => v === 'medical:visit_read', 'medical:visit_read');
    assert(`${id} not the recency reader`, d.reason,
      (v) => v !== 'medical:visit_history_read', 'not medical:visit_history_read');
  }

  // ── STATEMENT/CAPTURE FENCES — must not become a read (either reader) ──
  const statements: [string, string][] = [
    ['STMT16', 'I saw Dr. Smith last week.'],
    ['STMT17', 'I saw my doctor yesterday.'],
    ['STMT18', 'My last doctor was Dr. Smith.'],
    ['STMT19', 'I was telling you I saw Dr. Smith.'],
    ['STMT20', 'I wanted to tell you I saw Dr. Smith.'],
  ];
  for (const [id, text] of statements) {
    freshDBWithOneVisit();
    const d = await classifyQuery(text);
    assert(`${id} does not become a read — "${text}"`, d.reason,
      (v) => v !== 'medical:visit_history_read' && v !== 'medical:visit_read',
      'not medical:visit_history_read / medical:visit_read');
  }
  // Explicit, unchanged-behavior capture confirmations (these two were
  // already action:medical_capture before this repair and must stay so).
  {
    freshDBWithOneVisit();
    const d = await classifyQuery('I saw Dr. Smith last week.');
    assert('STMT16 still action:medical_capture (unchanged)', d.reason,
      (v) => v === 'action:medical_capture', 'action:medical_capture');
  }
  {
    freshDBWithOneVisit();
    const d = await classifyQuery('I saw my doctor yesterday.');
    assert('STMT17 still action:medical_capture (unchanged)', d.reason,
      (v) => v === 'action:medical_capture', 'action:medical_capture');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LastDoctorReaderCoverage: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('lastDoctorReaderCoverage.test.ts')) {
  runLastDoctorReaderCoverageTests().catch(console.error);
}
