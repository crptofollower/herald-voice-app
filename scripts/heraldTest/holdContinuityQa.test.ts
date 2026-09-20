// Hold Continuity Q&A V1 — preference questions over live associated holds.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder, DISCOURSE_TURN_TTL } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { detectFamilyCapture } from '../../src/utils/familyCapture.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import {
  classifyHoldContinuityPreferenceQuestion,
  matchHoldContinuityQa,
  answerHoldContinuityQa,
} from '../../src/routing/holdContinuityQa.ts';
import { inspectHolds, formatHoldRecall } from '../../src/routing/holdRecall.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const GARDENIA_F1 =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const GARDENIA_F1B =
  "Oh man, great day — boss says he's promoting me. Haven't told my wife. I'll grab flowers for her on the way home. She loves gardenias. That's been her favorite since our anniversary on December 4th.";

const TWO_PREFS =
  "My wife's favorite flowers are gardenias. My son's favorite food is pizza.";

const UNRELATED =
  "I walked past some gardenias at the market. I haven't told my wife yet.";

const WIFE_Q = 'What flowers does my wife like?';
const SON_Q = 'What food does my son like?';
const HUSBAND_JAZZ =
  "My husband's favorite music is jazz. On the way home I'm going to pick up tickets.";
const HUSBAND_FAVORITE_Q = "What's my husband's favorite music?";
const WIFE_FAVORITE_Q = "What's my wife's favorite flower?";
const WIFE_NAME_Q = "What's my wife's name?";
const DURABLE_RE = /\b(remember(?:ed)?|saved|stored|i remember|i have stored|your profile says)\b/i;

function medCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  const q = (sql: string) => {
    try { return db.prepare(sql).all().length; } catch { return 0; }
  };
  return {
    medications: q('SELECT id FROM medications'),
    medical_records: q('SELECT id FROM medical_records'),
    list_items: q('SELECT id FROM list_items'),
    facts: q('SELECT id FROM facts'),
    contacts: q("SELECT id FROM contacts WHERE removed_at IS NULL"),
  };
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

