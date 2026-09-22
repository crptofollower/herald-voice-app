// Rung 5 Gap 3 — close capturePerson relationship dual-write.
// contacts.relationship remains authoritative. Historical facts stay put.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { capturePerson } from '../../src/db/capturePerson.ts';
import { findContactByRelationship } from '../../src/db/contactsDB.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { backfillContactsFromFacts } from '../../src/db/backfillContacts.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function count(db: Database.Database, table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''};`).get() as { n: number };
  return row.n;
}

async function freshDb() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function insertHistoricalRelationshipFact(db: Database.Database, id: string, fact: string) {
  db.prepare(
    `INSERT INTO facts (id, fact, category, confidence, source_date, use_count)
     VALUES (?, ?, 'relationships', 'stated', '2024-01-01', 1);`,
  ).run(id, fact);
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

export async function runRung5Gap3RelationshipDualWriteTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Gap 3 relationship dual-write --${RESET}\n`);

  const captureSrc = fs.readFileSync(path.join(root, 'src/db/capturePerson.ts'), 'utf8');
  const backfillSrc = fs.readFileSync(path.join(root, 'src/db/backfillContacts.ts'), 'utf8');
  const srcFiles = walkTs(path.join(root, 'src'));
  const insertHits = srcFiles.flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+entity_relationships/gi)]
      .map((m) => `${path.relative(root, file)}:${m[0]}`);
  });

  assert('capturePerson no longer shadow-writes relationship facts',
    /writeFact/.test(captureSrc), (v) => v === false, 'false');
  assert('historical facts→contacts backfill still reads relationship facts and does not delete them',
    /getFactsByCategory\(\s*'relationships'/.test(backfillSrc)
      && /Never touches the facts table/.test(backfillSrc)
      && !/DELETE\s+FROM\s+facts/i.test(backfillSrc),
    (v) => v === true, 'true');
  assert('zero entity_relationships INSERT writers in src/',
    insertHits, (v) => Array.isArray(v) && (v as string[]).length === 0, '[]');

  const db = await freshDb();
  insertHistoricalRelationshipFact(db, 'fact_hist_wife', 'wife: LegacyPat');

  const captured = capturePerson({ name: 'Shannon', relationship: 'wife', phone: '2145550100' });
  assert('person capture with a relationship still commits the contact',
    captured, (v) => (v as { ok: boolean }).ok === true, 'ok: true');

  const contact = db.prepare(
    `SELECT id, name, relationship, phone, entity_id FROM contacts WHERE removed_at IS NULL AND LOWER(name) = 'shannon' LIMIT 1;`,
  ).get() as { id: string; name: string; relationship: string; phone: string; entity_id: string } | undefined;
  assert('captured contact stores authoritative relationship and phone',
    contact, (v) => !!v && (v as { name: string }).name === 'Shannon'
      && (v as { relationship: string }).relationship === 'wife'
      && (v as { phone: string }).phone === '2145550100',
    'Shannon/wife/2145550100');

  assert('capture creates no new facts relationship row',
    count(db, 'facts', "category = 'relationships'"), (v) => v === 1, '1 historical row only');

  const familyAnswer = answerFamilyRead(detectFamilyRead("what's my wife's name")!);
  assert('familyRead still resolves the relationship from contacts',
    familyAnswer, (v) => typeof v === 'string' && (v as string).includes('Shannon'), 'includes Shannon');

  const byRel = findContactByRelationship('wife');
  assert('findContactByRelationship still resolves the captured contact',
    byRel?.name === 'Shannon' && byRel?.relationship === 'wife', (v) => v === true, 'true');

  const entity = contact
    ? db.prepare(`SELECT id, type FROM entities WHERE id = ?;`).get(contact.id) as { id: string; type: string } | undefined
    : undefined;
  assert('Step-2 person/entity identity still holds for capturePerson',
    !!contact && entity?.id === contact.id && entity?.type === 'person' && contact.entity_id === contact.id,
    (v) => v === true, 'true');

  assert('capturePerson creates no entity_relationships row',
    count(db, 'entity_relationships'), (v) => v === 0, '0');

  const historical = db.prepare(`SELECT id, fact, category FROM facts WHERE id = 'fact_hist_wife';`)
    .get() as { id: string; fact: string; category: string } | undefined;
  assert('existing historical relationship fact is not deleted or migrated',
    historical?.id === 'fact_hist_wife' && historical.fact === 'wife: LegacyPat' && historical.category === 'relationships',
    (v) => v === true, 'true');

  const backfill = backfillContactsFromFacts();
  const legacyContact = db.prepare(
    `SELECT name, relationship FROM contacts WHERE removed_at IS NULL AND LOWER(name) = 'legacypat' LIMIT 1;`,
  ).get() as { name: string; relationship: string } | undefined;
  const factAfterBackfill = db.prepare(`SELECT fact FROM facts WHERE id = 'fact_hist_wife';`)
    .get() as { fact: string } | undefined;
  assert('historical facts→contacts backfill still creates the contact and leaves the fact',
    !backfill.already && !!legacyContact && legacyContact.relationship === 'wife'
      && factAfterBackfill?.fact === 'wife: LegacyPat'
      && count(db, 'facts', "category = 'relationships'") === 1,
    (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Gap3RelationshipDualWrite: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Gap3RelationshipDualWrite.test.ts')) {
  runRung5Gap3RelationshipDualWriteTests().catch(console.error);
}
