// Conversational Continuity V1 — Commit B1 ownership.
// Generic window, self-recap vs empty hold-recall, specific selection,
// identity boundary, and acknowledgement precedence.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  CONVERSATION_TURN_LEDGER_TTL_MS,
  createConversationTurnLedger,
} from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger, ConversationTurnOperation } from '../../src/routing/conversationTurnLedger.ts';
import { ledgerFocusWithConversationalTopic } from '../../src/routing/conversationTurnLedgerWrite.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import { answerActiveSubjectReference, isClosedActiveSubjectIdentityLookup } from '../../src/routing/activeSubjectReference.ts';
import {
  inspectHolds,
  HOLD_RECALL_EMPTY_REPLY,
} from '../../src/routing/holdRecall.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { acknowledgeAct, projectRealization, realizationActForTurn } from '../../src/routing/responseAct.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const BUSY = "I've had a really busy day.";
const JOB = "I'm leaving my job so I'm trying to get everything ready for the people taking over.";
const DISHES = 'The kitchen sink is still full of dishes.';
const BUSY_SPOKEN = "you'd had a really busy day";
const JOB_SPOKEN = "you're leaving your job so you're trying to get everything ready for the people taking over";
const WINDOW = `You mentioned ${BUSY_SPOKEN}, and that ${JOB_SPOKEN}.`;
const JOB_RECAP = `You mentioned ${JOB_SPOKEN}.`;

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

function publish(ledger: ConversationTurnLedger, utterance: string, operation: ConversationTurnOperation = 'conversational') {
  ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation,
    outcome: 'generated',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    focus: ledgerFocusWithConversationalTopic([], { operation, utterance }),
  });
}

