// Named medication inquiry vs capture — speech-act ownership.
// No last-mentioned referent slot. No fuzzy STT match. No LLM facts.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  confirmMedicationCapture,
  getActiveMedications,
  writeMedication,
} from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import {
  answerNamedMedicationInquiry,
  detectMedicationInquiry,
} from '../../src/utils/medicationInquiry.ts';
import { answerFromDevice } from '../../src/utils/localAnswers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

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
    visit_date TEXT, doctor_name TEXT, facility TEXT, reason TEXT,
    diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, removed_at TEXT, created_at TEXT
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
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profile (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL,
    all_day   INTEGER DEFAULT 0,
    notes     TEXT,
    cached_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    fact TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'stated',
    created_at TEXT NOT NULL
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

function seedNamedMeds() {
  writeMedication({ name: 'Metformin', dosage: '500 mg', is_active: 1 });
  writeMedication({ name: 'Eliquis', dosage: '5 mg', is_active: 1 });
}

export async function runMedicationInquiryTests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Medication Inquiry / Read-vs-Capture --------------------${RESET}\n`);

  // Path A — assertions still capture
  freshDB();
  check('A1 I take Metformin 500 mg twice a day → detectMedicalEvent medication',
    detectMedicalEvent('I take Metformin 500 mg twice a day.')?.type === 'medication');
  check('A2 I\'m on Eliquis 5 mg → detectMedicalEvent medication',
    detectMedicalEvent("I'm on Eliquis 5 mg.")?.type === 'medication');

  {
    const d = await classifyQuery('I take Metformin 500 mg twice a day.');
    check('A3 classifyQuery Metformin assertion → medical_capture',
      d.reason === 'action:medical_capture' && d.actionIntent?.type === 'medical_capture');
  }
  {
    const d = await classifyQuery("I'm on Eliquis 5 mg.");
    check('A4 classifyQuery Eliquis assertion → medical_capture',
      d.reason === 'action:medical_capture' && d.actionIntent?.type === 'medical_capture');
  }

  {
    const pending = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'Metformin', dosage: '500 mg', raw: 'I take Metformin 500 mg twice a day.' },
      'I take Metformin 500 mg twice a day.',
    );
    check('A5 assertion writer is confirmation-gated (pending, no write yet)',
      pending.status === 'pending' && getActiveMedications().length === 0);
    const yes = await pending.resume!('Yes');
    check('A6 confirm Yes writes Metformin',
      yes.status === 'committed' && getActiveMedications().some((m) => m.name === 'Metformin'));
  }

  // Path B — frequency inquiry never capture
  freshDB();
  seedNamedMeds();
  check('B1 How often do I take Metformin? → not capture',
    detectMedicalEvent('How often do I take Metformin?') == null);
  check('B2 How many times a day do I take Eliquis? → not capture',
    detectMedicalEvent('How many times a day do I take Eliquis?') == null);

  {
    const d = await classifyQuery('How often do I take Metformin?');
    check('B3 classifyQuery frequency → named_inquiry, not capture',
      d.reason === 'medical:named_inquiry' && d.actionIntent == null);
    check('B4 frequency honest miss when first-class frequency empty',
      d.tier1Response === "I have Metformin saved, but I don't have how often you take it.");
  }
  {
    const d = await classifyQuery('How many times a day do I take Eliquis?');
    check('B5 how-many-times inquiry is a read',
      d.reason === 'medical:named_inquiry' && !/remember/i.test(d.tier1Response ?? ''));
  }

  {
    freshDB();
    writeMedication({ name: 'Metformin', dosage: '500 mg', frequency: 'twice a day', is_active: 1 });
    const d = await classifyQuery('How often do I take Metformin?');
    check('B6 stored frequency is returned when the column is populated',
      d.reason === 'medical:named_inquiry' && /twice a day/i.test(d.tier1Response ?? ''));
  }

  // Path B yes/no schedule
  freshDB();
  seedNamedMeds();
  check('B7 Do I take Metformin twice a day? → not capture',
    detectMedicalEvent('Do I take Metformin twice a day?') == null);
  {
    const d = await classifyQuery('Do I take Metformin twice a day?');
    check('B8 yes/no schedule is named inquiry, not a write proposal',
      d.reason === 'medical:named_inquiry'
      && d.actionIntent == null
      && !/want me to remember/i.test(d.tier1Response ?? '')
      && !/sound right/i.test(d.tier1Response ?? ''));
    check('B9 yes/no schedule honest miss without stored frequency',
      /don't have how often/i.test(d.tier1Response ?? ''));
  }

  // Path C — dosage
  {
    const d = await classifyQuery('What is my Metformin dose?');
    check('C1 Metformin dose inquiry reads stored dosage',
      d.reason === 'medical:named_inquiry' && /500 mg/i.test(d.tier1Response ?? ''));
  }
  {
    const d = await classifyQuery('What dosage do I take for Eliquis?');
    check('C2 Eliquis dosage inquiry reads stored dosage',
      d.reason === 'medical:named_inquiry' && /5 mg/i.test(d.tier1Response ?? ''));
  }
  check('C3 dose inquiry is not capture',
    detectMedicalEvent('What is my Metformin dose?') == null);

  // Timing
  {
    const d = await classifyQuery('When do I take Metformin?');
    check('D-timing honest miss without stored frequency/schedule',
      d.reason === 'medical:named_inquiry'
      && /don't have how often/i.test(d.tier1Response ?? '')
      && d.actionIntent == null);
  }
  check('D-timing not capture',
    detectMedicalEvent('When do I take Metformin?') == null);

  // Path D — named recall
  {
    const d = await classifyQuery('What did I tell you about Metformin?');
    check('D1 named recall owns the stored medication record',
      d.reason === 'medical:named_inquiry' && /Metformin/i.test(d.tier1Response ?? ''));
    check('D2 named recall is not a profile dump',
      !/your name is/i.test(d.tier1Response ?? '') && !/still learning about you/i.test(d.tier1Response ?? ''));
  }
  {
    const local = answerFromDevice('What did I tell you about Metformin?');
    check('D3 answerFromDevice named recall is medication, not profile',
      !!local && /Metformin/i.test(local) && !/your name is/i.test(local));
  }

  // Path E — unknown medication
  {
    const d = await classifyQuery('How often do I take Lesquis?');
    check('E1 unmatched name is an honest miss, not a guess',
      d.reason === 'medical:named_inquiry'
      && /don't have Lesquis/i.test(d.tier1Response ?? '')
      && !/5 mg|twice/i.test(d.tier1Response ?? ''));
  }
  check('E2 unknown named recall does not hijack memory_probe/profile',
    answerNamedMedicationInquiry('What did I tell you about Shannon?') == null);

  {
    const d = await classifyQuery('What did I tell you about Shannon?');
    check('E3 unrelated what-did-I-tell-you is not medical:named_inquiry',
      d.reason !== 'medical:named_inquiry');
  }

  // List retrieval unchanged
  {
    const d = await classifyQuery('What medications am I taking?');
    check('L1 catalog list remains medical:summary',
      d.reason === 'medical:summary');
  }
  check('L2 catalog is not named-inquiry owner',
    detectMedicationInquiry('What medications am I taking?') == null);

  // Negatives / Path F
  check('N1 grocery take-off-list is not a medical event',
    detectMedicalEvent('take chocolate milk off my grocery list') == null);
  {
    const d = await classifyQuery('take chocolate milk off my grocery list');
    check('N2 grocery take-off-list remains list_remove',
      d.actionIntent?.type === 'list_remove');
  }
  {
    const d = await classifyQuery('call hunter');
    check('N3 CALL ownership unchanged', d.actionIntent?.type === 'call');
  }
  {
    const d = await classifyQuery("I'm on Eliquis");
    check('N4 CF-23 assertion still medical_capture',
      d.actionIntent?.type === 'medical_capture');
  }
  {
    const d = await classifyQuery('I finished that thing from yesterday');
    check('N5 Conversation Foundation todo_complete still reachable',
      d.actionIntent?.type === 'todo_complete');
  }

  // Correction remains confirmation-gated
  {
    freshDB();
    confirmMedicationCapture('Metformin', '500 mg', 'I take Metformin 500 mg');
    const pending = await DOMAIN_WRITERS.medical_capture!.add(
      { type: 'medical_capture', drug: 'Metformin', dosage: '1000 mg', raw: 'I take Metformin 1000 mg' },
      'I take Metformin 1000 mg',
    );
    check('N6 correction is pending before Yes',
      pending.status === 'pending' && getActiveMedications()[0]?.dosage === '500 mg');
    const yes = await pending.resume!('Yes');
    check('N7 correction writes only after Yes',
      yes.status === 'committed' && getActiveMedications()[0]?.dosage === '1000 mg');
  }

  // Capture path still does not persist first-class frequency (documented, not repaired)
  {
    freshDB();
    confirmMedicationCapture('Eliquis', '5 milligrams', 'I take Eliquis 5 milligrams twice a day.');
    const row = getActiveMedications()[0];
    check('F1 confirmMedicationCapture still leaves frequency empty',
      !!row && !row.frequency);
  }

  // Case E — not repaired
  {
    const d = await classifyQuery('What was the medication we were talking about?');
    check('CASE-E referent question is not claimed as named_inquiry',
      d.reason !== 'medical:named_inquiry');
    check('CASE-E detectMedicationInquiry does not invent a last-mentioned name',
      detectMedicationInquiry('What was the medication we were talking about?') == null);
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ medicationInquiry: ${failures.length} failed${RESET}`);
    for (const f of failures) console.log(`  ${RED}✗ ${f}${RESET}  ${DIM}${RESET}`);
  } else {
    console.log(`${GREEN}✅ medicationInquiry: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('medicationInquiry.test.ts')) {
  runMedicationInquiryTests().catch(console.error);
}
