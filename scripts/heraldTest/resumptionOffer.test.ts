// Deterministic Resumption Offer V1.
// Topic, then a completed interruption, then one anchored reply.
// YES realizes the frozen segment. Anything else releases the offer first.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger, ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { ledgerFocusWithConversationalTopic } from '../../src/routing/conversationTurnLedgerWrite.ts';
import { answerImmediateSemanticRecap, HONEST_RECAP_MISS } from '../../src/routing/immediateSemanticRecap.ts';
import {
  appendResumptionOffer,
  currentTurnLedgerRecord,
  RESUMPTION_DECLINE_TEXT,
  RESUMPTION_OFFER_KEY,
  RESUMPTION_OFFER_TEXT,
} from '../../src/routing/resumptionOffer.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const JOB = "I'm leaving my job so I'm trying to get everything ready for the people taking over.";
const JOB_RECAP = "You mentioned you're leaving your job so you're trying to get everything ready for the people taking over.";
const GARDEN = 'The garden needs water before Friday.';
const GROCERY = 'Add milk to my grocery list.';
const EGGS = 'Add eggs to my grocery list.';
const REASK = "I'm not sure I'm following — can you say that again?";
const RELEASE = "Let's come back to that — just tell me again anytime.";
const GENERIC_CANCEL = "No problem — I won't do that.";

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

function deps(calls: { n: number }) {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    getMedicationSemanticInterpreterCtx: () => {
      calls.n += 1;
      return null;
    },
  };
}

function publish(ledger: ConversationTurnLedger, utterance: string, mentionIds?: string[]) {
  return ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation: 'conversational',
    outcome: 'generated',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    focus: ledgerFocusWithConversationalTopic([], {
      operation: 'conversational',
      utterance,
      ...(mentionIds ? { discourseMentionIds: mentionIds } : {}),
    }),
  });
}

function pushRecord(ledger: ConversationTurnLedger, record: Pick<ConversationTurnRecord, 'operation' | 'outcome'> & { utterance?: string; focus?: ConversationTurnRecord['focus'] }) {
  return ledger.push({
    establishedAt: Date.now(),
    utterance: record.utterance ?? 'synthetic interruption',
    intentType: null,
    operation: record.operation,
    outcome: record.outcome,
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    focus: record.focus ?? [],
  });
}

async function interrupt(ledger: ConversationTurnLedger, session: ConversationSession, calls: { n: number }, text = GROCERY) {
  return processUtterance(text, session, deps(calls), null, null, null, null, null, null, ledger);
}

function turnIndices(ledger: ConversationTurnLedger): Set<number> {
  return new Set(ledger.peek(Date.now()).map((record) => record.turnIndex));
}

function offerAfter(
  ledger: ConversationTurnLedger,
  session: ConversationSession,
  responseText: string,
  lastKey: string | null,
  turnIndicesBeforeTurn: ReadonlySet<number>,
  extra?: { recoveryOpen?: boolean; emergency?: boolean; mentions?: { mentionId: string; status: string }[] },
) {
  return appendResumptionOffer({
    responseText,
    session,
    ledger,
    discourseMentions: extra?.mentions,
    recoveryOpen: extra?.recoveryOpen === true,
    emergencyThisTurn: extra?.emergency === true,
    lastOfferedSegmentKey: lastKey,
    turnIndicesBeforeTurn,
  });
}

