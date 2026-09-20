// Same-Utterance Self-Repair V1 — superseded list-add meaning must not persist.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  interpretSameUtteranceListAddSupersession,
  UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
} from '../../src/routing/sameUtteranceListAddRepair.ts';
import {
  interpretCandidateSetDemonstrative,
  UNRESOLVED_LIST_REFERENT_REASON,
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

export async function runSameUtteranceSelfRepairV1Tests() {
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

  console.log(`\n${BOLD}-- Same-Utterance Self-Repair V1 ----------------------------${RESET}\n`);

  function interpret(captureRaw: string, remainder: string, items: string[]) {
    return interpretSameUtteranceListAddSupersession({ captureRaw, remainder, provisionalItems: items });
  }

  assert(
    'no repair leaves milk',
    interpret('milk', '', ['milk']).kind === 'none',
    (v) => v === true,
    'none',
  );
  assert(
    'unrelated trailing speech is not a replacement',
    interpret('milk', ' and tell mom', ['milk']).kind === 'none',
    (v) => v === true,
    'none',
  );

  async function runAdd(input: string, setup?: (d: DiscourseContinuityHolder) => void) {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    setup?.(discourse);
    const before = medCounts(db as never);
    const outcome = await processUtterance(normalizeInput(input), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    return { db, outcome, bodies: groceryBodies(db as never), before, after };
  }

  async function assertWrite(label: string, input: string, expected: string[]) {
    const r = await runAdd(input);
    const committed = r.outcome.handled && r.outcome.commits.some((c) => c.status === 'committed');
    const bodies = [...r.bodies].sort();
    const want = [...expected].sort();
    assert(
      `${label} commits only ${want.join('+')}`,
      committed && JSON.stringify(bodies) === JSON.stringify(want) && !bodies.includes('milk') === !want.includes('milk'),
      (v) => v === true,
      want.join(','),
    );
    return r;
  }

  async function assertZero(label: string, input: string, setup?: (d: DiscourseContinuityHolder) => void) {
    const r = await runAdd(input, setup);
    const committed = r.outcome.handled && r.outcome.commits.some((c) => c.status === 'committed');
    const clarified = (!r.outcome.handled && r.outcome.routeDecision.kind === 'device_read')
      || (r.outcome.handled && !committed);
    assert(`${label} exact-zero sqlite`, JSON.stringify(r.before) === JSON.stringify(r.after), (v) => v === true, 'unchanged');
    assert(`${label} no durable commit`, !committed && r.bodies.length === 0, (v) => v === true, 'empty grocery');
    assert(`${label} clarification/non-write`, clarified, (v) => v === true, 'non-write');
    return r;
  }

  {
    const d = await classifyQuery('add milk to my grocery list actually make that oat milk');
    assert(
      'proven failure now classifies as list_add oat milk',
      d.actionIntent?.type === 'list_add' && d.actionIntent.type === 'list_add'
        && d.actionIntent.items.length === 1 && d.actionIntent.items[0] === 'oat milk',
      (v) => v === true,
      '["oat milk"]',
    );
  }

  await assertWrite('single actually oat milk', 'add milk to my grocery list actually oat milk', ['oat milk']);
  await assertWrite('single actually make that oat milk', 'add milk to my grocery list actually make that oat milk', ['oat milk']);
  await assertWrite('single comma no oat milk', 'add milk, no, oat milk to my grocery list', ['oat milk']);
  await assertWrite('bare need make that oat milk', 'I need milk... make that oat milk', ['oat milk']);
  await assertWrite(
    'targeted make the milk oat milk',
    'add milk and bread to my grocery list actually make the milk oat milk',
    ['oat milk', 'bread'],
  );
  await assertWrite(
    'just bread narrowing',
    'add milk and bread to my grocery list actually just bread',
    ['bread'],
  );
  await assertWrite(
    'whole-set restatement oat milk and bread',
    'add milk and bread to my grocery list no, oat milk and bread',
    ['oat milk', 'bread'],
  );
  await assertWrite('wait oat milk', 'add milk to my grocery list wait, oat milk', ['oat milk']);
  await assertWrite('sorry oat milk', 'add milk to my grocery list sorry, oat milk', ['oat milk']);

  await assertZero('ambiguous actually oat milk over two items', 'add milk and bread to my grocery list actually oat milk');
  await assertZero('missing replacement', 'add milk to my grocery list actually');
  {
    const r = await assertZero('referential replacement actually that', 'add milk to my grocery list actually that');
    const d = await classifyQuery('add milk to my grocery list actually that');
    assert(
      'referential replacement is RWI not restored milk',
      d.reason === UNRESOLVED_LIST_REFERENT_REASON && !d.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
    assert('referential replacement has no milk row', !r.bodies.includes('milk') && !r.bodies.includes('that'), (v) => v === true, 'no milk/that');
  }
  await assertZero('multiple repair boundaries', 'add milk to my grocery list actually oat milk wait almond milk');

  await assertWrite('Actually, add milk is not a repair', 'Actually, add milk to my grocery list', ['milk']);
  {
    const d = await classifyQuery('I actually need milk');
    assert(
      'I actually need milk is not supersession',
      d.reason !== UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
      (v) => v === true,
      'not unresolved_list_add_supersession',
    );
  }
  await assertWrite('normal single add unchanged', 'add milk to my grocery list', ['milk']);
  await assertWrite('normal multi-item add unchanged', 'add milk and bread to my grocery list', ['milk', 'bread']);

  {
    const d = await classifyQuery('add those to my grocery list');
    assert(
      'RWI those still unresolved_list_referent',
      d.reason === UNRESOLVED_LIST_REFERENT_REASON && !d.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishCandidateSet('grocery', ['eggs', 'chocolate milk']);
    const demo = interpretCandidateSetDemonstrative('add those to my grocery list', discourse.peekCandidateSet());
    assert('candidateSet those still resolves', demo.kind === 'resolved', (v) => v === true, 'resolved');
    const outcome = await processUtterance(
      normalizeInput('add those to my grocery list'),
      session,
      deps,
      null, null, null, null, null,
      discourse,
    );
    const bodies = groceryBodies(db as never).sort();
    assert(
      'candidateSet demonstrative still writes live items',
      outcome.handled && bodies.includes('eggs') && bodies.includes('chocolate milk') && !bodies.includes('those'),
      (v) => v === true,
      'eggs + chocolate milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const first = await processUtterance(normalizeInput('grab milk and eggs'), session, deps, null, null, null, null, null, discourse);
    assert(
      'operational-list continuation still clarifies',
      first.handled && first.commits.some((c) => c.status === 'pending'),
      (v) => v === true,
      'pending',
    );
    const second = await processUtterance(normalizeInput('for groceries'), session, deps, null, null, null, null, null, discourse);
    const bodies = groceryBodies(db as never).sort();
    assert(
      'operational-list grocery resume unchanged',
      second.handled && second.commits.some((c) => c.status === 'committed') && bodies.includes('milk') && bodies.includes('eggs'),
      (v) => v === true,
      'milk+eggs',
    );
  }

  {
    const r = await assertWrite('no duplicate oat milk', 'add milk to my grocery list actually make that oat milk', ['oat milk']);
    assert('exactly one grocery row after repair', r.after.list_items === 1, (v) => v === true, '1');
    assert('superseded milk absent', !r.bodies.includes('milk'), (v) => v === true, 'no milk');
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishInterpretationHold('ep-pref', [
      { kind: 'preference', value: 'roses', disposition: 'hold', episodeId: 'ep-pref', subject: 'wife' },
    ]);
    const outcome = await processUtterance(
      normalizeInput('add milk to my grocery list actually that'),
      session,
      deps,
      null, null, null, null, null,
      discourse,
    );
    const bodies = groceryBodies(db as never);
    assert(
      'preference hold does not authorize repaired that/roses',
      (!outcome.handled || outcome.commits.every((c) => c.status !== 'committed'))
        && bodies.length === 0,
      (v) => v === true,
      'zero grocery',
    );
  }

  {
    const d = await classifyQuery('add milk and bread to my grocery list actually oat milk');
    assert(
      'ambiguous repair classifies fail-closed',
      d.reason === UNRESOLVED_LIST_ADD_SUPERSESSION_REASON && !d.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
    );
  }

  console.log(`\n${BOLD}Same-Utterance Self-Repair V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('sameUtteranceSelfRepair');
if (isDirect) {
  runSameUtteranceSelfRepairV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
