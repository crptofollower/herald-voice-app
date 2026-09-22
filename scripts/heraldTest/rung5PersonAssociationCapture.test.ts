// Rung 5 — first conversational person↔person association capture.
// Production seam: processUtterance + ConversationSession + Step-3 writer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { writeContactValidated } from '../../src/db/contactsDB.ts';
import { detectFamilyRead, answerFamilyRead } from '../../src/utils/familyRead.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { getActiveEdges } from '../../src/db/entityRelationshipsWriter.ts';
import { mapStatedAssociation } from '../../src/utils/personAssociationCapture.ts';
import { EDGE_SOURCE_USER_UTTERANCE } from '../../src/db/entityRelationshipsWriter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UTTERANCE = "Karen is David's daughter.";

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function fresh() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  const session = new ConversationSession();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) => processUtterance(text, session, deps);
  return { db, session, say };
}

function seed(name: string, relationship?: string) {
  const result = writeContactValidated({ name, relationship, importance: 7 });
  if (!result.ok) throw new Error(`seed failed: ${name}`);
  return result.contactId;
}

function speechOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  return 'responseText' in outcome && typeof outcome.responseText === 'string' ? outcome.responseText : '';
}

function count(db: Database.Database, table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''};`).get() as { n: number };
  return row.n;
}

export async function runRung5PersonAssociationCaptureTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 first conversational association capture --${RESET}\n`);

  const captureSrc = fs.readFileSync(path.join(root, 'src/db/capturePerson.ts'), 'utf8');
  assert('Gap 3 stays closed: capturePerson has no writeFact',
    /writeFact/.test(captureSrc), (v) => v === false, 'false');
  assert('daughter maps to parent_of with possessor as parent',
    mapStatedAssociation('daughter'),
    (v) => (v as { relation: string; direction: string }).relation === 'parent_of'
      && (v as { direction: string }).direction === 'possessor_to_subject',
    'parent_of / possessor_to_subject');

  {
    const { db, session, say } = await fresh();
    const david = seed('David');
    const karen = seed('Karen');
    seed('Shannon', 'wife');
    const familyBefore = answerFamilyRead(detectFamilyRead('who is my wife')!);
    const first = await say(UTTERANCE);
    assert('target utterance arms confirmation and does not write yet',
      first.handled === true && session.hasPending()
        && session.peekPendingKey() === 'person_association_capture'
        && getActiveEdges().length === 0,
      (v) => v === true, 'true');
    assert('confirmation prompt reflects the stated association, not a committed ACK',
      /Karen is David's daughter/i.test(speechOf(first)) && /that right/i.test(speechOf(first))
        && !/^I'll remember/i.test(speechOf(first)),
      (v) => v === true, 'true');

    const yes = await say('Yes.');
    const edges = getActiveEdges();
    const row = edges[0];
    assert('confirmation commits exactly one David parent_of Karen edge',
      !session.hasPending() && yes.handled === true && edges.length === 1
        && row?.relation === 'parent_of' && row.from_entity === david && row.to_entity === karen,
      (v) => v === true, 'true');
    assert('stated_as preserves the user relationship wording',
      row?.stated_as === 'daughter', (v) => v === true, 'true');
    assert('raw_phrase preserves the utterance',
      row?.raw_phrase === UTTERANCE, (v) => v === true, 'true');
    assert("source is user_utterance",
      row?.source === EDGE_SOURCE_USER_UTTERANCE, (v) => v === true, 'true');
    assert('ACK reflects committed truth only',
      /^I'll remember Karen is David's daughter\./i.test(speechOf(yes)),
      (v) => v === true, 'true');

    const again = await say(UTTERANCE);
    await say('Yes.');
    assert('repeated identical confirmed capture remains idempotent',
      getActiveEdges().filter((e) => e.relation === 'parent_of' && e.from_entity === david && e.to_entity === karen).length === 1,
      (v) => v === true, 'true');
    assert('familyRead/contact Me↔person authority is unchanged after association capture',
      answerFamilyRead(detectFamilyRead('who is my wife')!) === familyBefore
        && familyBefore.includes('Shannon'),
      (v) => v === true, 'true');
    assert('association capture writes no relationship facts',
      count(db, 'facts', "category = 'relationships'") === 0, (v) => v === true, 'true');
    void again;
  }

  {
    const { session, say } = await fresh();
    seed('David');
    const first = await say(UTTERANCE);
    assert('missing Karen produces no pending and no edge',
      !session.hasPending() && getActiveEdges().length === 0,
      (v) => v === true, 'true');
    void first;
  }

  {
    const { session, say } = await fresh();
    seed('David');
    seed('Karen');
    writeContactValidated({ name: 'Karen', relationship: 'niece', importance: 6 });
    const first = await say(UTTERANCE);
    assert('ambiguous Karen produces no pending and no edge',
      !session.hasPending() && getActiveEdges().length === 0,
      (v) => v === true, 'true');
    void first;
  }

  {
    const { session, say } = await fresh();
    seed('David');
    seed('Karen');
    await say(UTTERANCE);
    const declined = await say('No.');
    assert('declining confirmation produces no edge',
      !session.hasPending() && getActiveEdges().length === 0
        && /won't remember/i.test(speechOf(declined)),
      (v) => v === true, 'true');
  }

  {
    const { session, say } = await fresh();
    seed('Shannon', 'wife');
    const first = await say('Shannon is my wife.');
    assert('Me↔person statement does not create a stored graph edge',
      getActiveEdges().length === 0 && session.peekPendingKey() !== 'person_association_capture',
      (v) => v === true, 'true');
    void first;
  }

  {
    const { say } = await fresh();
    seed('David');
    seed('Karen');
    await say("Karen is David's coworker.");
    await say('Yes.');
    const row = getActiveEdges()[0];
    assert('unclassified explicit association floors to related_to',
      row?.relation === 'related_to' && row?.stated_as === 'coworker',
      (v) => v === true, 'true');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5PersonAssociationCapture: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5PersonAssociationCapture.test.ts')) {
  runRung5PersonAssociationCaptureTests().catch(console.error);
}
