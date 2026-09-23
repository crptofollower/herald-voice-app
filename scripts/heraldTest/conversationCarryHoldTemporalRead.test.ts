// Conversation Carry V1 / Slice 4 — targeted temporal reads from live holds.
// Event span comes from the question; date authority is the candidate .temporal.
// Runner: npx tsx run.mjs

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  classifyHoldContinuityTemporalQuestion,
  matchHoldContinuityQa,
} from '../../src/routing/holdContinuityQa.ts';
import { inspectHolds, formatHoldRecall } from '../../src/routing/holdRecall.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const GARDENIA =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const PICKUP_Q = 'What was I going to pick up?';
const ANNIVERSARY_Q = 'When is our anniversary?';
const ANNIVERSARY_CONTRACTION_Q = "When's our anniversary?";
const BARE_ANNIVERSARY_Q = 'When is anniversary?';
const WIFE_Q = 'What flowers does my wife like?';
const RECALL_Q = 'What did I just tell you?';
const CALENDAR_Q = "What's on my calendar tomorrow?";

function medCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  const q = (sql: string) => {
    try { return db.prepare(sql).all().length; } catch { return 0; }
  };
  return {
    facts: q('SELECT id FROM facts'),
    contacts: q("SELECT id FROM contacts WHERE removed_at IS NULL"),
  };
}

function holdCands(discourse: DiscourseContinuityHolder) {
  return discourse.peekInterpretationHold()?.candidates ?? [];
}

function hold(over: Partial<AdmittedMultiFactCandidate> = {}): AdmittedMultiFactCandidate {
  return {
    kind: 'event',
    value: 'placeholder value',
    disposition: 'hold',
    episodeId: 'ep-test',
    ...over,
  };
}

function slot(candidates: AdmittedMultiFactCandidate[], episodeId = 'ep-test') {
  return { episodeId, candidates, sourceTurn: 1, refreshedAtTurn: 1 };
}

