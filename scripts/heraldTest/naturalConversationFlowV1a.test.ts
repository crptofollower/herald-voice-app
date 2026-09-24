// Natural Conversation Flow V1A — mocked semantic ctx. Structural proofs only.

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
import { persistEvidence } from '../../src/db/evidenceDB.ts';
import { resetReminiscenceAdmissionState } from '../../src/db/reminiscenceWrite.ts';
import {
  ReminiscenceArcHolder,
  resetDefaultReminiscenceArc,
} from '../../src/routing/reminiscenceArc.ts';
import { resetReminiscenceNominator } from '../../src/utils/reminiscenceNominator.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';
import {
  generateRecollectionConversationFlow,
  recollectionFlowSpeech,
  RECOLLECTION_FLOW_FALLBACK,
  RECOLLECTION_FLOW_SYSTEM_PROMPT,
  formatRecollectionFlowUserContent,
} from '../../src/routing/recollectionConversationFlow.ts';
import {
  resetSemanticCompletionLifecycleForTests,
  isSemanticNativeCompletionInFlight,
} from '../../src/utils/semanticCompletionLifecycle.ts';
import { withLlamaContextExclusive } from '../../src/utils/llamaContextExclusive.ts';
import {
  RECOLLECTION_SEMANTIC_TIMEOUT_MS,
  getRecollectionSemanticShadowCount,
} from '../../src/routing/recollectionSemanticNomination.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const CHILDHOOD = 'When I was a kid, we spent summers at the lake.';
const LAKE = 'There was a lake about an hour from us.';
const SANDWICHES = 'We packed sandwiches.';
const FLOW_ONE = 'Was that the same lake you spent summers at?';
const FLOW_TWO = 'What did you pack?';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number }).n;
}

function snapshotWriters(db: Database.Database) {
  return {
    medical: count(db, 'medical_records'),
    facts: count(db, 'facts'),
    contacts: count(db, 'contacts'),
    entities: count(db, 'entities'),
    edges: count(db, 'entity_relationships'),
    episodes: count(db, 'episodes'),
    medications: count(db, 'medications'),
    appointments: count(db, 'appointments'),
    listItems: count(db, 'list_items'),
  };
}

function liveR() {
  return listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
}

function dualMock(flowTexts: string[]) {
  const calls: unknown[] = [];
  let flowI = 0;
  const ctx = {
    completion: async (params: unknown) => {
      calls.push(params);
      const sys = String((params as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content || '');
      if (sys.includes('already-open personal recollection story')) {
        const text = flowTexts[Math.min(flowI, flowTexts.length - 1)] ?? FLOW_ONE;
        flowI += 1;
        return { text };
      }
      return { text: '{"disposition":"UNCERTAIN","confidence":0.2}' };
    },
  };
  return { ctx, calls, getCtx: () => ctx };
}

async function fresh(opts?: { getCtx?: () => { completion: (args: unknown) => Promise<unknown> } | null }) {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  resetReminiscenceAdmissionState();
  resetDefaultReminiscenceArc();
  resetReminiscenceNominator();
  resetSemanticCompletionLifecycleForTests();
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
    getMedicationSemanticInterpreterCtx: opts?.getCtx,
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, null, null, null, null, null, null, arc);
  return { db, session, subject, arc, say };
}

