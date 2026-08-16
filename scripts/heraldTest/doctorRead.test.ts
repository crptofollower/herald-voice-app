// scripts/heraldTest/doctorRead.test.ts
// Doctor-read contract — Build 72.
// Locks medical:doctor_read as its own reader (§4a): empty → honest miss
// (never a medication summary), seeded doctor_name returned verbatim, singular
// "who is my doctor" stays on doctor_read (not medical:summary), and med
// phrasing still routes medical:summary (regression on the removed patterns).
// DR7/DR8 (added later): visit-outcome recall — schema updated to v21 shape
// (visit_outcome/outcome_asked_at) to support attachVisitOutcome.
// DR17-DR20 (Fix 1, doctor-recall ownership repair): tell-cue coverage
// (bare, singular-visit, plural-visits) plus the two-doctor trust
// differential proving an explicitly-named-but-unresolved doctor
// ("doctor Smith") fails closed rather than silently returning a
// different doctor's outcome. Real repo coverage for tierRouter.ts's
// OUTCOME_CUE/APPOINTMENT_CONTEXT/NAMED_BUT_UNRESOLVED_DOCTOR_RE changes.
// DR21-DR30 (2026-08-15, medical multi-doctor ambiguity): unhinted
// visit-outcome clarify when 2+ distinct named doctors or any
// unattributed outcome row; hinted/unresolved-name paths unchanged.
// DR31-DR44 (2026-08-16, doctor-communication ownership): "what did
// my/the/Dr X say" is visit-outcome, never medical:summary; speaker-
// span rejects "What did I tell my doctor?"; Fix 1 unresolved +
// retrospective how-did remain unchanged.
//
// Runner: npx tsx scripts/heraldTest/doctorRead.test.ts
// Gate:   wired from run.mjs — must be green before Build 72 closes.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeMedicalContact, writeMedication, writeMedicalRecord, attachVisitOutcome, getMedicalSummary } from '../../src/db/medicalDB.ts';
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

  // ── DR17: bare "what did my doctor tell me" — Fix 1 Part A, no visit/
  // appointment noun at all. Before Fix 1 this fell through to medical:summary
  // (OUTCOME_CUE only recognized "say"; APPOINTMENT_CONTEXT had no bare-"tell
  // me" alternative). Same seed shape as DR7/DR8.
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR17 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR17 response includes exact stored outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood work looked good, no medication changes, follow up in six months'),
      'includes stored outcome');
  }

  // ── DR18: "what did my doctor tell me about my visit" — singular visit noun,
  // Fix 1 Part A tell-cue.
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('What did my doctor tell me about my visit?');
    assert('DR18 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR18 response includes exact stored outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood work looked good, no medication changes, follow up in six months'),
      'includes stored outcome');
  }

  // ── DR19: "what did my doctor tell me about my visits" — plural. Fix 1 Part A
  // also fixed a word-boundary bug (/\bvisit\b/ never matched "visits") found
  // independently while tracing this exact required case.
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('What did my doctor tell me about my visits?');
    assert('DR19 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR19 response includes exact stored outcome verbatim', d.tier1Response,
      (v) => typeof v === 'string' && v.includes('Blood work looked good, no medication changes, follow up in six months'),
      'includes stored outcome');
  }

  // ── DR20: two-doctor trust differential — Fix 1 Part B. "doctor Smith"
  // (spelled-out "doctor", not "Dr") is explicitly named but NOT resolved by
  // extractDoctorName (Dr/Dr.-only). Foster's visit is newer, so an undefined
  // hint routed to the ordinary unhinted-latest reader (old behavior) would
  // silently return Foster's outcome under Smith's name — the exact trust
  // failure Fix 1 Part B exists to close. Same differential-seeding shape as
  // DR11, applied to the outcome reader instead of the visit-history reader.
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', visit_date: '2026-05-01', notes: 'older visit' });
    attachVisitOutcome(smithId, 'Everything from your last checkup looked normal.');
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'newer visit' });
    attachVisitOutcome(fosterId, 'Your blood pressure reading was elevated, follow up in a month.');
    const d = await classifyQuery('What did my doctor Smith tell me at my appointment');
    assert('DR20a fails closed — does not route to medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_unresolved_doctor', 'medical:visit_outcome_unresolved_doctor');
    assert('DR20b response does NOT leak Foster\'s (newer, wrong-doctor) outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('elevated'), 'excludes Foster outcome text');
    assert('DR20c response does NOT silently return Smith\'s outcome either (genuine fail-closed, not a lucky match)', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('looked normal'), 'excludes Smith outcome text');
  }

  // ── DR21: zero outcomes, unhinted query. 0 qualifying rows is always
  // safe (helper shortcut). Existing miss text, existing read reason.
  {
    freshDB();
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR21 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR21 returns existing miss text', d.tier1Response,
      (v) => v === "I don't have anything from your last visit yet.",
      'existing miss text');
  }

  // ── DR22: one named doctor, one outcome, unhinted. Safe singleton.
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR22 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR22 response includes stored outcome (not a clarify)', d.tier1Response,
      (v) => typeof v === 'string'
        && v.includes('Blood work looked good, no medication changes, follow up in six months')
        && v !== 'Which doctor do you mean?',
      'includes stored outcome, not clarify');
  }

  // ── DR23: one doctor, multiple outcome rows for that same doctor,
  // unhinted. Same-doctor multiplicity is NOT ambiguous — latest wins.
  {
    freshDB();
    const olderId = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'older visit', visit_date: '2026-05-01' });
    attachVisitOutcome(olderId, 'Older checkup notes, not the latest.');
    const newerId = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'newer visit', visit_date: '2026-07-20' });
    attachVisitOutcome(newerId, 'Blood work looked good, no medication changes, follow up in six months');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR23 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR23 returns the latest Alvarez outcome, not the older one', d.tier1Response,
      (v) => typeof v === 'string'
        && v.includes('Blood work looked good, no medication changes, follow up in six months')
        && !v.includes('Older checkup notes'),
      'latest Alvarez outcome only');
  }

  // ── DR24: two named doctors, unhinted. Must clarify; leak-proof.
  {
    freshDB();
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR24 routes medical:visit_outcome_multiple_doctors', d.reason,
      (v) => v === 'medical:visit_outcome_multiple_doctors', 'medical:visit_outcome_multiple_doctors');
    assert('DR24 clarify copy is exact', d.tier1Response,
      (v) => v === 'Which doctor do you mean?', 'Which doctor do you mean?');
    assert('DR24 response does not leak Patel outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('labs were unremarkable'), 'excludes Patel outcome');
    assert('DR24 response does not leak Smith outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('continue the current dose'), 'excludes Smith outcome');
  }

  // ── DR25: one named doctor's outcome PLUS one unattributed outcome
  // (doctor_name = null), unhinted. Unattributed is never assumed to
  // belong to the named doctor — clarify. Leak-proof on outcome and name.
  {
    freshDB();
    const namedId = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'named visit', visit_date: '2026-05-01' });
    attachVisitOutcome(namedId, 'Alvarez said the blood pressure was improved.');
    const nullId = writeMedicalRecord({ notes: 'unattributed visit', visit_date: '2026-07-20' });
    attachVisitOutcome(nullId, 'Unattributed follow-up notes, no doctor recorded.');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR25 routes medical:visit_outcome_multiple_doctors', d.reason,
      (v) => v === 'medical:visit_outcome_multiple_doctors', 'medical:visit_outcome_multiple_doctors');
    assert('DR25 clarify copy is exact', d.tier1Response,
      (v) => v === 'Which doctor do you mean?', 'Which doctor do you mean?');
    assert('DR25 does not leak named-doctor outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('blood pressure was improved'), 'excludes Alvarez outcome');
    assert('DR25 does not leak unattributed outcome or doctor name', d.tier1Response,
      (v) => typeof v === 'string'
        && !v.includes('Unattributed follow-up')
        && !v.includes('Alvarez'),
      'excludes unattributed outcome and doctor name');
  }

  // ── DR26: exactly ONE outcome row total, doctor_name = null, unhinted.
  // rows.length <= 1 shortcut fires before any ambiguity check.
  {
    freshDB();
    const id = writeMedicalRecord({ notes: 'unattributed visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'Follow up in six months, no medication changes.');
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR26 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR26 returns existing single-answer text', d.tier1Response,
      (v) => v === 'Last time, you mentioned: Follow up in six months, no medication changes.',
      'existing unattributed single-answer text');
  }

  // ── DR27: explicit "Dr Smith" query with 2+ doctors present. Hinted
  // path — new branch never fires when doctorHint is truthy.
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'smith visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, 'Everything from your last checkup looked normal.');
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'patel visit', visit_date: '2026-07-20' });
    attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
    const d = await classifyQuery('What did Dr Smith say at my last appointment');
    assert('DR27 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR27 returns Smith\'s outcome specifically', d.tier1Response,
      (v) => typeof v === 'string'
        && v.includes('Everything from your last checkup looked normal.')
        && !v.includes('labs were unremarkable')
        && v !== 'Which doctor do you mean?',
      'Smith outcome only');
  }

  // ── DR28: "my doctor Smith" (unresolved name shape) with 2+ doctors.
  // Fix 1's existing guard still runs BEFORE the new branch.
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'older visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, 'Everything from your last checkup looked normal.');
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', notes: 'newer visit', visit_date: '2026-07-20' });
    attachVisitOutcome(fosterId, 'Your blood pressure reading was elevated, follow up in a month.');
    const d = await classifyQuery('What did my doctor Smith tell me at my appointment');
    assert('DR28 still fails closed on unresolved doctor (Fix 1 before new branch)', d.reason,
      (v) => v === 'medical:visit_outcome_unresolved_doctor', 'medical:visit_outcome_unresolved_doctor');
  }

  // ── DR29: regression — DR17, DR18, DR19, DR20 above are unmodified
  // and already ran. No new assertions; those four must still pass
  // exactly as before (getLastVisitOutcome / getLastVisitOutcomeSummary
  // are byte-unchanged).

  // ── DR30: getMedicalSummary() against a DB with active medications
  // AND multiple ambiguous doctor-outcome rows. Medication list and
  // primary-doctor line must be unaffected (no cross-contamination).
  {
    freshDB();
    writeMedication({ name: 'Aspirin', dosage: '81mg', is_active: 1 });
    writeMedicalContact({ name: 'Dr. Sarver', is_primary: 1 });
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
    const summary = getMedicalSummary();
    assert('DR30 medication list is unaffected', summary,
      (v) => v.includes('Aspirin') && v.includes('81mg'), 'includes Aspirin 81mg');
    assert('DR30 primary-doctor line is unaffected', summary,
      (v) => v.includes('Dr. Sarver'), 'includes Dr. Sarver');
  }

  // ── DR31–DR44: doctor-communication ownership (2026-08-16) ────────────────
  // Device-proven: "What did my doctor say?" was stolen by medical:summary.
  // Communication-shaped asks now share the visit-outcome reader; summary
  // no longer owns /what did (my|the) doctor/. Existing Fix 1 reasons,
  // miss text, and disambiguation are reused — no new response types.

  const SMITH_OUTCOME = 'Everything from your last checkup looked normal.';
  const FOSTER_OUTCOME = 'Your blood pressure reading was elevated, follow up in a month.';
  const ALVAREZ_OUTCOME = 'Blood work looked good, no medication changes, follow up in six months';
  const VISIT_OUTCOME_MISS = "I don't have anything from your last visit yet.";

  // DR31: device failure — "What did my doctor say?" + one stored outcome
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, ALVAREZ_OUTCOME);
    const d = await classifyQuery('What did my doctor say?');
    assert('DR31a routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR31b response includes exact stored outcome', d.tier1Response,
      (v) => typeof v === 'string' && v.includes(ALVAREZ_OUTCOME), 'includes stored outcome');
    assert('DR31c is not medical:summary', d.reason,
      (v) => v !== 'medical:summary', 'not medical:summary');
  }

  // DR32: known-good — "What did my doctor tell me?" remains visit-outcome
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, ALVAREZ_OUTCOME);
    const d = await classifyQuery('What did my doctor tell me?');
    assert('DR32 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
  }

  // DR33: "What did the doctor say?" — unhinted communication, not summary
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, ALVAREZ_OUTCOME);
    const d = await classifyQuery('What did the doctor say?');
    assert('DR33a routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR33b is not medical:summary', d.reason,
      (v) => v !== 'medical:summary', 'not medical:summary');
    assert('DR33c response includes exact stored outcome', d.tier1Response,
      (v) => typeof v === 'string' && v.includes(ALVAREZ_OUTCOME), 'includes stored outcome');
  }

  // DR34: named "What did Dr Smith say?" — Smith outcome, newer other doctor
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', visit_date: '2026-05-01', notes: 'older visit' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'newer visit' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    const d = await classifyQuery('What did Dr Smith say?');
    assert('DR34a routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR34b returns Smith outcome', d.tier1Response,
      (v) => typeof v === 'string' && v.includes(SMITH_OUTCOME), 'includes Smith outcome');
    assert('DR34c does not leak Foster (newer) outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('elevated'), 'excludes Foster outcome');
  }

  // DR35: named miss — "What did Dr Smith say?" with only another doctor's outcome
  {
    freshDB();
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'visit' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    const d = await classifyQuery('What did Dr Smith say?');
    assert('DR35a routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR35b honest miss', d.tier1Response,
      (v) => v === VISIT_OUTCOME_MISS, VISIT_OUTCOME_MISS);
    assert('DR35c does not leak Foster outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('elevated'), 'excludes Foster outcome');
  }

  // DR36: no stored outcome — honest miss, not medical:summary
  {
    freshDB();
    const d = await classifyQuery('What did my doctor say?');
    assert('DR36a routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
    assert('DR36b honest miss', d.tier1Response,
      (v) => v === VISIT_OUTCOME_MISS, VISIT_OUTCOME_MISS);
    assert('DR36c is not medical:summary', d.reason,
      (v) => v !== 'medical:summary', 'not medical:summary');
  }

  // DR37: multiple doctors, unhinted "What did my doctor say?"
  {
    freshDB();
    const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
    const d = await classifyQuery('What did my doctor say?');
    assert('DR37a routes medical:visit_outcome_multiple_doctors', d.reason,
      (v) => v === 'medical:visit_outcome_multiple_doctors', 'medical:visit_outcome_multiple_doctors');
    assert('DR37b clarify copy is exact', d.tier1Response,
      (v) => v === 'Which doctor do you mean?', 'Which doctor do you mean?');
    assert('DR37c does not leak either outcome', d.tier1Response,
      (v) => typeof v === 'string'
        && !v.includes('labs were unremarkable')
        && !v.includes('continue the current dose'),
      'excludes Patel and Smith outcomes');
  }

  // DR38: Fix 1 unresolved lock — spelled-out "my doctor Smith" + tell me
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', visit_date: '2026-05-01', notes: 'older visit' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'newer visit' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    const d = await classifyQuery('What did my doctor Smith tell me at my appointment');
    assert('DR38a still medical:visit_outcome_unresolved_doctor', d.reason,
      (v) => v === 'medical:visit_outcome_unresolved_doctor', 'medical:visit_outcome_unresolved_doctor');
    assert('DR38b does not leak Foster outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('elevated'), 'excludes Foster outcome');
    assert('DR38c does not leak Smith outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('looked normal'), 'excludes Smith outcome');
  }

  // DR39: new unresolved sibling — "What did my doctor Smith say?"
  {
    freshDB();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', visit_date: '2026-05-01', notes: 'older visit' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', visit_date: '2026-07-20', notes: 'newer visit' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    const d = await classifyQuery('What did my doctor Smith say?');
    assert('DR39a routes medical:visit_outcome_unresolved_doctor', d.reason,
      (v) => v === 'medical:visit_outcome_unresolved_doctor', 'medical:visit_outcome_unresolved_doctor');
    assert('DR39b does not leak Foster outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('elevated'), 'excludes Foster outcome');
    assert('DR39c does not leak Smith outcome', d.tier1Response,
      (v) => typeof v === 'string' && !v.includes('looked normal'), 'excludes Smith outcome');
  }

  // DR40: speaker-direction negative — doctor is addressee, not speaker
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Alvarez', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, ALVAREZ_OUTCOME);
    const d = await classifyQuery('What did I tell my doctor?');
    assert('DR40a is not medical:visit_outcome_read', d.reason,
      (v) => v !== 'medical:visit_outcome_read', 'not medical:visit_outcome_read');
    assert('DR40b is not medical:summary', d.reason,
      (v) => v !== 'medical:summary', 'not medical:summary');
  }

  // DR41: medication positive control
  {
    freshDB();
    const d = await classifyQuery('What medications am I on?');
    assert('DR41 routes medical:summary', d.reason,
      (v) => v === 'medical:summary', 'medical:summary');
  }

  // DR42: doctor-identity positive control
  {
    freshDB();
    const d = await classifyQuery('Who is my doctor?');
    assert('DR42 routes medical:doctor_read', d.reason,
      (v) => v === 'medical:doctor_read', 'medical:doctor_read');
  }

  // DR43: "Who is my primary doctor?" coverage lock — do not repair here.
  // Current owner is fallthrough (reason "default"); must not become
  // visit-outcome or medical:summary.
  {
    freshDB();
    const d = await classifyQuery('Who is my primary doctor?');
    assert('DR43a is not medical:visit_outcome_read', d.reason,
      (v) => v !== 'medical:visit_outcome_read', 'not medical:visit_outcome_read');
    assert('DR43b is not medical:summary', d.reason,
      (v) => v !== 'medical:summary', 'not medical:summary');
    assert('DR43c preserves current fallthrough owner', d.reason,
      (v) => v === 'default', 'default');
  }

  // DR44: retrospective how-did lock — still visit-outcome
  {
    freshDB();
    const id = writeMedicalRecord({ doctor_name: 'Dr. Hexagon', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(id, 'He said keep taking the blood pressure medicine.');
    const d = await classifyQuery('How did my appointment with Dr. Hexagon go?');
    assert('DR44 routes medical:visit_outcome_read', d.reason,
      (v) => v === 'medical:visit_outcome_read', 'medical:visit_outcome_read');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}DoctorRead: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