export async function runConversationCarryHoldTemporalReadV1Tests() {
  let passed = 0;
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  function assert(label: string, cond: boolean, expected = 'true') {
    if (cond) {
      console.log(`${GREEN}PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${RESET}  ${label}`);
      failures.push({ label, got: false, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversation Carry V1 Slice 4 temporal hold reads -----------${RESET}\n`);

  assert(
    'classifier binds When is <event-span>',
    classifyHoldContinuityTemporalQuestion(ANNIVERSARY_Q).kind === 'temporal'
      && (classifyHoldContinuityTemporalQuestion(ANNIVERSARY_Q) as { eventSpan?: string }).eventSpan === 'our anniversary',
  );
  assert(
    "classifier binds When's <event-span>",
    classifyHoldContinuityTemporalQuestion(ANNIVERSARY_CONTRACTION_Q).kind === 'temporal'
      && (classifyHoldContinuityTemporalQuestion(ANNIVERSARY_CONTRACTION_Q) as { eventSpan?: string }).eventSpan === 'our anniversary',
  );
  assert(
    'classifier does not bind closed When is it',
    classifyHoldContinuityTemporalQuestion('When is it?').kind === 'not_question',
  );

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    const t1 = await say(GARDENIA);
    const afterT1 = holdCands(discourse);
    const episode = discourse.peekInterpretationHold()?.episodeId;
    const temporal = afterT1.find((c) => c.kind === 'temporal');
    assert(
      'T1 NCA gardenia is interpretation hold',
      t1.handled === true && t1.source === 'interpretation' && session.peekPendingKey() === null,
    );
    assert(
      'T1 live temporal grounds anniversary and December 4th',
      !!temporal
        && /our anniversary/i.test(temporal.value)
        && /^December 4th$/i.test(temporal.temporal ?? ''),
    );
    assert(
      'T1 live intention and preference remain',
      afterT1.some((c) => c.kind === 'intention' && /pick up flowers/i.test(c.value))
        && afterT1.some((c) => c.kind === 'preference' && c.subject === 'wife' && /^gardenias$/i.test(c.value)),
    );

    const t2 = await say(WIFE_Q);
    assert(
      'T2 preference Hold Continuity gardenias',
      t2.handled === true && t2.source === 'hold_continuity' && /gardenias/i.test(t2.responseText ?? ''),
    );

    const t3 = await say(PICKUP_Q);
    assert(
      'T3 intention Hold Continuity pickup',
      t3.handled === true && t3.source === 'hold_continuity' && /pick up flowers/i.test(t3.responseText ?? '') && /you said/i.test(t3.responseText ?? ''),
    );

    const beforeT4 = medCounts(db as never);
    const holdBeforeT4 = JSON.stringify(holdCands(discourse).map((c) => ({ k: c.kind, s: c.subject, v: c.value, t: c.temporal })));
    const bound = matchHoldContinuityQa(ANNIVERSARY_Q, discourse.peekInterpretationHold());
    const t4 = await say(ANNIVERSARY_Q);
    const afterT4 = medCounts(db as never);
    const spoken = t4.responseText ?? '';
    assert(
      'T4 owner is hold_continuity temporal',
      t4.handled === true && t4.source === 'hold_continuity'
        && bound.kind === 'answer' && bound.channel === 'temporal',
    );
    assert(
      'T4 answers December 4th from live .temporal with You said provenance',
      /december 4th/i.test(spoken) && /^you said/i.test(spoken) && !/your anniversary is/i.test(spoken),
    );
    assert('T4 no pending', session.peekPendingKey() === null);
    assert('T4 no facts/contact write', beforeT4.facts === afterT4.facts && beforeT4.contacts === afterT4.contacts);
    assert(
      'T4 does not replace the hold',
      discourse.peekInterpretationHold()?.episodeId === episode
        && JSON.stringify(holdCands(discourse).map((c) => ({ k: c.kind, s: c.subject, v: c.value, t: c.temporal }))) === holdBeforeT4,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const q = await processUtterance(normalizeInput(ANNIVERSARY_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'FC1 no live hold does not invent a date',
      !(q.handled && q.source === 'hold_continuity') && !/december 4th/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife likes gardenias.');
    const q = await say(ANNIVERSARY_Q);
    assert(
      'FC2 preference-only hold does not answer a date',
      !(q.handled && q.source === 'hold_continuity') && !/december/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  {
    const dentist = matchHoldContinuityQa(ANNIVERSARY_Q, slot([
      hold({ kind: 'event', value: 'dentist appointment October 8th', temporal: 'October 8th' }),
    ]));
    assert('FC3 dentist event does not answer anniversary', dentist.kind !== 'answer');
  }

  {
    const two = matchHoldContinuityQa(ANNIVERSARY_Q, slot([
      hold({ kind: 'temporal', value: 'Our anniversary is December 4th.', temporal: 'December 4th' }),
      hold({ kind: 'temporal', value: 'Our anniversary is December 10th.', temporal: 'December 10th' }),
    ]));
    assert('FC4 two distinct anniversary dates fail closed', two.kind === 'ambiguous' || two.kind === 'no_match');
  }

  {
    const uniqueOur = matchHoldContinuityQa(ANNIVERSARY_Q, slot([
      hold({ kind: 'temporal', value: 'Our anniversary is December 4th.', temporal: 'December 4th' }),
      hold({ kind: 'temporal', value: 'Her anniversary is December 10th.', temporal: 'December 10th' }),
    ]));
    assert(
      'FC5 our anniversary uniquely selects December 4th',
      uniqueOur.kind === 'answer' && uniqueOur.channel === 'temporal' && /december 4th/i.test(uniqueOur.response) && !/december 10th/i.test(uniqueOur.response),
    );
    const bare = matchHoldContinuityQa(BARE_ANNIVERSARY_Q, slot([
      hold({ kind: 'temporal', value: 'Our anniversary is December 4th.', temporal: 'December 4th' }),
      hold({ kind: 'temporal', value: 'Her anniversary is December 10th.', temporal: 'December 10th' }),
    ]));
    assert(
      'FC5 bare anniversary matching both dates fails closed',
      bare.kind === 'ambiguous' || bare.kind === 'no_match',
    );
  }

  {
    const sameDate = matchHoldContinuityQa(ANNIVERSARY_Q, slot([
      hold({ kind: 'temporal', value: 'She told me that on our anniversary, December 4th.', temporal: 'December 4th' }),
      hold({ kind: 'temporal', value: 'Our anniversary, December 4th.', temporal: 'December 4th' }),
    ]));
    assert(
      'same grounded temporal across matches is one unique answer',
      sameDate.kind === 'answer' && /december 4th/i.test(sameDate.response),
    );
  }

  {
    const contradicted = matchHoldContinuityQa(ANNIVERSARY_Q, slot([
      hold({
        kind: 'temporal',
        value: 'Our anniversary is December 4th and December 10th.',
        temporal: 'December 4th',
        contradictGroupId: 'date-collision',
      }),
    ]));
    assert('FC6 contradiction-group candidate is not a guessed date', contradicted.kind !== 'answer');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say(GARDENIA);
    const cal = await say(CALENDAR_Q);
    const reason = !cal.handled && cal.routeDecision.kind === 'device_read'
      ? cal.routeDecision.reason
      : '';
    assert(
      'FC7 calendar read evidence stays on the calendar path',
      cal.source !== 'hold_continuity'
        && !cal.handled
        && cal.routeDecision.kind === 'device_read'
        && reason.startsWith('calendar:'),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say(GARDENIA);
    const recall = await say(RECALL_Q);
    const spoken = recall.responseText ?? '';
    assert(
      'FC10 Hold Recall still recites the episode',
      recall.handled === true && recall.source === 'hold_recall'
        && /pick up flowers/i.test(spoken) && /gardenias/i.test(spoken),
    );
    const inspect = inspectHolds(RECALL_Q, discourse.peekInterpretationHold());
    assert('FC10 inspectHolds still whole_set', inspect.kind === 'whole_set' && (formatHoldRecall(inspect) ?? '').length > 0);
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife is Shannon.');
    await say('Yes.');
    await say('Her favorite flowers are gardenias.');
    const q = await say(WIFE_Q);
    assert(
      'FC11 Slice 2 Shannon→her gardenias preference Q still Hold Continuity',
      q.handled === true && q.source === 'hold_continuity' && /gardenias/i.test(q.responseText ?? '') && session.peekPendingKey() === null,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say(GARDENIA);
    const q = await say(ANNIVERSARY_CONTRACTION_Q);
    assert(
      "When's our anniversary still answers from live .temporal",
      q.handled === true && q.source === 'hold_continuity' && /december 4th/i.test(q.responseText ?? '') && /you said/i.test(q.responseText ?? ''),
    );
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('conversationCarryHoldTemporalRead.test.ts')) {
  runConversationCarryHoldTemporalReadV1Tests().then((r) => {
    console.log(`\n${BOLD}ConversationCarryHoldTemporalReadV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
