// Natural Recollection Admission Mechanism V1A — stub nominator only.

import Database from 'better-sqlite3';
import { setDB, runMigrations, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { listActiveEvidence } from '../../src/db/evidenceDB.ts';
import { resetReminiscenceAdmissionState } from '../../src/db/reminiscenceWrite.ts';
import {
  ReminiscenceArcHolder,
  resetDefaultReminiscenceArc,
} from '../../src/routing/reminiscenceArc.ts';
import {
  getReminiscenceNominationCount,
  resetReminiscenceNominator,
  stubNominateReminiscence,
} from '../../src/utils/reminiscenceNominator.ts';
import { REMINISCENCE_DISPOSITIONS } from '../../src/utils/reminiscenceDisposition.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const CHILDHOOD = 'When I was a kid, we spent summers at the lake.';
const CONTINUE = 'When I was a kid, actually maybe 1969.';
const ABOUT = 'About twelve.';
const RECALL = 'What did I say about when I was a kid?';
const ASSISTANT_Q = 'How old were you?';

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
  resetReminiscenceAdmissionState();
  resetDefaultReminiscenceArc();
  resetReminiscenceNominator();
  setNow(new Date(2026, 8, 22, 12, 0, 0));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const arc = new ReminiscenceArcHolder();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, null, null, null, null, null, null, arc);
  return { db, session, subject, arc, say };
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number };
  return row.n;
}

function snapshotT(db: Database.Database) {
  return {
    medical: count(db, 'medical_records'),
    facts: count(db, 'facts'),
    contacts: count(db, 'contacts'),
    entities: count(db, 'entities'),
    edges: count(db, 'entity_relationships'),
    episodes: count(db, 'episodes'),
    medications: count(db, 'medications'),
  };
}

function liveR() {
  return listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
}

function spoken(out: { responseText?: string; routeDecision?: { response?: string; reason?: string; kind?: string } }): string {
  if (typeof out.responseText === 'string' && out.responseText) return out.responseText;
  if (typeof out.routeDecision?.response === 'string') return out.routeDecision.response;
  return '';
}

