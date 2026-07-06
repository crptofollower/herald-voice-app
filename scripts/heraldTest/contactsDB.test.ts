// scripts/heraldTest/contactsDB.test.ts
// findAllContactMatches contract tests (S-DISCLOSE build arc, C-1).
// Pins the multi-match resolver that feeds contact disambiguation.
//
// Runner: npx tsx scripts/heraldTest/contactsDB.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { findAllContactMatches } from '../../src/db/contactsDB.ts';
import type { Contact } from '../../src/db/contactsDB.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    relationship TEXT,
    phone TEXT,
    address TEXT,
    email TEXT,
    birthday TEXT,
    importance INTEGER DEFAULT 5,
    entity_id TEXT,
    os_contact_id TEXT,
    notes TEXT,
    last_contact TEXT,
    is_emergency INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT
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

function insertContact(
  db: Database.Database,
  row: Pick<Contact, 'id' | 'name'> & Partial<Contact> & { removed_at?: string | null },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.importance ?? 5,
    row.created_at ?? now,
    row.updated_at ?? now,
    row.removed_at ?? null,
  );
}

export async function runContactsDBTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- findAllContactMatches Contract Tests ------------------${RESET}\n`);

  // ── T-FACM-1: no live rows → [] ───────────────────────────────────────────
  {
    freshDB();
    assert('T-FACM-1 empty contacts table → []',
      findAllContactMatches('daughter'),
      v => Array.isArray(v) && v.length === 0,
      '[]');
  }

  // ── T-FACM-2: single relationship match ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c1', name: 'Emily', relationship: 'daughter', phone: '555-0101', importance: 8 });
    const matches = findAllContactMatches('daughter');
    assert('T-FACM-2 relationship match returns the one live contact',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c1' && v[0].name === 'Emily',
      'one match, id c1');
  }

  // ── T-FACM-3: multiple relationship matches, importance DESC ────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', importance: 3 });
    insertContact(db, { id: 'c_high', name: 'Beth', relationship: 'daughter', importance: 9 });
    const matches = findAllContactMatches('daughter');
    assert('T-FACM-3 two daughters → both returned, higher importance first',
      matches.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v[0] === 'c_high' && v[1] === 'c_low',
      '["c_high","c_low"]');
  }

  // ── T-FACM-4: name partial match (LIKE) ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_sarah', name: 'Sarah Miller', relationship: 'friend' });
    insertContact(db, { id: 'c_other', name: 'Mike', relationship: 'neighbor' });
    const matches = findAllContactMatches('sarah');
    assert('T-FACM-4 name partial match returns Sarah only',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_sarah',
      'one match Sarah Miller');
  }

  // ── T-FACM-5: removed contacts excluded ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_live', name: 'Emily', relationship: 'daughter' });
    insertContact(db, { id: 'c_gone', name: 'Kate', relationship: 'daughter', removed_at: new Date().toISOString() });
    assert('T-FACM-5 removed_at row excluded from matches',
      findAllContactMatches('daughter').map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_live',
      'only c_live');
  }

  // ── T-FACM-6: dual-predicate dedup by id ────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_dedup', name: 'My Daughter', relationship: 'daughter' });
    assert('T-FACM-6 relationship + name both match → one row, not duplicated',
      findAllContactMatches('daughter'),
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_dedup',
      'length 1, id c_dedup');
  }

  // ── T-FACM-7: trim + case-insensitive input ─────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_doc', name: 'Dr. Smith', relationship: 'doctor' });
    const matches = findAllContactMatches('  DOCTOR  ');
    assert('T-FACM-7 trimmed/case input matches relationship exactly',
      matches,
      v => Array.isArray(v) && v.length === 1 && v[0].id === 'c_doc',
      'one match Dr. Smith');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ContactsDB: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('contactsDB.test.ts')) {
  runContactsDBTests().catch(console.error);
}