export async function runResumptionOfferTests() {
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

  console.log(`\n${BOLD}-- Deterministic Resumption Offer V1 -------------------------${RESET}\n`);

  {
    const db = await openDb();
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const topic = publish(ledger, JOB);
    const topicEntry = topic.focus[0];
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    const afterGrocery = rowCounts(db);
    const offered = offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    assertTrue('completed capture offers resumption', offered.offered === true && offered.responseText.endsWith(RESUMPTION_OFFER_TEXT));
    assertTrue('offer keeps the capture reply', grocery.handled && offered.responseText.startsWith(grocery.responseText));
    assert('offer arms the single resumption slot', session.peekPendingKey(), RESUMPTION_OFFER_KEY);
    calls.n = 0;
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('yeah resumes the frozen segment', yes.handled ? yes.responseText : '', JOB_RECAP);
    const resumed = ledger.peek(Date.now()).at(-1);
    assert('yeah re-anchors a conversational record', resumed?.operation, 'conversational');
    assert('yeah re-anchor is presented', resumed?.outcome, 'presented');
    assertTrue('yeah carries the frozen topic by reference', resumed?.focus[0] === topicEntry);
    assert('yeah leaves no pending', session.peekPendingKey(), null);
    assert('offer and yeah write no sqlite rows', rowCounts(db), afterGrocery);
    assert('offer and yeah call no semantic provider', calls.n, 0);
    const next = await processUtterance('The sky looks grey today.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('turn after yeah is ordinary routing', next.handled === false);
    assert('turn after yeah has no pending leak', session.peekPendingKey(), null);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const no = await processUtterance('No.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('no declines without resuming', no.handled ? no.responseText : '', RESUMPTION_DECLINE_TEXT);
    assert('no does not re-anchor the topic', ledger.peek(Date.now()).at(-1)?.operation, 'capture');
    assert('no leaves no pending', session.peekPendingKey(), null);
    const after = await processUtterance('The sky looks grey today.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('turn after no is ordinary routing', after.handled === false);
    assert('turn after no has no pending leak', session.peekPendingKey(), null);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const cancel = await processUtterance('Never mind.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('cancel declines without the generic cancel ack', cancel.handled ? cancel.responseText : '', RESUMPTION_DECLINE_TEXT);
    assertTrue('cancel is not the generic pending cancel', (cancel.handled ? cancel.responseText : '') !== GENERIC_CANCEL);
    assert('cancel leaves no pending', session.peekPendingKey(), null);
  }

  for (const reply of ['Hmm.', 'Maybe.']) {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const released = await processUtterance(reply, session, deps(calls), null, null, null, null, null, null, ledger);
    const spoken = released.handled ? released.responseText : '';
    assertTrue(`${reply} releases the offer`, session.peekPendingKey() === null);
    assertTrue(`${reply} does not re-ask`, spoken !== REASK && spoken !== RELEASE && spoken !== RESUMPTION_OFFER_TEXT);
    assertTrue(`${reply} is not pending resolution`, !(released.handled && released.source === 'pending_resume'));
    const next = await processUtterance('The sky looks grey today.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue(`turn after ${reply} is ordinary routing`, next.handled === false && session.peekPendingKey() === null);
  }

  {
    const db = await openDb();
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    const offered = offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const before = rowCounts(db);
    const beforeEggs = turnIndices(ledger);
    const eggs = await processUtterance(EGGS, session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('add eggs releases then captures', eggs.handled === true && eggs.source === 'capture');
    assert('add eggs leaves no resumption pending', session.peekPendingKey(), null);
    assertTrue('add eggs writes the capture', JSON.stringify(rowCounts(db)) !== JSON.stringify(before));
    const again = offerAfter(ledger, session, eggs.handled ? eggs.responseText : '', offered.lastOfferedSegmentKey, beforeEggs);
    const eggsRecord = currentTurnLedgerRecord(ledger.peek(Date.now()), beforeEggs);
    assert('same-segment eggs capture is the current turn record', eggsRecord?.operation, 'capture');
    assertTrue('same interrupted segment is offered once', again.offered === false && !again.responseText.includes(RESUMPTION_OFFER_TEXT));
    assert('second interruption does not arm a pending', session.peekPendingKey(), null);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const released = await processUtterance('Where were we?', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('where were we releases the offer', session.peekPendingKey(), null);
    assertTrue('where were we is not swallowed by the offer', !(released.handled && (released.source === 'resumption_offer' || released.source === 'pending_resume')));
    const provider = { n: 0 };
    const recap = await answerImmediateSemanticRecap('Where were we?', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: () => {
        provider.n += 1;
        return null;
      },
    });
    assert('released where-were-we reaches the existing generic recap', recap.handled ? recap.reply : '', HONEST_RECAP_MISS);
    assert('deterministic recap calls no semantic provider', provider.n, 0);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const topic = publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    ledger.clear();
    publish(ledger, GARDEN);
    pushRecord(ledger, { operation: 'capture', outcome: 'committed', utterance: EGGS });
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('expired frozen target is an honest miss', yes.handled ? yes.responseText : '', HONEST_RECAP_MISS);
    assertTrue('expired target does not substitute the later segment', !(yes.handled && yes.responseText.includes('garden')));
    assertTrue('expired miss does not re-anchor the original topic', ledger.peek(Date.now()).every((record) => !record.focus.includes(topic.focus[0]!)));
  }

  {
    const calls = { n: 0 };
    const mentions = [{ mentionId: 'm1', status: 'active' }];
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB, ['m1']);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    const offered = offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery, { mentions });
    assertTrue('active topic is offered before correction', offered.offered === true);
    mentions[0]!.status = 'corrected_away';
    const discourse = new DiscourseContinuityHolder();
    discourse.peekDiscourseMentions = () => mentions as never;
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, discourse, ledger);
    assert('correction-suppressed topic does not resurface', yes.handled ? yes.responseText : '', HONEST_RECAP_MISS);
    assertTrue('suppressed display value is absent', !(yes.handled && yes.responseText.includes('leaving my job')));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    const offered = offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    assertTrue('no prior conversational segment offers nothing', offered.offered === false);
    assert('no prior segment leaves no pending', session.peekPendingKey(), null);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    for (const record of [
      { operation: 'clarify_request' as const, outcome: 'clarified' as const },
      { operation: 'capture' as const, outcome: 'failed' as const },
      { operation: 'capture' as const, outcome: 'pending' as const },
    ]) {
      const before = turnIndices(ledger);
      pushRecord(ledger, record);
      const offered = offerAfter(ledger, session, 'Noted.', null, before);
      assertTrue(`${record.operation}/${record.outcome} does not offer`, offered.offered === false && session.peekPendingKey() === null);
    }
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    await interrupt(ledger, session, calls);
    session.setPending({
      pendingKey: 'list_add',
      resume: async () => ({ status: 'noop', ack: 'kept' }),
    });
    const offered = offerAfter(ledger, session, 'Added milk.', null, beforeGrocery);
    assertTrue('existing pending blocks the resumption offer', offered.offered === false);
    assert('existing pending stays in place', session.peekPendingKey(), 'list_add');
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeCapture = turnIndices(ledger);
    pushRecord(ledger, { operation: 'capture', outcome: 'committed', utterance: GROCERY });
    const blocked = offerAfter(ledger, session, 'Added milk.', null, beforeCapture, { recoveryOpen: true });
    assertTrue('open soft recovery blocks the offer', blocked.offered === false && session.peekPendingKey() === null);
    const emergency = offerAfter(ledger, session, 'Added milk.', null, beforeCapture, { emergency: true });
    assertTrue('emergency turn blocks the offer', emergency.offered === false && session.peekPendingKey() === null);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeCapture = turnIndices(ledger);
    pushRecord(ledger, { operation: 'capture', outcome: 'committed', utterance: GROCERY });
    offerAfter(ledger, session, 'Added milk.', null, beforeCapture);
    const emergency = await processUtterance("I'm having an emergency", session, deps(calls), null, null, null, null, null, null, ledger);
    assert('law 0 preempts the resumption offer', emergency.handled ? emergency.source : '', 'emergency');
    assert('law 0 clears the resumption slot', session.peekPendingKey(), null);
  }

  {
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeRead = turnIndices(ledger);
    pushRecord(ledger, {
      operation: 'read',
      outcome: 'presented',
      utterance: 'What is on my grocery list?',
      focus: [{ kind: 'collection', displayValue: 'grocery', referable: true, tier: 'deterministic' }],
    });
    const offered = offerAfter(ledger, session, 'Your grocery list is empty.', null, beforeRead);
    assertTrue('referable non-topic read offers resumption', offered.offered === true);
    assert('read offer uses the resumption slot', session.peekPendingKey(), RESUMPTION_OFFER_KEY);
  }

  {
    for (const operation of ['capture', 'action', 'clarify_resolution'] as const) {
      const ledger = createConversationTurnLedger();
      publish(ledger, JOB);
      const session = new ConversationSession();
      const before = turnIndices(ledger);
      const record = pushRecord(ledger, { operation, outcome: 'committed' });
      const offered = offerAfter(ledger, session, 'Done.', null, before);
      assert('current-turn record is the interruption', currentTurnLedgerRecord(ledger.peek(Date.now()), before), record);
      assertTrue(`current ${operation} interruption offers resumption`, offered.offered === true && session.peekPendingKey() === RESUMPTION_OFFER_KEY);
    }
  }

  {
    const db = await openDb();
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    ledger.clear();
    publish(ledger, GARDEN);
    const beforeYeah = turnIndices(ledger);
    const rowsBefore = rowCounts(db);
    calls.n = 0;
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    const offered = offerAfter(ledger, session, yes.handled ? yes.responseText : '', null, beforeYeah);
    assert('expired yes without a new interruption is an honest miss', yes.handled ? yes.responseText : '', HONEST_RECAP_MISS);
    assertTrue('expired yes without a new interruption does not offer', offered.offered === false && !offered.responseText.includes(RESUMPTION_OFFER_TEXT));
    assert('expired yes without a new interruption leaves pending null', session.peekPendingKey(), null);
    assert('expired yes admission writes no sqlite rows', rowCounts(db), rowsBefore);
    assert('expired yes admission calls no semantic provider', calls.n, 0);
  }

  {
    const db = await openDb();
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    ledger.clear();
    publish(ledger, GARDEN);
    const planted = pushRecord(ledger, { operation: 'capture', outcome: 'committed', utterance: EGGS });
    const beforeYeah = turnIndices(ledger);
    const rowsBefore = rowCounts(db);
    calls.n = 0;
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    const live = ledger.peek(Date.now());
    const offered = offerAfter(ledger, session, yes.handled ? yes.responseText : '', null, beforeYeah);
    assert('expired yes with a newer interruption is an honest miss', yes.handled ? yes.responseText : '', HONEST_RECAP_MISS);
    assert('stale interruption is not the current turn record', currentTurnLedgerRecord(live, beforeYeah), null);
    assertTrue('stale interruption was already in the ledger', beforeYeah.has(planted.turnIndex) && live[live.length - 1] === planted);
    assertTrue('expired yes does not arm from the stale interruption', offered.offered === false && !offered.responseText.includes(RESUMPTION_OFFER_TEXT));
    assert('expired yes with a stale interruption leaves pending null', session.peekPendingKey(), null);
    assert('stale-interruption admission writes no sqlite rows', rowCounts(db), rowsBefore);
    assert('stale-interruption admission calls no semantic provider', calls.n, 0);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    const armed = offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const beforeYeah = turnIndices(ledger);
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    const current = currentTurnLedgerRecord(ledger.peek(Date.now()), beforeYeah);
    const offered = offerAfter(ledger, session, yes.handled ? yes.responseText : '', armed.lastOfferedSegmentKey, beforeYeah);
    assert('successful yeah resumes', yes.handled ? yes.responseText : '', JOB_RECAP);
    assert('successful yeah record is conversational', current?.operation, 'conversational');
    assertTrue('successful yeah does not arm from the older interruption', offered.offered === false && !offered.responseText.includes(RESUMPTION_OFFER_TEXT));
    assert('successful yeah leaves pending null', session.peekPendingKey(), null);
  }

  for (const reply of ['No.', 'Never mind.']) {
    const db = await openDb();
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    const grocery = await interrupt(ledger, session, calls);
    offerAfter(ledger, session, grocery.handled ? grocery.responseText : '', null, beforeGrocery);
    const beforeReply = turnIndices(ledger);
    const planted = ledger.peek(Date.now()).at(-1);
    const rowsBefore = rowCounts(db);
    calls.n = 0;
    const declined = await processUtterance(reply, session, deps(calls), null, null, null, null, null, null, ledger);
    const offered = offerAfter(ledger, session, declined.handled ? declined.responseText : '', null, beforeReply);
    assert(`${reply} declines`, declined.handled ? declined.responseText : '', RESUMPTION_DECLINE_TEXT);
    assert(`${reply} produces no current-turn record`, currentTurnLedgerRecord(ledger.peek(Date.now()), beforeReply), null);
    assertTrue(`${reply} leaves the prior interruption in place`, !!planted && beforeReply.has(planted.turnIndex));
    assertTrue(`${reply} does not arm from stale ledger state`, offered.offered === false && session.peekPendingKey() === null);
    assert(`${reply} admission writes no sqlite rows`, rowCounts(db), rowsBefore);
    assert(`${reply} admission calls no semantic provider`, calls.n, 0);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    await interrupt(ledger, session, calls);
    offerAfter(ledger, session, 'Added milk.', null, beforeGrocery);
    const beforeRelease = turnIndices(ledger);
    const released = await processUtterance('Hmm.', session, deps(calls), null, null, null, null, null, null, ledger);
    const offered = offerAfter(ledger, session, released.handled ? released.responseText : '', null, beforeRelease);
    assert('released hmm produces no current-turn record', currentTurnLedgerRecord(ledger.peek(Date.now()), beforeRelease), null);
    assertTrue('released hmm does not arm from the stale interruption', offered.offered === false && session.peekPendingKey() === null);
    assertTrue('released hmm is not an offer reply', !(released.handled && released.source === 'resumption_offer'));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, JOB);
    const session = new ConversationSession();
    const beforeGrocery = turnIndices(ledger);
    await interrupt(ledger, session, calls);
    const first = offerAfter(ledger, session, 'Added milk.', null, beforeGrocery);
    ledger.clear();
    publish(ledger, GARDEN);
    const beforeEggs = turnIndices(ledger);
    const eggs = await processUtterance(EGGS, session, deps(calls), null, null, null, null, null, null, ledger);
    const current = currentTurnLedgerRecord(ledger.peek(Date.now()), beforeEggs);
    const offered = offerAfter(ledger, session, eggs.handled ? eggs.responseText : '', first.lastOfferedSegmentKey, beforeEggs);
    assertTrue('released add-eggs is the current capture', eggs.handled === true && eggs.source === 'capture' && current?.operation === 'capture');
    assertTrue('current capture of a new segment offers resumption', offered.offered === true && offered.responseText.includes(RESUMPTION_OFFER_TEXT));
    assert('new-segment capture arms the resumption slot', session.peekPendingKey(), RESUMPTION_OFFER_KEY);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const session = new ConversationSession();
    const beforeEggs = turnIndices(ledger);
    const eggs = await processUtterance(EGGS, session, deps(calls), null, null, null, null, null, null, ledger);
    const offered = offerAfter(ledger, session, eggs.handled ? eggs.responseText : '', null, beforeEggs);
    assertTrue('add eggs with no prior segment captures', eggs.handled === true && eggs.source === 'capture');
    assertTrue('add eggs with no prior segment does not offer', offered.offered === false && session.peekPendingKey() === null);
  }

  console.log(`\n${BOLD}RESULTS: ${passed} passed / ${failures.length} failed / ${passed + failures.length} total${RESET}\n`);
  return { passed, failed: failures.length, total: passed + failures.length };
}

if (process.argv[1]?.endsWith('resumptionOffer.test.ts')) {
  runResumptionOfferTests().then((result) => {
    if (result.failed) process.exit(1);
  });
}
