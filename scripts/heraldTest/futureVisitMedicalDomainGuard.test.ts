// scripts/heraldTest/futureVisitMedicalDomainGuard.test.ts
// Locks the FUTURE_VISIT medical-domain-evidence guard repair (2026-09-06).
// Root cause: detectMedicalEvent's hasFutureVisit admitted bare "going to
// see" / "gonna see" / "will see" / "seeing my" / "scheduled with" with no
// medical-domain token required — unlike its sibling hasPastVisit, which
// already required hasMedicalVisitDomainEvidence. tierRouter.ts then
// promoted the resulting MedicalEvent straight to a tier-1 medical_capture,
// and routeIntent.ts produced the deterministic appointment clarification
// ("I want to get this right — when is your appointment...?") for ordinary
// future-tense social/family/travel narrative (September 6 device evidence:
// Sarah/family/future-vacation narrative → unwanted appointment steal).
//
// Runner: npx tsx scripts/heraldTest/futureVisitMedicalDomainGuard.test.ts
// Gate:   wired from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
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

const ROUTE_DEPS = { classifyQuery, classifyLLM: null as null, llmReady: false };

// True iff routeIntent's result is (or contains) a medical capture/clarify —
// the exact observable symptom of the appointment-steal.
function producedMedicalCaptureOrClarify(rd: Awaited<ReturnType<typeof routeIntent>>): boolean {
  if (rd.kind === 'capture') {
    return rd.intents.some((i) => i.type.startsWith('medical'));
  }
  return false;
}

export async function runFutureVisitMedicalDomainGuardTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- FUTURE_VISIT Medical Domain Guard --${RESET}\n`);

  // ── NEGATIVE — unit level: detectMedicalEvent must return null ────────────
  const negativePhrases: [string, string][] = [
    ['N1', "We're going to see Sarah when we're in Florida."],
    ['N2', "I'm going to see my son next week."],
    ['N3', "We'll see Jeffrey while we're there."],
    ['N4', "She's seeing her family over Christmas."],
    ['N5', "We're excited about seeing my family for the vacation next month."],
  ];
  for (const [id, phrase] of negativePhrases) {
    const ev = detectMedicalEvent(phrase);
    assert(`${id} detectMedicalEvent(null) — "${phrase}"`, ev, (v) => v === null, 'null');
  }

  // ── NEGATIVE — route level: no medical_capture, no appointment clarify ────
  for (const [id, phrase] of negativePhrases) {
    freshDB();
    const rd = await routeIntent(phrase, ROUTE_DEPS);
    assert(`${id}R routeIntent does not produce medical capture — "${phrase}"`, rd,
      (v) => !producedMedicalCaptureOrClarify(v as Awaited<ReturnType<typeof routeIntent>>), 'no medical_* intent');
    if (rd.kind === 'capture') {
      assert(`${id}R2 no upcoming-appointment clarify prompt`, JSON.stringify(rd),
        (v) => typeof v === 'string' && !v.includes('when is your appointment'), 'does not contain "when is your appointment"');
    }
  }

  // ── POSITIVE — unit level: genuine medical future-visit still classifies ──
  {
    const ev = detectMedicalEvent("I'm going to see Dr. Smith next Tuesday.");
    assert('P1 type visit', ev?.type, (v) => v === 'visit', 'visit');
    assert('P1 tense future', ev?.tense, (v) => v === 'future', 'future');
    assert('P1 doctor_name captured', ev?.doctor_name, (v) => v === 'Dr. Smith', 'Dr. Smith');
  }
  {
    const ev = detectMedicalEvent("I'm going to see my doctor next week.");
    assert('P2 type visit', ev?.type, (v) => v === 'visit', 'visit');
    assert('P2 tense future', ev?.tense, (v) => v === 'future', 'future');
    assert('P2 specialty captured via "my doctor"', ev?.specialty, (v) => v === 'doctor', 'doctor');
  }
  {
    const ev = detectMedicalEvent('I have an appointment with Dr. Jones tomorrow.');
    assert('P3 type visit', ev?.type, (v) => v === 'visit', 'visit');
    assert('P3 tense future', ev?.tense, (v) => v === 'future', 'future');
    assert('P3 doctor_name captured', ev?.doctor_name, (v) => v === 'Dr. Jones', 'Dr. Jones');
  }
  {
    // "seeing the doctor" — bare alternative whose own text already supplies
    // domain evidence ("doctor"); must remain admitted.
    const ev = detectMedicalEvent('I am seeing the doctor next week about my knee.');
    assert('P4 type visit', ev?.type, (v) => v === 'visit', 'visit');
    assert('P4 tense future', ev?.tense, (v) => v === 'future', 'future');
  }

  // ── POSITIVE — route level: genuine cases still reach medical_visit_upcoming ─
  {
    freshDB();
    const rd = await routeIntent("I'm going to see Dr. Smith next Tuesday.", ROUTE_DEPS);
    assert('P1R routeIntent produces capture', rd.kind, (v) => v === 'capture', 'capture');
    if (rd.kind === 'capture') {
      assert('P1R intent type is medical_visit_upcoming', rd.intents[0]?.type,
        (v) => v === 'medical_visit_upcoming', 'medical_visit_upcoming');
    }
  }
  {
    freshDB();
    const rd = await routeIntent('I have an appointment with Dr. Jones tomorrow.', ROUTE_DEPS);
    assert('P3R routeIntent produces capture', rd.kind, (v) => v === 'capture', 'capture');
    if (rd.kind === 'capture') {
      assert('P3R intent type is medical_visit_upcoming', rd.intents[0]?.type,
        (v) => v === 'medical_visit_upcoming', 'medical_visit_upcoming');
    }
  }

  // ── REGRESSION / TRUST ──────────────────────────────────────────────────
  // R1: past medical-visit detection unchanged (hasPastVisit's own pre-
  // existing domain-evidence guard is untouched by this diff).
  {
    const ev = detectMedicalEvent('I saw Dr. Smith yesterday.');
    assert('R1 past visit with domain evidence still classifies', ev?.tense, (v) => v === 'past', 'past');
  }
  {
    const ev = detectMedicalEvent('I saw my sister yesterday.');
    assert('R2 past narrative without domain evidence still declines (pre-existing behavior)', ev,
      (v) => v === null, 'null');
  }
  // R3: medication capture authority untouched — different branch entirely.
  {
    const ev = detectMedicalEvent("I'm taking Lisinopril 10mg.");
    assert('R3 medication capture unaffected', ev?.type, (v) => v === 'medication', 'medication');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}FutureVisitMedicalDomainGuard: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('futureVisitMedicalDomainGuard.test.ts')) {
  runFutureVisitMedicalDomainGuardTests().catch(console.error);
}
