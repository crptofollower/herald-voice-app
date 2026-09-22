// Rung 5 Step 2 — contact↔entity person identity and Me node.
// contacts remains authoritative. No relationship edges. people stays dormant.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeContactRaw, writeContactValidated } from '../../src/db/contactsDB.ts';
import {
  ME_ENTITY_ID,
  ensureRung5PersonEntityIdentity,
} from '../../src/db/personEntityIdentity.ts';
import { setProfileField } from '../../src/db/profileDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number };
  return row.n;
}

async function freshDb() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function insertLiveContact(db: Database.Database, id: string, name: string, relationship: string, phone: string) {
  const now = '2026-09-21T00:00:00.000Z';
  db.prepare(
    `INSERT INTO contacts
       (id, name, relationship, phone, address, email, birthday, importance,
        entity_id, os_contact_id, notes, is_emergency, last_contact, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, 7, NULL, NULL, NULL, 0, NULL, ?, ?);`,
  ).run(id, name, relationship, phone, now, now);
}

export async function runRung5Step2PersonEntityIdentityTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Step 2 person/entity identity --${RESET}\n`);

  const db = await freshDb();
  insertLiveContact(db, 'c_live_shannon', 'Shannon', 'wife', '2145550100');
  insertLiveContact(db, 'c_live_josh', 'Josh', 'son', '9725550199');
  const now = '2026-09-21T00:00:00.000Z';
  db.prepare(
    `INSERT INTO contacts
       (id, name, relationship, phone, address, email, birthday, importance,
        entity_id, os_contact_id, notes, is_emergency, last_contact, created_at, updated_at, removed_at)
     VALUES ('c_removed_pat', 'Pat', 'friend', NULL, NULL, NULL, NULL, 5,
             NULL, NULL, NULL, 0, NULL, ?, ?, ?);`,
  ).run(now, now, now);

  const beforeEntities = count(db, 'entities');
  const beforePeople = count(db, 'people');
  const beforeEdges = count(db, 'entity_relationships');
  const beforeFacts = count(db, 'facts');
  const beforeMedical = count(db, 'medical_records');
  const beforeAppts = count(db, 'appointments');
  const beforeEpisodes = count(db, 'episodes');

  ensureRung5PersonEntityIdentity();
  ensureRung5PersonEntityIdentity();

  const personEntities = db.prepare(
    `SELECT id, name, type, notes FROM entities WHERE type = 'person' ORDER BY id;`,
  ).all() as { id: string; name: string; type: string; notes: string | null }[];

  const liveIds = ['c_live_shannon', 'c_live_josh'];
  const liveEntities = personEntities.filter((e) => liveIds.includes(e.id));
  assert('existing live contacts backfill to exactly one entity each',
    liveEntities.length, (v) => v === 2, '2');

  const shannon = db.prepare(`SELECT id, entity_id, relationship, phone, name FROM contacts WHERE id = 'c_live_shannon';`)
    .get() as { id: string; entity_id: string; relationship: string; phone: string; name: string };
  const shannonEntity = db.prepare(`SELECT id, name, type, notes FROM entities WHERE id = 'c_live_shannon';`)
    .get() as { id: string; name: string; type: string; notes: string | null };
  assert('shared-id invariant: entities.id == contacts.id',
    shannonEntity?.id === shannon.id && shannon.entity_id === shannon.id, (v) => v === true, 'true');

  assert('rerun/idempotence creates no duplicate person entity',
    liveEntities.filter((e) => e.id === 'c_live_shannon').length, (v) => v === 1, '1');

  const removedEntity = db.prepare(`SELECT id FROM entities WHERE id = 'c_removed_pat';`).get();
  assert('removed contacts are not backfilled',
    removedEntity, (v) => v == null, 'null');

  assert('contact truth remains authoritative (relationship and phone stay on the contact)',
    shannon.relationship === 'wife' && shannon.phone === '2145550100' && shannon.name === 'Shannon',
    (v) => v === true, 'true');
  assert('person entity does not copy contact relationship into notes',
    shannonEntity.notes, (v) => v == null, 'null');
  assert('backfilled entity type is person',
    shannonEntity.type, (v) => v === 'person', 'person');

  const validated = writeContactValidated({ name: 'Avery', relationship: 'sister', phone: '555-0100', importance: 8 });
  assert('new writeContactValidated creates the corresponding person entity',
    validated.ok && validated.ok === true
      ? db.prepare(`SELECT id, type FROM entities WHERE id = ?;`).get(validated.contactId) as { id: string; type: string } | undefined
      : null,
    (v) => !!v && (v as { id: string; type: string }).id === (validated.ok ? validated.contactId : '') && (v as { type: string }).type === 'person',
    'matching person entity');

  const rawId = writeContactRaw({ name: 'Grant', relationship: 'son', importance: 7 });
  const rawEntity = db.prepare(`SELECT id FROM entities WHERE id = ?;`).get(rawId) as { id: string } | undefined;
  assert('new writeContactRaw creates the corresponding person entity',
    rawEntity?.id === rawId && !!rawId, (v) => v === true, 'true');

  const contactAfterWrite = db.prepare(`SELECT relationship, phone FROM contacts WHERE id = ?;`)
    .get((validated as { contactId: string }).contactId) as { relationship: string; phone: string };
  assert('new contact write leaves contact row as the person store',
    contactAfterWrite?.relationship === 'sister' && contactAfterWrite?.phone === '555-0100',
    (v) => v === true, 'true');

  insertLiveContact(db, 'c_sql_hunter', 'Hunter', 'son', '2145550111');
  const hunterUpdate = writeContactValidated({ name: 'Hunter', relationship: 'son', phone: '2145550111', importance: 7 });
  const hunterEntity = db.prepare(`SELECT id FROM entities WHERE id = 'c_sql_hunter';`).get() as { id: string } | undefined;
  assert('update path on an existing live contact still ensures the shared-id person entity',
    hunterUpdate.ok && hunterEntity?.id === 'c_sql_hunter', (v) => v === true, 'true');

  setProfileField('name', 'Mike');
  ensureRung5PersonEntityIdentity();
  const me1 = db.prepare(`SELECT id, type, name FROM entities WHERE id = ?;`).get(ME_ENTITY_ID) as
    { id: string; type: string; name: string } | undefined;
  ensureRung5PersonEntityIdentity();
  const meCount = db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE id = ?;`).get(ME_ENTITY_ID) as { n: number };
  const meContact = db.prepare(`SELECT id FROM contacts WHERE id = ?;`).get(ME_ENTITY_ID);

  assert('Me node exists deterministically as a person entity',
    me1?.id === ME_ENTITY_ID && me1?.type === 'person', (v) => v === true, 'true');
  assert('Me ensure is idempotent',
    meCount.n, (v) => v === 1, '1');
  assert('Me is not written as a contacts row',
    meContact, (v) => v == null, 'null');

  assert('no relationship edges are written',
    count(db, 'entity_relationships'), (v) => v === beforeEdges, String(beforeEdges));
  assert('people remains unwritten',
    count(db, 'people'), (v) => v === beforePeople, String(beforePeople));
  assert('unrelated domain stores are not modified',
    {
      facts: count(db, 'facts') - beforeFacts,
      medical_records: count(db, 'medical_records') - beforeMedical,
      appointments: count(db, 'appointments') - beforeAppts,
      episodes: count(db, 'episodes') - beforeEpisodes,
      entitiesDeltaVsBackfill: count(db, 'entities') - beforeEntities,
    },
    (v) => {
      const d = v as {
        facts: number; medical_records: number; appointments: number; episodes: number;
      };
      return d.facts === 0 && d.medical_records === 0 && d.appointments === 0 && d.episodes === 0;
    },
    'facts/medical_records/appointments/episodes delta 0');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Step2PersonEntityIdentity: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Step2PersonEntityIdentity.test.ts')) {
  runRung5Step2PersonEntityIdentityTests().catch(console.error);
}
