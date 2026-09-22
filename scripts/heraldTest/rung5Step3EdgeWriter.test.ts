// Rung 5 Step 3 — sole entity_relationships writer contracts.
// Writer is called with already-resolved entity ids. No capture/parser/routing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeContactValidated } from '../../src/db/contactsDB.ts';
import { capturePerson } from '../../src/db/capturePerson.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { ensureMeEntity, ME_ENTITY_ID } from '../../src/db/personEntityIdentity.ts';
import {
  CANONICAL_RELATIONS,
  EDGE_SOURCE_USER_UTTERANCE,
  getActiveEdges,
  softRemoveRelationshipEdge,
  supersedeRelationshipEdge,
  writeRelationshipEdge,
} from '../../src/db/entityRelationshipsWriter.ts';

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

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function seedPerson(name: string, relationship?: string) {
  const result = writeContactValidated({ name, relationship, importance: 7 });
  if (!result.ok) throw new Error(`seed failed for ${name}`);
  return result.contactId;
}

export async function runRung5Step3EdgeWriterTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Step 3 edge writer --${RESET}\n`);

  const writerRel = path.join('src', 'db', 'entityRelationshipsWriter.ts').replace(/\\/g, '/');
  const mutationHits = walkTs(path.join(root, 'src')).flatMap((file) => {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel === writerRel) return [];
    const text = fs.readFileSync(file, 'utf8');
    return [...text.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?|UPDATE)\b[\s\S]{0,80}entity_relationships/gi)]
      .map((m) => `${rel}:${m[0].replace(/\s+/g, ' ').slice(0, 60)}`);
  });
  const writerSrc = fs.readFileSync(path.join(root, 'src/db/entityRelationshipsWriter.ts'), 'utf8');
  const captureSrc = fs.readFileSync(path.join(root, 'src/db/capturePerson.ts'), 'utf8');

  assert('sole writer authority: no INSERT/UPDATE on entity_relationships outside entityRelationshipsWriter.ts',
    mutationHits, (v) => Array.isArray(v) && (v as string[]).length === 0, '[]');
  assert('writer never calls mergeEntities',
    /mergeEntities/.test(writerSrc), (v) => v === false, 'false');
  assert('Gap 3 stays closed: capturePerson still has no writeFact',
    /writeFact/.test(captureSrc), (v) => v === false, 'false');
  assert('closed symmetric set is exactly sibling_of and spouse_of',
    Object.entries(CANONICAL_RELATIONS).filter(([, m]) => m.symmetric).map(([k]) => k).sort(),
    (v) => JSON.stringify(v) === JSON.stringify(['sibling_of', 'spouse_of']),
    '["sibling_of","spouse_of"]');

  const db = await freshDb();
  const david = seedPerson('David');
  const karen = seedPerson('Karen');
  const tyler = seedPerson('Tyler');

  const parent = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: karen,
    relation: 'parent_of',
    statedAs: 'daughter',
    rawPhrase: "Karen is David's daughter",
  });
  const parentRow = parent.ok
    ? db.prepare(`SELECT relation, stated_as, raw_phrase, source, created_at FROM entity_relationships WHERE id = ?;`)
      .get(parent.edgeId) as { relation: string; stated_as: string; raw_phrase: string; source: string; created_at: string }
    : null;
  assert('canonical parent_of stores verbatim in relation',
    parent.ok && parentRow?.relation === 'parent_of', (v) => v === true, 'true');
  assert('stated_as preserves the user word, not the canonical relation',
    parentRow?.stated_as === 'daughter', (v) => v === true, 'true');
  assert('raw_phrase and source=user_utterance and UTC-Z created_at are persisted',
    parentRow?.raw_phrase === "Karen is David's daughter"
      && parentRow?.source === EDGE_SOURCE_USER_UTTERANCE
      && /Z$/.test(parentRow?.created_at ?? ''),
    (v) => v === true, 'true');

  const floored = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: tyler,
    relation: "stepson's boy",
    statedAs: "stepson's boy",
    rawPhrase: "Tyler is David's late brother's stepson's boy",
  });
  const floorRow = floored.ok
    ? db.prepare(`SELECT relation, stated_as FROM entity_relationships WHERE id = ?;`).get(floored.edgeId) as
      { relation: string; stated_as: string }
    : null;
  assert('non-canonical relation floors to related_to and keeps stated_as',
    floored.ok && floorRow?.relation === 'related_to' && floorRow?.stated_as === "stepson's boy",
    (v) => v === true, 'true');

  const entityCount = count(db, 'entities');
  const missingFrom = writeRelationshipEdge({
    fromEntityId: 'missing_from',
    toEntityId: karen,
    relation: 'parent_of',
    statedAs: 'daughter',
    rawPhrase: 'ghost parent',
  });
  const missingTo = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: 'missing_to',
    relation: 'parent_of',
    statedAs: 'daughter',
    rawPhrase: 'ghost child',
  });
  assert('missing from_entity fails closed with unresolved_endpoint',
    missingFrom, (v) => (v as { ok: false; reason: string }).ok === false
      && (v as { reason: string }).reason === 'unresolved_endpoint', 'unresolved_endpoint');
  assert('missing to_entity fails closed with unresolved_endpoint',
    missingTo, (v) => (v as { ok: false; reason: string }).ok === false
      && (v as { reason: string }).reason === 'unresolved_endpoint', 'unresolved_endpoint');
  assert('unresolved endpoint does not create an entity or dangling edge',
    count(db, 'entities') === entityCount && count(db, 'entity_relationships', "from_entity = 'missing_from' OR to_entity = 'missing_to'") === 0,
    (v) => v === true, 'true');

  const again = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: karen,
    relation: 'parent_of',
    statedAs: 'daughter',
    rawPhrase: "Karen is David's daughter",
  });
  assert('rewriting the same active edge is idempotent',
    again.ok && again.action === 'unchanged' && again.edgeId === (parent.ok ? parent.edgeId : '')
      && getActiveEdges(david, karen).filter((e) => e.relation === 'parent_of').length === 1,
    (v) => v === true, 'true');

  const reverseParent = writeRelationshipEdge({
    fromEntityId: karen,
    toEntityId: david,
    relation: 'parent_of',
    statedAs: 'father',
    rawPhrase: "David is Karen's father",
  });
  assert('directional parent_of does not collapse endpoint order',
    reverseParent.ok && reverseParent.action === 'inserted'
      && getActiveEdges().filter((e) => e.relation === 'parent_of').length === 2,
    (v) => v === true, 'true');

  const sibA = writeRelationshipEdge({
    fromEntityId: karen,
    toEntityId: tyler,
    relation: 'sibling_of',
    statedAs: 'brother',
    rawPhrase: 'Tyler is Karen\'s brother',
  });
  const sibB = writeRelationshipEdge({
    fromEntityId: tyler,
    toEntityId: karen,
    relation: 'sibling_of',
    statedAs: 'sister',
    rawPhrase: 'Karen is Tyler\'s sister',
  });
  const sibRows = getActiveEdges().filter((e) => e.relation === 'sibling_of');
  const [lo, hi] = karen < tyler ? [karen, tyler] : [tyler, karen];
  assert('sibling_of stores one canonical row regardless of endpoint order',
    sibA.ok && sibB.ok && sibB.action === 'unchanged' && sibRows.length === 1
      && sibRows[0].from_entity === lo && sibRows[0].to_entity === hi,
    (v) => v === true, 'true');

  const noStated = writeRelationshipEdge({
    fromEntityId: david, toEntityId: karen, relation: 'related_to', statedAs: '  ', rawPhrase: 'said something',
  });
  const noRaw = writeRelationshipEdge({
    fromEntityId: david, toEntityId: karen, relation: 'related_to', statedAs: 'kin', rawPhrase: '',
  });
  assert('missing stated_as or raw_phrase is rejected',
    !noStated.ok && noStated.reason === 'missing_provenance' && !noRaw.ok && noRaw.reason === 'missing_provenance',
    (v) => v === true, 'true');

  const calendar = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: karen,
    relation: 'related_to',
    statedAs: 'saw',
    rawPhrase: 'calendar event',
    source: 'calendar',
  });
  assert('non-utterance source is rejected; no evidence/calendar→edge path',
    !calendar.ok && calendar.reason === 'invalid_source'
      && getActiveEdges().every((e) => e.source === EDGE_SOURCE_USER_UTTERANCE),
    (v) => v === true, 'true');

  const spouse = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: seedPerson('Pat'),
    relation: 'spouse_of',
    statedAs: 'husband',
    rawPhrase: 'Pat is David\'s husband',
  });
  const patId = spouse.ok
    ? (db.prepare(`SELECT from_entity, to_entity FROM entity_relationships WHERE id = ?;`).get(spouse.edgeId) as { from_entity: string; to_entity: string })
    : null;
  const otherSpouse = patId && patId.from_entity === david ? patId.to_entity : patId?.from_entity;
  const superseded = spouse.ok
    ? supersedeRelationshipEdge(spouse.edgeId, {
        fromEntityId: david,
        toEntityId: otherSpouse!,
        relation: 'ex_spouse_of',
        statedAs: 'ex-husband',
        rawPhrase: 'Pat is David\'s ex-husband',
      })
    : { ok: false as const, reason: 'not_found' as const };
  const oldSpouse = spouse.ok
    ? db.prepare(`SELECT relation, ended_at, removed_at FROM entity_relationships WHERE id = ?;`).get(spouse.edgeId) as
      { relation: string; ended_at: string | null; removed_at: string | null }
    : null;
  assert('supersession stamps ended_at, inserts a new row, and preserves the old relation',
    superseded.ok && oldSpouse?.relation === 'spouse_of' && !!oldSpouse.ended_at && oldSpouse.removed_at == null
      && getActiveEdges().some((e) => e.relation === 'ex_spouse_of'),
    (v) => v === true, 'true');

  const parentId = parent.ok ? parent.edgeId : '';
  const beforeNonSup = count(db, 'entity_relationships');
  const blockParent = supersedeRelationshipEdge(parentId, {
    fromEntityId: david, toEntityId: tyler, relation: 'parent_of', statedAs: 'son', rawPhrase: 'now son',
  });
  const blockSib = sibA.ok
    ? supersedeRelationshipEdge(sibA.edgeId, {
        fromEntityId: karen, toEntityId: tyler, relation: 'related_to', statedAs: 'kin', rawPhrase: 'no longer siblings',
      })
    : { ok: false as const, reason: 'not_found' as const };
  assert('non-supersedable parent_of/sibling_of reject with no mutation',
    !blockParent.ok && blockParent.reason === 'non_supersedable'
      && !blockSib.ok && blockSib.reason === 'non_supersedable'
      && count(db, 'entity_relationships') === beforeNonSup,
    (v) => v === true, 'true');

  const school = 'school_ou';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO entities (id, name, type, notes, created_at, updated_at) VALUES (?, 'OU', 'place', NULL, ?, ?);`,
  ).run(school, now, now);
  const loc = writeRelationshipEdge({
    fromEntityId: david, toEntityId: school, relation: 'located_at', statedAs: 'at', rawPhrase: 'David was at OU',
  });
  const gp = writeRelationshipEdge({
    fromEntityId: david, toEntityId: tyler, relation: 'grandparent_of', statedAs: 'grandson', rawPhrase: 'Tyler is David\'s grandson',
  });
  const inv = writeRelationshipEdge({
    fromEntityId: school, toEntityId: david, relation: 'involves', statedAs: 'involved', rawPhrase: 'the OU game involved David',
  });
  const blockLoc = loc.ok
    ? supersedeRelationshipEdge(loc.edgeId, {
        fromEntityId: david, toEntityId: school, relation: 'related_to', statedAs: 'near', rawPhrase: 'moved',
      })
    : { ok: false as const, reason: 'not_found' as const };
  const blockGp = gp.ok
    ? supersedeRelationshipEdge(gp.edgeId, {
        fromEntityId: david, toEntityId: karen, relation: 'grandparent_of', statedAs: 'granddaughter', rawPhrase: 'changed',
      })
    : { ok: false as const, reason: 'not_found' as const };
  const blockInv = inv.ok
    ? supersedeRelationshipEdge(inv.edgeId, {
        fromEntityId: school, toEntityId: karen, relation: 'involves', statedAs: 'involved', rawPhrase: 'changed',
      })
    : { ok: false as const, reason: 'not_found' as const };
  assert('non-supersedable grandparent_of/involves/located_at reject with no replacement',
    !blockLoc.ok && blockLoc.reason === 'non_supersedable'
      && !blockGp.ok && blockGp.reason === 'non_supersedable'
      && !blockInv.ok && blockInv.reason === 'non_supersedable',
    (v) => v === true, 'true');

  const activeBeforeRemove = getActiveEdges().length;
  const removed = floored.ok ? softRemoveRelationshipEdge(floored.edgeId) : false;
  const removedRow = floored.ok
    ? db.prepare(`SELECT removed_at, ended_at FROM entity_relationships WHERE id = ?;`).get(floored.edgeId) as
      { removed_at: string | null; ended_at: string | null }
    : null;
  assert('soft removal sets removed_at, leaves the active set, and inserts no replacement',
    removed === true && !!removedRow?.removed_at && removedRow.ended_at == null
      && getActiveEdges().length === activeBeforeRemove - 1
      && getActiveEdges().every((e) => e.id !== (floored.ok ? floored.edgeId : '')),
    (v) => v === true, 'true');

  const afterRemoveWrite = writeRelationshipEdge({
    fromEntityId: david,
    toEntityId: tyler,
    relation: "stepson's boy",
    statedAs: "stepson's boy",
    rawPhrase: "Tyler is David's late brother's stepson's boy",
  });
  assert('a removed prior row does not block a new active edge',
    afterRemoveWrite.ok && afterRemoveWrite.action === 'inserted',
    (v) => v === true, 'true');

  ensureMeEntity();
  const shannon = seedPerson('Shannon', 'wife');
  const familyBefore = answerFamilyRead(detectFamilyRead('who is my wife')!);
  const meEdge = writeRelationshipEdge({
    fromEntityId: ME_ENTITY_ID,
    toEntityId: shannon,
    relation: 'spouse_of',
    statedAs: 'wife',
    rawPhrase: 'Shannon is my wife',
  });
  const familyAfter = answerFamilyRead(detectFamilyRead('who is my wife')!);
  const meStored = getActiveEdges().some(
    (e) => (e.from_entity === ME_ENTITY_ID || e.to_entity === ME_ENTITY_ID)
      && (e.from_entity === shannon || e.to_entity === shannon),
  );
  assert('Me↔contact kinship already in contacts.relationship is not stored as an edge',
    !meEdge.ok && meEdge.reason === 'me_contact_kinship_duplicate' && meStored === false,
    (v) => v === true, 'true');
  assert('familyRead is unchanged after the rejected Me↔contact edge write',
    familyBefore === familyAfter && familyAfter.includes('Shannon'),
    (v) => v === true, 'true');

  const cols = db.prepare('PRAGMA table_info(entity_relationships);').all().map((r: { name: string }) => r.name);
  assert('entity_relationships has no persisted confidence column',
    cols.includes('confidence'), (v) => v === false, 'false');

  const capture = capturePerson({ name: 'Avery', relationship: 'sister' });
  const avery = db.prepare(
    `SELECT relationship FROM contacts WHERE LOWER(name) = 'avery' AND removed_at IS NULL;`,
  ).get() as { relationship: string } | undefined;
  assert('capturePerson still writes the contact and no relationship fact',
    capture.ok && count(db, 'facts', "category = 'relationships'") === 0 && avery?.relationship === 'sister',
    (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Step3EdgeWriter: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Step3EdgeWriter.test.ts')) {
  runRung5Step3EdgeWriterTests().catch(console.error);
}
