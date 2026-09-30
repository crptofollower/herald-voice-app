// Conversational Continuity V1 — Commit B2 declarative resumption.
// Reuses the B1 window, selection, and realization. Stage B may propose resume; it cannot select.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { ledgerFocusWithConversationalTopic } from '../../src/routing/conversationTurnLedgerWrite.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import { inspectHolds } from '../../src/routing/holdRecall.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const BUSY = "I've had a really busy day.";
const JOB = "I'm leaving my job so I'm trying to get everything ready for the people taking over.";
const OTHER_JOB = 'The other job posting closed yesterday.';
const JOB_RECAP = "You mentioned you're leaving your job so you're trying to get everything ready for the people taking over.";
const WINDOW = "You mentioned you'd had a really busy day, and that you're leaving your job so you're trying to get everything ready for the people taking over.";
const GROCERY = 'Add milk to my grocery list.';

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number };
    out[table.name] = row.n;
  }
  return out;
}

async function openDb() {
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  return db;
}

function deps() {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    getMedicationSemanticInterpreterCtx: () => null,
  };
}

function publish(ledger: ConversationTurnLedger, utterance: string) {
  ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation: 'conversational',
    outcome: 'generated',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    focus: ledgerFocusWithConversationalTopic([], { operation: 'conversational', utterance }),
  });
}

function resumeCtx(calls: { n: number }, selectedIndex: number | null = null) {
  return () => ({
    completion: async () => {
      calls.n += 1;
      return { text: JSON.stringify({ isImmediateRecap: false, act: 'resume', selectedIndex, confidence: 0.91 }) };
    },
  }) as any;
}

export async function runConversationalContinuityResumptionTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  console.log(`\n${BOLD}-- Conversational Continuity B2 --------------------------------${RESET}\n`);

  {
    const db = await openDb();
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const grocery = await processUtterance(GROCERY, session, deps(), null, null, null, null, null, null, ledger);
    const afterGrocery = rowCounts(db);
    assertTrue('grocery interruption stays a capability capture', grocery.handled === true && grocery.source === 'capture');
    assertTrue('grocery interruption is not topic content', ledger.peek(Date.now()).at(-1)?.operation === 'capture' && ledger.peek(Date.now()).at(-1)?.focus.every((entry) => entry.kind !== 'topic') === true);
    const calls = { n: 0 };
    const resumed = await answerImmediateSemanticRecap('Back to what we were talking about.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(calls),
    });
    assert('content-free resumption recaps the interrupted job', resumed.handled ? resumed.reply : '', JOB_RECAP);
    assert('content-free resumption consulted Stage B once', calls.n, 1);
    assert('resumption adds no database rows beyond the grocery write', rowCounts(db), afterGrocery);
    const equivalentCalls = { n: 0 };
    const equivalent = await answerImmediateSemanticRecap("Let's go back to what I was saying.", {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(equivalentCalls),
    });
    assert('semantic equivalent resumption recaps the same job', equivalent.handled ? equivalent.reply : '', JOB_RECAP);
    const specificCalls = { n: 0 };
    const specific = await answerImmediateSemanticRecap('Back to the job thing.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(specificCalls, 0),
    });
    assert('content-bearing resumption selects the job', specific.handled ? specific.reply : '', JOB_RECAP);
    const skyCalls = { n: 0 };
    const sky = await answerImmediateSemanticRecap('The sky looks grey today.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(skyCalls),
    });
    assertTrue('unrelated declarative after interruption is not resumption', sky.handled === false);
    assert('unrelated declarative does not consult Stage B', skyCalls.n, 0);
    assert('resumption utterance is not published as a topic', ledgerFocusWithConversationalTopic([], {
      operation: 'read',
      utterance: 'Back to what we were talking about.',
    }).length, 0);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    ledger.push({
      establishedAt: Date.now(),
      utterance: GROCERY,
      intentType: 'list_add',
      operation: 'capture',
      outcome: 'committed',
      authorityTier: 'deterministic',
      assistantReplySummary: null,
      focus: [{ kind: 'item', displayValue: 'milk', referable: true, tier: 'authoritative' }],
    });
    const calls = { n: 0 };
    const selected = await answerImmediateSemanticRecap('Back to the job thing.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(calls, 0),
    });
    assert('discriminator selects the job even when Stage B points at the other thread', selected.handled ? selected.reply : '', JOB_RECAP);
    assertTrue('selected job recap does not include the other thread', selected.handled === true && !selected.reply.includes('busy day'));
    const ambiguous = await answerImmediateSemanticRecap('Back to the job thing.', {
      ledgerEntries: (() => {
        const both = createConversationTurnLedger();
        publish(both, JOB);
        publish(both, OTHER_JOB);
        both.push({
          establishedAt: Date.now(),
          utterance: GROCERY,
          intentType: 'list_add',
          operation: 'capture',
          outcome: 'committed',
          authorityTier: 'deterministic',
          assistantReplySummary: null,
          focus: [{ kind: 'item', displayValue: 'milk', referable: true, tier: 'authoritative' }],
        });
        return both.peek(Date.now());
      })(),
      getInterpreterCtx: resumeCtx({ n: 0 }, 0),
    });
    assert('insufficient discriminator clarifies once', ambiguous.handled ? ambiguous.kind : null, 'clarify_ambiguous');
    assertTrue('the clarification names both job threads', ambiguous.handled === true && ambiguous.kind === 'clarify_ambiguous' && ambiguous.reply.includes(JOB) && ambiguous.reply.includes(OTHER_JOB));
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const calls = { n: 0 };
    const missed = await answerImmediateSemanticRecap('Back to what we were talking about.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(calls),
    });
    assertTrue('resumption without an interruption does not invent the prior topic', missed.handled === false);
    assert('resumption without an interruption does not consult Stage B', calls.n, 0);
    const longCalls = { n: 0 };
    ledger.push({
      establishedAt: Date.now(),
      utterance: GROCERY,
      intentType: 'list_add',
      operation: 'capture',
      outcome: 'committed',
      authorityTier: 'deterministic',
      assistantReplySummary: null,
      focus: [{ kind: 'item', displayValue: 'milk', referable: true, tier: 'authoritative' }],
    });
    const long = await answerImmediateSemanticRecap('I wanted to go back to the job after I finish the other errands today.', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(longCalls, 0),
    });
    assertTrue('an over-bound declarative is not resumption', long.handled === false);
    assert('an over-bound declarative does not consult Stage B', longCalls.n, 0);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const calls = { n: 0 };
    const recap = await answerImmediateSemanticRecap('Do you know what we were just talking about?', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: resumeCtx(calls),
    });
    assert('B1 generic recap is unchanged', recap.handled ? recap.reply : '', WINDOW);
    assert('B1 generic recap does not consult resumption Stage B', calls.n, 0);
    const session = new ConversationSession();
    const who = await processUtterance('Who am I talking about?', session, deps());
    assert('who remains a profile identity read', who.routeDecision.reason, 'profile:lookup');
    assert('named-store recall still declines without a hold', inspectHolds('What did I tell you about Eliquis?', null).kind, 'not_recall');
  }

  console.log(`\n${BOLD}RESULTS: ${passed} passed / ${failures.length} failed / ${passed + failures.length} total${RESET}\n`);
  return { passed, failed: failures.length, total: passed + failures.length };
}

if (process.argv[1]?.endsWith('conversationalContinuityResumption.test.ts')) {
  runConversationalContinuityResumptionTests();
}
