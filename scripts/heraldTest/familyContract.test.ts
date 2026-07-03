// scripts/heraldTest/familyContract.test.ts
// Family read contract — detectFamilyRead + answerFamilyRead against contacts.
//
// NOTE: The contacts DDL below is a hand-maintained replica of production
// schema.ts (through v17). If production adds a contacts column, this must be
// updated — otherwise tests pass while production drifts.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT
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

function addContact(db, name, relationship, location = null, importance = 5) {
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, location, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'));`,
  ).run('c_' + Math.random().toString(36).slice(2), name, relationship, location, importance);
}

export async function runFamilyContractTests() {
  const failures = [];
  let passed = 0;
  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}? PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}? FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Family Contract Tests ---------------------------------${RESET}\n`);

  // F1 typed single: seed Shannon/wife → includes Shannon
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    const answer = answerFamilyRead(detectFamilyRead('who is my wife')!);
    assert('F1 typed single includes Shannon', answer, (v) => v.includes('Shannon'), 'includes "Shannon"');
  }

  // F2 typed multiple (no LIMIT 1): Hunter + Grant both sons
  {
    const db = freshDB();
    addContact(db, 'Hunter', 'son');
    addContact(db, 'Grant', 'son');
    const intent = detectFamilyRead('who are my sons');
    assert('F2a detectFamilyRead fires for sons', intent, (v) => v !== null, 'non-null intent');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F2b includes Hunter and Grant', answer, (v) => v.includes('Hunter') && v.includes('Grant'), 'includes both names');
  }

  // F3 NULL-location safe: NYC on Hunter, null on Grant — no literal "null"
  {
    const db = freshDB();
    addContact(db, 'Hunter', 'son', 'New York City');
    addContact(db, 'Grant', 'son', null);
    const intent = detectFamilyRead('who are my sons');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F3a includes New York City', answer, (v) => v.includes('New York City'), 'includes "New York City"');
    assert('F3b includes Grant', answer, (v) => v.includes('Grant'), 'includes "Grant"');
    assert('F3c no literal null', answer, (v) => !v.toLowerCase().includes('null'), 'no "null"');
  }

  // F4 de-dupe by person: Shannon/wife twice → Shannon once
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    addContact(db, 'Shannon', 'wife');
    const answer = answerFamilyRead(detectFamilyRead('who is my wife')!);
    const count = (answer.match(/Shannon/g) || []).length;
    assert('F4 Shannon appears exactly once', count, (v) => v === 1, 'count === 1');
  }

  // F5 honest miss: empty DB
  {
    freshDB();
    const intent = detectFamilyRead('who is my wife');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F5a gap message', answer, (v) => v.startsWith("I don't have"), "starts with I don't have");
    assert('F5b no fabricated name', answer, (v) => !v.includes('Shannon'), 'no "Shannon"');
  }

  // F6 D2 statement guard: declarative capture phrase → null
  {
    freshDB();
    assert('F6 statement guard returns null', detectFamilyRead('my son Grant lives in Dallas'), (v) => v === null, 'null');
  }

  // F7 typeless overview: Shannon/wife + Hunter/son
  {
    const db = freshDB();
    addContact(db, 'Shannon', 'wife');
    addContact(db, 'Hunter', 'son');
    const intent = detectFamilyRead('tell me about my family');
    assert('F7a overview relation null', intent, (v) => v !== null && v.relation === null, 'relation === null');
    const answer = intent ? answerFamilyRead(intent) : '';
    assert('F7b includes Shannon and Hunter', answer, (v) => v.includes('Shannon') && v.includes('Hunter'), 'includes both names');
  }

  // F8 synonym: Barbara/mom → who is my mother
  {
    const db = freshDB();
    addContact(db, 'Barbara', 'mom');
    const answer = answerFamilyRead(detectFamilyRead('who is my mother')!);
    assert('F8 synonym mother includes Barbara', answer, (v) => v.includes('Barbara'), 'includes "Barbara"');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('familyContract.test.mjs')) {
  runFamilyContractTests().catch(console.error);
}
