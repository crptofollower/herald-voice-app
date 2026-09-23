// Conversation Carry V1 / Slice 3 — targeted intention reads from live holds.
// Temporal is out of slice (different bind/answer field). Runner: npx tsx run.mjs

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  matchHoldContinuityQa,
} from '../../src/routing/holdContinuityQa.ts';
import { inspectHolds, formatHoldRecall } from '../../src/routing/holdRecall.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const GARDENIA =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const PICKUP_Q = 'What was I going to pick up?';
const ANNIVERSARY_Q = 'When is our anniversary?';
const WIFE_Q = 'What flowers does my wife like?';
const RECALL_Q = 'What did I just tell you?';

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

export async function runConversationCarryHoldTargetedReadV1Tests() {
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

  console.log(`\n${BOLD}-- Conversation Carry V1 Slice 3 targeted hold reads --------${RESET}\n`);

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    const t1 = await say(GARDENIA);
    const afterT1 = holdCands(discourse);
    const episode = discourse.peekInterpretationHold()?.episodeId;
    assert(
      'T1 NCA gardenia is interpretation hold',
      t1.handled === true && t1.source === 'interpretation' && session.peekPendingKey() === null,
    );
    assert(
      'T1 live intention contains pick up flowers',
      afterT1.some((c) => c.kind === 'intention' && /pick up flowers/i.test(c.value)),
    );
    assert(
      'T1 live preference is wife→gardenias',
      afterT1.some((c) => c.kind === 'preference' && c.subject === 'wife' && /^gardenias$/i.test(c.value)),
    );

    const t2 = await say(WIFE_Q);
    assert(
      'T2 preference still Hold Continuity gardenias',
      t2.handled === true && t2.source === 'hold_continuity' && /gardenias/i.test(t2.responseText ?? ''),
    );

    const beforeT3 = medCounts(db as never);
    const holdBeforeT3 = JSON.stringify(holdCands(discourse).map((c) => ({ k: c.kind, s: c.subject, v: c.value })));
    const t3 = await say(PICKUP_Q);
    const afterT3 = medCounts(db as never);
    const holdAfterT3 = holdCands(discourse);
    assert(
      'T3 pickup is Hold Continuity',
      t3.handled === true && t3.source === 'hold_continuity' && session.peekPendingKey() === null,
    );
    assert(
      'T3 answers from live intention span',
      /pick up flowers/i.test(t3.responseText ?? '') && /you said/i.test(t3.responseText ?? ''),
    );
    assert('T3 no facts/contact write', beforeT3.facts === afterT3.facts && beforeT3.contacts === afterT3.contacts);
    assert(
      'T3 does not replace the hold',
      discourse.peekInterpretationHold()?.episodeId === episode
        && JSON.stringify(holdAfterT3.map((c) => ({ k: c.kind, s: c.subject, v: c.value }))) === holdBeforeT3,
    );

    const t4 = await say(ANNIVERSARY_Q);
    // Slice 3 encoded T4 as out-of-slice (no temporal reader). Slice 4
    // supersedes that miss; this file only requires T4 not to clobber T3.
    assert(
      'T4 does not replace the gardenia hold',
      discourse.peekInterpretationHold()?.episodeId === episode,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const q = await processUtterance(normalizeInput(PICKUP_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'FC1 no live hold does not invent pickup',
      !(q.handled && q.source === 'hold_continuity') && !/flowers/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife likes gardenias.');
    const q = await say(PICKUP_Q);
    assert(
      'FC2 preference-only hold does not invent pickup',
      !(q.handled && q.source === 'hold_continuity') && !/pick up/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  {
    const two = matchHoldContinuityQa(PICKUP_Q, {
      episodeId: 'ep-two',
      candidates: [
        hold({ kind: 'intention', value: "I'm going to pick up flowers" }),
        hold({ kind: 'intention', value: "I'm going to pick up tickets" }),
      ],
      sourceTurn: 1,
      refreshedAtTurn: 1,
    });
    assert('FC3 two pick-up intentions fail closed', two.kind === 'ambiguous' || two.kind === 'no_match');
  }

  {
    const unrelated = matchHoldContinuityQa(PICKUP_Q, {
      episodeId: 'ep-call',
      candidates: [
        hold({ kind: 'intention', value: "I'm going to call Hunter" }),
      ],
      sourceTurn: 1,
      refreshedAtTurn: 1,
    });
    assert('FC4 unrelated intention does not answer pick up', unrelated.kind !== 'answer');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say(GARDENIA);
    const recall = await say(RECALL_Q);
    const spoken = recall.responseText ?? '';
    assert(
      'FC6 Hold Recall still recites the episode',
      recall.handled === true && recall.source === 'hold_recall'
        && /pick up flowers/i.test(spoken) && /gardenias/i.test(spoken),
    );
    const inspect = inspectHolds(RECALL_Q, discourse.peekInterpretationHold());
    assert('FC6 inspectHolds still whole_set', inspect.kind === 'whole_set' && (formatHoldRecall(inspect) ?? '').length > 0);
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
      'FC7 Slice 2 Shannon→her gardenias preference Q still Hold Continuity',
      q.handled === true && q.source === 'hold_continuity' && /gardenias/i.test(q.responseText ?? '') && session.peekPendingKey() === null,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const q = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'FC9 cold preference Q is still not Hold Continuity gardenias',
      !(q.handled && q.source === 'hold_continuity') && !/gardenias/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('conversationCarryHoldTargetedRead.test.ts')) {
  runConversationCarryHoldTargetedReadV1Tests().then((r) => {
    console.log(`\n${BOLD}ConversationCarryHoldTargetedReadV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