export async function runHoldContinuityQaV1Tests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
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

  console.log(`\n${BOLD}-- Hold Continuity Q&A V1 -------------------------------------${RESET}\n`);

  {
    const q = classifyHoldContinuityPreferenceQuestion(WIFE_Q);
    assert(
      'F1 question is preference/wife',
      q.kind === 'preference' && q.kind === 'preference' && q.subject === 'wife',
      (v) => v === true,
      'preference wife',
    );
    const f1bQ = classifyHoldContinuityPreferenceQuestion("What's my son's favorite food?");
    assert(
      'favorite-food shape is preference/son',
      f1bQ.kind === 'preference' && f1bQ.kind === 'preference' && f1bQ.subject === 'son',
      (v) => v === true,
      'preference son',
    );
    assert(
      'hold-recall grammar is not continuity Q&A',
      classifyHoldContinuityPreferenceQuestion('What did I tell you about gardenias?').kind === 'not_question',
      (v) => v === true,
      'not_question',
    );
    assert(
      'family identity read is not continuity Q&A',
      classifyHoldContinuityPreferenceQuestion('Who is my wife?').kind === 'not_question',
      (v) => v === true,
      'not_question',
    );
    assert(
      'look-like is not preference Q&A',
      classifyHoldContinuityPreferenceQuestion('What does my wife look like?').kind === 'not_question',
      (v) => v === true,
      'not_question',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    const before = medCounts(db as never);
    const refreshedBefore = discourse.peekInterpretationHold()?.refreshedAtTurn;
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const spoken = outcome.handled ? outcome.responseText : '';
    assert('F1 handled hold_continuity', outcome.handled && outcome.source === 'hold_continuity', (v) => v === true, 'hold_continuity');
    assert('F1 answers gardenias', /gardenias/i.test(spoken), (v) => v === true, 'gardenias');
    assert('F1 conversational provenance', /^You said she likes /i.test(spoken) && !DURABLE_RE.test(spoken), (v) => v === true, 'You said she likes');
    assert('F1 commits empty', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
    assert('F1 no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('F1 zero sqlite growth', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert(
      'F1 read does not refresh TTL',
      refreshedBefore != null && discourse.peekInterpretationHold()?.refreshedAtTurn === refreshedBefore,
      (v) => v === true,
      'same refreshedAtTurn',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1B), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'F1b same product result',
      outcome.handled && outcome.source === 'hold_continuity' && /gardenias/i.test(outcome.responseText),
      (v) => v === true,
      'hold_continuity gardenias',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(TWO_PREFS), session, deps, null, null, null, null, null, discourse);
    const son = await processUtterance(normalizeInput(SON_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'son pizza is subject-specific',
      son.handled && son.source === 'hold_continuity' && /pizza/i.test(son.responseText) && !/gardenias/i.test(son.responseText),
      (v) => v === true,
      'he likes pizza',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(TWO_PREFS), session, deps, null, null, null, null, null, discourse);
    const wife = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'two-person wife question stays gardenias',
      wife.handled && /gardenias/i.test(wife.responseText) && !/pizza/i.test(wife.responseText),
      (v) => v === true,
      'gardenias only',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput(SON_Q), session, deps, null, null, null, null, null, discourse);
    const diverted = outcome.handled && outcome.source === 'hold_continuity';
    assert('wrong subject is not a hold answer', diverted === false, (v) => v === true, 'not hold_continuity');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(UNRELATED), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'unrelated gardenia event is not preference Q&A',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const captured = detectFamilyCapture(WIFE_Q);
    assert(
      'known family-capture defect still fires on detector',
      captured.length === 1 && captured[0].type === 'family_capture' && captured[0].type === 'family_capture' && captured[0].relation === 'wife' && /^like$/i.test(captured[0].name),
      (v) => v === true,
      'wife/like',
    );
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'no live hold does not invent a hold answer',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'fall through',
    );
    assert(
      'no-match fallback still exposes family-capture pending',
      session.hasPending() && session.peekPendingKey() === 'family_capture',
      (v) => v === true,
      'family_capture pending',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    for (let i = 0; i < DISCOURSE_TURN_TTL + 1; i++) discourse.beginUserTurn();
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'expired hold cannot answer',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'fall through',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    session.setPending({
      pendingKey: 'medical_visit',
      kind: 'standard',
      budget: 2,
      resume: async (): Promise<CommitResult> => ({
        status: 'pending',
        prompt: 'Want me to remember you saw Dr. Cather?',
        pendingKey: 'medical_visit',
        resume: async () => ({ status: 'noop', ack: '' }),
      }),
    });
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'already-live pending retains authority',
      outcome.handled && outcome.source === 'pending_resume',
      (v) => v === true,
      'pending_resume',
    );
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-conflict', [
      hold({ kind: 'preference', subject: 'wife', value: 'gardenias' }),
      hold({ kind: 'preference', subject: 'wife', value: 'roses' }),
    ]);
    const match = matchHoldContinuityQa(WIFE_Q, discourse.peekInterpretationHold());
    assert('conflicting values do not pick a winner', match.kind === 'ambiguous', (v) => v === true, 'ambiguous');
    assert('conflicting values produce no spoken answer', answerHoldContinuityQa(WIFE_Q, discourse.peekInterpretationHold()), (v) => v === null, 'null');
    const { session, deps } = openJourneyDb();
    const outcome = await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'conflicting journey does not guess',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    await processUtterance(normalizeInput(WIFE_Q), session, deps, null, null, null, null, null, discourse);
    const recall = await processUtterance(normalizeInput('What did I just tell you?'), session, deps, null, null, null, null, null, discourse);
    assert(
      'existing Hold Recall still works after Q&A',
      recall.handled && recall.source === 'hold_recall' && /gardenias/i.test(recall.responseText),
      (v) => v === true,
      'hold_recall gardenias',
    );
    const inspected = inspectHolds('What did I just tell you?', discourse.peekInterpretationHold());
    assert(
      'Hold Recall inspection still sees the live set',
      inspected.kind === 'whole_set' && formatHoldRecall(inspected) !== null,
      (v) => v === true,
      'whole_set',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('Who is my wife?'), session, deps, null, null, null, null, null, discourse);
    const familyRead =
      !outcome.handled
      && outcome.routeDecision.kind === 'device_read'
      && outcome.routeDecision.reason === 'family:read'
      && /Shannon/i.test(outcome.routeDecision.response);
    assert('durable family read retains precedence', familyRead, (v) => v === true, 'family:read Shannon');
    assert(
      'durable read is not hold_continuity',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const classified = await classifyQuery(HUSBAND_FAVORITE_Q);
    assert(
      'favorite-music still classifies as over-broad family:read',
      classified.tier === 1 && classified.reason === 'family:read',
      (v) => v === true,
      'family:read',
    );
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(HUSBAND_JAZZ), session, deps, null, null, null, null, null, discourse);
    const before = medCounts(db as never);
    const refreshedBefore = discourse.peekInterpretationHold()?.refreshedAtTurn;
    const outcome = await processUtterance(normalizeInput(HUSBAND_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const spoken = outcome.handled ? outcome.responseText : '';
    assert('husband favorite is hold_continuity', outcome.handled && outcome.source === 'hold_continuity', (v) => v === true, 'hold_continuity');
    assert('husband favorite answers jazz', /jazz/i.test(spoken), (v) => v === true, 'jazz');
    assert('husband favorite is not durable miss', !/don'?t have your husband/i.test(spoken), (v) => v === true, 'not family miss');
    assert('husband favorite commits empty', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
    assert('husband favorite no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('husband favorite zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert(
      'husband favorite does not refresh TTL',
      refreshedBefore != null && discourse.peekInterpretationHold()?.refreshedAtTurn === refreshedBefore,
      (v) => v === true,
      'same refreshedAtTurn',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput(WIFE_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'wife favorite flower is hold_continuity gardenias',
      outcome.handled && outcome.source === 'hold_continuity' && /gardenias/i.test(outcome.responseText),
      (v) => v === true,
      'hold_continuity gardenias',
    );
  }

  {
    const cases: Array<{ subject: string; value: string; question: string }> = [
      { subject: 'daughter', value: 'purple', question: "What's my daughter's favorite color?" },
      { subject: 'mother', value: 'lasagna', question: "What's my mother's favorite food?" },
      { subject: 'father', value: 'baseball', question: "What's my father's favorite sport?" },
      { subject: 'sister', value: 'casablanca', question: "What's my sister's favorite movie?" },
    ];
    for (const c of cases) {
      const { session, deps } = openJourneyDb();
      const discourse = new DiscourseContinuityHolder();
      discourse.beginUserTurn();
      discourse.establishInterpretationHold('ep-rel', [
        hold({ kind: 'preference', subject: c.subject, value: c.value, episodeId: 'ep-rel' }),
        hold({ kind: 'event', value: 'companion hold', episodeId: 'ep-rel' }),
      ]);
      const outcome = await processUtterance(normalizeInput(c.question), session, deps, null, null, null, null, null, discourse);
      assert(
        `${c.subject} favorite is hold_continuity ${c.value}`,
        outcome.handled && outcome.source === 'hold_continuity' && new RegExp(c.value, 'i').test(outcome.responseText),
        (v) => v === true,
        `hold_continuity ${c.value}`,
      );
    }
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    await processUtterance(normalizeInput(GARDENIA_F1), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput(WIFE_NAME_Q), session, deps, null, null, null, null, null, discourse);
    const familyRead =
      !outcome.handled
      && outcome.routeDecision.kind === 'device_read'
      && outcome.routeDecision.reason === 'family:read'
      && /Shannon/i.test(outcome.routeDecision.response);
    assert("what's my wife's name remains family:read", familyRead, (v) => v === true, 'family:read Shannon');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(normalizeInput(HUSBAND_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'favorite question without hold does not fabricate hold_continuity',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-conflict-fav', [
      hold({ kind: 'preference', subject: 'husband', value: 'jazz' }),
      hold({ kind: 'preference', subject: 'husband', value: 'blues' }),
    ]);
    const { session, deps } = openJourneyDb();
    const outcome = await processUtterance(normalizeInput(HUSBAND_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'ambiguous favorite does not guess',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(HUSBAND_JAZZ), session, deps, null, null, null, null, null, discourse);
    for (let i = 0; i < DISCOURSE_TURN_TTL + 1; i++) discourse.beginUserTurn();
    const outcome = await processUtterance(normalizeInput(HUSBAND_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'expired favorite hold cannot answer',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'fall through',
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(HUSBAND_JAZZ), session, deps, null, null, null, null, null, discourse);
    session.setPending({
      pendingKey: 'medical_visit',
      kind: 'standard',
      budget: 2,
      resume: async (): Promise<CommitResult> => ({
        status: 'pending',
        prompt: 'Want me to remember you saw Dr. Cather?',
        pendingKey: 'medical_visit',
        resume: async () => ({ status: 'noop', ack: '' }),
      }),
    });
    const outcome = await processUtterance(normalizeInput(HUSBAND_FAVORITE_Q), session, deps, null, null, null, null, null, discourse);
    assert(
      'pending retains authority over favorite question',
      outcome.handled && outcome.source === 'pending_resume',
      (v) => v === true,
      'pending_resume',
    );
  }

  console.log(`\n${BOLD}Hold Continuity Q&A V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('holdContinuityQa.test');
if (isDirect) {
  runHoldContinuityQaV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
