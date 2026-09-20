// Referential Write Integrity V1 — bare unresolved list values must not persist.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder, DISCOURSE_TURN_TTL } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  admitListAddItemCandidates,
  interpretCandidateSetDemonstrative,
  isBareUnresolvedListReferent,
  UNRESOLVED_LIST_REFERENT_REASON,
} from '../../src/routing/operationalListContinuity.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const WIFE_ROSES = 'My wife really loves roses.';
const ADD_THOSE = 'add those to my grocery list';
const ADD_THAT = 'add that to my grocery list';
const PUT_IT = 'put it on my grocery list';
const ADD_MILK = 'add milk to my grocery list';
const ADD_MULTI = 'add milk and eggs to my grocery list';
const ADD_THOSE_COOKIES = 'add those cookies to my grocery list';
const ADD_MIXED = 'add those and milk to my grocery list';

function groceryBodies(db: { prepare: (s: string) => { all: () => Array<{ body: string }> } }): string[] {
  try {
    return db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id
       WHERE l.name = 'grocery' AND li.checked = 0 AND li.removed_at IS NULL`,
    ).all().map((r) => r.body);
  } catch {
    return [];
  }
}

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

export async function runReferentialWriteIntegrityV1Tests() {
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

  console.log(`\n${BOLD}-- Referential Write Integrity V1 ---------------------------${RESET}\n`);

  assert('bare those is an unresolved list referent', isBareUnresolvedListReferent('those'), (v) => v === true, 'true');
  assert('bare that is an unresolved list referent', isBareUnresolvedListReferent('that'), (v) => v === true, 'true');
  assert('bare it is an unresolved list referent', isBareUnresolvedListReferent('it'), (v) => v === true, 'true');
  assert('those cookies is not a bare unresolved referent', isBareUnresolvedListReferent('those cookies'), (v) => v === false, 'false');
  assert('milk is grounded', admitListAddItemCandidates(['milk']).kind === 'grounded', (v) => v === true, 'grounded');
  assert(
    'mixed those+milk vetoes the whole set',
    admitListAddItemCandidates(['those', 'milk']).kind === 'unresolved_referent',
    (v) => v === true,
    'unresolved_referent',
  );

  {
    const d = await classifyQuery(ADD_THOSE);
    assert(
      'add those classifies as unresolved_list_referent',
      d.reason === UNRESOLVED_LIST_REFERENT_REASON && !d.actionIntent && typeof d.tier1Response === 'string',
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
  }
  {
    const d = await classifyQuery(ADD_MILK);
    assert(
      'add milk remains list_add',
      d.actionIntent?.type === 'list_add' && d.actionIntent.type === 'list_add' && d.actionIntent.items.includes('milk'),
      (v) => v === true,
      'list_add milk',
    );
  }

  async function assertNoWrite(label: string, input: string, setup?: (d: DiscourseContinuityHolder) => Promise<void>) {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    if (setup) await setup(discourse);
    const before = medCounts(db as never);
    const outcome = await processUtterance(normalizeInput(input), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const bodies = groceryBodies(db as never);
    const clarified =
      (!outcome.handled && outcome.routeDecision.kind === 'device_read' && outcome.routeDecision.reason === UNRESOLVED_LIST_REFERENT_REASON)
      || (outcome.handled && outcome.source === 'capture' && outcome.commits.length === 0);
    assert(`${label} zero sqlite`, JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert(`${label} no those/that/it row`, !bodies.some((b) => /^(those|that|this|these|them|it)$/i.test(b)), (v) => v === true, 'no pro-form row');
    assert(`${label} no roses row`, !bodies.some((b) => /roses/i.test(b)), (v) => v === true, 'no roses');
    assert(`${label} clarifies without durable write`, clarified && (outcome.handled ? outcome.commits.every((c) => c.status !== 'committed') : true), (v) => v === true, 'clarification');
    return { db, session, deps, discourse, outcome };
  }

  await assertNoWrite('bare those', ADD_THOSE);
  await assertNoWrite('bare that', ADD_THAT);
  await assertNoWrite('bare it', PUT_IT);
  await assertNoWrite('no live referent', ADD_THOSE);
  await assertNoWrite('live preference hold', ADD_THOSE, async (discourse) => {
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-pref', [
      { kind: 'preference', value: 'roses', disposition: 'hold', episodeId: 'ep-pref', subject: 'wife' },
    ]);
  });
  await assertNoWrite('two preference subjects still no write', ADD_THOSE, async (discourse) => {
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-two', [
      { kind: 'preference', value: 'roses', disposition: 'hold', episodeId: 'ep-two', subject: 'wife' },
      { kind: 'preference', value: 'tulips', disposition: 'hold', episodeId: 'ep-two', subject: 'sister' },
    ]);
  });
  await assertNoWrite('expired preference hold', ADD_THOSE, async (discourse) => {
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-exp', [
      { kind: 'preference', value: 'roses', disposition: 'hold', episodeId: 'ep-exp', subject: 'wife' },
    ]);
    for (let i = 0; i < DISCOURSE_TURN_TTL + 1; i++) discourse.beginUserTurn();
  });
  await assertNoWrite('mixed those and milk', ADD_MIXED);

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(WIFE_ROSES), session, deps, null, null, null, null, null, discourse);
    const before = medCounts(db as never);
    const holdBefore = discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|');
    const outcome = await processUtterance(normalizeInput(ADD_THOSE), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const bodies = groceryBodies(db as never);
    const holdAfter = discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|');
    assert('preference hold remains live after those', holdBefore === holdAfter && /wife:roses/i.test(holdAfter ?? ''), (v) => v === true, 'wife:roses');
    assert('preference hold does not authorize those or roses write', before.list_items === after.list_items && bodies.length === 0, (v) => v === true, 'no grocery rows');
    assert(
      'those is not hold_continuity write authority',
      !(outcome.handled && outcome.source === 'hold_continuity'),
      (v) => v === true,
      'not hold_continuity',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishCandidateSet('grocery', ['eggs', 'chocolate milk']);
    const demo = interpretCandidateSetDemonstrative(ADD_THOSE, discourse.peekCandidateSet());
    assert('candidateSet those is resolved to live items', demo.kind === 'resolved' && demo.kind === 'resolved' && demo.items.length === 2, (v) => v === true, 'resolved 2');
    const outcome = await processUtterance(normalizeInput(ADD_THOSE), session, deps, null, null, null, null, null, discourse);
    const bodies = groceryBodies(db as never).sort();
    assert(
      'authorized candidateSet those writes eggs and chocolate milk',
      outcome.handled && outcome.source === 'capture' && bodies.includes('eggs') && bodies.includes('chocolate milk') && !bodies.includes('those'),
      (v) => v === true,
      'eggs + chocolate milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const milk = await processUtterance(normalizeInput(ADD_MILK), session, deps, null, null, null, null, null, discourse);
    assert(
      'concrete milk writes',
      milk.handled && milk.source === 'capture' && groceryBodies(db as never).includes('milk'),
      (v) => v === true,
      'milk committed',
    );
    const multi = await processUtterance(normalizeInput(ADD_MULTI), session, deps, null, null, null, null, null, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'multi-item milk and eggs writes',
      multi.handled && bodies.includes('milk') && bodies.includes('eggs'),
      (v) => v === true,
      'milk eggs',
    );
    const cookies = await processUtterance(normalizeInput(ADD_THOSE_COOKIES), session, deps, null, null, null, null, null, discourse);
    assert(
      'those cookies is lexical content, not a bare pro-form veto',
      cookies.handled && groceryBodies(db as never).some((b) => /those cookies/i.test(b)),
      (v) => v === true,
      'those cookies',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('grab milk and eggs'), session, deps, null, null, null, null, null, discourse);
    const before = medCounts(db as never);
    const resume = await processUtterance(normalizeInput('for groceries'), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const bodies = groceryBodies(db as never);
    assert(
      'clarify→resume grocery still writes milk and eggs',
      resume.handled && resume.source === 'pending_resume' && bodies.includes('milk') && bodies.includes('eggs') && after.list_items === before.list_items + 2,
      (v) => v === true,
      'pending_resume milk eggs',
    );
  }

  console.log(`\n${BOLD}Referential Write Integrity V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('referentialWriteIntegrity');
if (isDirect) {
  runReferentialWriteIntegrityV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
