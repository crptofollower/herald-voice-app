// scripts/heraldTest/diagnosisContract.test.ts
// Diagnosis capture contract — detectDiagnosisCapture (detector) + writeDiagnosis/
// getDiagnoses (verbatim writer + single reader) against medical_records.
//
// NOTE: the medical_records DDL below is a hand-maintained replica of production
// schema.ts THROUGH v18 (includes removed_at). If production adds a medical_records
// column, update this — otherwise tests pass while production drifts. Same replica
// caveat as familyContract.test.ts; only the DEVICE test proves the real migration.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { detectDiagnosisCapture } from '../../src/utils/detectMedicalEvent.ts';
import { writeDiagnosis, getDiagnoses } from '../../src/db/medicalDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT, created_at TEXT,
    removed_at TEXT
  );
`;
function makeShim(db) {
  return {
    getAllSync: (s, p = []) => db.prepare(s).all(...p),
    getFirstSync: (s, p = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}
function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

// Extracted condition from a detector result (or undefined if no capture).
function condOf(input) {
  const r = detectDiagnosisCapture(input);
  return r.length && r[0].type === 'diagnosis_capture' ? r[0].condition : undefined;
}

export async function runDiagnosisContractTests() {
  const failures = [];
  let passed = 0;
  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}❌ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}--- Diagnosis Contract Tests -----------------------------${RESET}\n`);

  // ── Detector: MUST capture, condition carried VERBATIM (Spine §3) ──
  assert('DX1 diagnosed-with → "type 2 diabetes"', condOf('I was diagnosed with type 2 diabetes'),
    (v) => v === 'type 2 diabetes', '"type 2 diabetes"');
  assert('DX2 diagnosed-me-with → "COPD"', condOf('the doctor diagnosed me with COPD'),
    (v) => v === 'COPD', '"COPD"');
  assert('DX3 diagnosis-is → "atrial fibrillation"', condOf('my diagnosis is atrial fibrillation'),
    (v) => v === 'atrial fibrillation', '"atrial fibrillation"');
  assert('DX4 results-frame device case (verbatim full phrase)',
    condOf('I just got my test results back I have diffuse large B-cell lymphoma'),
    (v) => v === 'diffuse large B-cell lymphoma', '"diffuse large B-cell lymphoma"');
  assert("DX5 been-diagnosed → \"early-stage Parkinson's\"",
    condOf("I've been diagnosed with early-stage Parkinson's"),
    (v) => v === "early-stage Parkinson's", "\"early-stage Parkinson's\"");

  // ── Detector: MUST NOT capture (fail toward NOT capturing) ──
  assert('NX1 headache → no capture', detectDiagnosisCapture('I have a headache'), (v) => v.length === 0, '[]');
  assert('NX2 cold → no capture', detectDiagnosisCapture('I have a cold'), (v) => v.length === 0, '[]');
  assert('NX3 question → no capture', detectDiagnosisCapture('I have a question'), (v) => v.length === 0, '[]');
  assert('NX4 grandkids → no capture', detectDiagnosisCapture('I have three grandkids'), (v) => v.length === 0, '[]');
  assert('NX5 appointment (visit, not dx) → no capture', detectDiagnosisCapture("I have a doctor's appointment tomorrow"), (v) => v.length === 0, '[]');
  assert('NX6 read "what\'s my diagnosis" → no capture', detectDiagnosisCapture("what's my diagnosis"), (v) => v.length === 0, '[]');
  assert('NX7 read "do I have any diagnoses" → no capture', detectDiagnosisCapture('do I have any diagnoses'), (v) => v.length === 0, '[]');
  assert('NX8 grocery list → no capture', detectDiagnosisCapture('take chocolate milk off my grocery list'), (v) => v.length === 0, '[]');
  assert('NX9 errand "pick up milk" → no capture', detectDiagnosisCapture('I have to pick up milk'), (v) => v.length === 0, '[]');

  // ── Writer + reader: verbatim, additive, soft-delete aware, honest miss ──
  {
    freshDB();
    assert('WX1 empty DB → no diagnoses', getDiagnoses(), (v) => v.length === 0, 'length 0');
  }
  {
    freshDB();
    writeDiagnosis('diffuse large B-cell lymphoma', 'I just got my test results back I have diffuse large B-cell lymphoma');
    const rows = getDiagnoses();
    assert('WX2 write → one diagnosis row', rows, (v) => v.length === 1, 'length 1');
    assert('WX3 stored VERBATIM (§3 character-for-character)', rows[0]?.diagnosis,
      (v) => v === 'diffuse large B-cell lymphoma', '"diffuse large B-cell lymphoma"');
  }
  {
    freshDB();
    writeDiagnosis('type 2 diabetes', 'raw a');
    writeDiagnosis('atrial fibrillation', 'raw b');
    const conds = getDiagnoses().map(r => r.diagnosis);
    assert('WX4 additive, not superseding (both held)', conds,
      (v) => v.includes('type 2 diabetes') && v.includes('atrial fibrillation'), 'both present');
  }
  {
    const db = freshDB();
    writeDiagnosis('active condition', 'raw active');
    writeDiagnosis('removed condition', 'raw removed');
    db.prepare("UPDATE medical_records SET removed_at = datetime('now') WHERE diagnosis = ?").run('removed condition');
    const conds = getDiagnoses().map(r => r.diagnosis);
    assert('WX5 soft-delete aware (removed excluded, active kept)', conds,
      (v) => v.includes('active condition') && !v.includes('removed condition'), 'active only');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('diagnosisContract.test.mjs')) {
  runDiagnosisContractTests().catch(console.error);
}
