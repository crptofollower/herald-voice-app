// scripts/heraldTest/contactsDB.test.ts
// findAllContactMatches contract tests (S-DISCLOSE build arc, C-1).
// Pins the multi-match resolver that feeds contact disambiguation.
//
// Runner: npx tsx scripts/heraldTest/contactsDB.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { findAllContactMatches, nameMatchesQuery } from '../../src/db/contactsDB.ts';
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
    `INSERT INTO contacts (id, name, relationship, phone, address, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.address ?? null,
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

  // ── T-NMQ-1: reversed word order still matches ──────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'clevenger david');
    assert('T-NMQ-1 reversed order matches',
      result,
      v => v === true,
      'true (S_CONTACT K2 fix)');
  }

  // ── T-NMQ-2: single token still matches ──────────────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'david');
    assert('T-NMQ-2 single token matches',
      result,
      v => v === true,
      'true');
  }

  // ── T-NMQ-3: substring-of-different-word does not false-positive ────────────
  {
    const result = nameMatchesQuery('David Clevenger', 'davidson');
    assert('T-NMQ-3 no false positive on partial word',
      result,
      v => v === false,
      'false');
  }

  // ── T-NMQ-4: null name never matches, never throws ───────────────────────────
  {
    const result = nameMatchesQuery(null, 'david');
    assert('T-NMQ-4 null name returns false',
      result,
      v => v === false,
      'false');
  }

  // ── T-NMQ-5: empty query never matches-all ───────────────────────────────────
  {
    const result = nameMatchesQuery('David Clevenger', '');
    assert('T-NMQ-5 empty query returns false',
      result,
      v => v === false,
      'false');
  }

  // ── SMS / nav Herald multi-match branch predicates (dispatch.ts mirrors) ──
  // dispatch cannot be imported here (RN). These pin the same pools the arms
  // branch on: sms → findAllContactMatches.filter(phone); nav → unfiltered.
  const smsHeraldPool = (q: string) =>
    findAllContactMatches(q).filter(c => !!c.phone?.trim());
  const navHeraldPool = (q: string) => findAllContactMatches(q);

  // ── T-SMS-H1: multi-Herald-match asks ─────────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_s1', name: 'Sarah Smith', phone: '5551112222', importance: 9 });
    insertContact(db, { id: 'c_s2', name: 'Sarah Jones', phone: '5553334444', importance: 5 });
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H1a two Sarahs both phoned → smsHeraldPool length > 1 (ask which one)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v.includes('c_s1') && v.includes('c_s2'),
      'length 2 both phoned',
    );
  }

  // ── T-SMS-H2: single Herald match executes ────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_only', name: 'Sarah Smith', phone: '5551112222', importance: 9 });
    insertContact(db, { id: 'c_other', name: 'Mike Jones', phone: '5559998888', importance: 5 });
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H2a one phoned Sarah → smsHeraldPool length === 1 (execute openURL)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_only',
      'length 1 c_only',
    );
  }

  // ── T-SMS-H3: zero phoned Herald matches → fall through ───────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_bare1', name: 'Sarah Smith', phone: null, importance: 9 });
    insertContact(db, { id: 'c_bare2', name: 'Sarah Jones', phone: null, importance: 5 });
    const nameHits = findAllContactMatches('Sarah');
    const pool = smsHeraldPool('Sarah');
    assert(
      'T-SMS-H3a two Sarahs phoneless → smsHeraldPool length 0 (fall through resolveContactPhone)',
      { nameHits: nameHits.length, phonePool: pool.length },
      v =>
        typeof v === 'object' && v !== null &&
        (v as { nameHits: number }).nameHits === 2 &&
        (v as { phonePool: number }).phonePool === 0,
      'name hits 2, phone pool 0',
    );
  }

  // ── T-NAV-H1: plain name collision (both addressed) → ask ─────────────────
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_s1', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    insertContact(db, {
      id: 'c_s2', name: 'Sarah Jones', phone: '5553334444',
      address: '456 Pine Ave', importance: 5,
    });
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H1a two Sarahs both addressed → navHeraldPool length > 1 (ask which one)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 2 && v.includes('c_s1') && v.includes('c_s2'),
      'length 2 plain collision',
    );
  }

  // ── T-FACM-8: address completeness must NOT stand in for confirmation ─────
  // Second nav multi-ask instance: only ONE has an address. Pool stays length 2.
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_sarah_addr', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    insertContact(db, {
      id: 'c_sarah_bare', name: 'Sarah Jones', phone: '5553334444',
      address: null, importance: 5,
    });
    const matches = navHeraldPool('Sarah');
    const addressedOnly = matches.filter(c => !!c.address?.trim());
    assert(
      'T-FACM-8a two Sarahs (one addressed) → unfiltered pool length 2 (nav must ask)',
      {
        pool: matches.map(c => c.id),
        addressedTrap: addressedOnly.map(c => c.id),
      },
      v =>
        typeof v === 'object' && v !== null &&
        Array.isArray((v as { pool: string[] }).pool) &&
        (v as { pool: string[] }).pool.length === 2 &&
        (v as { pool: string[] }).pool.includes('c_sarah_addr') &&
        (v as { pool: string[] }).pool.includes('c_sarah_bare') &&
        (v as { addressedTrap: string[] }).addressedTrap.length === 1 &&
        (v as { addressedTrap: string[] }).addressedTrap[0] === 'c_sarah_addr',
      'pool both Sarahs; addressed-only trap is Sarah Smith alone',
    );
  }

  // ── T-NAV-H2: single Herald match executes ────────────────────────────────
  {
    const db = freshDB();
    insertContact(db, {
      id: 'c_only', name: 'Sarah Smith', phone: '5551112222',
      address: '123 Oak St', importance: 9,
    });
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H2a one Sarah → navHeraldPool length === 1 (execute openOrCollectAddress)',
      pool.map(c => c.id),
      v => Array.isArray(v) && v.length === 1 && v[0] === 'c_only',
      'length 1 c_only',
    );
  }

  // ── T-NAV-H3: zero Herald matches → fall through ──────────────────────────
  {
    freshDB();
    const pool = navHeraldPool('Sarah');
    assert(
      'T-NAV-H3a no Sarah rows → navHeraldPool length 0 (fall through relationship/name/raw)',
      pool.length,
      v => v === 0,
      'length 0',
    );
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ContactsDB: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('contactsDB.test.ts')) {
  runContactsDBTests().catch(console.error);
}
