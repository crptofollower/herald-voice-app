// scripts/heraldTest/conversationSessionVisitOutcome.test.ts
// Moment 2 — proves the PENDING-STATE behavior (arm, replace, budget ladder,
// cancel, release) around buildVisitOutcomeAskSlot that a direct slot-builder
// test cannot prove on its own. Mirrors medClear.test.ts's structure exactly.
//
// Runner: npx tsx scripts/heraldTest/conversationSessionVisitOutcome.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalRecord, markAppointmentSurfaced } from '../../src/db/medicalDB.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { buildVisitOutcomeAskSlot } from '../../src/routing/medicalVisitOutcomeAsk.ts';

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

function makeAwaitingVisit(doctorName = 'Dr. Patel', visitDate = '2020-01-01') {
  const id = writeMedicalRecord({ doctor_name: doctorName, visit_date: visitDate, status: 'noted' });
  markAppointmentSurfaced(id);
  return { id, doctorName };
}

function readOutcome(db: Database.Database, id: string) {
  return db.prepare(`SELECT visit_outcome FROM medical_records WHERE id = ?`).get(id) as { visit_outcome: string | null };
}

function armOutcomeSlot(session: ConversationSession, awaiting: { id: string; doctorName?: string }) {
  const slot = buildVisitOutcomeAskSlot(awaiting);
  session.setPending({ pendingKey: slot.pendingKey, kind: slot.kind, budget: slot.budget, resume: slot.resume });
  return slot;
}

export async function runConversationSessionVisitOutcomeTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- ConversationSession × Visit Outcome (pending-state) ---${RESET}\n`);

  // ── V1: original outcome slot arms ─────────────────────────────────────────
  {
    freshDB();
    const session = new ConversationSession();
    armOutcomeSlot(session, makeAwaitingVisit());
    assert('V1 original outcome slot arms with pending set', session.hasPending(), v => v === true, 'true');
  }

  // ── V2: empty reply retains the original stage ──────────────────────────────
  {
    freshDB();
    const session = new ConversationSession();
    armOutcomeSlot(session, makeAwaitingVisit());
    const result = await session.resolvePending('   ');
    assert('V2 empty reply → still pending, STILL the original outcome stage', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome',
      'pending / medical_visit_outcome');
    assert('V2b session still holds a pending slot', session.hasPending(), v => v === true, 'true');
  }

  // ── V3: valid candidate replaces pending with the confirm stage ────────────
  {
    freshDB();
    const session = new ConversationSession();
    armOutcomeSlot(session, makeAwaitingVisit());
    const result = await session.resolvePending('He adjusted my blood pressure medicine.');
    assert('V3 advances to confirm stage', result,
      v => (v as any).status === 'pending' && (v as any).pendingKey === 'medical_visit_outcome_confirm',
      'pending / medical_visit_outcome_confirm');
    assert('V3b session holds the replaced (confirm) slot', session.hasPending(), v => v === true, 'true');
  }

  // ── V4: ambiguous confirmation retains the confirm stage, with the
  //        candidate-specific reaskPrompt — never DEFAULT_REASK, never the
  //        original outcome question, never empty ─────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    armOutcomeSlot(session, awaiting);
    await session.resolvePending('He adjusted my blood pressure medicine.');
    const result = await session.resolvePending('maybe');
    assert('V4a still pending after ambiguous confirm reply', result,
      v => (v as any).status === 'pending', 'pending');
    assert('V4b STILL the confirm stage — never falls back to the original outcome question', result,
      v => (v as any).pendingKey === 'medical_visit_outcome_confirm', 'medical_visit_outcome_confirm');
    assert('V4c prompt is the CANDIDATE-SPECIFIC reaskPrompt — repeats the exact candidate and asks yes/no; not DEFAULT_REASK, not empty',
      result,
      v => (v as any).prompt === 'Please say yes or no. Should I remember "He adjusted my blood pressure medicine." from your appointment with Dr. Patel?',
      'candidate-specific reaskPrompt, not the generic "can you say that again?"');
    assert('V4d prompt is NOT the generic DEFAULT_REASK', result,
      v => (v as any).prompt !== "I'm not sure I'm following — can you say that again?",
      'must not equal DEFAULT_REASK');
    assert('V4e no database write occurs during the ambiguous reply', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
  }

  // ── V5: yes commits and clears pending ──────────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    armOutcomeSlot(session, awaiting);
    await session.resolvePending('He adjusted my blood pressure medicine.');
    const result = await session.resolvePending('yes');
    assert('V5a yes commits', result, v => (v as any).status === 'committed', 'committed');
    assert('V5b visit_outcome written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === 'He adjusted my blood pressure medicine.',
      'He adjusted my blood pressure medicine.');
    assert('V5c pending cleared after commit', session.hasPending(), v => v === false, 'false');
  }

  // ── V6: no clears pending without writing ───────────────────────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    armOutcomeSlot(session, awaiting);
    await session.resolvePending('Call Sarah');
    const result = await session.resolvePending('no');
    assert('V6a no is a terminal noop', result, v => (v as any).status === 'noop', 'noop');
    assert('V6b nothing written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
    assert('V6c pending cleared after rejection', session.hasPending(), v => v === false, 'false');
  }

  // ── V7a: cancel at stage 1 clears pending without writing ──────────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    armOutcomeSlot(session, awaiting);
    const result = await session.resolvePending('never mind');
    assert('V7a-1 cancel at stage 1 is a terminal noop', result, v => (v as any).status === 'noop', 'noop');
    assert('V7a-2 nothing written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
    assert('V7a-3 pending cleared', session.hasPending(), v => v === false, 'false');
  }

  // ── V7b: cancel at confirm stage clears pending without writing ────────────
  {
    const db = freshDB();
    const awaiting = makeAwaitingVisit();
    const session = new ConversationSession();
    armOutcomeSlot(session, awaiting);
    await session.resolvePending('He adjusted my blood pressure medicine.');
    const result = await session.resolvePending('cancel');
    assert('V7b-1 cancel at confirm stage is a terminal noop', result, v => (v as any).status === 'noop', 'noop');
    assert('V7b-2 nothing written', readOutcome(db, awaiting.id),
      v => (v as { visit_outcome: string | null }).visit_outcome === null, 'null');
    assert('V7b-3 pending cleared', session.hasPending(), v => v === false, 'false');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationSession × Visit Outcome: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationSessionVisitOutcome.test.ts')) {
  runConversationSessionVisitOutcomeTests().catch(console.error);
}
