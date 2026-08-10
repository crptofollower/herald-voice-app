// scripts/heraldTest/doctorRead.test.ts
// Doctor-read contract — Build 72.
// Locks medical:doctor_read as its own reader (§4a): empty → honest miss
// (never a medication summary), seeded doctor_name returned verbatim, singular
// "who is my doctor" stays on doctor_read (not medical:summary), and med
// phrasing still routes medical:summary (regression on the removed patterns).
// DR7/DR8 (added later): visit-outcome recall — schema updated to v21 shape
// (visit_outcome/outcome_asked_at) to support attachVisitOutcome.
//
// Runner: npx tsx scripts/heraldTest/doctorRead.test.ts
// Gate:   wired from run.mjs — must be green before Build 72 closes.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalContact, writeMedication, writeMedicalRecord, attachVisitOutcome } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Hand-maintained replica of the medical tables classifyQuery/getDoctorSummary
// touch. Same caveat as medicalContract / diagnosisContract: if production DDL
// drifts, update this — device is the real migration proof.
// UPDATED for DR7/DR8: medical_records gains visit_outcome/outcome_asked_at
// (v21 migration, 07-29) — this replica was stale until this session.
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
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
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
  CREATE TABLE IF NOT EXISTS local_profile (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
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

  // ── DR4: med phrasing still medical:summary (regression guard)
  {
    freshDB();
    const d = await classifyQuery('what medication am I on');
    assert('DR4 med phrasing still routes medical:summary', d.reason,
      (v) => v === 'medical:summary', 'medical:summary');
  }

  // ── DR5: "what medications do i take" — real seeded med, real recall
  {
    freshDB();
    writeMedication({ name: 'Aspirin', dosage: '81mg', is_active: 1 });
    const d = await classifyQuery('what medications do i take');
    assert('DR5 routes medical:summary', d.reason,
      (v) => v === 'medical:summary', 'medical:summary');
    assert('DR5 summary includes exact drug name', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Aspirin'), 'includes "Aspirin"');
  }

  // ── DR6: "what medicine do i take" — singular-noun variant, same seed
  {
    freshDB();
    writeMedication({ name: 'Aspirin', dosage: '81mg', is_active: 1 });
    const d = await classifyQuery('what medicine do i take');
    assert('DR6 routes medical:summary', d.reason,
      (v) => v === 'medical:summary', 'medical:summary');
    assert('DR6 summary includes exact drug name', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Aspirin'), 'includes "Aspirin"');
  }

  // ── DR7: "what did Dr Alvarez say at my last appointment" — real committed
  // outcome, real recall path via VISIT_OUTCOME_READ -> getLastVisitOutcomeSummary
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('what did Dr Alvarez say at my last appointment');
    assert('DR7 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR7 response includes exact stored outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood work looked good, no medication changes, follow up in six months'),
      'includes stored outcome');
  }

  // ── DR8: "what did the doctor say last time" — natural variant, no name, same seed
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('what did the doctor say last time');
    assert('DR8 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR8 response includes exact stored outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood work looked good, no medication changes, follow up in six months'),
      'includes stored outcome');
  }

  // ── DR9: getLastVisit period-insensitivity — same normalization fix,
  // different reader (VISIT_HISTORY_READ, "when did I last see"), proves the
  // shared helper actually fixed both call sites, not just getLastVisitOutcome.
  {
    freshDB();
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    const d = await classifyQuery('when did i last see Dr Alvarez');
    assert('DR9 routes medical:visit_history_read', d.reason,
      (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
    assert('DR9 finds the visit despite no-period query vs. stored "Dr. Alvarez"', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Alvarez') && !/don't have a visit/i.test(v),
      'response names Alvarez, not the honest-miss line');
  }

  // ── DR10: getLastVisit reason/diagnosis/follow_up now spoken verbatim —
  // Session 1 (2026-08-10) widened getLastVisit's return shape; this proves
  // VISIT_HISTORY_READ actually speaks the new fields rather than silently
  // carrying unused data. Exact stored strings only — nothing invented.
  {
    freshDB();
    writeMedicalRecord({
      doctor_name: 'Dr. Alvarez',
      visit_date: '2026-07-20',
      reason: 'annual checkup',
      diagnosis: 'mild hypertension',
      follow_up: 'recheck blood pressure in three months',
    });
    const d = await classifyQuery('when did i last see Dr Alvarez');
    assert('DR10a routes medical:visit_history_read', d.reason,
      (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
    assert('DR10b response includes exact stored reason verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('annual checkup'), 'includes "annual checkup"');
    assert('DR10c response includes exact stored diagnosis verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('mild hypertension'), 'includes "mild hypertension"');
    assert('DR10d response includes exact stored follow_up verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('recheck blood pressure in three months'),
      'includes "recheck blood pressure in three months"');
  }

  // ── DR11: shared extractDoctorName resolves a phrasing the OLD inline
  // /\bsee\s+(dr\.?\s+\w+)/i regex would have missed (no literal "see"
  // adjacent to the name). Two doctors seeded, Foster's visit newer, so an
  // undefined hint (old-code behavior) would fall back to Foster — the
  // WRONG doctor — making this a genuine differential guard, not a test
  // that would pass either way.
  {
    freshDB();
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-05-01', notes: 'older visit' });
    writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'newer visit' });
    const d = await classifyQuery('When was my last appointment with Dr Alvarez?');
    assert('DR11a routes medical:visit_history_read', d.reason,
      (v) => v === 'medical:visit_history_read', 'medical:visit_history_read');
    assert('DR11b resolves Alvarez specifically, not the newer Foster fallback', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Alvarez') && !v.includes('Foster'),
      'response names Alvarez, not Foster');
  }

  // ── DR12: doctor summary composer — full composite, everything present ────
  // Session 2 (2026-08-10). Proves the composer surfaces identity/specialty,
  // last-visit reason/diagnosis/follow_up, matching-date outcome, and an
  // upcoming appointment together, without touching any new authority.
  {
    freshDB();
    writeMedicalContact({ name: 'Dr. Alvarez', specialty: 'Cardiologist', is_primary: 1 });
    const visitId = writeMedicalRecord({
      doctor_name: 'Dr. Alvarez',
      visit_date: '2026-07-20',
      reason: 'annual checkup',
      diagnosis: 'mild hypertension',
      follow_up: 'recheck blood pressure in three months',
      status: 'noted',
    });
    attachVisitOutcome(visitId, 'Blood pressure was a little high');
    writeMedicalRecord({ doctor_name: 'Dr. Alvarez', visit_date: '2026-09-15', status: 'upcoming' });

    const d = await classifyQuery('Tell me about Dr Alvarez');
    assert('DR12a routes medical:doctor_summary', d.reason,
      (v) => v === 'medical:doctor_summary', 'medical:doctor_summary');
    assert('DR12b includes specialty', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Cardiologist'), 'includes "Cardiologist"');
    assert('DR12c includes reason, diagnosis, and follow_up verbatim', d.tier1Response,
      (v) => typeof v === 'string'
        && v.includes('annual checkup')
        && v.includes('mild hypertension')
        && v.includes('recheck blood pressure in three months'),
      'includes reason, diagnosis, follow_up');
    assert('DR12d includes matching-date outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood pressure was a little high'),
      'includes stored outcome');
    assert('DR12e includes upcoming appointment section', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('You see'), 'includes upcoming phrasing');
  }

  // ── DR13: no medical_contacts row — specialty line omitted, not fabricated,
  // rest of the composite still present. ──────────────────────────────────
  {
    freshDB();
    writeMedicalRecord({
      doctor_name: 'Dr. Foster',
      visit_date: '2026-06-01',
      reason: 'follow-up visit',
      status: 'noted',
    });
    const d = await classifyQuery('Tell me about Dr Foster');
    assert('DR13a routes medical:doctor_summary', d.reason,
      (v) => v === 'medical:doctor_summary', 'medical:doctor_summary');
    assert('DR13b specialty line omitted (no "is your" phrase) when no contact exists', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('is your'), 'no "is your"');
    assert('DR13c visit info still present', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('follow-up visit'), 'includes "follow-up visit"');
  }

  // ── DR14: outcome/visit-date mismatch — the composer's own conflict guard.
  // Older visit has the only outcome; newer visit has none. getLastVisit and
  // getLastVisitOutcome correctly point at DIFFERENT rows — proves the
  // composer suppresses the mismatched outcome rather than showing two dates
  // in one breath. ────────────────────────────────────────────────────────
  {
    freshDB();
    const olderId = writeMedicalRecord({
      doctor_name: 'Dr. Lee',
      visit_date: '2026-01-10',
      reason: 'earlier concern',
      status: 'noted',
    });
    attachVisitOutcome(olderId, 'Started a new medication back then');
    writeMedicalRecord({
      doctor_name: 'Dr. Lee',
      visit_date: '2026-07-01',
      reason: 'recent checkup',
      status: 'noted',
    });
    const d = await classifyQuery('Tell me about Dr Lee');
    assert('DR14a routes medical:doctor_summary', d.reason,
      (v) => v === 'medical:doctor_summary', 'medical:doctor_summary');
    assert('DR14b shows the NEWER visit (proves getLastVisit picked the right row)', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('recent checkup'), 'includes "recent checkup"');
    assert('DR14c does NOT show the older mismatched-date outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('Started a new medication back then'),
      'excludes older outcome text');
  }

  // ── DR15: complete miss — nothing known about this doctor at all ──────────
  {
    freshDB();
    const d = await classifyQuery('Tell me about Dr Nguyen');
    assert('DR15a routes medical:doctor_summary (fires on phrasing alone)', d.reason,
      (v) => v === 'medical:doctor_summary', 'medical:doctor_summary');
    assert('DR15b honest miss, names the doctor, no fabrication', d.tier1Response,
      (v) => typeof v === 'string' && /don't have anything on/i.test(v) && v.includes('Nguyen'),
      'honest miss naming Nguyen');
  }

  // ── DR16: routing coverage — "tell me about" and close paraphrases ────────
  {
    freshDB();
    const phrasings = [
      { label: 'DR16a "tell me about Dr X"', text: 'Tell me about Dr Alvarez' },
      { label: 'DR16b "what do you know about Dr X"', text: 'What do you know about Dr Alvarez' },
      { label: 'DR16c "give me a rundown on Dr X"', text: 'Give me a rundown on Dr Alvarez' },
    ];
    for (const { label, text } of phrasings) {
      const d = await classifyQuery(text);
      assert(label, d.reason, (v) => v === 'medical:doctor_summary', 'medical:doctor_summary');
    }
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}DoctorRead: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

