// scripts/heraldTest/g1HarvestAuthority.test.ts
// G1 — backend harvest and local extraction must not persist personal memory
// without the confirm-gated DOMAIN_WRITERS / applyIntents boundary.
//
// Production correction is caller-side in ChatScreen.tsx. These tests pin:
//   1) ChatScreen no longer calls the unauthorized writers
//   2) the G1 production path (drop candidates) leaves SQLite empty
//   3) writeFacts itself is unchanged (caller-side only)
//   4) leftover medical routing still selects medication/visit writers
//
// Runner: npx tsx --tsconfig ./tsconfig.json ./g1HarvestAuthority.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeFacts, _registerContactExtractor, isMedicalCaptureIntent, medicalCategoryFromText } from '../../src/db/factDB.ts';
import { extractContactFromFact, findContactByName } from '../../src/db/contactsDB.ts';
import { getMedicalRecords, getActiveMedications } from '../../src/db/medicalDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, removed_at TEXT, created_at TEXT
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
  _registerContactExtractor(extractContactFromFact);
  return db;
}

// Production G1 onFacts: drop candidates. Must stay identical to ChatScreen.
function productionOnFacts(_facts: Array<{ category: string; value: string }>): void {
  return;
}

let passed = 0;
const failures: Array<{ label: string; expected: string; got: string }> = [];

function assert(label: string, got: unknown, pred: (v: unknown) => boolean, expected: unknown) {
  if (pred(got)) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
  } else {
    failures.push({ label, expected: String(expected), got: String(got) });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}expected ${expected} got ${got}${RESET}`);
  }
}

export async function runG1HarvestAuthorityTests() {
  passed = 0;
  failures.length = 0;
  console.log(`\n${BOLD}G1 Harvest Authority${RESET}`);

  const chatPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/screens/ChatScreen.tsx',
  );
  const chatSrc = fs.readFileSync(chatPath, 'utf8');

  assert(
    'G1-1 ChatScreen production has no writeFacts( call',
    chatSrc.includes('writeFacts('),
    (v) => v === false,
    false,
  );
  assert(
    'G1-2 ChatScreen production has no extractFactsLocally( call',
    chatSrc.includes('extractFactsLocally('),
    (v) => v === false,
    false,
  );
  assert(
    'G1-3 ChatScreen production has no writeMedicalFact( call',
    chatSrc.includes('writeMedicalFact('),
    (v) => v === false,
    false,
  );
  assert(
    'G1-4 ChatScreen still receives onFacts (drop, not unplug the stream)',
    /onFacts:\s*\(/.test(chatSrc),
    (v) => v === true,
    true,
  );

  {
    const db = freshDB();
    productionOnFacts([{ category: 'general', value: 'likes fishing' }]);
    const n = db.prepare('SELECT count(*) as n FROM facts').get() as { n: number };
    assert('G1-5 backend general fact → no facts row', n.n, (v) => v === 0, 0);
  }

  {
    const db = freshDB();
    productionOnFacts([{ category: 'relationships', value: 'Shannon is my wife' }]);
    const facts = db.prepare('SELECT count(*) as n FROM facts').get() as { n: number };
    const contacts = db.prepare('SELECT count(*) as n FROM contacts').get() as { n: number };
    assert('G1-6a backend relationship fact → no facts row', facts.n, (v) => v === 0, 0);
    assert('G1-6b backend relationship fact → no contacts row', contacts.n, (v) => v === 0, 0);
    assert('G1-6c extractor registered but unused', findContactByName('Shannon'), (v) => v == null, 'null');
  }

  {
    freshDB();
    productionOnFacts([{ category: 'diagnosis', value: 'diagnosed with asthma' }]);
    assert(
      'G1-7 non-medication medical backend fact → no medical_records row',
      getMedicalRecords().length,
      (v) => v === 0,
      0,
    );
  }

  {
    freshDB();
    productionOnFacts([{ category: 'medication', value: 'Eliquis 5mg' }]);
    productionOnFacts([{ category: 'medications', value: 'Eliquis' }]);
    assert('G1-8a medication backend harvest → no medications row', getActiveMedications().length, (v) => v === 0, 0);
    assert('G1-8b medication backend harvest → no medical_records row', getMedicalRecords().length, (v) => v === 0, 0);
  }

  {
    const db = freshDB();
    // Production fallthrough no longer calls extractFactsLocally.
    const n = db.prepare('SELECT count(*) as n FROM facts').get() as { n: number };
    assert(
      'G1-9 eligible local general-fact pattern is not persisted by production fallthrough',
      n.n,
      (v) => v === 0,
      0,
    );
  }

  {
    freshDB();
    assert(
      'G1-10 local medical pattern isMedicalCaptureIntent / leftover is not auto-written',
      getMedicalRecords().length,
      (v) => v === 0,
      0,
    );
  }

  {
    freshDB();
    const text = 'I was diagnosed with asthma last year';
    assert(
      'G1-11a generic leftover classifies as medical not medication/visit',
      isMedicalCaptureIntent(text) && medicalCategoryFromText(text) === 'medical',
      (v) => v === true,
      true,
    );
    assert(
      'G1-11b generic leftover does not persist medical_records',
      getMedicalRecords().length,
      (v) => v === 0,
      0,
    );
  }

  assert(
    'G1-12 leftover "I am on Eliquis" still selects medication writer',
    isMedicalCaptureIntent('I am on Eliquis') && medicalCategoryFromText('I am on Eliquis') === 'medication',
    (v) => v === true,
    true,
  );
  assert(
    'G1-13 leftover "I saw the doctor" still selects visit writer',
    isMedicalCaptureIntent('I saw the doctor') && medicalCategoryFromText('I saw the doctor') === 'visit',
    (v) => v === true,
    true,
  );

  {
    const db = freshDB();
    writeFacts([{ category: 'general', value: 'likes fishing' }]);
    const n = db.prepare('SELECT count(*) as n FROM facts').get() as { n: number };
    assert(
      'G1-14 writeFacts still persists if called (caller-side correction only)',
      n.n,
      (v) => v === 1,
      1,
    );
  }

  {
    freshDB();
    writeFacts([{ category: 'relationships', value: 'Shannon is my wife' }]);
    const row = findContactByName('Shannon');
    assert(
      'G1-15 writeFacts relationship side effect still extracts a contact if writeFacts is called',
      row && row.name === 'Shannon',
      (v) => v === true,
      true,
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}G1 Harvest Authority: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('g1HarvestAuthority.test.ts')) {
  runG1HarvestAuthorityTests().catch(console.error);
}
