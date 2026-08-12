// scripts/heraldTest/visitOutcomeHowDid.test.ts
// Locks VISIT_OUTCOME_READ "how did/was my appointment with Dr. X" phrasing
// (tierRouter.ts) — must win BEFORE detectMedicalEvent / FUTURE_VISIT capture.
//
// Runner: npx tsx scripts/heraldTest/visitOutcomeHowDid.test.ts
// Gate:   wire from run.mjs when ready (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  writeMedicalRecord,
  attachVisitOutcome,
  getMedicalRecords,
} from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';

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

const ROUTE_DEPS = {
  classifyQuery,
  classifyLLM: null as null,
  llmReady: false,
};

export async function runVisitOutcomeHowDidTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Visit-Outcome "How Did / How Was" Contract --------------${RESET}\n`);

  const HOW_DID = 'How did my appointment with Dr. Hexagon go?';
  const STORED_OUTCOME = 'He said keep taking the blood pressure medicine.';

  // ── A: seeded visit_outcome → VISIT_OUTCOME_READ hit template ──────────────
  {
    freshDB();
    const id = writeMedicalRecord({
      doctor_name: 'Dr. Hexagon',
      notes: 'visit',
      visit_date: '2026-07-20',
    });
    attachVisitOutcome(id, STORED_OUTCOME);
    const rowsBefore = getMedicalRecords().length;

    const d = await classifyQuery(HOW_DID);
    assert('A1 reason is medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('A2 not medical_capture', d.reason,
      (v) => v !== 'action:medical_capture', 'not action:medical_capture');
    assert('A3 response equals VISIT_OUTCOME_READ hit template with stored outcome', d.tier1Response,
      (v) => v === `Last time with Dr. Hexagon, you mentioned: ${STORED_OUTCOME}`,
      `Last time with Dr. Hexagon, you mentioned: ${STORED_OUTCOME}`);

    const session = new ConversationSession();
    await processUtterance(HOW_DID, session, ROUTE_DEPS);
    const rd = await routeIntent(HOW_DID, ROUTE_DEPS);
    assert('A4 routeIntent kind is device_read (not capture)', rd.kind,
      (v) => v === 'device_read', 'device_read');
    assert('A5 no new medical_records row inserted', getMedicalRecords().length,
      (v) => v === rowsBefore, String(rowsBefore));
  }

  // ── B: no seeded row → honest miss; never upcoming-capture prompt ──────────
  {
    freshDB();
    const rowsBefore = getMedicalRecords().length;
    const d = await classifyQuery(HOW_DID);
    assert('B1 reason is medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    // getLastVisitOutcomeSummary: hinted miss uses the same string as unhinted.
    assert('B2 honest miss string from getLastVisitOutcomeSummary', d.tier1Response,
      (v) => v === "I don't have anything from your last visit yet.",
      "I don't have anything from your last visit yet.");
    assert('B3 does NOT ask when-is-your-appointment (upcoming pending)', d.tier1Response,
      (v) => typeof v === 'string' && !/when is your appointment/i.test(v),
      'no "when is your appointment"');

    const rd = await routeIntent(HOW_DID, ROUTE_DEPS);
    assert('B4 routeIntent kind is device_read (not capture / upcoming)', rd.kind,
      (v) => v === 'device_read', 'device_read');
    const session = new ConversationSession();
    await processUtterance(HOW_DID, session, ROUTE_DEPS);
    assert('B5 no medical_records row inserted', getMedicalRecords().length,
      (v) => v === rowsBefore, String(rowsBefore));
  }

  // ── C: future scheduling phrasing still FUTURE_VISIT / medical_visit_upcoming ─
  // Mirrors parseTimeFromText PT10 shape (appointment with Dr. X + future tense).
  {
    freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const d = await classifyQuery(phrase);
    const ev = d.actionIntent && 'event' in d.actionIntent
      ? (d.actionIntent as { event?: { type?: string; tense?: string; doctor_name?: string } }).event
      : undefined;
    assert('C1 classifyQuery → action:medical_capture future visit', 
      { reason: d.reason, type: ev?.type, tense: ev?.tense, doctor: ev?.doctor_name },
      (v) => {
        const x = v as { reason?: string; type?: string; tense?: string; doctor?: string };
        return x.reason === 'action:medical_capture'
          && x.type === 'visit'
          && x.tense === 'future'
          && x.doctor === 'Dr. Hexagon';
      },
      'action:medical_capture; visit; future; Dr. Hexagon');

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    assert('C2 routeIntent → medical_visit_upcoming capture',
      { kind: rd.kind, type: rd.kind === 'capture' ? rd.intents[0]?.type : null, reason: rd.reason },
      (v) => {
        const x = v as { kind?: string; type?: string; reason?: string };
        return x.kind === 'capture'
          && x.type === 'medical_visit_upcoming'
          && x.reason === 'tier1:visit_upcoming_intercept';
      },
      'capture / medical_visit_upcoming / tier1:visit_upcoming_intercept');
  }

  // ── D: existing PAST_VISIT capture phrasing from medicalContract M17 ───────
  // "I saw Dr. Sarver today" — must remain past medical_visit write path.
  {
    freshDB();
    const phrase = 'I saw Dr. Sarver today';
    const d = await classifyQuery(phrase);
    const ev = d.actionIntent && 'event' in d.actionIntent
      ? (d.actionIntent as { event?: { type?: string; tense?: string; doctor_name?: string } }).event
      : undefined;
    assert('D1 classifyQuery → action:medical_capture past visit (unchanged)',
      { reason: d.reason, type: ev?.type, tense: ev?.tense, doctor: ev?.doctor_name },
      (v) => {
        const x = v as { reason?: string; type?: string; tense?: string; doctor?: string };
        return x.reason === 'action:medical_capture'
          && x.type === 'visit'
          && x.tense === 'past'
          && x.doctor === 'Dr. Sarver';
      },
      'action:medical_capture; visit; past; Dr. Sarver');

    const session = new ConversationSession();
    const out = await processUtterance(phrase, session, ROUTE_DEPS);
    assert('D2 processUtterance still commits medical_visit ack',
      { handled: out.handled, text: out.handled ? out.responseText : null },
      (v) => {
        const x = v as { handled?: boolean; text?: string | null };
        return x.handled === true && x.text === "I'll remember you saw Dr. Sarver.";
      },
      "handled; I'll remember you saw Dr. Sarver.");
    assert('D3 still writes exactly one medical_records row', getMedicalRecords().length,
      (v) => v === 1, '1');
  }

  // ── E: phrase-order / noun-variant class (componentized isVisitOutcomeRead) ─
  // Previously fused-order regexes missed "doctor's appointment … with Dr X".
  {
    freshDB();
    const phrases: { label: string; text: string }[] = [
      { label: "E1 doctor's appointment + Dr Foster (reordered)", text: "How did my doctor's appointment go with Dr Foster?" },
      { label: "E2 doctor's appointment + Dr Wynn (reordered)", text: "How did my doctor's appointment go with Dr Wynn?" },
      { label: 'E3 visit-noun variant with Dr Foster', text: 'How did my visit with Dr Foster go?' },
      { label: 'E4 checkup-noun variant with Dr Foster', text: 'How was my checkup with Dr Foster?' },
      { label: 'E5 "what happened" cue variant with Dr Foster', text: 'What happened at my last appointment with Dr Foster?' },
    ];
    for (const { label, text } of phrases) {
      const d = await classifyQuery(text);
      assert(label, d.reason,
        (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    }
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}VisitOutcomeHowDid: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('visitOutcomeHowDid.test.ts')) {
  runVisitOutcomeHowDidTests().catch(console.error);
}