export async function runNaturalRecollectionAdmissionV1aTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Natural Recollection Admission V1A (stub nominator) --${RESET}\n`);

  try {
    assert('SCHEMA_VERSION remains 25 (no schema 26)', SCHEMA_VERSION, (v) => v === 25, '25');
    assert('closed disposition contract is the six labels',
      JSON.stringify(REMINISCENCE_DISPOSITIONS),
      (v) => v === JSON.stringify(['AUTOBIOGRAPHICAL', 'CONTINUE_ARC', 'TRANSIENT', 'SENSITIVE', 'THIRD_PARTY', 'UNCERTAIN']),
      'six labels');
    assert('stub labels childhood as AUTOBIOGRAPHICAL',
      stubNominateReminiscence(CHILDHOOD, { arcOpen: false }),
      (v) => v === 'AUTOBIOGRAPHICAL', 'AUTOBIOGRAPHICAL');
    assert('stub labels About twelve as CONTINUE_ARC only when arc is open',
      stubNominateReminiscence(ABOUT, { arcOpen: true }) === 'CONTINUE_ARC'
        && stubNominateReminiscence(ABOUT, { arcOpen: false }) === 'UNCERTAIN',
      (v) => v === true, 'true');

    {
      const { say } = await fresh();
      const before = getReminiscenceNominationCount();
      const out = await say('Add milk to my grocery list.');
      assert('grocery command uses existing capability and does not call the nominator',
        getReminiscenceNominationCount() === before
          && out.source !== 'recollection'
          && liveR().length === 0
          && (out.source === 'capture' || out.handled === false || /grocery|milk/i.test(spoken(out))),
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      const before = getReminiscenceNominationCount();
      const out = await say('Call David.');
      assert('contact-call command uses existing capability and does not call the nominator',
        getReminiscenceNominationCount() === before
          && out.source !== 'recollection'
          && liveR().length === 0,
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      const before = snapshotT(db);
      const out = await say('My doctor doubled my Eliquis.');
      assert('medical utterance is fail-closed from silent R and does not write Track T',
        liveR().length === 0
          && out.source !== 'recollection'
          && JSON.stringify(snapshotT(db)) === JSON.stringify(before),
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh();
      const beforeEp = count(db, 'episodes');
      const nomBefore = getReminiscenceNominationCount();
      const out = await say("Remember that Dad loved that restaurant.");
      assert('explicit Episode Capture is Episode only; nominator not used',
        /Want me to remember/.test(spoken(out))
          && out.source === 'capture'
          && liveR().length === 0
          && count(db, 'episodes') === beforeEp
          && getReminiscenceNominationCount() === nomBefore,
        (v) => v === true, 'true');
    }

    {
      const { db, arc, say } = await fresh();
      const before = snapshotT(db);
      const out = await say(CHILDHOOD);
      assert('autobiographical stub appends verbatim R and opens the RAM arc',
        out.source === 'recollection'
          && liveR().length === 1
          && liveR()[0].rawText === CHILDHOOD
          && arc.peekState() === 'ARC_OPEN'
          && JSON.stringify(snapshotT(db)) === JSON.stringify(before),
        (v) => v === true, 'true');
    }

    {
      const { arc, say } = await fresh();
      await say(CHILDHOOD);
      arc.noteAssistantQuestion(ASSISTANT_Q);
      const out = await say(ABOUT);
      const rows = liveR();
      assert('start + About twelve stores both USER utterances verbatim; assistant text never enters R',
        out.source === 'recollection'
          && rows.length === 2
          && rows[0].rawText === CHILDHOOD
          && rows[1].rawText === ABOUT
          && !rows.some((r) => r.rawText.includes(ASSISTANT_Q))
          && !/when Dad|Colorado|I was about twelve when/i.test(rows[1].rawText)
          && arc.peekAssistantQuestion() === 'Okay.'
          && arc.peekState() === 'ARC_OPEN',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say('Traffic was awful today.');
      assert('TRANSIENT produces no R write',
        liveR().length === 0, (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say('asdfgh stt fragment');
      assert('UNCERTAIN produces no R write',
        liveR().length === 0, (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say('When I was a kid, I took insulin every morning.');
      assert('SENSITIVE produces no R write',
        liveR().length === 0
          && stubNominateReminiscence('When I was a kid, I took insulin every morning.', { arcOpen: false }) === 'SENSITIVE',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say("My brother's marriage was a disaster.");
      assert('THIRD_PARTY produces no R write',
        liveR().length === 0
          && stubNominateReminiscence("My brother's marriage was a disaster.", { arcOpen: false }) === 'THIRD_PARTY',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say('When I was a kid, we walked to the lake and I took insulin.');
      assert('mixed-sensitive utterance is excluded as a whole; no split',
        liveR().length === 0, (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say('When I was a kid, it was 1968.');
      await say(CONTINUE);
      const rows = liveR();
      assert('correction appends a second verbatim row and does not overwrite',
        rows.length === 2
          && rows[0].rawText === 'When I was a kid, it was 1968.'
          && rows[1].rawText === CONTINUE,
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh();
      await say(CHILDHOOD);
      const suppressed = await say("Don't remember what I just said.");
      const recalled = await say(RECALL);
      assert('don\'t remember what I just said removes the last row',
        suppressed.responseText === "Okay — I won't keep that."
          && liveR().length === 0
          && recalled.responseText === "You haven't told me that kind of thing yet.",
        (v) => v === true, 'true');
    }

    {
      const { arc, say } = await fresh();
      await say(CHILDHOOD);
      await say(CONTINUE);
      assert('two-row arc is live before story suppress',
        liveR().length === 2 && arc.hasDeterministicIdentity(), (v) => v === true, 'true');
      const suppressed = await say("Don't keep this story.");
      const recalled = await say(RECALL);
      assert('unambiguous don\'t keep this story removes the current arc rows',
        suppressed.responseText === "Okay — I won't keep that."
          && liveR().length === 0
          && arc.peekState() === 'NO_ARC'
          && recalled.responseText === "You haven't told me that kind of thing yet.",
        (v) => v === true, 'true');
    }

    {
      const probe = await classifyQuery('what have i told you');
      assert('memory:probe is unchanged',
        probe.tier === 2 && probe.reason === 'memory:probe',
        (v) => v === true, 'true');
    }
  } finally {
    resetNow();
    resetReminiscenceAdmissionState();
    resetDefaultReminiscenceArc();
    resetReminiscenceNominator();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NaturalRecollectionAdmissionV1a: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('naturalRecollectionAdmissionV1a.test.ts')) {
  runNaturalRecollectionAdmissionV1aTests().catch((err) => {
    resetNow();
    console.error(err);
  });
}
