// scripts/heraldTest/medicalFollowUpCapture.test.ts
// Structured medical_records.follow_up capture — chained after confirmed
// visit_outcome. Existence → value → confirm. Same visit id. No prose parse.
//
// Runner: npx tsx scripts/heraldTest/medicalFollowUpCapture.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  writeMedicalRecord,
  markAppointmentSurfaced,
  attachFollowUp,
  attachVisitOutcome,
  getLastVisit,
} from '../../src/db/medicalDB.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
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

function makeAwaitingVisit(
  db: Database.Database,
  opts: { doctorName?: string; visitDate?: string; follow_up?: string; notes?: string; reason?: string; diagnosis?: string } = {},
) {
  const id = writeMedicalRecord({
    doctor_name: opts.doctorName ?? 'Dr. Patel',
    visit_date: opts.visitDate ?? '2020-01-01',
    status: 'noted',
    follow_up: opts.follow_up,
    notes: opts.notes,
    reason: opts.reason,
    diagnosis: opts.diagnosis,
  });
  markAppointmentSurfaced(id);
  return { id, doctorName: opts.doctorName ?? 'Dr. Patel' };
}

type VisitRow = {
  visit_outcome: string | null;
  notes: string | null;
  reason: string | null;
  diagnosis: string | null;
  status: string | null;
  doctor_name: string | null;
  visit_date: string | null;
  follow_up: string | null;
  outcome_asked_at: string | null;
};

function readRow(db: Database.Database, id: string): VisitRow {
  return db.prepare(
    `SELECT visit_outcome, notes, reason, diagnosis, status, doctor_name, visit_date, follow_up, outcome_asked_at
       FROM medical_records WHERE id = ?`,
  ).get(id) as VisitRow;
}

function armOutcome(session: ConversationSession, awaiting: { id: string; doctorName?: string }) {
  const slot = buildVisitOutcomeAskSlot(awaiting);
  session.setPending({ pendingKey: slot.pendingKey, kind: slot.kind, budget: slot.budget, resume: slot.resume });
}

async function commitOutcome(
  session: ConversationSession,
  awaiting: { id: string; doctorName?: string },
  outcomeText: string,
): Promise<CommitResult> {
  armOutcome(session, awaiting);
  await session.resolvePending(outcomeText);
  return session.resolvePending('yes');
}

export async function runMedicalFollowUpCaptureTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Medical Follow-Up Capture (structured writer) ---------${RESET}\n`);

  // ── 1. HAPPY PATH ──────────────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    const afterOutcome = await commitOutcome(session, awaiting, 'Dr Patel said everything looks good.');
    assert('FU1a outcome YES → follow-up existence pending', afterOutcome,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_follow_up_existence',
      'pending / medical_visit_follow_up_existence');
    assert('FU1b visit_outcome committed before follow-up collection', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Dr Patel said everything looks good.',
      'Dr Patel said everything looks good.');
    assert('FU1c follow_up still NULL after outcome commit', readRow(db, awaiting.id).follow_up,
      v => v === null, 'null');
    assert('FU1d existence prompt is the existence question', afterOutcome,
      v => (v as any).prompt === 'Did they tell you when to come back?',
      'Did they tell you when to come back?');

    const afterYes = await session.resolvePending('yes');
    assert('FU1e existence YES → value collection', afterYes,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_follow_up_value',
      'pending / medical_visit_follow_up_value');
    assert('FU1f value prompt', afterYes,
      v => (v as any).prompt === 'When did they say to come back?',
      'When did they say to come back?');

    const afterValue = await session.resolvePending('in six weeks');
    assert('FU1g value → confirm pending', afterValue,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_follow_up_confirm',
      'pending / medical_visit_follow_up_confirm');
    assert('FU1h confirm reads back verbatim candidate with stored doctor name', afterValue,
      v => (v as any).prompt === 'Should I remember "in six weeks" as your follow-up from Dr. Patel?',
      'Should I remember "in six weeks" as your follow-up from Dr. Patel?');
    assert('FU1i follow_up still NULL until confirm YES', readRow(db, awaiting.id).follow_up,
      v => v === null, 'null');

    const committed = await session.resolvePending('yes');
    assert('FU1j confirm YES → committed', committed, v => (v as any).status === 'committed', 'committed');
    assert('FU1k follow_up === "in six weeks"', readRow(db, awaiting.id).follow_up,
      v => v === 'in six weeks', 'in six weeks');
    assert('FU1l visit_outcome unchanged after follow_up write', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Dr Patel said everything looks good.',
      'Dr Patel said everything looks good.');
    assert('FU1m pending cleared', session.hasPending(), v => v === false, 'false');
  }

  // ── 2. EXISTENCE DECLINE ───────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Dr Patel said everything looks good.');
    const result = await session.resolvePending('no');
    assert('FU2a existence NO → recognized close', result,
      v => (v as any).status === 'noop' && (v as any).ack === 'Okay.',
      'noop / Okay.');
    assert('FU2b follow_up NULL', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU2c visit_outcome still committed', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Dr Patel said everything looks good.',
      'Dr Patel said everything looks good.');
    assert('FU2d pending closed', session.hasPending(), v => v === false, 'false');
    assert('FU2e decline ack is not a question', result,
      v => typeof (v as any).ack === 'string' && !(v as any).ack.includes('?'),
      'non-question ack');
  }
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    const result = await session.resolvePending("they didn't");
    assert('FU2f "they didn\'t" closes without extra prompt', result,
      v => (v as any).status === 'noop' && (v as any).ack === 'Okay.',
      'noop / Okay.');
    assert('FU2g follow_up NULL after they-didn\'t', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU2h pending closed after they-didn\'t', session.hasPending(), v => v === false, 'false');
  }

  // ── 3. VALUE CANCEL ────────────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('yes');
    const result = await session.resolvePending('never mind');
    assert('FU3a never mind at value → terminal noop', result, v => (v as any).status === 'noop', 'noop');
    assert('FU3b follow_up NULL', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU3c visit_outcome unchanged', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
    assert('FU3d pending closed', session.hasPending(), v => v === false, 'false');
  }

  // ── 4. CONFIRM CANCEL / NO ─────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('yes');
    await session.resolvePending('in six weeks');
    const result = await session.resolvePending('no');
    assert('FU4a confirm NO → closed', result,
      v => (v as any).status === 'noop' && (v as any).ack === 'Okay.',
      'noop / Okay.');
    assert('FU4b follow_up NULL after confirm NO', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU4c visit_outcome unchanged after confirm NO', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
    assert('FU4d pending closed after confirm NO', session.hasPending(), v => v === false, 'false');
  }
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('yes');
    await session.resolvePending('in six weeks');
    const result = await session.resolvePending('cancel');
    assert('FU4e confirm cancel → terminal noop', result, v => (v as any).status === 'noop', 'noop');
    assert('FU4f follow_up NULL after confirm cancel', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU4g visit_outcome unchanged after confirm cancel', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
  }

  // ── 5. CORRECTION ──────────────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('yes');
    await session.resolvePending('six weeks');
    const corrected = await session.resolvePending('actually three months');
    assert('FU5a correction does not write original candidate', readRow(db, awaiting.id).follow_up,
      v => v === null, 'null');
    assert('FU5b reconfirm names the replacement candidate', corrected,
      v => (v as any).status === 'pending'
        && (v as any).pendingKey === 'medical_visit_follow_up_confirm'
        && (v as any).prompt === 'Should I remember "three months" as your follow-up from Dr. Patel?',
      'reconfirm three months');
    const committed = await session.resolvePending('yes');
    assert('FU5c confirm YES stores corrected value only', readRow(db, awaiting.id).follow_up,
      v => v === 'three months', 'three months');
    assert('FU5d visit_outcome unchanged through correction', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
    assert('FU5e correction YES committed', committed, v => (v as any).status === 'committed', 'committed');
  }

  // ── 6. SAME VISIT ID — no latest-visit re-resolution ───────────────────────
  {
    const db = freshDB();
    const visitA = makeAwaitingVisit(db, { doctorName: 'Dr. Patel', visitDate: '2020-01-01' });
    const visitB = makeAwaitingVisit(db, { doctorName: 'Dr. Patel', visitDate: '2020-06-01' });
    const latest = getLastVisit('Patel');
    assert('FU6a getLastVisit would pick the later sibling', latest?.visitDate, v => v === '2020-06-01', '2020-06-01');
    const session = new ConversationSession();
    await commitOutcome(session, visitA, 'Dr Patel said everything looks good.');
    await session.resolvePending('yes');
    await session.resolvePending('in six weeks');
    await session.resolvePending('yes');
    assert('FU6b outcome written to original armed visit A', readRow(db, visitA.id).visit_outcome,
      v => v === 'Dr Patel said everything looks good.',
      'Dr Patel said everything looks good.');
    assert('FU6c follow_up written to SAME visit A id', readRow(db, visitA.id).follow_up,
      v => v === 'in six weeks', 'in six weeks');
    assert('FU6d sibling B visit_outcome untouched', readRow(db, visitB.id).visit_outcome, v => v === null, 'null');
    assert('FU6e sibling B follow_up untouched', readRow(db, visitB.id).follow_up, v => v === null, 'null');
  }

  // ── 7. COLUMN ISOLATION — attachFollowUp touches follow_up only ────────────
  {
    const db = freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Patel',
      visit_date: '2020-01-01',
      notes: 'saw Patel',
      reason: 'checkup',
      diagnosis: 'stable',
      status: 'noted',
    });
    attachVisitOutcome(id, 'looks good');
    const before = readRow(db, id);
    attachFollowUp(id, 'in six weeks');
    const after = readRow(db, id);
    assert('FU7a follow_up set by attachFollowUp', after.follow_up, v => v === 'in six weeks', 'in six weeks');
    assert('FU7b no other isolated column changed', {
      visit_outcome: after.visit_outcome === before.visit_outcome,
      notes: after.notes === before.notes,
      reason: after.reason === before.reason,
      diagnosis: after.diagnosis === before.diagnosis,
      status: after.status === before.status,
      doctor_name: after.doctor_name === before.doctor_name,
      visit_date: after.visit_date === before.visit_date,
      outcome_asked_at: after.outcome_asked_at === before.outcome_asked_at,
    }, v => Object.values(v as Record<string, boolean>).every(Boolean),
      'visit_outcome/notes/reason/diagnosis/status/doctor_name/visit_date/outcome_asked_at unchanged');
  }

  // ── 8. INTERRUPT AFTER OUTCOME COMMIT ──────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Dr Patel said everything looks good.');
    const reset = new ConversationSession();
    assert('FU8a visit_outcome remains after session reset', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Dr Patel said everything looks good.',
      'Dr Patel said everything looks good.');
    assert('FU8b follow_up NULL — no rollback, no backfill', readRow(db, awaiting.id).follow_up,
      v => v === null, 'null');
    assert('FU8c new ConversationSession has no resurrected pending', reset.hasPending(), v => v === false, 'false');
  }

  // ── 9. FOLLOW_UP VERBATIM ──────────────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('yes');
    const value = 'recheck my blood pressure in three months';
    await session.resolvePending(value);
    await session.resolvePending('yes');
    assert('FU9 stored follow_up equals the full confirmed reply', readRow(db, awaiting.id).follow_up,
      v => v === value, value);
  }

  // ── 10. SUBSTRING / PROVENANCE LOCK ────────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    const outcome = 'Dr Patel said everything looks good.';
    const value = 'in six weeks';
    await commitOutcome(session, awaiting, outcome);
    await session.resolvePending('yes');
    await session.resolvePending(value);
    await session.resolvePending('yes');
    const row = readRow(db, awaiting.id);
    assert('FU10a follow_up equals the dedicated value reply', row.follow_up, v => v === value, value);
    assert('FU10b follow_up is not the visit_outcome sentence', row.follow_up, v => v !== outcome, 'not the outcome blob');
    assert('FU10c follow_up is contained in the dedicated reply, not extracted from outcome', {
      inValue: value.includes(row.follow_up ?? ''),
      inOutcome: outcome.includes(row.follow_up ?? ''),
    }, v => (v as { inValue: boolean; inOutcome: boolean }).inValue === true
      && (v as { inValue: boolean; inOutcome: boolean }).inOutcome === false,
      'substring of value reply only');
  }

  // ── 11. DECLINE DOES NOT OVERWRITE EXISTING follow_up ──────────────────────
  // Decline/cancel never call attachFollowUp (no UPDATE). A pre-existing
  // non-null follow_up on an unasked visit is not a live production case
  // (no writer existed), but if present, existence-NO must not wipe it.
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db, { follow_up: 'already set' });
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    await session.resolvePending('no');
    assert('FU11a existence decline leaves pre-existing follow_up intact', readRow(db, awaiting.id).follow_up,
      v => v === 'already set', 'already set');
    assert('FU11b visit_outcome still committed', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
  }

  // ── D. Pending budget exhaustion after outcome commit ──────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit(db);
    const session = new ConversationSession();
    await commitOutcome(session, awaiting, 'Looks good.');
    const first = await session.resolvePending('maybe');
    assert('FU-D1 first unresolved existence reply re-asks', first,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_follow_up_existence',
      'pending existence');
    const second = await session.resolvePending('maybe');
    assert('FU-D2 budget exhaustion releases pending', second,
      v => (v as any).status === 'noop' && session.hasPending() === false,
      'noop / pending cleared');
    assert('FU-D3 follow_up NULL after release', readRow(db, awaiting.id).follow_up, v => v === null, 'null');
    assert('FU-D4 visit_outcome unchanged after release', readRow(db, awaiting.id).visit_outcome,
      v => v === 'Looks good.', 'Looks good.');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Medical Follow-Up Capture: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalFollowUpCapture.test.ts')) {
  runMedicalFollowUpCaptureTests().catch(console.error);
}
