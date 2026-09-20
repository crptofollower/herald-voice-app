// RWI Indefinite Referential Quantity V1.
// Headless quantity/referential spans must not persist as list items.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  admitListAddItemCandidates,
  isBareUnresolvedListReferent,
  isUnresolvedReferentialQuantity,
  UNRESOLVED_LIST_REFERENT_REASON,
  CLARIFY_LIST_ADD_ITEM_KEY,
} from '../../src/routing/operationalListContinuity.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

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

function todoBodies(db: { prepare: (s: string) => { all: () => Array<{ body: string }> } }): string[] {
  try {
    return db.prepare(
      `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id
       WHERE l.name = 'todos' AND li.checked = 0 AND li.removed_at IS NULL`,
    ).all().map((r) => r.body);
  } catch {
    return [];
  }
}

function listCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  try {
    return db.prepare('SELECT id FROM list_items').all().length;
  } catch {
    return 0;
  }
}

export async function runReferentialQuantityV1Tests() {
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

  console.log(`\n${BOLD}-- RWI Indefinite Referential Quantity V1 -------------------${RESET}\n`);

  const unresolvedSpans = ['some', 'a few', 'a couple', 'one', 'several', 'those', 'them', 'it', 'that'];
  for (const span of unresolvedSpans) {
    assert(
      `predicate unresolved: "${span}"`,
      isUnresolvedReferentialQuantity(span) || isBareUnresolvedListReferent(span),
      (v) => v === true,
      'unresolved',
    );
    assert(
      `admission unresolved: "${span}"`,
      admitListAddItemCandidates([span]).kind,
      (v) => v === 'unresolved_referent',
      'unresolved_referent',
    );
  }

  const groundedSpans = [
    ['a couple bananas', 'bananas'],
    ['a few apples', 'apples'],
    ['one gallon of milk', 'milk'],
    ['two dozen eggs', 'eggs'],
    ['half and half', 'half'],
  ] as const;
  for (const [span] of groundedSpans) {
    assert(
      `predicate grounded: "${span}"`,
      isUnresolvedReferentialQuantity(span) || (span === 'half and half' ? false : isBareUnresolvedListReferent(span)),
      (v) => v === false,
      'grounded',
    );
  }
  assert(
    'half as identity token is not a non-identity class member',
    isUnresolvedReferentialQuantity('half') || isBareUnresolvedListReferent('half'),
    (v) => v === false,
    'grounded half',
  );
  assert(
    'a gallon remains V1 grounded boundary',
    isUnresolvedReferentialQuantity('a gallon'),
    (v) => v === false,
    'grounded',
  );

  assert('adversarial SOME', isBareUnresolvedListReferent('SOME'), (v) => v === true, 'true');
  assert('adversarial Some.', isBareUnresolvedListReferent('Some.'), (v) => v === true, 'true');
  assert('adversarial  some  ', isBareUnresolvedListReferent('  some  '), (v) => v === true, 'true');
  assert('adversarial a few,', isBareUnresolvedListReferent('a few,'), (v) => v === true, 'true');
  assert('adversarial A Couple!', isBareUnresolvedListReferent('A Couple!'), (v) => v === true, 'true');
  assert('adversarial a couple bananas still grounded', isBareUnresolvedListReferent('a couple bananas'), (v) => v === false, 'false');
  assert('mixed some+milk still vetoes', admitListAddItemCandidates(['some', 'milk']).kind, (v) => v === 'unresolved_referent', 'unresolved_referent');

  async function assertUnresolvedUtterance(label: string, input: string, list: 'grocery' | 'todo' = 'grocery') {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = listCounts(db as never);
    const outcome = await processUtterance(normalizeInput(input), session, deps, null, null, null, null, null, discourse);
    const after = listCounts(db as never);
    const bodies = list === 'todo' ? todoBodies(db as never) : groceryBodies(db as never);
    const classified = await classifyQuery(normalizeInput(input));
    assert(
      `${label} classifies unresolved_list_referent`,
      classified.reason === UNRESOLVED_LIST_REFERENT_REASON && !classified.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
    assert(`${label} zero sqlite`, before === after, (v) => v === true, 'unchanged');
    assert(
      `${label} no quantity/pro-form row`,
      !bodies.some((b) => /^(some|few|couple|one|several|those|them|it|that|this|these|a few|a couple)$/i.test(b)),
      (v) => v === true,
      'no headless row',
    );
    assert(
      `${label} fail-closed unresolved read`,
      !outcome.handled
        && outcome.routeDecision.kind === 'device_read'
        && outcome.routeDecision.reason === UNRESOLVED_LIST_REFERENT_REASON,
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
    if (list === 'grocery') {
      assert(
        `${label} arms existing item clarification`,
        session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
        (v) => v === true,
        CLARIFY_LIST_ADD_ITEM_KEY,
      );
    } else {
      assert(
        `${label} shared admission blocks the todo write`,
        todoBodies(db as never).length === 0,
        (v) => v === true,
        'no todo rows',
      );
    }
  }

  await assertUnresolvedUtterance('add some', 'add some to my grocery list');
  await assertUnresolvedUtterance('put some', 'Put some on the grocery list.');
  await assertUnresolvedUtterance('a few', 'add a few to my grocery list');
  await assertUnresolvedUtterance('a couple', 'add a couple to my grocery list');
  await assertUnresolvedUtterance('one', 'add one to my grocery list');
  await assertUnresolvedUtterance('several', 'add several to my grocery list');
  await assertUnresolvedUtterance('those', 'add those to my grocery list');
  await assertUnresolvedUtterance('them', 'add them to my grocery list');
  await assertUnresolvedUtterance('it', 'put it on my grocery list');
  await assertUnresolvedUtterance('that', 'add that to my grocery list');
  await assertUnresolvedUtterance('todo some', 'add some to my todo list', 'todo');

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const bananas = await processUtterance(normalizeInput('add a couple bananas to my grocery list'), session, deps, null, null, null, null, null, discourse);
    assert(
      'a couple bananas writes bananas',
      bananas.handled === true && groceryBodies(db as never).some((b) => /bananas/i.test(b)) && !groceryBodies(db as never).includes('couple'),
      (v) => v === true,
      'bananas',
    );
  }
  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const apples = await processUtterance(normalizeInput('add a few apples to my grocery list'), session, deps, null, null, null, null, null, discourse);
    assert(
      'a few apples writes apples',
      apples.handled === true && groceryBodies(db as never).some((b) => /apples/i.test(b)),
      (v) => v === true,
      'apples',
    );
  }
  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const milk = await processUtterance(normalizeInput('add one gallon of milk to my grocery list'), session, deps, null, null, null, null, null, discourse);
    assert(
      'one gallon of milk is grounded write',
      milk.handled === true && groceryBodies(db as never).some((b) => /gallon of milk|milk/i.test(b)),
      (v) => v === true,
      'grounded milk measure',
    );
  }
  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const eggs = await processUtterance(normalizeInput('add two dozen eggs to my grocery list'), session, deps, null, null, null, null, null, discourse);
    assert(
      'two dozen eggs is grounded write',
      eggs.handled === true && groceryBodies(db as never).some((b) => /dozen eggs|eggs/i.test(b)),
      (v) => v === true,
      'grounded eggs measure',
    );
  }
  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const half = await processUtterance(normalizeInput('add half and half to my grocery list'), session, deps, null, null, null, null, null, discourse);
    assert(
      'half and half is not unresolved quantity',
      half.handled === true && groceryBodies(db as never).length > 0 && !session.hasPending(),
      (v) => v === true,
      'grounded write',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('My wife really loves gardenias.'), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|');
    const before = listCounts(db as never);
    const some = await processUtterance(normalizeInput('Put some on the grocery list.'), session, deps, null, null, null, null, null, discourse);
    const midBodies = groceryBodies(db as never);
    const holdAfter = discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|');
    assert('preference hold remains live after some', /wife:gardenias/i.test(hold ?? '') && hold === holdAfter, (v) => v === true, 'wife:gardenias');
    assert(
      'put some after preference writes nothing',
      listCounts(db as never) === before
        && midBodies.length === 0
        && !some.handled
        && some.routeDecision.reason === UNRESOLVED_LIST_REFERENT_REASON
        && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
      (v) => v === true,
      'zero write + clarify:list_add_item',
    );
    assert(
      'preference does not supply gardenias as the write',
      !midBodies.some((b) => /gardenias/i.test(b)),
      (v) => v === true,
      'no gardenias yet',
    );
    const resume = await processUtterance(normalizeInput('Gardenias.'), session, deps, null, null, null, null, null, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'explicit Gardenias. writes gardenias once',
      resume.handled === true
        && resume.source === 'pending_resume'
        && bodies.filter((b) => b === 'gardenias').length === 1
        && bodies.length === 1
        && !session.hasPending(),
      (v) => v === true,
      'one gardenias',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('add those to my grocery list'), session, deps, null, null, null, null, null, discourse);
    const roses = await processUtterance(normalizeInput('the roses'), session, deps, null, null, null, null, null, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'existing those→the roses resumption unchanged',
      roses.source === 'pending_resume' && bodies.filter((b) => b === 'roses').length === 1 && !session.hasPending(),
      (v) => v === true,
      'one roses',
    );
  }

  console.log(`\n${BOLD}RWI Indefinite Referential Quantity V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('referentialQuantity');
if (isDirect) {
  runReferentialQuantityV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
