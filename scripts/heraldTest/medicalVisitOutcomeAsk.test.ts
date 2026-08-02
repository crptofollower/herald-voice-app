// scripts/heraldTest/medicalVisitOutcomeAsk.test.ts
// Moment 2 — post-visit outcome ask, two-stage capture-then-confirm.
// buildVisitOutcomeAskSlot contract tests. Headless against better-sqlite3.
//
// Runner: npx tsx scripts/heraldTest/medicalVisitOutcomeAsk.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  writeMedicalRecord,
  markAppointmentSurfaced,
  getLastVisitOutcomeSummary,
} from '../../src/db/medicalDB.ts';
import { buildVisitOutcomeAskSlot } from '../../src/routing/medicalVisitOutcomeAsk.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

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

/** Creates a real surfaced, noted, unasked visit — the row shape
 *  buildVisitOutcomeAskSlot's confirm-stage resume actually writes into. */
function makeAwaitingVisit(db: Database.Database, doctorName = 'Dr. Patel', visitDate = '2020-01-01') {
  const id = writeMedicalRecord({ doctor_name: doctorName, visit_date: visitDate, status: 'noted' });
  markAppointmentSurfaced(id);
  return { id, doctorName };
}

function readOutcome(db: Database.Database, id: string) {
  return db.prepare(`SELECT visit_outcome FROM medical_records WHERE id = ?`).get(id) as { visit_outcome: string | null };
}

export async function runMedicalVisitOutcomeAskTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Medical Visit Outcome Ask (slot builder) --------------${RESET}\n`);

  // ── T1: stage-1 resume, empty reply → noop, never advances to confirm ─────
  {
    freshDB();
    const slot = buildVisitOutcomeAskSlot({ id: 'irrelevant-empty-case', doctorName: 'Dr. Patel' });
    const result = await slot.resume('   ');
    assert('T1 empty reply → noop with empty ack (re-ask ladder, not a real ack)', result,
      v => (v as CommitResult).status === 'noop' && (v as any).ack === '',
      'status noop, ack ""');
  }

  // ── T2: stage-1 resume, non-empty → confirm-stage pending; DB untouched ───
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const result = await slot.resume('He adjusted my blood pressure medicine.');
    assert('T2a advances to confirm-stage pendingKey', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome_confirm',
      'pending / medical_visit_outcome_confirm');
    assert('T2b confirm prompt reads back the exact candidate verbatim', result,
      v => (v as any).prompt === 'Should I remember "He adjusted my blood pressure medicine." from your appointment with Dr. Patel?',
      'exact verbatim read-back prompt');
    assert('T2c reaskPrompt is candidate-specific — repeats the exact candidate and asks yes/no', result,
      v => (v as any).reaskPrompt === 'Please say yes or no. Should I remember "He adjusted my blood pressure medicine." from your appointment with Dr. Patel?',
      'candidate-specific reaskPrompt, not undefined, not generic');
    assert('T2d visit_outcome still null — candidate not yet written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T3: confirm-stage "yes" → commits exact untrimmed candidate ───────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const stage1 = await slot.resume('  He adjusted my blood pressure medicine.  ');
    const confirmResume = (stage1 as any).resume as (t: string) => Promise<CommitResult>;
    const result = await confirmResume('yes');
    assert('T3a yes → committed', result, v => (v as any).status === 'committed', 'committed');
    assert('T3b stored value is the UNTRIMMED candidate (attachVisitOutcome does its own internal trim)',
      readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === 'He adjusted my blood pressure medicine.',
      'He adjusted my blood pressure medicine.');
  }

  // ── T4: confirm-stage "no" → discards, never writes ────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const stage1 = await slot.resume('Call Sarah.');
    const confirmResume = (stage1 as any).resume as (t: string) => Promise<CommitResult>;
    const result = await confirmResume('no');
    assert('T4a no → noop with recovery ack', result,
      v => (v as any).status === 'noop' && (v as any).ack === "Okay, I won't save that. What would you like me to do?",
      'noop / recovery ack');
    assert('T4b visit_outcome stays null after rejection', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T5: confirm-stage ambiguous reply → noop; no write; reask carried on the
  //        OUTER pending object (proven in the ConversationSession suite, V4) ─
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const stage1 = await slot.resume('He adjusted my blood pressure medicine.');
    const confirmResume = (stage1 as any).resume as (t: string) => Promise<CommitResult>;
    const result = await confirmResume('maybe');
    assert('T5a ambiguous confirm reply → inner resume returns noop with empty ack (ConversationSession supplies the candidate-specific reaskPrompt from the outer pending object, not this closure)',
      result, v => (v as any).status === 'noop' && (v as any).ack === '', 'noop / ""');
    assert('T5b no database write occurs during the ambiguous reply', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T9: unrelated command — read back verbatim, rejected, never written ───
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const stage1 = await slot.resume('Call Sarah');
    assert('T9a "Call Sarah" as candidate is read back verbatim, not silently committed', stage1,
      v => (v as any).status === 'pending'
        && (v as any).prompt === 'Should I remember "Call Sarah" from your appointment with Dr. Patel?',
      'verbatim confirm prompt');
    const confirmResume = (stage1 as any).resume as (t: string) => Promise<CommitResult>;
    const result = await confirmResume('no');
    assert('T9b rejected', result, v => (v as any).status === 'noop', 'noop');
    assert('T9c no false medical memory written for an unrelated command', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T10: bare "No" at stage-1 → declines the flow, never becomes candidate ─
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const result = await slot.resume('No');
    assert('T10a bare "No" → noop with decline ack, not a candidate', result,
      v => (v as any).status === 'noop'
        && (v as any).ack === "Okay, no worries. What would you like me to do?"
        && (v as any).pendingKey === undefined
        && (v as any).resume === undefined,
      'noop / decline ack / no pendingKey / no nested resume');
    assert('T10b visit_outcome stays null', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T11: "No thanks" at stage-1 → same decline path ────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const result = await slot.resume('No thanks');
    assert('T11a "No thanks" → noop with decline ack', result,
      v => (v as any).status === 'noop'
        && (v as any).ack === "Okay, no worries. What would you like me to do?",
      'noop / decline ack');
    assert('T11b visit_outcome stays null', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T12: a real answer starting with "No" must still become a candidate ───
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const result = await slot.resume('No complications, everything looked fine.');
    assert('T12a real answer starting with "No" still advances to confirm-stage', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome_confirm',
      'pending / medical_visit_outcome_confirm');
    assert('T12b confirm prompt reads back the exact candidate verbatim', result,
      v => (v as any).prompt === 'Should I remember "No complications, everything looked fine." from your appointment with Dr. Patel?',
      'exact verbatim read-back prompt');
    assert('T12c visit_outcome still null — candidate not yet written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── T8: recall — committed candidate is exactly recallable offline ────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db, 'Dr. Patel', '2020-01-01');
    const slot = buildVisitOutcomeAskSlot(awaiting);
    const stage1 = await slot.resume('He adjusted my blood pressure medicine.');
    const confirmResume = (stage1 as any).resume as (t: string) => Promise<CommitResult>;
    await confirmResume('yes');
    const summary = getLastVisitOutcomeSummary('Patel');
    assert('T8 getLastVisitOutcomeSummary includes the exact committed text', summary,
      v => typeof v === 'string' && (v as string).includes('He adjusted my blood pressure medicine.'),
      'summary contains exact committed text');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Medical Visit Outcome Ask: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalVisitOutcomeAsk.test.ts')) {
  runMedicalVisitOutcomeAskTests().catch(console.error);
}
