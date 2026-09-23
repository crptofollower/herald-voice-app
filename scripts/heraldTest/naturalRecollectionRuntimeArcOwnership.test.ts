// Natural Recollection Runtime Arc Ownership V1 — ChatScreen lifecycle only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  getDefaultReminiscenceArc,
  resetDefaultReminiscenceArc,
} from '../../src/routing/reminiscenceArc.ts';
import { resetReminiscenceNominator } from '../../src/utils/reminiscenceNominator.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const CHILDHOOD = 'When I was a kid, we spent summers at the lake.';
const ABOUT = 'About twelve.';
const ASSISTANT_Q = 'How old were you?';
const DONT_SAVE = "Don't remember what I just said.";
const EMERGENCY = "I'm having an emergency";

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function fresh(arc: ReminiscenceArcHolder) {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  resetReminiscenceAdmissionState();
  resetDefaultReminiscenceArc();
  resetReminiscenceNominator();
  setNow(new Date(2026, 8, 22, 12, 0, 0));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, null, null, null, null, null, null, arc);
  return { db, session, subject, arc, say, deps };
}

function liveR() {
  return listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
}

export async function runNaturalRecollectionRuntimeArcOwnershipV1Tests(): Promise<{
  passed: number; failed: number; total: number;
}> {
  let passed = 0;
  const failures: string[] = [];
  const assert = (label: string, value: unknown, pred: (v: unknown) => boolean, expected: string) => {
    if (pred(value)) {
      passed++;
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
    } else {
      failures.push(label);
      console.log(`${RED}✗ FAIL${RESET}  ${label}${DIM}  got ${JSON.stringify(value)} expected ${expected}${RESET}`);
    }
  };

  console.log(`\n${BOLD}-- Natural Recollection Runtime Arc Ownership V1 --${RESET}\n`);

  try {
    assert('SCHEMA_VERSION remains 25', SCHEMA_VERSION, (v) => v === 25, '25');

    const chatPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
    const chatSrc = fs.readFileSync(chatPath, 'utf8');
    const processCalls = [...chatSrc.matchAll(/processUtterance\(/g)];
    assert('production ChatScreen supplies an explicit reminiscenceArcRef at every processUtterance call',
      processCalls.length === 2
        && /const reminiscenceArcRef = useRef<ReminiscenceArcHolder>\(new ReminiscenceArcHolder\(\)\)/.test(chatSrc)
        && chatSrc.includes('conversationLedgerRef.current, reminiscenceArcRef.current, recoveryObligationRef.current, todoPresentationRef.current);')
        && (chatSrc.match(/conversationLedgerRef\.current, reminiscenceArcRef\.current, recoveryObligationRef\.current, todoPresentationRef\.current\)/g) ?? []).length === 2,
      (v) => v === true, 'true');

    const law0Block = chatSrc.slice(chatSrc.indexOf('if (detectEmergency(text))'), chatSrc.indexOf('await dispatchEmergency(text)'));
    const resetBlock = chatSrc.slice(chatSrc.indexOf('resetConversation: () =>'), chatSrc.indexOf('useStore.getState().clearChat()'));
    assert('ChatScreen Law-0 bridge and resetConversation clear the session-owned reminiscence arc',
      law0Block.includes('reminiscenceArcRef.current.clear()')
        && resetBlock.includes('reminiscenceArcRef.current.clear()'),
      (v) => v === true, 'true');

    assert('ChatScreen does not wire noteAssistantQuestion',
      !chatSrc.includes('noteAssistantQuestion'),
      (v) => v === true, 'true');

    {
      const production = new ReminiscenceArcHolder();
      const { say } = await fresh(production);
      await say(CHILDHOOD);
      assert('production-style explicit holder leaves the proving singleton unused',
        production.peekState() === 'ARC_OPEN'
          && getDefaultReminiscenceArc().peekState() === 'NO_ARC'
          && getDefaultReminiscenceArc().peekRowIds().length === 0
          && production.peekRowIds().length === 1,
        (v) => v === true, 'true');
    }

    {
      const arcA = new ReminiscenceArcHolder();
      const { say } = await fresh(arcA);
      await say(CHILDHOOD);
      assert('Conversation A opens a reminiscence arc',
        arcA.peekState() === 'ARC_OPEN' && liveR().length === 1 && liveR()[0].rawText === CHILDHOOD,
        (v) => v === true, 'true');

      const priorId = liveR()[0].id;
      arcA.clear();
      assert('conversation reset clears that arc including last-admitted identity',
        arcA.peekState() === 'NO_ARC'
          && !arcA.isOpen()
          && arcA.peekRowIds().length === 0
          && arcA.peekLastAdmittedId() === null,
        (v) => v === true, 'true');

      const afterReset = await say(ABOUT);
      assert('"About twelve" after reset cannot continue Conversation A',
        !arcA.isOpen()
          && liveR().length === 1
          && liveR()[0].id === priorId
          && afterReset.handled === false,
        (v) => v === true, 'true');

      const forgotten = await say(DONT_SAVE);
      assert('last-admitted suppression cannot cross a reset/session boundary',
        forgotten.responseText === "I don't have anything like that to forget."
          && liveR().length === 1
          && liveR()[0].id === priorId
          && liveR()[0].rawText === CHILDHOOD,
        (v) => v === true, 'true');
    }

    {
      const holderA = new ReminiscenceArcHolder();
      const { say } = await fresh(holderA);
      await say(CHILDHOOD);
      const holderB = new ReminiscenceArcHolder();
      assert('a new-session holder cannot see the previous holder arc',
        holderA.peekState() === 'ARC_OPEN'
          && holderB.peekState() === 'NO_ARC'
          && holderB.peekRowIds().length === 0
          && holderB.peekLastAdmittedId() === null
          && holderA.peekRowIds().length === 1,
        (v) => v === true, 'true');
    }

    {
      const arc = new ReminiscenceArcHolder();
      const { say } = await fresh(arc);
      await say(CHILDHOOD);
      const out = await say(EMERGENCY);
      assert('processUtterance emergency clears the active arc',
        out.source === 'emergency'
          && arc.peekState() === 'NO_ARC'
          && arc.peekLastAdmittedId() === null
          && arc.peekRowIds().length === 0,
        (v) => v === true, 'true');
    }

    {
      const arc = new ReminiscenceArcHolder();
      const { say } = await fresh(arc);
      await say(CHILDHOOD);
      const noSpeechFn = chatSrc.slice(
        chatSrc.indexOf('const handleNoRecognizableSpeech'),
        chatSrc.indexOf('}, [classifyQuery, getCtx,'),
      );
      assert('STT/no-turn equivalent does not clear an active arc',
        arc.peekState() === 'ARC_OPEN'
          && liveR().length === 1
          && !noSpeechFn.includes('reminiscenceArcRef.current.clear()'),
        (v) => v === true, 'true');
    }

    {
      const arc = new ReminiscenceArcHolder();
      const { say } = await fresh(arc);
      await say(CHILDHOOD);
      await say('Add milk to my grocery list.');
      assert('deterministic operational interruption still closes the arc',
        arc.peekState() === 'ARC_CLOSED' && !arc.isOpen() && liveR().length === 1,
        (v) => v === true, 'true');
    }

    {
      const arc = new ReminiscenceArcHolder();
      const { say } = await fresh(arc);
      await say(CHILDHOOD);
      await say(ABOUT);
      const rows = liveR();
      assert('About twelve continuation within one valid session remains verbatim-only',
        arc.peekState() === 'ARC_OPEN'
          && rows.length === 2
          && rows[0].rawText === CHILDHOOD
          && rows[1].rawText === ABOUT
          && !rows.some((r) => r.rawText.includes(ASSISTANT_Q)),
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
  console.log(`\n${BOLD}NaturalRecollectionRuntimeArcOwnershipV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('naturalRecollectionRuntimeArcOwnership')) {
  runNaturalRecollectionRuntimeArcOwnershipV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
