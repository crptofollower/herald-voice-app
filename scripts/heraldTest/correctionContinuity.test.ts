// Correction Continuity V1. Closed marker, typed or aligned slot, read-time supersession.

import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnLedger, ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { ledgerFocusWithConversationalTopic } from '../../src/routing/conversationTurnLedgerWrite.ts';
import {
  answerImmediateSemanticRecap,
  buildRecapCandidates,
  validateFrozenResumptionTopics,
  peekInterruptedSegment,
} from '../../src/routing/immediateSemanticRecap.ts';
import { appendResumptionOffer } from '../../src/routing/resumptionOffer.ts';
import { correctionSpeech, clarifySpeech } from '../../src/routing/discourseCorrection.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';
import { CORRECTION_CLARIFY_KEY, CORRECTION_CONFIRM_KEY } from '../../src/routing/correctionContinuity.ts';
import { createHotNarrativeRing, hasImmediatelyAdjacentHotAuthorization } from '../../src/utils/hotNarrativeRing.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const MARCH = "I'm leaving in March.";
const APRIL_SPEECH = correctionSpeech('event_or_topic', 'April');
const TUESDAY = 'My appointment is Tuesday.';
const DALLAS = 'He lives in Dallas.';
const ROUTE = 'Flying from Dallas to Rome.';
const MEETING = 'John is meeting Mike in March.';
const REASK = "I'm not sure I'm following — can you say that again?";

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

function deps(calls: { n: number }, contacts: string[] = []) {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts, lists: [] as string[] },
    getMedicationSemanticInterpreterCtx: () => {
      calls.n += 1;
      return null;
    },
  };
}

function publish(ledger: ConversationTurnLedger, utterance: string, mentionIds?: string[]) {
  const admitted = ledgerFocusWithConversationalTopic([], {
    operation: 'conversational',
    utterance,
    ...(mentionIds ? { discourseMentionIds: mentionIds } : {}),
  });
  const focus = admitted.length > 0 || utterance !== ROUTE
    ? admitted
    : [{
      kind: 'topic' as const,
      displayValue: utterance,
      referable: true,
      tier: 'conversational' as const,
      ...(mentionIds ? { discourseMentionIds: mentionIds } : {}),
    }];
  return ledger.push({
    establishedAt: Date.now(),
    utterance,
    intentType: null,
    operation: 'conversational',
    outcome: 'generated',
    authorityTier: 'conversational',
    assistantReplySummary: null,
    focus,
  });
}

function snapshot(record: ConversationTurnRecord): string {
  return JSON.stringify(record);
}

async function recap(ledger: ConversationTurnLedger, text: string, calls: { n: number }) {
  return answerImmediateSemanticRecap(text, {
    ledgerEntries: ledger.peek(Date.now()),
    getInterpreterCtx: () => {
      calls.n += 1;
      return null;
    },
  });
}