export async function runConversationalContinuityRecapTests() {
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

  console.log(`\n${BOLD}-- Conversational Continuity B1 --------------------------------${RESET}\n`);

  {
    const db = await openDb();
    const before = rowCounts(db);
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const entries = ledger.peek(Date.now());
    const generic = await answerImmediateSemanticRecap('Do you know what we were just talking about?', { ledgerEntries: entries });
    assertTrue('generic recap is a direct two-entry answer', generic.handled === true && generic.kind === 'conversational_recap');
    assert('generic recap is both user sentences oldest first', generic.handled ? generic.reply : '', WINDOW);
    const self = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: entries });
    assertTrue('self-recap is the conversational window', self.handled === true && self.kind === 'conversational_recap');
    assert('self-recap uses the same user sentences', self.handled ? self.reply : '', WINDOW);
    const session = new ConversationSession();
    const routed = await processUtterance('What did I just tell you?', session, deps());
    assertTrue('self-recap is not empty hold-recall', !(routed.handled && routed.source === 'hold_recall') && routed.responseText !== HOLD_RECALL_EMPTY_REPLY);
    assert('recap question publishes no topic', ledgerFocusWithConversationalTopic([], {
      operation: 'read',
      utterance: 'Do you know what we were just talking about?',
    }).length, 0);
    assert('continuity recap writes no database rows', rowCounts(db), before);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    publish(ledger, DISHES);
    const recap = await answerImmediateSemanticRecap('What were we just talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('three topics keep only the last two oldest first', recap.handled ? recap.reply : '', `You mentioned ${JOB_SPOKEN}, and that ${DISHES.replace(/[.?!]+$/, '')}.`);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    ledger.push({
      establishedAt: Date.now(),
      utterance: 'Add milk',
      intentType: 'list_add',
      operation: 'capture',
      outcome: 'committed',
      authorityTier: 'deterministic',
      assistantReplySummary: null,
      focus: [{ kind: 'item', displayValue: 'milk', referable: true, tier: 'authoritative' }],
    });
    publish(ledger, JOB);
    const recap = await answerImmediateSemanticRecap('Where were we?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('a capture turn breaks the segment', recap.handled ? recap.reply : '', JOB_RECAP);
  }

  {
    const ledger = createConversationTurnLedger();
    ledger.push({
      establishedAt: Date.now() - CONVERSATION_TURN_LEDGER_TTL_MS - 1000,
      utterance: BUSY,
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: ledgerFocusWithConversationalTopic([], { operation: 'conversational', utterance: BUSY }),
    });
    const recap = await answerImmediateSemanticRecap('What was I just saying?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('expired topic is an honest miss', recap.handled ? recap.kind : null, 'honest_miss');
  }

  {
    const recap = await answerImmediateSemanticRecap('Do you know what we were just talking about?', { ledgerEntries: [] });
    assert('fresh session generic recap is an honest miss', recap.handled ? recap.kind : null, 'honest_miss');
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const recap = await answerImmediateSemanticRecap('What did I just tell you about the weather?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('ambiguous specific selection clarifies once', recap.handled ? recap.kind : null, 'clarify_ambiguous');
    assertTrue('the clarification names both live candidates', recap.handled === true && recap.kind === 'clarify_ambiguous' && recap.reply.includes(BUSY) && recap.reply.includes(JOB));
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const recap = await answerImmediateSemanticRecap('What did I just tell you about the job?', { ledgerEntries: ledger.peek(Date.now()) });
    assertTrue('job discriminator selects only the job entry', recap.handled === true && recap.kind === 'conversational_recap' && recap.reply === JOB_RECAP);
  }

  {
    const db = await openDb();
    const session = new ConversationSession();
    const who = await processUtterance('Who am I talking about?', session, deps());
    assert('who remains a profile identity read', who.routeDecision.reason, 'profile:lookup');
    assertTrue('who is not a conversational topic recap', who.routeDecision.kind === 'device_read' && !(who.responseText ?? '').includes(JOB));
    assertTrue('who is still a closed identity act', isClosedActiveSubjectIdentityLookup('Who am I talking about?') === true);
    assertTrue('content what-talking is not an identity act', isClosedActiveSubjectIdentityLookup('What was I talking about?') === false);
    void db;
  }

  {
    const ledger = createConversationTurnLedger();
    ledger.push({
      establishedAt: Date.now(),
      utterance: 'Alina called.',
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: [{ kind: 'person', displayValue: 'Alina', referable: true, tier: 'conversational' }],
    });
    publish(ledger, BUSY);
    publish(ledger, JOB);
    const generic = await answerImmediateSemanticRecap('Do you know what we were just talking about?', { ledgerEntries: ledger.peek(Date.now()) });
    assert('content recap stays the user sentences', generic.handled ? generic.reply : '', WINDOW);
    assertTrue('content recap is not a person identity reply', generic.handled === true && !generic.reply.includes('Alina'));
    const personOnly = createConversationTurnLedger();
    personOnly.push({
      establishedAt: Date.now(),
      utterance: 'Alina called.',
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: [{ kind: 'person', displayValue: 'Alina', referable: true, tier: 'conversational' }],
    });
    const content = await answerImmediateSemanticRecap('What was I talking about?', { ledgerEntries: personOnly.peek(Date.now()) });
    const subject = await answerActiveSubjectReference('What was I talking about?', { ledgerEntries: personOnly.peek(Date.now()) });
    assert('person-only content question is an honest miss', content.handled ? content.kind : null, 'honest_miss');
    assertTrue('active subject does not answer content with the person', subject.handled === false);
  }

  {
    const filtered = inspectHolds('What did I tell you about Eliquis?', null);
    assert('named-store recall still declines without a hold', filtered.kind, 'not_recall');
    const meds = await answerImmediateSemanticRecap('What medications am I taking?', {
      ledgerEntries: createConversationTurnLedger().peek(Date.now()),
    });
    assertTrue('catalog medication read is not a conversational topic recap', meds.handled === false);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-b1', [{
      kind: 'event',
      value: 'gardenias',
      disposition: 'hold',
      episodeId: 'ep-b1',
    }]);
    const session = new ConversationSession();
    const live = await processUtterance('What did I just tell you?', session, deps(), null, null, null, null, null, discourse);
    assertTrue('a live hold still owns whole-set recall', live.handled === true && live.source === 'hold_recall' && live.responseText.includes('gardenias'));
  }

  {
    async function spoken(utterance: string) {
      const ledger = createConversationTurnLedger();
      publish(ledger, utterance);
      const recap = await answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: ledger.peek(Date.now()) });
      return recap.handled ? recap.reply : '';
    }
    assert('I is framed as the user', await spoken('I called.'), 'You mentioned you called.');
    assert("I'm is framed as the user", await spoken("I'm leaving."), "You mentioned you're leaving.");
    assert("I've is framed as the user", await spoken("I've had a really busy day."), `You mentioned ${BUSY_SPOKEN}.`);
    assert("I'd is framed as the user", await spoken("I'd rather stay."), "You mentioned you'd rather stay.");
    assert("I'll is framed as the user", await spoken("I'll call later."), "You mentioned you'll call later.");
    assert('my is framed as the user', await spoken('my appointment is Tuesday.'), 'You mentioned your appointment is Tuesday.');
    assert('me is framed as the user', await spoken('She told me.'), 'You mentioned She told you.');
    assert('quoted names and values stay verbatim', await spoken('I saw "Metformin" and said "I take it".'), 'You mentioned you saw "Metformin" and said "I take it".');
    const db = await openDb();
    const before = rowCounts(db);
    const worn = await spoken("I've been feeling really worn out since the weekend.");
    assert('medical reported speech stays attributed to the user', worn, "You mentioned you'd been feeling really worn out since the weekend.");
    assertTrue('medical reported speech is not Herald claiming the symptom', !worn.includes("I've") && !worn.includes("I'm"));
    assert('perspective recap writes no database rows', rowCounts(db), before);
  }

  {
    const ack = acknowledgeAct('Got it — Ireland.');
    const recapReply = `You mentioned ${BUSY_SPOKEN}.`;
    assert('acknowledgement still replaces speech when recap does not own the turn', projectRealization(realizationActForTurn(false, ack), recapReply).speech, ack.text);
    assert('acknowledgement cannot replace an Immediate Recap reply', projectRealization(realizationActForTurn(true, ack), recapReply).speech, recapReply);
  }

  console.log(`\n${BOLD}RESULTS: ${passed} passed / ${failures.length} failed / ${passed + failures.length} total${RESET}\n`);
  return { passed, failed: failures.length, total: passed + failures.length };
}

if (process.argv[1]?.endsWith('conversationalContinuityRecap.test.ts')) {
  runConversationalContinuityRecapTests();
}
