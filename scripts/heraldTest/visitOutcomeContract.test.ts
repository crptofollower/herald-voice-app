// scripts/heraldTest/visitOutcomeContract.test.ts
// Post-visit outcome ask / never-nag latch — medical_records.visit_outcome +
// outcome_asked_at (schema v21). Soft-delete aware; Substring Gate on attach.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  writeMedicalRecord,
  writeDiagnosis,
  supersedeStaleUpcomingAppointments,
  markAppointmentSurfaced,
  getVisitAwaitingOutcome,
  markVisitOutcomeAsked,
  attachVisitOutcome,
  getLastVisitOutcome,
  getLastVisitOutcomeSummary,
  getLastVisit,
} from '../../src/db/medicalDB.ts';

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
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
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

export async function runVisitOutcomeContractTests() {
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

  console.log(`\n${BOLD}-- Visit Outcome Contract --------------------------------${RESET}\n`);

  // a. upcoming → supersede → surface → awaiting outcome
  {
    const db = freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Sarver',
      visit_date: '2020-06-15',
      status: 'upcoming',
      notes: 'checkup',
    });
    supersedeStaleUpcomingAppointments();
    const afterSuper = db.prepare(`SELECT status FROM medical_records WHERE id = ?`).get(id) as { status: string };
    assert('VO-a1 supersede flips past upcoming → noted', afterSuper.status, v => v === 'noted', 'noted');
    markAppointmentSurfaced(id);
    const awaiting = getVisitAwaitingOutcome();
    assert('VO-a2 getVisitAwaitingOutcome returns surfaced past visit',
      awaiting,
      v => !!v && (v as { id: string }).id === id
        && (v as { doctorName?: string }).doctorName === 'Dr. Sarver'
        && (v as { visitDate: string }).visitDate === '2020-06-15',
      'id + Sarver + 2020-06-15');
  }

  // b. markVisitOutcomeAsked → never-nag (awaiting null)
  {
    freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Sarver',
      visit_date: '2020-06-15',
      status: 'upcoming',
    });
    supersedeStaleUpcomingAppointments();
    markAppointmentSurfaced(id);
    assert('VO-b1 pre-ask awaiting present', getVisitAwaitingOutcome()?.id, v => v === id, id);
    markVisitOutcomeAsked(id);
    assert('VO-b2 after markVisitOutcomeAsked → awaiting null (never-nag)',
      getVisitAwaitingOutcome(), v => v === null, 'null');
  }

  // c. attachVisitOutcome verbatim + summary "you mentioned"
  {
    freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Patel',
      visit_date: '2021-03-01',
      status: 'noted',
    });
    markAppointmentSurfaced(id);
    const phrase = 'blood pressure was a little high';
    attachVisitOutcome(id, phrase);
    const got = getLastVisitOutcome();
    assert('VO-c1 getLastVisitOutcome returns exact verbatim outcome',
      got,
      v => !!v
        && (v as { outcome: string }).outcome === phrase
        && (v as { doctorName?: string }).doctorName === 'Dr. Patel'
        && (v as { visitDate: string }).visitDate === '2021-03-01',
      phrase);
    const summary = getLastVisitOutcomeSummary();
    assert('VO-c2 getLastVisitOutcomeSummary uses "you mentioned"',
      summary,
      v => typeof v === 'string'
        && /you mentioned/i.test(v as string)
        && (v as string).includes(phrase)
        && /Dr\. Patel/.test(v as string),
      'Last time with Dr. Patel, you mentioned: …');
  }

  // d. dismiss without attach — excluded; visit_outcome stays null
  {
    const db = freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Lee',
      visit_date: '2019-11-11',
      status: 'upcoming',
    });
    supersedeStaleUpcomingAppointments();
    markAppointmentSurfaced(id);
    markVisitOutcomeAsked(id);
    assert('VO-d1 dismissed visit excluded from awaiting',
      getVisitAwaitingOutcome(), v => v === null, 'null');
    const row = db.prepare(
      `SELECT visit_outcome, outcome_asked_at FROM medical_records WHERE id = ?`
    ).get(id) as { visit_outcome: string | null; outcome_asked_at: string | null };
    assert('VO-d2 visit_outcome stays null after dismiss-only',
      row,
      v => (v as { visit_outcome: string | null }).visit_outcome == null
        && !!(v as { outcome_asked_at: string | null }).outcome_asked_at,
      'outcome null, asked_at set');
  }

  // e. diagnosis + general note (noted, surfaced_at NULL) never awaiting
  {
    freshDB();
    writeDiagnosis('type 2 diabetes', 'I have type 2 diabetes');
    writeMedicalRecord({
      notes: 'general note only',
      status: 'noted',
      visit_date: '2018-01-01',
    });
    assert('VO-e1 diagnosis + unsourced note never returned by getVisitAwaitingOutcome',
      getVisitAwaitingOutcome(), v => v === null, 'null');
  }

  // f. doctorHint filtering matches getLastVisit substring behavior
  {
    freshDB();
    const idA = writeMedicalRecord({
      doctor_name: 'Dr. Sarver',
      visit_date: '2022-01-10',
      status: 'noted',
    });
    const idB = writeMedicalRecord({
      doctor_name: 'Dr. Patel',
      visit_date: '2022-06-20',
      status: 'noted',
    });
    markAppointmentSurfaced(idA);
    markAppointmentSurfaced(idB);
    attachVisitOutcome(idA, 'felt tired after labs');
    attachVisitOutcome(idB, 'started a new inhaler');

    const bySarver = getLastVisitOutcome('sarver');
    const visitBySarver = getLastVisit('sarver');
    assert('VO-f1 doctorHint "sarver" picks Sarver outcome (getLastVisit-style substring)',
      { bySarver, visitBySarver },
      v => {
        const o = v as {
          bySarver: { doctorName?: string; outcome: string } | null;
          visitBySarver: { doctorName?: string } | null;
        };
        return o.bySarver?.doctorName === 'Dr. Sarver'
          && o.bySarver.outcome === 'felt tired after labs'
          && o.visitBySarver?.doctorName === 'Dr. Sarver';
      },
      'Sarver outcome + Sarver last visit');

    const byPatel = getLastVisitOutcome('Patel');
    assert('VO-f2 doctorHint "Patel" picks Patel outcome',
      byPatel,
      v => (v as { doctorName?: string; outcome: string } | null)?.doctorName === 'Dr. Patel'
        && (v as { outcome: string }).outcome === 'started a new inhaler',
      'Patel / inhaler');

    assert('VO-f3 unknown doctorHint → null (honest miss)',
      getLastVisitOutcome('zzzz-no-doctor'), v => v === null, 'null');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Visit Outcome Contract: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('visitOutcomeContract.test.ts')) {
  runVisitOutcomeContractTests().catch(console.error);
}
