// scripts/heraldTest/medicalVisitResume.test.ts
// Continuity audit v2 §3.3 / §3.1 — medical_visit resume write/no-write
// and question-shaped provenance. Authoritative storage read-back via
// getMedicalRecords / getLastVisit (not CommitResult alone).
//
// Runner: npx tsx scripts/heraldTest/medicalVisitResume.test.ts
// Gate:   wire from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { getMedicalRecords, getLastVisit } from '../../src/db/medicalDB.ts';
import { parseDatePhrase } from '../../src/utils/parseTime.ts';

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

const NAMELESS_CAPTURE = 'I went to the doctor yesterday';
const HONEST_RELEASE = "Let's come back to that — just tell me again anytime.";
const CANCEL_ACK = "No problem — I won't do that.";

async function armNamelessVisit(raw: string) {
  return DOMAIN_WRITERS.medical_visit!.add({ type: 'medical_visit', raw }, raw);
}

async function sessionFromPending(raw: string) {
  const add = await armNamelessVisit(raw);
  const session = new ConversationSession();
  if (add.status !== 'pending') {
    return { add, session, armed: false as const };
  }
  session.setPending({ pendingKey: add.pendingKey, resume: add.resume });
  return { add, session, armed: true as const };
}

export async function runMedicalVisitResumeTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medical Visit Resume (trust repair 2026-08-20) ----------${RESET}\n`);

  // ── W1: "No stop" must not write (device-proven corrupt doctor_name) ───────
  {
    freshDB();
    const { session, armed } = await sessionFromPending(NAMELESS_CAPTURE);
    assert('W1 pending armed before "No stop"', armed, (v) => v === true, 'pending armed');
    await session.resolvePending('No stop');
    assert('W1 "No stop" writes zero medical_records rows', getMedicalRecords().length,
      (v) => v === 0, '0');
    assert('W1 getLastVisit is null after "No stop"', getLastVisit(),
      (v) => v === null, 'null');
  }

  // ── W2: "no, stop" ────────────────────────────────────────────────────────
  {
    freshDB();
    const { session } = await sessionFromPending(NAMELESS_CAPTURE);
    await session.resolvePending('no, stop');
    assert('W2 "no, stop" writes zero medical_records rows', getMedicalRecords().length,
      (v) => v === 0, '0');
  }

  // ── W3: "I don't know" ────────────────────────────────────────────────────
  {
    freshDB();
    const { session } = await sessionFromPending(NAMELESS_CAPTURE);
    await session.resolvePending("I don't know");
    assert('W3 "I don\'t know" writes zero medical_records rows', getMedicalRecords().length,
      (v) => v === 0, '0');
  }

  // ── W4: "never mind" — existing CANCEL_RE path ────────────────────────────
  {
    freshDB();
    const { session } = await sessionFromPending(NAMELESS_CAPTURE);
    const result = await session.resolvePending('never mind');
    assert('W4 "never mind" cancel ack', result,
      (v) => (v as { status?: string; ack?: string }).status === 'noop'
        && (v as { ack?: string }).ack === CANCEL_ACK,
      `noop / ${CANCEL_ACK}`);
    assert('W4 "never mind" writes zero medical_records rows', getMedicalRecords().length,
      (v) => v === 0, '0');
    assert('W4 pending cleared after cancel', session.hasPending(),
      (v) => v === false, 'false');
  }

  // ── W5: explicit "Dr. Patel" still commits ────────────────────────────────
  {
    freshDB();
    const { session } = await sessionFromPending(NAMELESS_CAPTURE);
    const result = await session.resolvePending('Dr. Patel');
    assert('W5 "Dr. Patel" commits', result,
      (v) => (v as { status?: string }).status === 'committed', 'committed');
    const recs = getMedicalRecords();
    assert('W5 writes exactly one medical_records row', recs.length,
      (v) => v === 1, '1');
    assert('W5 doctor_name stored as Dr. Patel', recs[0]?.doctor_name,
      (v) => v === 'Dr. Patel', '"Dr. Patel"');
  }

  // ── W6: two unrecognized replies exhaust budget, honest release, no row ────
  {
    freshDB();
    const { session, armed } = await sessionFromPending(NAMELESS_CAPTURE);
    assert('W6 pending armed before unrecognized replies', armed, (v) => v === true, 'pending armed');
    const first = await session.resolvePending('zzzz');
    assert('W6 first unrecognized stays pending (re-ask)', first,
      (v) => (v as { status?: string }).status === 'pending', 'pending');
    assert('W6 no row after first unrecognized reply', getMedicalRecords().length,
      (v) => v === 0, '0');
    const second = await session.resolvePending('yyyy');
    assert('W6 second unrecognized honest-releases', second,
      (v) => (v as { status?: string; ack?: string }).status === 'noop'
        && (v as { ack?: string }).ack === HONEST_RELEASE,
      `noop / ${HONEST_RELEASE}`);
    assert('W6 two unrecognized replies write zero rows', getMedicalRecords().length,
      (v) => v === 0, '0');
    assert('W6 pending cleared after budget exhaust', session.hasPending(),
      (v) => v === false, 'false');
  }

  // ── P-A: question-shaped capture raw must not become visit notes ───────────
  {
    freshDB();
    const captureRaw = 'Who was the last Doctor I saw';
    const { session, armed } = await sessionFromPending(captureRaw);
    assert('P-A writer reached intentionally (pending armed)', armed,
      (v) => v === true, 'pending armed');
    await session.resolvePending('Dr. Patel');
    const recs = getMedicalRecords();
    assert('P-A resume Dr. Patel writes one row', recs.length,
      (v) => v === 1, '1');
    assert('P-A doctor_name is Dr. Patel', recs[0]?.doctor_name,
      (v) => v === 'Dr. Patel', '"Dr. Patel"');
    assert('P-A notes are null (question is not visit provenance)', recs[0]?.notes,
      (v) => v == null, 'null');
    assert('P-A original question is not stored as visit detail', recs[0],
      (v) => {
        const row = v as { notes?: string | null };
        const blob = JSON.stringify(row);
        return !/Who was the last Doctor I saw/i.test(blob);
      },
      'question text absent from stored row');
  }

  // ── P-B: legitimate capture provenance and date remain intact ──────────────
  {
    freshDB();
    const captureRaw = 'I went to the doctor yesterday';
    // Writer derivation is parseDatePhrase(raw) ?? today. parseDatePhrase has
    // no "yesterday" grammar (today/tomorrow/weekday/month-day only) — that
    // gap is pre-existing and out of this package. Lock that provenance
    // suppression does not change date derivation.
    const expectedDate = parseDatePhrase(captureRaw) ?? new Date().toLocaleDateString('en-CA');
    const { session } = await sessionFromPending(captureRaw);
    await session.resolvePending('Dr. Patel');
    const recs = getMedicalRecords();
    assert('P-B visit still writes', recs.length, (v) => v === 1, '1');
    assert('P-B visit_date still follows writer derivation from raw', recs[0]?.visit_date,
      (v) => v === expectedDate, expectedDate);
    assert('P-B legitimate capture provenance remains in notes', recs[0]?.notes,
      (v) => v === captureRaw, captureRaw);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicalVisitResume: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalVisitResume.test.ts')) {
  runMedicalVisitResumeTests().catch(console.error);
}
