// scripts/heraldTest/lastDoctorReadShapeGuardRepair.test.ts
// Locks the read-shape guard repair (2026-09-06). Root cause: detectMedicalEvent's
// isReadShapedUtterance did not recognize common wrapped/embedded read questions
// ("Can you tell me who my last doctor was?", "I was asking you if you can tell
// me..."), so bare "saw" + "doctor" got misread as a past-visit statement and
// tierRouter's medical-capture intercept stole the turn before either
// authoritative visit-history reader (visit_read / VISIT_HISTORY_READ) was ever
// reached — proven in HERALD_LAST_DOCTOR_READ_DIAGNOSTIC_2026-09-06.md, repaired
// per HERALD_LAST_DOCTOR_READ_SHAPE_GUARD_REPAIR_2026-09-06.md. This commit only
// repairs the read-shape guard; the secondary VISIT_HISTORY_READ/visit_read
// phrase-coverage gap remains intentionally unresolved.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { isReadShapedUtterance, detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
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

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

export async function runLastDoctorReadShapeGuardRepairTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Last-Doctor Read-Shape Guard Repair --${RESET}\n`);

  // ── DEVICE REGRESSIONS — the two exact Samsung utterances must no longer
  // route to action:medical_capture. Per instruction, success for this commit
  // is exactly that — NOT that they reach VISIT_HISTORY_READ (the secondary
  // phrase-coverage gap there is intentionally deferred).
  {
    const text = 'Can you tell me what the last doctor was I saw';
    assert('DEVICE-1 isReadShapedUtterance is now true', isReadShapedUtterance(text), (v) => v === true, 'true');
    assert('DEVICE-1 detectMedicalEvent is now null', detectMedicalEvent(text), (v) => v === null, 'null');
    freshDB();
    const d = await classifyQuery(text);
    assert('DEVICE-1 no longer routes to action:medical_capture', d.reason,
      (v) => v !== 'action:medical_capture', 'not action:medical_capture');
  }
  {
    const text = 'No I was asking you if you can tell me who my last doctor was that I saw';
    assert('DEVICE-2 isReadShapedUtterance is now true', isReadShapedUtterance(text), (v) => v === true, 'true');
    assert('DEVICE-2 detectMedicalEvent is now null', detectMedicalEvent(text), (v) => v === null, 'null');
    freshDB();
    const d = await classifyQuery(text);
    assert('DEVICE-2 no longer routes to action:medical_capture', d.reason,
      (v) => v !== 'action:medical_capture', 'not action:medical_capture');
  }

  // ── READ-SHAPE POSITIVES ────────────────────────────────────────────────
  const positives: [string, string][] = [
    ['POS-3', 'Can you tell me who my last doctor was?'],
    ['POS-4', 'I wanted to know when I last saw Dr. Smith.'],
    ['POS-5', 'Do you know who my last doctor was?'],
    ['POS-6', 'Could you tell me who I saw last?'],
  ];
  for (const [id, text] of positives) {
    assert(`${id} isReadShapedUtterance true — "${text}"`, isReadShapedUtterance(text), (v) => v === true, 'true');
    assert(`${id} detectMedicalEvent null (guarded closed)`, detectMedicalEvent(text), (v) => v === null, 'null');
  }

  // ── CAPTURE / STATEMENT NEGATIVES — must remain unaffected ─────────────
  const negatives: [string, string, boolean][] = [
    ['NEG-7', 'I saw Dr. Smith last week.', true],
    ['NEG-8', 'I saw my doctor yesterday.', true],
    ['NEG-9', 'My last doctor was Dr. Smith.', false],
    ['NEG-10', 'I was telling you I saw Dr. Smith.', true],
    ['NEG-11', 'I wanted to tell you I saw Dr. Smith.', true],
    // Explicit fence case: a command ("tell Dr. Smith...") must never be
    // read as a historical read merely because it also contains "saw"/"last".
    ['NEG-12', 'Can you tell Dr. Smith I saw him last week.', true],
  ];
  for (const [id, text, expectMedicalEvent] of negatives) {
    assert(`${id} isReadShapedUtterance stays false — "${text}"`, isReadShapedUtterance(text), (v) => v === false, 'false');
    const ev = detectMedicalEvent(text);
    if (expectMedicalEvent) {
      assert(`${id} still detected as a past-visit capture candidate`, ev?.tense, (v) => v === 'past', 'past');
    } else {
      assert(`${id} detectMedicalEvent null (unrelated to this guard)`, ev, (v) => v === null, 'null');
    }
  }

  // ── Route-level confirmation: negatives that ARE capture candidates still
  // reach action:medical_capture (guard repair did not weaken capture) ─────
  {
    freshDB();
    const d = await classifyQuery('I saw Dr. Smith last week.');
    assert('NEG-7 route still action:medical_capture', d.reason,
      (v) => v === 'action:medical_capture', 'action:medical_capture');
  }
  {
    freshDB();
    const d = await classifyQuery('Can you tell Dr. Smith I saw him last week.');
    assert('NEG-12 route still action:medical_capture (command, not converted to a read)', d.reason,
      (v) => v === 'action:medical_capture', 'action:medical_capture');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}LastDoctorReadShapeGuardRepair: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('lastDoctorReadShapeGuardRepair.test.ts')) {
  runLastDoctorReadShapeGuardRepairTests().catch(console.error);
}