export async function runNaturalConversationFlowV1aTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Natural Conversation Flow V1A --------------------------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const flowSrc = fs.readFileSync(path.join(root, 'src/routing/recollectionConversationFlow.ts'), 'utf8');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
  const writeSrc = fs.readFileSync(path.join(root, 'src/db/reminiscenceWrite.ts'), 'utf8');

  assert('SCHEMA_VERSION remains 25', SCHEMA_VERSION, (v) => v === 25, '25');

  assert('Flow prompt forbids invented facts and has no writer imports',
    flowSrc.includes('Do not invent an unstated event')
      && flowSrc.includes("runSpecialistInference('recollection_flow'")
      && !flowSrc.includes('runSharedSemanticCompletion')
      && !flowSrc.includes('persistEvidence')
      && !flowSrc.includes('admitReminiscenceVerbatim')
      && !/medicalDB|contactsDB|calendar|entity_relationships|list_items/.test(flowSrc)
      && processSrc.includes('generateRecollectionConversationFlow')
      && /if \(arc\.isOpen\(\)\)/.test(processSrc)
      && writeSrc.includes("return 'Okay.';")
      && RECOLLECTION_FLOW_FALLBACK === 'Okay.'
      && RECOLLECTION_SEMANTIC_TIMEOUT_MS === 8000,
    (v) => v === true, 'conservative prompt; 8000 deadline');

  try {
    {
      const mock = dualMock([FLOW_ONE, FLOW_TWO]);
      const { db, arc, subject, say } = await fresh({ getCtx: mock.getCtx });
      const before = snapshotWriters(db);
      await say(CHILDHOOD);
      arc.noteAssistantQuestion('How old were you?');
      const rBefore = liveR().map((r) => r.rawText);
      const out = await say(LAKE);
      const userPayload = JSON.stringify(mock.calls[mock.calls.length - 1] ?? {});
      assert('open story + preceding Kit act + short reply yields mocked Flow responseText',
        out.handled === true
          && out.source === 'recollection'
          && out.responseText === FLOW_ONE
          && liveR().length === 1
          && liveR()[0].rawText === CHILDHOOD
          && arc.isOpen()
          && arc.peekAssistantQuestion() === FLOW_ONE
          && userPayload.includes(LAKE)
          && userPayload.includes('How old were you?')
          && userPayload.includes(CHILDHOOD),
        (v) => v === true, 'mocked Flow speech; R unchanged');

      const out2 = await say(SANDWICHES);
      assert('subsequent story turn remains in Flow without subject restart',
        out2.handled === true
          && out2.responseText === FLOW_TWO
          && arc.isOpen()
          && liveR().length === 1
          && subject.peek() == null
          && JSON.stringify(snapshotWriters(db)) === JSON.stringify(before),
        (v) => v === true, 'second Flow; no subject; no extra writers');

      assert('generated Kit text is never persisted as evidence; only prior user verbatim remains in R',
        JSON.stringify(liveR().map((r) => r.rawText)) === JSON.stringify(rBefore)
          && !liveR().some((r) => r.rawText.includes(FLOW_ONE) || r.rawText.includes(FLOW_TWO)),
        (v) => v === true, 'no Kit text in R');
    }

    {
      const mock = dualMock([FLOW_ONE]);
      const { db, say } = await fresh({ getCtx: mock.getCtx });
      const before = snapshotWriters(db);
      await say(CHILDHOOD);
      const shadowAfterAdmit = getRecollectionSemanticShadowCount();
      mock.calls.length = 0;
      const out = await say(LAKE);
      const systems = mock.calls.map((params) =>
        String((params as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content || ''),
      );
      assert('Flow-eligible turn does not launch recollection-shadow inference before Flow',
        out.handled === true
          && out.source === 'recollection'
          && out.responseText === FLOW_ONE
          && getRecollectionSemanticShadowCount() === shadowAfterAdmit
          && systems.some((s) => s.includes('already-open personal recollection story'))
          && !systems.some((s) => s.includes('classify one spoken utterance for autobiographical recollection admission'))
          && liveR().length === 1
          && liveR()[0].rawText === CHILDHOOD
          && JSON.stringify(snapshotWriters(db)) === JSON.stringify(before),
        (v) => v === true, 'Flow owns 3B; no competing shadow; no extra writes');
    }

    {
      const mock = dualMock([FLOW_ONE]);
      const { db, say } = await fresh({ getCtx: mock.getCtx });
      const before = snapshotWriters(db);
      persistEvidence({
        sourceClass: 'user_explicit',
        sourceKind: 'note',
        rawText: 'SECRET_NOTE_SHOULD_NOT_ENTER_FLOW',
        observedAt: new Date().toISOString(),
      });
      await say(CHILDHOOD);
      await say(CHILDHOOD);
      await say(CHILDHOOD);
      mock.calls.length = 0;
      await say(LAKE);
      const last = JSON.stringify(mock.calls[mock.calls.length - 1] ?? {});
      const formatted = formatRecollectionFlowUserContent({
        currentUtterance: LAKE,
        precedingKitAct: 'Okay.',
        arcRows: [CHILDHOOD, CHILDHOOD, CHILDHOOD],
      });
      assert('Flow input is only current verbatim + preceding Track-C act + at most 3 current-arc R rows',
        last.includes('current_user_verbatim')
          && last.includes('preceding_kit_act')
          && last.includes('current_story_rows')
          && !last.includes('SECRET_NOTE_SHOULD_NOT_ENTER_FLOW')
          && !last.includes('medical')
          && (last.match(/When I was a kid, we spent summers at the lake\./g) || []).length <= 3
          && formatted.split('\n').filter((l) => /^\d+\. /.test(l)).length === 3
          && JSON.stringify(snapshotWriters(db)) === JSON.stringify(before),
        (v) => v === true, 'bounded payload');
    }

    resetSemanticCompletionLifecycleForTests();
    {
      const run = await generateRecollectionConversationFlow(
        LAKE,
        () => null,
        new ReminiscenceArcHolder(),
      );
      assert('no_ctx fails closed to deterministic fallback',
        run.status === 'unavailable' && run.reason === 'no_ctx'
          && recollectionFlowSpeech(run) === RECOLLECTION_FLOW_FALLBACK,
        (v) => v === true, 'no_ctx → Okay.');
    }

    resetSemanticCompletionLifecycleForTests();
    {
      let called = 0;
      const ctx = { completion: async () => { called += 1; return { text: FLOW_ONE }; } };
      const held = await withLlamaContextExclusive('classifier', 'try', async () =>
        generateRecollectionConversationFlow(LAKE, () => ctx, new ReminiscenceArcHolder()),
      );
      assert('busy fails closed without a native completion',
        held.ok === true
          && held.value.status === 'unavailable' && held.value.reason === 'busy'
          && called === 0
          && recollectionFlowSpeech(held.value) === RECOLLECTION_FLOW_FALLBACK,
        (v) => v === true, 'busy');
    }

    resetSemanticCompletionLifecycleForTests();
    {
      const d = {
        completion: () => new Promise(() => {}),
      };
      const first = generateRecollectionConversationFlow(LAKE, () => d, new ReminiscenceArcHolder(), { timeoutMs: 40 });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      const second = await generateRecollectionConversationFlow(SANDWICHES, () => d, new ReminiscenceArcHolder());
      const timed = await first;
      assert('in_flight second Flow does not start another completion',
        isSemanticNativeCompletionInFlight() === true
          && second.status === 'unavailable' && second.reason === 'in_flight'
          && recollectionFlowSpeech(second) === RECOLLECTION_FLOW_FALLBACK
          && timed.status === 'unavailable' && timed.reason === 'timeout',
        (v) => v === true, 'in_flight + timeout');
    }

    resetSemanticCompletionLifecycleForTests();
    {
      const run = await generateRecollectionConversationFlow(
        LAKE,
        () => ({ completion: async () => ({ text: '   ' }) }),
        new ReminiscenceArcHolder(),
      );
      assert('empty semantic output uses deterministic fallback',
        run.status === 'unavailable' && run.reason === 'empty'
          && recollectionFlowSpeech(run) === RECOLLECTION_FLOW_FALLBACK,
        (v) => v === true, 'empty');
    }

    resetSemanticCompletionLifecycleForTests();
    {
      const run = await generateRecollectionConversationFlow(
        LAKE,
        () => ({ completion: async () => { throw new Error('native boom'); } }),
        new ReminiscenceArcHolder(),
      );
      assert('semantic error uses deterministic fallback',
        run.status === 'unavailable' && run.reason === 'error'
          && recollectionFlowSpeech(run) === RECOLLECTION_FLOW_FALLBACK,
        (v) => v === true, 'error');
    }

    {
      const { db, arc, say } = await fresh({ getCtx: () => null });
      const before = snapshotWriters(db);
      await say(CHILDHOOD);
      const rCount = liveR().length;
      const out = await say(LAKE);
      assert('processUtterance Flow failures preserve the open story and write nothing extra',
        out.handled === true
          && out.responseText === RECOLLECTION_FLOW_FALLBACK
          && arc.isOpen()
          && liveR().length === rCount
          && JSON.stringify(snapshotWriters(db)) === JSON.stringify(before),
        (v) => v === true, 'fallback; arc open; no write');
    }

    {
      const arc = new ReminiscenceArcHolder();
      arc.begin();
      arc.noteAssistantQuestion('How old were you?');
      arc.clear();
      assert('arc.clear() removes assistant conversational state',
        arc.peekAssistantQuestion() === null && arc.peekState() === 'NO_ARC',
        (v) => v === true, 'Track-C cleared');
    }

    assert('Flow system prompt is not a phrase fixture of the design journey',
      !RECOLLECTION_FLOW_SYSTEM_PROMPT.includes('made a whole day of it')
        && !RECOLLECTION_FLOW_SYSTEM_PROMPT.includes('looked forward to'),
      (v) => v === true, 'no illustrative journey phrases');
  } finally {
    resetNow();
    resetReminiscenceAdmissionState();
    resetDefaultReminiscenceArc();
    resetReminiscenceNominator();
    resetSemanticCompletionLifecycleForTests();
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}NaturalConversationFlowV1a: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('naturalConversationFlowV1a')) {
  runNaturalConversationFlowV1aTests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
