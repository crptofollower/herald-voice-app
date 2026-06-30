// scripts/heraldTest/medicalContract.test.mjs
// Medical domain contract tests — verbatim write/read invariant.
//
// Highest-trust domain: drug names and dosages must be stored and returned
// character-for-character. Any deviation (LLM paraphrase, normalization,
// case-folding, truncation) is a trust-critical failure per CLAUDE.md
// Medical Safety Rule and Spine §3 verbatim rule.
//
// These tests run against an in-memory SQLite DB (better-sqlite3).
// No React Native imports. No network. Fully offline.
//
// Runner:  npx tsx scripts/heraldTest/medicalContract.test.mjs
// Gate:    Must be green before Gate 3 / Heather onboard. Hard blocker.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import {
  writeMedication,
  confirmMedicationCapture,
  getActiveMedications,
  getMedicalSummary,
  deactivateMedicationByName,
  getMedicalRecords,
} from '../../src/db/medicalDB.ts';

const BOLD  = '\x1b[1m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';

// Full schema required by medicalDB.ts query paths.
// getActiveMedications queries: WHERE is_active = 1 AND removed_at IS NULL
// — removed_at column is mandatory or the query throws.
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
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_clarifications (
    id TEXT PRIMARY KEY,
    record_id TEXT,
    slot TEXT,
    created_at TEXT
  );
