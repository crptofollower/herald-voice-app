// Single-current family holder. Spouse-class capture retires the prior live
// holder in the same transaction. Plural relationships stay plural.

import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { capturePerson } from '../../src/db/capturePerson.ts';
import { findContactByRelationship, liveContactsByRelationships } from '../../src/db/contactsDB.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { exclusiveStatedRelationshipPeers } from '../../src/utils/personAssociationCapture.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function freshDb() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function seed(db: Database.Database, id: string, name: string, relationship: string) {
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, importance, created_at, updated_at)
     VALUES (?, ?, ?, 7, datetime('now'), datetime('now'));`,
  ).run(id, name, relationship);
}

function wifeNames(): string[] {
  const peers = exclusiveStatedRelationshipPeers('wife') ?? ['wife'];
  return liveContactsByRelationships(peers).map((row) => row.name);
}

export async function runFamilyCurrentHolderTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (value: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}❌ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}── Family current holder ─────────────────────────────────${RESET}\n`);

  {
    await freshDb();
    const wrote = capturePerson({ name: 'Pat', relationship: 'wife' });
    assert('A write accepted', wrote.ok, (v) => v === true, 'ok');
    assert('A Pat is the only current wife', wifeNames(), (v) => Array.isArray(v) && v.length === 1 && v[0] === 'Pat', 'Pat');
  }

  {
    await freshDb();
    capturePerson({ name: 'Pat', relationship: 'wife' });
    const wrote = capturePerson({ name: 'Avery', relationship: 'wife' });
    assert('B replacement accepted', wrote.ok, (v) => v === true, 'ok');
    assert('B Avery is the only current wife', wifeNames(), (v) => Array.isArray(v) && v.length === 1 && v[0] === 'Avery', 'Avery');
    const prior = findContactByRelationship('wife');
    assert('B greeting reader is Avery', prior?.name, (v) => v === 'Avery', 'Avery');
    const pat = getDB().getFirstSync<{ relationship: string | null }>(
      `SELECT relationship FROM contacts WHERE name = 'Pat' AND removed_at IS NULL LIMIT 1;`,
    );
    assert('B Pat is no longer the wife', pat?.relationship ?? null, (v) => v == null, 'null relationship');
  }

  {
    await freshDb();
    capturePerson({ name: 'Pat', relationship: 'wife' });
    const pending = await DOMAIN_WRITERS.family_capture!.add(
      { type: 'family_capture', relation: 'wife', name: 'Avery' } as never,
      'my wife is Avery',
    );
    assert('C confirm is pending before commit', pending.status, (v) => v === 'pending', 'pending');
    const committed = pending.status === 'pending' ? await pending.resume('yes') : pending;
    assert('C ACK is committed only after the write', committed.status, (v) => v === 'committed', 'committed');
    assert('C current wife is Avery when ACK commits', wifeNames(), (v) => Array.isArray(v) && v.join(',') === 'Avery', 'Avery');
  }

  {
    const db = await freshDb();
    capturePerson({ name: 'Pat', relationship: 'wife' });
    const shim = getDB() as { runSync: (sql: string, params?: unknown[]) => unknown };
    const orig = shim.runSync.bind(shim);
    shim.runSync = (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && /INSERT INTO contacts/i.test(sql)) throw new Error('insert failed');
      return orig(sql, params ?? []);
    };
    const wrote = capturePerson({ name: 'Avery', relationship: 'wife' });
    shim.runSync = orig;
    assert('D failed insert is not success', wrote.ok, (v) => v === false, 'not ok');
    assert('D Pat remains the only wife', wifeNames(), (v) => Array.isArray(v) && v.join(',') === 'Pat', 'Pat');
    const avery = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE name = 'Avery';`).get() as { n: number };
    assert('D Avery row was not left behind', avery.n, (v) => v === 0, '0');
    const pending = await DOMAIN_WRITERS.family_capture!.add(
      { type: 'family_capture', relation: 'wife', name: 'Quinn' } as never,
      'my wife is Quinn',
    );
    shim.runSync = (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && /INSERT INTO contacts/i.test(sql)) throw new Error('insert failed');
      return orig(sql, params ?? []);
    };
    const failed = pending.status === 'pending' ? await pending.resume('yes') : pending;
    shim.runSync = orig;
    assert('D family ACK is not success when insert fails', failed.status, (v) => v === 'failed', 'failed');
    assert('D Pat still current after failed ACK', wifeNames(), (v) => Array.isArray(v) && v.join(',') === 'Pat', 'Pat');
  }

  {
    await freshDb();
    capturePerson({ name: 'Blair', relationship: 'daughter' });
    capturePerson({ name: 'Casey', relationship: 'daughter' });
    const daughters = liveContactsByRelationships(['daughter']).map((row) => row.name).sort();
    assert('E both daughters stay current', daughters, (v) => Array.isArray(v) && v.join(',') === 'Blair,Casey', 'Blair,Casey');
  }

  {
    await freshDb();
    capturePerson({ name: 'Pat', relationship: 'wife' });
    capturePerson({ name: 'Avery', relationship: 'wife' });
    const greeting = findContactByRelationship('wife')?.name ?? null;
    const family = answerFamilyRead(detectFamilyRead('who is my wife')!);
    assert('F greeting reader is Avery', greeting, (v) => v === 'Avery', 'Avery');
    assert('F family read names Avery', family, (v) => typeof v === 'string' && v.includes('Avery') && !v.includes('Pat'), 'Avery only');
  }

  {
    const db = await freshDb();
    seed(db, 'c_pat', 'Pat', 'wife');
    seed(db, 'c_blair', 'Blair', 'wife');
    const wrote = capturePerson({ name: 'Quinn', relationship: 'wife' });
    assert('G correction accepted over two live wives', wrote.ok, (v) => v === true, 'ok');
    assert('G Quinn is the only current wife', wifeNames(), (v) => Array.isArray(v) && v.join(',') === 'Quinn', 'Quinn');
  }

  const total = passed + failures.length;
  return { passed, failed: failures.length, total, failures };
}
