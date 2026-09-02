// Confirmed medication frequency persistence — explicit span only.
// No inferred dosing. No notes scraping on read. No last-mentioned referent.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { confirmMedicationCapture, getActiveMedications } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { detectMedicalEvent, extractFrequency } from '../../src/utils/detectMedicalEvent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY, name TEXT, specialty TEXT, phone TEXT, address TEXT,
    is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL, all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT NOT NULL
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

function medIntent(raw: string): IntentRecord {
  const ev = detectMedicalEvent(raw);
  return {
    type: 'medical_capture',
    drug: ev?.drug_name,
    dosage: ev?.dosage,
    frequency: ev?.frequency,
    raw,
  };
}

export async function runMedicationFrequencyTests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Medication Frequency Persistence -----------------------${RESET}\n`);

  check('X1 twice a day', extractFrequency('I take Metformin 500 mg twice a day.') === 'twice a day');
  check('X2 once a day', extractFrequency('I take Metformin 500 mg once a day.') === 'once a day');
  check('X3 once daily', extractFrequency('I take Eliquis 5 mg once daily.') === 'once daily');
  check('X4 twice daily', extractFrequency('I take Eliquis 5 mg twice daily.') === 'twice daily');
  check('X5 three times a day', extractFrequency('I take Metformin 500 mg three times a day.') === 'three times a day');
  check('X6 every morning', extractFrequency('I take Aspirin 81 mg every morning.') === 'every morning');
  check('X7 every night', extractFrequency('I take Melatonin 3 mg every night.') === 'every night');
  check('X8 nightly', extractFrequency('I take Melatonin 3 mg nightly.') === 'nightly');
  check('X9 morning and night', extractFrequency('I take Metformin 500 mg morning and night.') === 'morning and night');
  check('X10 no frequency stated → undefined', extractFrequency('I take Metformin 500 mg.') === undefined);
  check('X11 every 8 hours unsupported', extractFrequency('I take Metformin 500 mg every 8 hours.') === undefined);
  check('X12 twice a week unsupported', extractFrequency('I take Methotrexate 10 mg twice a week.') === undefined);
  check('X13 conflicting spans stay unstructured',
    extractFrequency('I take Metformin twice a day every morning.') === undefined);

  // A — pending holds frequency; no write before YES; YES persists
  {
    freshDB();
    const raw = 'I take Metformin 500 mg twice a day.';
    check('A0 detectMedicalEvent carries frequency',
      detectMedicalEvent(raw)?.frequency === 'twice a day');
    const pending = await DOMAIN_WRITERS.medical_capture!.add(medIntent(raw), raw);
    check('A1 pending capture prompt includes explicit frequency',
      pending.status === 'pending' && /twice a day/i.test(pending.prompt ?? ''));
    check('A2 no DB write before YES', getActiveMedications().length === 0);
    const yes = await pending.resume!('Yes');
    const row = getActiveMedications()[0];
    check('A3 YES writes name, dosage, frequency',
      yes.status === 'committed'
      && row?.name === 'Metformin'
      && /500\s*mg/i.test(row?.dosage ?? '')
      && row?.frequency === 'twice a day');
  }

  // B — once daily
  {
    freshDB();
    const raw = 'I take Eliquis 5 mg once daily.';
    const pending = await DOMAIN_WRITERS.medical_capture!.add(medIntent(raw), raw);
    check('B1 Eliquis once daily is pending, not written',
      pending.status === 'pending' && getActiveMedications().length === 0);
    await pending.resume!('Yes');
    check('B2 frequency persisted as once daily',
      getActiveMedications()[0]?.frequency === 'once daily');
  }

  // C — no inferred default
  {
    freshDB();
    const raw = 'I take Metformin 5 mg.';
    const pending = await DOMAIN_WRITERS.medical_capture!.add(medIntent(raw), raw);
    await pending.resume!('Yes');
    const row = getActiveMedications()[0];
    check('C1 dose-only capture leaves frequency empty',
      !!row && !row.frequency && /5\s*mg/i.test(row.dosage ?? ''));
  }

  // D — reject/cancel
  {
    freshDB();
    const raw = 'I take Eliquis 5 milligrams twice a day.';
    const pending = await DOMAIN_WRITERS.medical_capture!.add(medIntent(raw), raw);
    const no = await pending.resume!('No');
    check('D1 reject is noop', no.status === 'noop');
    check('D2 reject writes no frequency row', getActiveMedications().length === 0);
  }

  // F — inquiry reads persisted frequency (inquiry owner unchanged)
  {
    freshDB();
    const raw = 'I take Metformin 500 mg twice a day.';
    const pending = await DOMAIN_WRITERS.medical_capture!.add(medIntent(raw), raw);
    await pending.resume!('Yes');
    const d = await classifyQuery('How often do I take Metformin?');
    check('F1 how-often reads persisted frequency',
      d.reason === 'medical:named_inquiry' && /twice a day/i.test(d.tier1Response ?? ''));
  }

  // G — corrections confirmation-gated; no fabricated frequency
  {
    freshDB();
    const first = 'I take Metformin 500 mg twice a day.';
    const p1 = await DOMAIN_WRITERS.medical_capture!.add(medIntent(first), first);
    await p1.resume!('Yes');
    const correction = 'I take Metformin 1000 mg.';
    const p2 = await DOMAIN_WRITERS.medical_capture!.add(medIntent(correction), correction);
    check('G1 correction is pending before YES',
      p2.status === 'pending'
      && getActiveMedications()[0]?.dosage?.includes('500')
      && getActiveMedications()[0]?.frequency === 'twice a day');
    check('G2 dosage-only correction prompt does not invent a new frequency',
      !/once daily|every morning|nightly/i.test(p2.prompt ?? ''));
    await p2.resume!('Yes');
    const row = getActiveMedications()[0];
    check('G3 after confirm, prior explicit frequency is kept (not fabricated, not wiped)',
      /1000/i.test(row?.dosage ?? '') && row?.frequency === 'twice a day');
  }
  {
    freshDB();
    const first = 'I take Eliquis 5 mg.';
    const p1 = await DOMAIN_WRITERS.medical_capture!.add(medIntent(first), first);
    await p1.resume!('Yes');
    const correction = 'I take Eliquis 10 mg.';
    const p2 = await DOMAIN_WRITERS.medical_capture!.add(medIntent(correction), correction);
    await p2.resume!('Yes');
    check('G4 dose-only lineage never invents frequency',
      !getActiveMedications()[0]?.frequency);
  }

  // Direct writer still does not scrape notes
  {
    freshDB();
    confirmMedicationCapture('Eliquis', '5 milligrams', 'I take Eliquis 5 milligrams twice a day.');
    check('W1 confirmMedicationCapture without frequency arg does not scrape notes',
      !getActiveMedications()[0]?.frequency);
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ medicationFrequency: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ medicationFrequency: ${passed}/${total} — all green${RESET}`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('medicationFrequency.test.ts')) {
  runMedicationFrequencyTests().catch(console.error);
}