`;

function makeShim(db) {
  return {
    getAllSync:    (s, p = []) => db.prepare(s).all(...p),
    getFirstSync: (s, p = []) => db.prepare(s).get(...p) ?? null,
    runSync:      (s, p = []) => db.prepare(s).run(...p),
    execSync:     (s) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

export async function runMedicalContractTests() {
  const failures = [];
  let passed = 0;

  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medical Contract Tests --------------------------------${RESET}\n`);

  // ── M1: writeMedication returns a non-empty ID ─────────────────────────────
  freshDB();
  const id1 = writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
  assert('M1 writeMedication returns non-empty ID', id1,
    v => typeof v === 'string' && v.length > 0, 'non-empty string');

  // ── M2: drug name stored verbatim — exact case ─────────────────────────────
  // "Metformin" must come back as "Metformin", not "metformin" or "METFORMIN".
  // Any case-normalization is a verbatim-rule violation (Spine §3).
  freshDB();
  writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
  const meds2 = getActiveMedications();
  assert('M2 name stored verbatim — exact case', meds2[0]?.name,
    v => v === 'Metformin', '"Metformin"');

  // ── M3: dosage stored verbatim ─────────────────────────────────────────────
  // "500mg" must come back as "500mg", not "500 mg" or "500MG".
  assert('M3 dosage stored verbatim', meds2[0]?.dosage,
    v => v === '500mg', '"500mg"');

  // ── M4: getActiveMedications returns what was written ──────────────────────
  freshDB();
  writeMedication({ name: 'Lisinopril', dosage: '10mg', is_active: 1 });
  const meds4 = getActiveMedications();
  assert('M4 getActiveMedications returns 1 row', meds4.length,
    v => v === 1, '1');

  // ── M5: getMedicalSummary includes exact drug name ─────────────────────────
  // The spoken summary must contain the stored name character-for-character.
  // A paraphrased summary ("blood pressure medication") is a trust failure.
  freshDB();
  writeMedication({ name: 'Lisinopril', dosage: '10mg', is_active: 1 });
  const summary5 = getMedicalSummary();
  assert('M5 getMedicalSummary includes exact drug name', summary5,
    v => v.includes('Lisinopril'), 'includes "Lisinopril"');

  // ── M6: getMedicalSummary includes exact dosage ────────────────────────────
  assert('M6 getMedicalSummary includes exact dosage', summary5,
    v => v.includes('10mg'), 'includes "10mg"');

  // ── M7: confirmMedicationCapture on new name → action is "created" ─────────
  freshDB();
  const result7 = confirmMedicationCapture('Atorvastatin', '20mg');
  assert('M7 confirmMedicationCapture creates new row', result7.action,
    v => v === 'created', '"created"');
  const meds7 = getActiveMedications();
  assert('M7 new row is active with correct name', meds7[0]?.name,
    v => v === 'Atorvastatin', '"Atorvastatin"');

  // ── M8: confirmMedicationCapture on existing name → action is "superseded" ─
  // One-writer rule (Spine §4a): updating a med retires the old row and
  // inserts a new one. Only the new row is active.
  freshDB();
  writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
  const result8 = confirmMedicationCapture('Metformin', '1000mg');
  assert('M8 confirmMedicationCapture supersedes existing row', result8.action,
    v => v === 'superseded', '"superseded"');

  // ── M9: after supersede, exactly one active row with the new dosage ─────────
  const meds9 = getActiveMedications();
  assert('M9 only one active row after supersede', meds9.length,
    v => v === 1, '1');
  assert('M9 active row has new dosage', meds9[0]?.dosage,
    v => v === '1000mg', '"1000mg"');

  // ── M10: deactivateMedicationByName returns changed count > 0 ──────────────
  freshDB();
  writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
  const changed10 = deactivateMedicationByName('Metformin');
  assert('M10 deactivateMedicationByName returns changed count', changed10,
    v => v > 0, '> 0');

  // ── M11: deactivated med absent from getActiveMedications ──────────────────
  const meds11 = getActiveMedications();
  assert('M11 deactivated med absent from getActiveMedications', meds11.length,
    v => v === 0, '0');

  // ── M12: empty DB → getActiveMedications returns [] without error ───────────
  freshDB();
  const meds12 = getActiveMedications();
  assert('M12 empty DB → getActiveMedications returns []', meds12.length,
    v => v === 0, '0');

  // ── M13: empty DB → getMedicalSummary returns honest gap message ────────────
  // Must never fabricate medications for an empty DB. Must never throw.
  const summary13 = getMedicalSummary();
  assert('M13 empty DB → getMedicalSummary returns gap message', summary13,
    v => typeof v === 'string' && v.toLowerCase().includes("don't have"),
    "includes \"don't have\"");

  // ── M14: extractFactsLocally must NOT write ambient medications fact for "I am on X"
  // Pattern 503 was deleted in b0aa3ec2 — this pins that deletion permanently.
  {
    const { extractFactsLocally } = await import('../../src/db/factDB.ts');
    const db14 = new Database(':memory:');
    db14.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, category TEXT, value TEXT, confidence REAL,
      source_msg TEXT, created_at TEXT, expires_at TEXT,
      valid_until TEXT, importance_score REAL, last_used TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, observation TEXT, category TEXT,
      confidence REAL, source_msg TEXT, created_at TEXT
    );`);
    setDB(makeShim(db14));
    extractFactsLocally('I am on Eliquis');
    const rows14 = db14.prepare(
      "SELECT count(*) as n FROM facts WHERE category = 'medications'"
    ).get();
    assert(
      'M14 extractFactsLocally: no ambient medications fact for "I am on X"',
      rows14.n, (v) => v === 0, 0
    );
  }

  // ── M15: isMedicalCaptureIntent catches the uncontracted form
  {
    const { isMedicalCaptureIntent } = await import('../../src/db/factDB.ts');
    assert(
      'M15 isMedicalCaptureIntent: "I am on Eliquis" returns true',
      isMedicalCaptureIntent('I am on Eliquis'),
      (v) => v === true, true
    );
  }

  // ── M16: detectMedicalEvent still catches the contracted form upstream
  {
    const { detectMedicalEvent } = await import('../../src/utils/detectMedicalEvent.ts');
    const ev16 = detectMedicalEvent("I'm on Eliquis");
    assert(
      "M16 detectMedicalEvent: \"I'm on Eliquis\" returns medication event",
      ev16?.type, (v) => v === 'medication', 'medication'
    );
  }

  // ── M17: clean doctor name → exactly one visit record, doctor_name verbatim ─
  // "I saw Dr. Sarver today" — a clean "Dr. X" name is HEARD, not guessed.
  // Visit policy + Spine §5: write immediately, verbatim. This case SHOULD write.
  freshDB();
  await DOMAIN_WRITERS.medical_visit!.add({
    type: 'medical_visit',
    doctor_name: 'Dr. Sarver',
    raw: 'I saw Dr. Sarver today',
  }, 'I saw Dr. Sarver today');
  const recs17 = getMedicalRecords();
  assert('M17 clean-name visit writes exactly one record', recs17.length,
    v => v === 1, '1');
  assert('M17 doctor_name stored verbatim', recs17[0]?.doctor_name,
    v => v === 'Dr. Sarver', '"Dr. Sarver"');

  // ── M18: specialty-only (NO clean name) → ZERO records written ─────────────
  // "I saw my cardiologist" has no "Dr. X". A specialty resolves to multiple
  // people over time; writing it as doctor_name is a confident-wrong write (§5)
  // that poisons the future association graph (§6). It MUST write NOTHING and ask.
  freshDB();
  const visit18 = await DOMAIN_WRITERS.medical_visit!.add({
    type: 'medical_visit',
    specialty: 'cardiologist',
    raw: 'I saw my cardiologist',
  }, 'I saw my cardiologist');
  const recs18 = getMedicalRecords();
  assert('M18 specialty-only visit writes ZERO records', recs18.length,
    v => v === 0, '0');
  assert('M18 specialty-only visit asks who you saw',
    visit18.status === 'pending' ? visit18.prompt : '',
    v => typeof v === 'string' && /who/i.test(v), 'a "who did you see?" question');

  // ── M19: pending resume with clean name → committed, one record ─────────────
  freshDB();
  const visit19 = await DOMAIN_WRITERS.medical_visit!.add({
    type: 'medical_visit',
    specialty: 'cardiologist',
    raw: 'I saw my cardiologist',
  }, 'I saw my cardiologist');
  assert('M19 specialty-only returns pending', visit19.status,
    v => v === 'pending', 'pending');
  const resumed19 = await visit19.resume('Dr. Chen');
  assert('M19 resume commits', resumed19.status,
    v => v === 'committed', 'committed');
  const recs19 = getMedicalRecords();
  assert('M19 resume writes exactly one record', recs19.length,
    v => v === 1, '1');
  assert('M19 resumed doctor_name stored verbatim', recs19[0]?.doctor_name,
    v => v === 'Dr. Chen', '"Dr. Chen"');

  // ── M20: advice appended to notes verbatim ─────────────────────────────────
  freshDB();
  await DOMAIN_WRITERS.medical_visit!.add({
    type: 'medical_visit',
    doctor_name: 'Dr. Lee',
    advice: 'cut salt',
    raw: 'I saw Dr. Lee today',
  }, 'I saw Dr. Lee today');
  const recs20 = getMedicalRecords();
  assert('M20 advice visit writes one record', recs20.length,
    v => v === 1, '1');
  assert('M20 notes include raw and advice verbatim', recs20[0]?.notes,
    v => v === 'I saw Dr. Lee today — cut salt',
    '"I saw Dr. Lee today — cut salt"');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Medical Contract: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalContract.test.ts')) {
  runMedicalContractTests().catch(console.error);
}
