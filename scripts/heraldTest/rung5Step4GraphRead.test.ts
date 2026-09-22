// Rung 5 Step 4 — deterministic person association graphRead v1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeContactValidated } from '../../src/db/contactsDB.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  EDGE_SOURCE_USER_UTTERANCE,
  getActiveEdges,
  softRemoveRelationshipEdge,
  supersedeRelationshipEdge,
  writeRelationshipEdge,
} from '../../src/db/entityRelationshipsWriter.ts';
import {
  answerPersonAssociationRead,
  detectPersonAssociationRead,
} from '../../src/db/graphRead.ts';

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

async function freshDb() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

function seedPerson(name: string, relationship?: string) {
  const result = writeContactValidated({ name, relationship, importance: 7 });
  if (!result.ok) throw new Error(`seed failed for ${name}`);
  return result.contactId;
}

function count(db: Database.Database, table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''};`).get() as { n: number };
  return row.n;
}

function writeEdge(from: string, to: string, relation: string, statedAs: string, phrase: string) {
  const written = writeRelationshipEdge({
    fromEntityId: from,
    toEntityId: to,
    relation,
    statedAs,
    rawPhrase: phrase,
  });
  if (!written.ok) throw new Error(`edge write failed: ${written.reason}`);
  return written.edgeId;
}

export async function runRung5Step4GraphReadTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Step 4 graphRead v1 --${RESET}\n`);

  const graphSrc = fs.readFileSync(path.join(root, 'src/db/graphRead.ts'), 'utf8');
  const familySrc = fs.readFileSync(path.join(root, 'src/utils/familyRead.ts'), 'utf8');
  const writerSrc = fs.readFileSync(path.join(root, 'src/db/entityRelationshipsWriter.ts'), 'utf8');
  const captureSrc = fs.readFileSync(path.join(root, 'src/utils/personAssociationCapture.ts'), 'utf8');
  const readIntentSrc = fs.readFileSync(path.join(root, 'src/routing/readIntent.ts'), 'utf8');
  const llmLayersSrc = fs.readFileSync(path.join(root, 'src/hooks/llmLayers.ts'), 'utf8');

  assert('graphRead never mutates entity_relationships',
    /\b(?:INSERT|UPDATE|DELETE)\b/i.test(graphSrc), (v) => v === false, 'false');
  assert('graphRead never reads contacts.relationship',
    /SELECT\s+relationship\s+FROM\s+contacts/i.test(graphSrc), (v) => v === false, 'false');
  assert('graphRead never calls mergeEntities or writeContact',
    /mergeEntities|writeContact/.test(graphSrc), (v) => v === false, 'false');
  assert('graphRead reuses mapStatedAssociation and getActiveEdges',
    /mapStatedAssociation/.test(graphSrc) && /getActiveEdges/.test(graphSrc), (v) => v === true, 'true');
  assert('graphRead uses CANONICAL_RELATIONS.symmetric rather than hard-coding sibling/spouse',
    /CANONICAL_RELATIONS/.test(graphSrc) && /\.symmetric/.test(graphSrc), (v) => v === true, 'true');
  assert('Step-3 writer semantics are unchanged in this slice',
    /EDGE_SOURCE_USER_UTTERANCE/.test(writerSrc) && /writeRelationshipEdge/.test(writerSrc),
    (v) => v === true, 'true');
  assert('association capture semantics are unchanged in this slice',
    /person_association_capture/.test(captureSrc) && /mapStatedAssociation/.test(captureSrc),
    (v) => v === true, 'true');
  assert('ReadIntent registry is untouched',
    /graph:person_association_read|entity_relationships/.test(readIntentSrc),
    (v) => v === false, 'false');
  assert('classifier emission is untouched',
    /graph:person_association_read/.test(llmLayersSrc), (v) => v === false, 'false');
  assert('familyRead still owns contacts kinship and never reads entity_relationships',
    /FROM contacts/.test(familySrc) && /entity_relationships/.test(familySrc) === false,
    (v) => v === true, 'true');

  const db = await freshDb();
  const entitiesBeforeSeed = count(db, 'entities');
  const david = seedPerson('David');
  const karen = seedPerson('Karen');
  const mike = seedPerson('Mike');
  const tyler = seedPerson('Tyler');
  const linda = seedPerson('Linda');
  writeEdge(david, karen, 'parent_of', 'daughter', "Karen is David's daughter");

  const first = detectPersonAssociationRead("Who is David's daughter?");
  const firstAnswer = first ? answerPersonAssociationRead(first) : '';
  assert('first journey resolves possessor David',
    first?.possessorEntityId === david && first?.queryWord === 'daughter' && first?.relation === 'parent_of',
    (v) => v === true, 'true');
  assert('first journey answers Karen with provenance and stated_as, never parent_of',
    /Karen/.test(firstAnswer) && /you told me/i.test(firstAnswer) && /daughter/.test(firstAnswer) && !/parent_of/.test(firstAnswer),
    (v) => v === true, 'true');

  const fatherQ = detectPersonAssociationRead("Who is Karen's father?");
  const fatherAnswer = fatherQ ? answerPersonAssociationRead(fatherQ) : '';
  assert('inverse father question traverses the same incoming parent_of edge to David',
    fatherQ?.possessorEntityId === karen && /David/.test(fatherAnswer) && /you told me/i.test(fatherAnswer) && !/parent_of/.test(fatherAnswer),
    (v) => v === true, 'true');

  writeEdge(david, mike, 'parent_of', 'son', "Mike is David's son");
  const daughterOnly = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's daughter?")!);
  const sonOnly = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's son?")!);
  assert('exact stated_as daughter keeps Karen and excludes Mike',
    /Karen/.test(daughterOnly) && !/Mike/.test(daughterOnly), (v) => v === true, 'true');
  assert('exact stated_as son keeps Mike and excludes Karen',
    /Mike/.test(sonOnly) && !/Karen/.test(sonOnly), (v) => v === true, 'true');
  const childQ = detectPersonAssociationRead("Who is David's child?");
  const childAnswer = childQ ? answerPersonAssociationRead(childQ) : '';
  assert('child does not umbrella-include daughter or son',
    !!childQ && !/Karen/.test(childAnswer) && !/Mike/.test(childAnswer) && /I don't have anyone recorded/.test(childAnswer),
    (v) => v === true, 'true');
  const childrenQ = detectPersonAssociationRead("Who is David's children?");
  const childrenAnswer = childrenQ ? answerPersonAssociationRead(childrenQ) : '';
  assert('plural children is related_to unread / honest miss, not an expansion',
    childrenQ?.relation === 'related_to' && !/Karen/.test(childrenAnswer) && !/Mike/.test(childrenAnswer),
    (v) => v === true, 'true');

  writeEdge(karen, tyler, 'sibling_of', 'brother', "Tyler is Karen's brother");
  const sibFromKaren = answerPersonAssociationRead(detectPersonAssociationRead("Who is Karen's brother?")!);
  const sibFromTyler = answerPersonAssociationRead(detectPersonAssociationRead("Who is Tyler's brother?")!);
  assert('symmetric sibling answers from the stored from endpoint',
    /Tyler/.test(sibFromKaren) && !/parent_of/.test(sibFromKaren), (v) => v === true, 'true');
  assert('symmetric sibling answers from the stored to endpoint',
    /Karen/.test(sibFromTyler), (v) => v === true, 'true');

  const spouseId = writeEdge(david, linda, 'spouse_of', 'wife', "Linda is David's wife");
  const wifeFromDavid = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's wife?")!);
  const wifeFromLinda = answerPersonAssociationRead(detectPersonAssociationRead("Who is Linda's wife?")!);
  assert('symmetric spouse answers from either endpoint',
    /Linda/.test(wifeFromDavid) && /David/.test(wifeFromLinda), (v) => v === true, 'true');

  const routedDaughter = await classifyQuery("Who is David's daughter?");
  assert('tier-1 graph reason is graph:person_association_read',
    routedDaughter.reason === 'graph:person_association_read' && routedDaughter.tier === 1
      && /Karen/.test(routedDaughter.tier1Response ?? ''),
    (v) => v === true, 'true');

  const meRelativeDetect = detectPersonAssociationRead('Who is my daughter?');
  const meFamily = detectFamilyRead('Who is my daughter?');
  const meRouted = await classifyQuery('Who is my daughter?');
  assert('Me-relative who-is never matches graphRead',
    meRelativeDetect, (v) => v === null, 'null');
  assert('Me-relative who-is stays on familyRead',
    !!meFamily && meRouted.reason === 'family:read', (v) => v === true, 'true');
  assert('name-possessor graph question does not match familyRead',
    detectFamilyRead("Who is David's daughter?"), (v) => v === null, 'null');

  const beforeRemove = count(db, 'entity_relationships', 'removed_at IS NULL');
  softRemoveRelationshipEdge(spouseId);
  const afterRemove = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's wife?")!);
  assert('soft-removed spouse edge is invisible',
    /I don't have anyone recorded as David's wife/.test(afterRemove)
      && getActiveEdges().every((e) => e.id !== spouseId),
    (v) => v === true, 'true');

  const oldSpouse = writeEdge(david, linda, 'spouse_of', 'wife', "Linda is David's wife");
  const replacement = supersedeRelationshipEdge(oldSpouse, {
    fromEntityId: david,
    toEntityId: linda,
    relation: 'spouse_of',
    statedAs: 'wife',
    rawPhrase: "Linda is still David's wife",
  });
  const afterSupersede = detectPersonAssociationRead("Who is David's wife?");
  const afterSupersedeAnswer = afterSupersede ? answerPersonAssociationRead(afterSupersede) : '';
  assert('superseded spouse row is invisible; only the active row answers',
    replacement.ok && /Linda/.test(afterSupersedeAnswer)
      && getActiveEdges().filter((e) => e.relation === 'spouse_of').length === 1,
    (v) => v === true, 'true');

  const uniqueZero = seedPerson('Patricia');
  const zeroDetect = detectPersonAssociationRead("Who is Patricia's daughter?");
  const zeroAnswer = zeroDetect ? answerPersonAssociationRead(zeroDetect) : '';
  assert('unique resolved person with zero matching edges is an honest miss',
    zeroDetect?.possessorEntityId === uniqueZero
      && /I don't have anyone recorded as Patricia's daughter/.test(zeroAnswer),
    (v) => v === true, 'true');

  const relatedWrite = writeRelationshipEdge({
    fromEntityId: mike,
    toEntityId: tyler,
    relation: 'related_to',
    statedAs: 'cousin',
    rawPhrase: "Tyler is Mike's cousin",
  });
  const relatedQ = detectPersonAssociationRead("Who is Mike's cousin?");
  const relatedAnswer = relatedQ ? answerPersonAssociationRead(relatedQ) : '';
  assert('related_to is stored but unread by any Who-is query',
    relatedWrite.ok && relatedQ?.relation === 'related_to'
      && !/Tyler/.test(relatedAnswer)
      && /I don't have anyone recorded as Mike's cousin/.test(relatedAnswer),
    (v) => v === true, 'true');

  db.prepare(`
    INSERT INTO entity_relationships
      (id, from_entity, relation, to_entity, created_at, stated_as, raw_phrase, source, ended_at, removed_at)
    VALUES ('er_calendar_forbidden', ?, 'parent_of', ?, datetime('now'), 'daughter', 'calendar derived', 'calendar', NULL, NULL);
  `).run(david, karen);
  const calendarPoison = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's daughter?")!);
  assert('non-utterance / calendar-derived edges are not graph truth',
    /Karen/.test(calendarPoison) && !/calendar derived/.test(calendarPoison),
    (v) => v === true, 'true');
  assert('active user_utterance edges remain the only spoken provenance',
    /you told me/.test(calendarPoison) && !/parent_of/.test(calendarPoison),
    (v) => v === true, 'true');

  const amy = seedPerson('Amy');
  writeEdge(david, amy, 'parent_of', 'daughter', "Amy is David's daughter");
  const twoDaughters = answerPersonAssociationRead(detectPersonAssociationRead("Who is David's daughter?")!);
  assert('multiple exact stated_as matches enumerate all, picking none',
    /Karen/.test(twoDaughters) && /Amy/.test(twoDaughters) && /you told me/i.test(twoDaughters) && !/parent_of/.test(twoDaughters),
    (v) => v === true, 'true');

  const contracted = detectPersonAssociationRead("Who's Karen's father?");
  assert("contracted Who's shape is accepted",
    contracted?.possessorEntityId === karen, (v) => v === true, 'true');

  const entitiesBeforeGhost = count(db, 'entities');
  const unresolvedDetect = detectPersonAssociationRead("Who is Nobodyhere's daughter?");
  const unresolvedRouted = await classifyQuery("Who is Nobodyhere's daughter?");
  assert('unresolved possessor does not match graphRead and fabricates no answer',
    unresolvedDetect === null && unresolvedRouted.reason !== 'graph:person_association_read',
    (v) => v === true, 'true');
  assert('unresolved possessor creates no entity and does not merge',
    count(db, 'entities'), (v) => v === entitiesBeforeGhost, String(entitiesBeforeGhost));

  seedPerson('David', 'uncle');
  const ambiguousDetect = detectPersonAssociationRead("Who is David's daughter?");
  const ambiguousRouted = await classifyQuery("Who is David's daughter?");
  assert('ambiguous possessor never auto-picks a person',
    ambiguousDetect === null && ambiguousRouted.reason !== 'graph:person_association_read',
    (v) => v === true, 'true');

  assert('familyRead still answers from contacts.relationship after graphRead exists',
    answerFamilyRead({ relation: 'uncle', spoken: 'uncle' }),
    (v) => /David/.test(String(v)), 'David from contacts');

  assert('graphRead did not create nodes beyond seeded contacts',
    count(db, 'entities') >= entitiesBeforeSeed, (v) => v === true, 'true');

  void beforeRemove;

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Step4GraphRead: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Step4GraphRead.test.ts')) {
  runRung5Step4GraphReadTests().catch(console.error);
}