export async function runCorrectionContinuityTests() {
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

  console.log(`\n${BOLD}-- Correction Continuity V1 ----------------------------------${RESET}\n`);

  {
    const db = await openDb();
    const before = rowCounts(db);
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const beforeRecord = snapshot(original);
    const session = new ConversationSession();
    const outcome = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, null, ledger);
    const live = ledger.peek(Date.now());
    const revised = live[live.length - 1]!;
    assert('month correction speaks the existing line', outcome.handled ? outcome.responseText : '', APRIL_SPEECH);
    assertTrue('month correction is correction continuity', outcome.handled === true && outcome.source === 'correction_continuity');
    assertTrue('revised topic says April', revised.focus[0]?.displayValue === "I'm leaving in April.");
    assertTrue('original March record is byte-unchanged', snapshot(original) === beforeRecord);
    assert('supersedes names the original topic', revised.supersedes, [{ turnIndex: original.turnIndex, focusIndex: 0 }]);
    assertTrue('April topic records its source span', revised.focus[0]?.derivedFrom?.replacement === 'April' && revised.focus[0]?.derivedFrom?.turnIndex === original.turnIndex);
    assertTrue('No, April is not its own topic', revised.focus.every((entry) => entry.displayValue !== 'No, April.'));
    const told = await recap(ledger, 'What did I just tell you?', calls);
    const where = await recap(ledger, 'Where were we?', calls);
    assertTrue('just-told recap is the April version', told.handled === true && told.reply.includes('April') && !told.reply.includes('March'));
    assertTrue('where-were-we recap is the April version', where.handled === true && where.reply.includes('April') && !where.reply.includes('March'));
    assert('conversational correction writes no rows', rowCounts(db), before);
    assert('correction path makes no semantic call', calls.n, 0);
    assertTrue('applied correction exposes the HOT pair', outcome.handled === true && outcome.correctionHot?.user === 'No, April.' && outcome.correctionHot.assistant === APRIL_SPEECH);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, TUESDAY);
    const session = new ConversationSession();
    const outcome = await processUtterance('Actually, Wednesday.', session, deps(calls), null, null, null, null, null, null, ledger);
    const revised = ledger.peek(Date.now()).at(-1)!;
    assert('weekday correction is direct', outcome.handled ? outcome.responseText : '', correctionSpeech('event_or_topic', 'Wednesday'));
    assertTrue('weekday topic is revised', revised.focus[0]?.displayValue === 'My appointment is Wednesday.');
    const waited = await processUtterance('Wait, Thursday.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('wait marker revises the new weekday', waited.handled ? waited.responseText : '', correctionSpeech('event_or_topic', 'Thursday'));
    assertTrue('wait marker leaves one current weekday', ledger.peek(Date.now()).at(-1)?.focus[0]?.displayValue === 'My appointment is Thursday.');
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, DALLAS);
    const beforeRecord = snapshot(original);
    const session = new ConversationSession();
    const asked = await processUtterance('Sorry, Austin.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('open slot asks before replacing', asked.handled ? asked.responseText : '', 'Austin instead of Dallas?');
    assert('open slot arms a yes/no hold', session.peekPendingKey(), CORRECTION_CONFIRM_KEY);
    assertTrue('confirmation publishes nothing yet', snapshot(original) === beforeRecord && ledger.peek(Date.now()).every((record) => !record.supersedes));
    const yes = await processUtterance('Yes', session, deps(calls), null, null, null, null, null, null, ledger);
    const revised = ledger.peek(Date.now()).at(-1)!;
    assert('confirmed open slot uses the existing line', yes.handled ? yes.responseText : '', correctionSpeech('event_or_topic', 'Austin'));
    assertTrue('confirmed place is Austin', revised.focus[0]?.displayValue === 'He lives in Austin.');
    assertTrue('confirmation clears the hold', session.peekPendingKey() === null);
    assertTrue('yes turn carries the correction into HOT', yes.handled === true && yes.correctionHot?.user === 'Sorry, Austin.' && yes.correctionHot.assistant.includes('Austin'));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, DALLAS);
    const beforeRecord = snapshot(original);
    const session = new ConversationSession();
    await processUtterance('Sorry, Austin.', session, deps(calls), null, null, null, null, null, null, ledger);
    const no = await processUtterance('No.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('confirmation no releases', no.handled ? no.responseText : '', 'Okay.');
    assertTrue('confirmation no leaves Dallas', snapshot(original) === beforeRecord && session.peekPendingKey() === null);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, DALLAS);
    const session = new ConversationSession();
    await processUtterance('Sorry, Austin.', session, deps(calls), null, null, null, null, null, null, ledger);
    const released = await processUtterance('The sky looks grey today.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('non-yes/no releases the confirmation', session.peekPendingKey() === null);
    assertTrue('released confirmation does not revise Dallas', original.focus[0]?.displayValue === DALLAS);
    assertTrue('released reply is not a correction', !(released.handled && released.source === 'correction_continuity' && released.responseText.startsWith('Got it')));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const beforeRecord = snapshot(original);
    const session = new ConversationSession();
    const outcome = await processUtterance("No, I'm leaving in April.", session, deps(calls), null, null, null, null, null, null, ledger);
    assert('aligned restatement revises directly', outcome.handled ? outcome.responseText : '', APRIL_SPEECH);
    assertTrue('aligned topic says April', ledger.peek(Date.now()).at(-1)?.focus[0]?.displayValue === "I'm leaving in April.");
    assertTrue('aligned correction leaves the original record', snapshot(original) === beforeRecord);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, ROUTE);
    const session = new ConversationSession();
    const asked = await processUtterance('No, Austin.', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('two places ask which one', asked.handled ? asked.responseText : '', clarifySpeech('Which one should I correct:', ['Dallas', 'Rome']));
    assert('clarification uses the clarify hold', session.peekPendingKey(), CORRECTION_CLARIFY_KEY);
    assertTrue('clarification supersedes nothing', ledger.peek(Date.now()).every((record) => !record.supersedes));
    const missed = await processUtterance('Paris', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('non-matching clarification releases', session.peekPendingKey() === null && original.focus[0]?.displayValue === ROUTE);
    assertTrue('non-matching clarification does not apply', !(missed.handled && missed.source === 'correction_continuity' && missed.responseText.startsWith('Got it')));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, ROUTE);
    const session = new ConversationSession();
    await processUtterance('No, Austin.', session, deps(calls), null, null, null, null, null, null, ledger);
    const chosen = await processUtterance('Dallas', session, deps(calls), null, null, null, null, null, null, ledger);
    assert('chosen place applies', chosen.handled ? chosen.responseText : '', correctionSpeech('event_or_topic', 'Austin'));
    assertTrue('Dallas becomes Austin and Rome stays', ledger.peek(Date.now()).at(-1)?.focus[0]?.displayValue === 'Flying from Austin to Rome.');
  }

  {
    const calls = { n: 0 };
    const utterance = MEETING;
    const discourse = new DiscourseContinuityHolder();
    const mikeAt = utterance.indexOf('Mike');
    const admitted = discourse.admitDiscourseProposals(utterance, [
      { kind: 'person', surfaceSpan: 'John', start: 0, end: 4 },
      { kind: 'person', surfaceSpan: 'Mike', start: mikeAt, end: mikeAt + 4 },
    ]);
    const ids = admitted.admitted.map((mention) => mention.mentionId);
    const surfacesBefore = discourse.peekDiscourseMentions().map((mention) => `${mention.surfaceSpan}:${mention.status}`);
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, utterance, ids);
    const session = new ConversationSession();
    const april = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, discourse, ledger);
    const revised = ledger.peek(Date.now()).at(-1)!;
    assertTrue('persons were admitted', ids.length === 2);
    assert('unique month among persons is revised', april.handled ? april.responseText : '', APRIL_SPEECH);
    assertTrue('meeting still names John and Mike', revised.focus[0]?.displayValue === 'John is meeting Mike in April.');
    assert('person mention ids stay on the revised topic', revised.focus[0]?.discourseMentionIds, ids);
    assert('person mentions are unchanged', discourse.peekDiscourseMentions().map((mention) => `${mention.surfaceSpan}:${mention.status}`), surfacesBefore);
    const candidates = buildRecapCandidates(ledger.peek(Date.now()), discourse.peekDiscourseMentions());
    assertTrue('recap candidates keep the people and the new month', candidates.some((candidate) => candidate.displayValue.includes('John') && candidate.displayValue.includes('Mike') && candidate.displayValue.includes('April') && !candidate.displayValue.includes('March')));
    const steveLedger = createConversationTurnLedger();
    const steveOriginal = publish(steveLedger, utterance, ids);
    const steveBefore = snapshot(steveOriginal);
    const steveSession = new ConversationSession();
    const steve = await processUtterance('No, Steve.', steveSession, deps(calls), null, null, null, null, null, discourse, steveLedger);
    assertTrue('person-shaped correction declines', !(steve.handled && steve.source === 'correction_continuity'));
    assertTrue('declined person correction leaves the meeting', snapshot(steveOriginal) === steveBefore && steveLedger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, MARCH);
    const session = new ConversationSession();
    const ambiguous = await processUtterance('No, April or May.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('two typed values decline', !(ambiguous.handled && ambiguous.source === 'correction_continuity'));
    assertTrue('ambiguous value publishes nothing', ledger.peek(Date.now()).every((record) => !record.supersedes) && ledger.peek(Date.now())[0]?.focus[0]?.displayValue === MARCH);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const session = new ConversationSession();
    const restated = await processUtterance("I'm leaving in April.", session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('bare restatement is not a correction', !(restated.handled && restated.source === 'correction_continuity'));
    assertTrue('bare restatement leaves March', original.focus[0]?.displayValue === MARCH && ledger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    ledger.push({
      establishedAt: Date.now() - 11 * 60 * 1000,
      utterance: MARCH,
      intentType: null,
      operation: 'conversational',
      outcome: 'generated',
      authorityTier: 'conversational',
      assistantReplySummary: null,
      focus: ledgerFocusWithConversationalTopic([], { operation: 'conversational', utterance: MARCH }),
    });
    const session = new ConversationSession();
    const expired = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('expired target declines', !(expired.handled && expired.source === 'correction_continuity'));
    assertTrue('expired target publishes nothing', ledger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const beforeRecord = snapshot(original);
    const session = new ConversationSession();
    await processUtterance('Add milk to my grocery list.', session, deps(calls), null, null, null, null, null, null, ledger);
    const declined = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('intervening capture is not a correction target', !(declined.handled && declined.source === 'correction_continuity'));
    assertTrue('intervening capture leaves March unchanged', snapshot(original) === beforeRecord && ledger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const session = new ConversationSession();
    const milk = await processUtterance('Add milk to my grocery list.', session, deps(calls), null, null, null, null, null, null, ledger);
    const milkRecord = ledger.peek(Date.now()).at(-1)!;
    const beforeRecord = snapshot(milkRecord);
    const eggs = await processUtterance('No, eggs.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('committed capture is not revised by correction continuity', milk.handled === true && milk.source === 'capture');
    assertTrue('No, eggs after a commit declines correction continuity', !(eggs.handled && eggs.source === 'correction_continuity'));
    assertTrue('milk record stays unchanged', snapshot(milkRecord) === beforeRecord && ledger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const session = new ConversationSession();
    establishHardPending(session, {
      pendingKey: 'llm_confirm:list_add',
      resume: async () => ({ status: 'noop', ack: '' }),
      correctable: {
        currentValue: 'milk',
        buildCorrected: (newValue: string) => ({
          pendingKey: 'llm_confirm:list_add',
          prompt: `Did you mean ${newValue}?`,
          resume: async () => ({ status: 'noop', ack: '' }),
        }),
      },
    });
    const owned = await processUtterance('No, eggs.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('pending owns No, eggs', owned.handled === true && owned.source === 'pending_resume');
    assert('pending re-asks instead of revising March', owned.handled ? owned.responseText : '', REASK);
    assertTrue('pending turn does not supersede March', original.focus[0]?.displayValue === MARCH && ledger.peek(Date.now()).every((record) => !record.supersedes));
    const repairSession = new ConversationSession();
    establishHardPending(repairSession, {
      pendingKey: 'llm_confirm:list_add',
      resume: async () => ({ status: 'noop', ack: '' }),
      correctable: {
        currentValue: 'milk',
        buildCorrected: (newValue: string) => ({
          pendingKey: 'llm_confirm:list_add',
          prompt: `Did you mean ${newValue}?`,
          resume: async () => ({ status: 'noop', ack: '' }),
        }),
      },
    });
    const repaired = await processUtterance("No, it's eggs.", repairSession, deps(calls), null, null, null, null, null, null, ledger);
    assert('CORRECTION_REPAIR owns the pending correction', repaired.handled ? [repaired.source, repaired.responseText] : repaired, ['pending_resume', 'Did you mean eggs.?']);
    assertTrue('CORRECTION_REPAIR does not publish a topic supersession', ledger.peek(Date.now()).every((record) => !record.supersedes));
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, DALLAS);
    const session = new ConversationSession();
    const blocked = await processUtterance('Sorry, Austin.', session, deps(calls, ['Dallas']), null, null, null, null, null, null, ledger);
    assertTrue('a known contact slot is not confirmed', !(blocked.handled && blocked.source === 'correction_continuity'));
    assertTrue('contact guard publishes nothing', ledger.peek(Date.now()).every((record) => !record.supersedes) && ledger.peek(Date.now())[0]?.focus[0]?.displayValue === DALLAS);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    const original = publish(ledger, MARCH);
    const session = new ConversationSession();
    const before = new Set(ledger.peek(Date.now()).map((record) => record.turnIndex));
    const grocery = await processUtterance('Add milk to my grocery list.', session, deps(calls), null, null, null, null, null, null, ledger);
    const frozen = peekInterruptedSegment(ledger.peek(Date.now()), []);
    const offered = appendResumptionOffer({
      responseText: grocery.handled ? grocery.responseText : '',
      session,
      ledger,
      recoveryOpen: false,
      emergencyThisTurn: false,
      lastOfferedSegmentKey: null,
      turnIndicesBeforeTurn: before,
    });
    assertTrue('resume setup arms an offer', offered.offered === true && frozen != null);
    const yes = await processUtterance('Yeah.', session, deps(calls), null, null, null, null, null, null, ledger);
    assertTrue('resume yes is not a correction', yes.handled === true && yes.source === 'resumption_offer');
    const corrected = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, null, ledger);
    const live = ledger.peek(Date.now());
    const revised = live.at(-1)!;
    assert('correction after resume revises the carried topic', corrected.handled ? corrected.responseText : '', APRIL_SPEECH);
    assert('resume correction supersedes the original identity', revised.supersedes, [{ turnIndex: original.turnIndex, focusIndex: 0 }]);
    assertTrue('original wording survives the resume correction', original.focus[0]?.displayValue === MARCH);
    const told = await recap(ledger, 'What did I just tell you?', calls);
    assertTrue('recap after resume correction is April only', told.handled === true && told.reply.includes('April') && !told.reply.includes('March'));
    const revalidated = validateFrozenResumptionTopics(live, frozen!, []);
    assertTrue('frozen resumption target skips the superseded topic', Array.isArray(revalidated) && revalidated.length === 0);
  }

  {
    const calls = { n: 0 };
    const ledger = createConversationTurnLedger();
    publish(ledger, MARCH);
    const session = new ConversationSession();
    const corrected = await processUtterance('No, April.', session, deps(calls), null, null, null, null, null, null, ledger);
    const ring = createHotNarrativeRing();
    if (corrected.handled && corrected.correctionHot) {
      ring.push({
        turnIndex: 1,
        user: corrected.correctionHot.user,
        assistant: corrected.correctionHot.assistant,
        establishedAt: Date.now(),
        assistantHotPolicy: 'include',
      });
    }
    const follow = await processUtterance("I've got a lot to finish before then.", session, deps(calls), null, null, null, null, null, null, ledger);
    const told = await recap(ledger, 'What did I just tell you?', calls);
    const screen = readFileSync(new URL('../../src/screens/ChatScreen.tsx', import.meta.url), 'utf8');
    assertTrue('progress turn is an ordinary continuation', !(follow.handled && follow.source === 'correction_continuity'));
    assertTrue('HOT adjacency sees the correction pair', hasImmediatelyAdjacentHotAuthorization(ring.peek(Date.now()), 2));
    assertTrue('later recap stays on April', told.handled === true && told.reply.includes('April') && !told.reply.includes('March'));
    assertTrue('ChatScreen writes the correction HOT pair', screen.includes('outcome.correctionHot'));
    assert('progress path makes no semantic call', calls.n, 0);
  }

  console.log(`\n${BOLD}RESULTS: ${passed} passed / ${failures.length} failed / ${passed + failures.length} total${RESET}\n`);
  return { passed, failed: failures.length, total: passed + failures.length };
}

if (process.argv[1]?.endsWith('correctionContinuity.test.ts')) {
  runCorrectionContinuityTests().then((result) => {
    if (result.failed) process.exit(1);
  });
}
