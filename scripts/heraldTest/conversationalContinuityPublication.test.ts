// Conversational Continuity V1 — Commit A publication.
// Proves topic focus is RAM-only user wording and that the existing
// Immediate Recap owner can read it. Does not own generic question routing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger, ConversationTurnOperation } from '../../src/routing/conversationTurnLedger.ts';
import {
  continuityLedgerFocus,
  ledgerFocusWithConversationalTopic,
} from '../../src/routing/conversationTurnLedgerWrite.ts';
import {
  answerImmediateSemanticRecap,
  classifyImmediateRecapDeterministic,
} from '../../src/routing/immediateSemanticRecap.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const BUSY = "I've had a really busy day.";
const JOB = "I'm leaving my job so I'm trying to get everything ready for the people taking over.";
const WORN = "I've been feeling really worn out since the weekend.";

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
    getMedicationSemanticInterpreterCtx: () => ({ completion: async () => ({ text: '[]' }) }),
  };
}

function publish(ledger: ConversationTurnLedger, utterance: string, operation: ConversationTurnOperation = 'conversational') {
  ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation,
    outcome: 'generated',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    focus: ledgerFocusWithConversationalTopic([], {
      operation,
      utterance,
    }),
  });
}

export async function runConversationalContinuityPublicationTests() {
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

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const envelope = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8')
    .match(/export type DomainFocusEnvelope = \{[\s\S]*?\n\};/)?.[0] ?? '';
  const ledgerSrc = fs.readFileSync(path.join(root, 'src/routing/conversationTurnLedger.ts'), 'utf8');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  assertTrue('topic is not a domain-envelope kind', envelope.length > 0 && !envelope.includes("'topic'"));
  assertTrue('ledger focus kind includes topic', ledgerSrc.includes("| 'topic'"));
  assertTrue('ledger module imports no database', !/from ['"].*\/db\//.test(ledgerSrc));
  assertTrue('ChatScreen publishes conversational topic focus', chatSrc.includes('ledgerFocusWithConversationalTopic'));

  {
    const db = await openDb();
    const before = rowCounts(db);
    const session = new ConversationSession();
    const ledger = createConversationTurnLedger();
    const outcome = await processUtterance(JOB, session, deps(), null, null, null, null, null, null, ledger);
    assertTrue('job turn stays an unhandled conversational route', !outcome.handled && outcome.routeDecision.kind === 'needs_clarification' && outcome.routeDecision.reason === 'default');
    publish(ledger, JOB);
    const recap = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('existing recap owner handles the published job turn', recap.handled === true && recap.kind === 'conversational_recap');
    assert('existing owner reports the user utterance', recap.handled ? recap.reply : '', `You mentioned ${JOB}.`);
    const record = ledger.peek(Date.now()).at(-1);
    assert('published topic is conversational and referable', record?.focus[0], {
      kind: 'topic',
      displayValue: JOB,
      referable: true,
      tier: 'conversational',
    });
    assert('publication writes no database rows', rowCounts(db), before);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const recap = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('two published topics stay with the existing owner', recap.handled === true && recap.kind === 'clarify_ambiguous');
    assert('existing owner names both user utterances', recap.handled ? recap.reply : '', `Did you mean ${JOB} or ${BUSY}?`);
    const generic = await answerImmediateSemanticRecap('Do you know what we were just talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('generic recap wording is not claimed by publication alone', generic.handled === false);
    assertTrue('generic recap wording is not Stage A', classifyImmediateRecapDeterministic('Do you know what we were just talking about?') === false);
  }

  {
    const db = await openDb();
    const beforeMeds = (db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n;
    const session = new ConversationSession();
    const outcome = await processUtterance(WORN, session, deps());
    assertTrue('medical conversational wording is not a capture', !outcome.handled && outcome.routeDecision.reason === 'default');
    const focus = ledgerFocusWithConversationalTopic([], { operation: 'conversational', utterance: WORN });
    assert('medical conversational topic is the user sentence', focus[0]?.displayValue, WORN);
    assert('medical conversational topic is not a domain thing', focus[0]?.kind, 'topic');
    const ledger = createConversationTurnLedger();
    ledger.push({
      establishedAt: Date.now(),
      utterance: WORN,
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus,
    });
    const recap = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('medical recap is reported speech of the user sentence', recap.handled ? recap.reply : '', `You mentioned ${WORN}.`);
    assertTrue('medical conversational recap does not invent a dosage', recap.handled && !recap.reply.includes('mg'));
    assert('medical conversational turn writes no medication row', (db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n, beforeMeds);
  }

  {
    const db = await openDb();
    const session = new ConversationSession();
    const ledger = createConversationTurnLedger();
    const outcome = await processUtterance('I take Metformin 500 mg twice a day.', session, deps(), null, null, null, null, null, null, ledger);
    assertTrue('medication floor remains a capture', outcome.handled === true && outcome.source === 'capture');
    const existing = ledger.peek(Date.now())[0]?.focus ?? [];
    assert('medication focus stays a thing', existing[0]?.kind, 'thing');
    const next = ledgerFocusWithConversationalTopic(existing, {
      operation: 'capture',
      utterance: 'I take Metformin 500 mg twice a day.',
    });
    assertTrue('existing domain focus is not duplicated with a topic', next.length === existing.length && next.every((entry) => entry.kind !== 'topic'));
    assert('medication capture still writes no row before confirmation', (db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n, 0);
  }

  {
    const person = continuityLedgerFocus({ kind: 'person', displayValue: 'Alina', referable: true }, true);
    const next = ledgerFocusWithConversationalTopic(person, {
      operation: 'conversational',
      utterance: 'I was talking with Alina about the weekend.',
    });
    assert('person focus remains the only entry', next.map((entry) => entry.kind), ['person']);
    assert('person display value is unchanged', next[0]?.displayValue, 'Alina');
  }

  {
    const session = new ConversationSession();
    const outcome = await processUtterance('Who am I talking about?', session, deps());
    assertTrue('who-am-I lookup stays a profile read', !outcome.handled && outcome.routeDecision.kind === 'device_read' && outcome.routeDecision.reason === 'profile:lookup');
  }

  {
    const session = new ConversationSession();
    const ledger = createConversationTurnLedger();
    await processUtterance('Add milk to my grocery list.', session, deps(), null, null, null, null, null, null, ledger);
    const kinds = ledger.peek(Date.now()).flatMap((record) => record.focus.map((entry) => entry.kind));
    assertTrue('grocery capture does not publish a topic', kinds.every((kind) => kind !== 'topic'));
  }

  {
    const none = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: 'email me at person@example.com about the day',
    });
    assert('identifier-shaped wording is not published', none, []);
    const one = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: 'about his trip to Ireland',
      groundedSpans: ['Ireland'],
      discourseMentionIds: ['m-ireland'],
    });
    assert('one grounded user span is the topic display', one[0]?.displayValue, 'Ireland');
    const many = ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance: 'Ireland and the harbor',
      groundedSpans: ['Ireland', 'harbor'],
    });
    assert('multiple spans stay the user utterance', many[0]?.displayValue, 'Ireland and the harbor');
    const ledger = createConversationTurnLedger();
    ledger.push({
      establishedAt: Date.now(),
      utterance: 'about his trip to Ireland',
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: one,
    });
    const suppressed = await answerImmediateSemanticRecap('What did I just tell you?', {
      ledgerEntries: ledger.peek(Date.now()),
      discourseMentions: [{ mentionId: 'm-ireland', status: 'corrected_away' }],
    });
    assertTrue('corrected-away topic is not active recap content', suppressed.handled === true && suppressed.kind === 'honest_miss');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationalContinuityPublication: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalContinuityPublication.test.ts')) {
  runConversationalContinuityPublicationTests();
}
