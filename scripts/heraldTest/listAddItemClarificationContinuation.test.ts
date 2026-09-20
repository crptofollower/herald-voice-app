// Fail-Closed List Clarification Continuation V1 — grocery list_add item slot.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  CLARIFY_LIST_ADD_ITEM_KEY,
  CLARIFY_OPERATIONAL_LIST_KEY,
  parseListAddItemClarificationAnswer,
  UNRESOLVED_LIST_REFERENT_REASON,
} from '../../src/routing/operationalListContinuity.ts';
import { UNRESOLVED_LIST_ADD_SUPERSESSION_REASON } from '../../src/routing/sameUtteranceListAddRepair.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const ADD_THOSE = 'add those to my grocery list';
const SUPERSESSION = 'add milk and bread to my grocery list, actually oat milk';

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

function say(
  input: string,
  session: ReturnType<typeof openJourneyDb>['session'],
  deps: ReturnType<typeof openJourneyDb>['deps'],
  discourse: DiscourseContinuityHolder,
) {
  return processUtterance(normalizeInput(input), session, deps, null, null, null, null, null, discourse);
}

export async function runListAddItemClarificationContinuationV1Tests() {
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

  console.log(`\n${BOLD}-- Fail-Closed List Clarification Continuation V1 -----------${RESET}\n`);

  const parserCases: Array<[string, string[] | null]> = [
    ['roses', ['roses']],
    ['the roses', ['roses']],
    ['gardenias', ['gardenias']],
    ['oat milk', ['oat milk']],
    ['just the oat milk', ['oat milk']],
    ['milk and eggs', ['milk', 'eggs']],
    ['those', null],
    ['that', null],
    ['it', null],
    ['yes', null],
    ['no', null],
    ['', null],
    [ADD_THOSE, null],
  ];
  for (const [raw, expected] of parserCases) {
    const got = parseListAddItemClarificationAnswer(raw);
    assert(
      `parser "${raw || '(empty)'}"`,
      got,
      (v) => JSON.stringify(v) === JSON.stringify(expected),
      JSON.stringify(expected),
    );
  }

  {
    const d = await classifyQuery(ADD_THOSE);
    assert(
      'add those still classifies unresolved_list_referent',
      d.reason === UNRESOLVED_LIST_REFERENT_REASON && !d.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_REFERENT_REASON,
    );
  }
  {
    const d = await classifyQuery(SUPERSESSION);
    assert(
      'ambiguous self-repair still classifies unresolved_list_add_supersession',
      d.reason === UNRESOLVED_LIST_ADD_SUPERSESSION_REASON && !d.actionIntent,
      (v) => v === true,
      UNRESOLVED_LIST_ADD_SUPERSESSION_REASON,
    );
  }

  async function armThose() {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const outcome = await say(ADD_THOSE, session, deps, discourse);
    const after = medCounts(db as never);
    const bodies = groceryBodies(db as never);
    const unhandled = !outcome.handled
      && outcome.routeDecision.kind === 'device_read'
      && outcome.routeDecision.reason === UNRESOLVED_LIST_REFERENT_REASON;
    assert('add those zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('add those no those/that/it row', !bodies.some((b) => /^(those|that|this|these|them|it)$/i.test(b)), (v) => v === true, 'no pro-form');
    assert('add those arms clarify:list_add_item', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY, (v) => v === true, CLARIFY_LIST_ADD_ITEM_KEY);
    assert('add those keeps fail-closed device_read', unhandled, (v) => v === true, 'unresolved_list_referent');
    assert('add those does not store a pending commit payload', outcome.handled === false, (v) => v === true, 'unhandled');
    return { db, session, deps, discourse };
  }

  const armed = await armThose();

  {
    const { db, session, deps, discourse } = armed;
    const before = medCounts(db as never);
    const out = await say('roses', session, deps, discourse);
    const bodies = groceryBodies(db as never);
    const after = medCounts(db as never);
    assert(
      'roses resumes pending_resume',
      out.handled && out.source === 'pending_resume',
      (v) => v === true,
      'pending_resume',
    );
    assert('roses writes exactly one roses row', bodies.filter((b) => b === 'roses').length === 1 && bodies.length === 1, (v) => v === true, 'one roses');
    assert('roses consumes pending', session.peekPendingKey() === null, (v) => v === true, 'null');
    assert('roses sqlite delta is list_items only', after.list_items === before.list_items + 1 && after.facts === before.facts && after.medications === before.medications, (v) => v === true, '+1 list_item');
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    const out = await say('the roses', session, deps, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'the roses grounds to roses',
      out.handled && out.source === 'pending_resume' && bodies.filter((b) => b === 'roses').length === 1 && bodies.length === 1 && !session.hasPending(),
      (v) => v === true,
      'one roses',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say('My wife loves gardenias.', session, deps, discourse);
    const hold = discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|');
    const before = medCounts(db as never);
    const those = await say(ADD_THOSE, session, deps, discourse);
    const mid = medCounts(db as never);
    const bodiesMid = groceryBodies(db as never);
    assert('preference hold remains live after those', /wife:gardenias/i.test(hold ?? '') && /wife:gardenias/i.test(discourse.peekInterpretationHold()?.candidates.map((c) => `${c.subject}:${c.value}`).join('|') ?? ''), (v) => v === true, 'wife:gardenias');
    assert(
      'add those after gardenias preference writes nothing',
      JSON.stringify(before) === JSON.stringify(mid)
        && bodiesMid.length === 0
        && !those.handled
        && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
      (v) => v === true,
      'zero write + pending',
    );
    const out = await say('Gardenias.', session, deps, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'explicit Gardenias. writes gardenias from the answer, not the hold',
      out.handled && out.source === 'pending_resume' && bodies.filter((b) => b === 'gardenias').length === 1 && bodies.length === 1 && !session.hasPending(),
      (v) => v === true,
      'one gardenias',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const first = await say(SUPERSESSION, session, deps, discourse);
    const after = medCounts(db as never);
    const bodies = groceryBodies(db as never);
    assert('ambiguous self-repair zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('ambiguous self-repair stores no milk/bread/oat milk', !bodies.some((b) => /milk|bread/.test(b)), (v) => v === true, 'empty');
    assert(
      'ambiguous self-repair arms item clarification',
      !first.handled
        && first.routeDecision.reason === UNRESOLVED_LIST_ADD_SUPERSESSION_REASON
        && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
      (v) => v === true,
      CLARIFY_LIST_ADD_ITEM_KEY,
    );
    const out = await say('just the oat milk', session, deps, discourse);
    const later = groceryBodies(db as never);
    assert(
      'just the oat milk writes only oat milk',
      out.source === 'pending_resume' && later.filter((b) => b === 'oat milk').length === 1 && later.length === 1 && !later.includes('milk') && !later.includes('bread') && !session.hasPending(),
      (v) => v === true,
      'one oat milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    const out = await say('milk and eggs', session, deps, discourse);
    const bodies = groceryBodies(db as never).sort();
    assert(
      'multi-item clarification preserves segmentation',
      out.source === 'pending_resume' && JSON.stringify(bodies) === JSON.stringify(['eggs', 'milk']) && !session.hasPending(),
      (v) => v === true,
      'eggs+milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    const before = medCounts(db as never);
    const invalid = await say('those', session, deps, discourse);
    const after = medCounts(db as never);
    assert('those as answer zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert(
      'those as answer re-asks and retains pending',
      invalid.handled && invalid.source === 'pending_resume' && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
      (v) => v === true,
      're-ask',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    const yes = await say('yes', session, deps, discourse);
    assert(
      'yes cannot satisfy item clarification',
      yes.source === 'pending_resume' && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'pending retained',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    await say('those', session, deps, discourse);
    const released = await say('it', session, deps, discourse);
    assert(
      'retry exhaustion releases pending with zero write',
      released.source === 'pending_resume' && !session.hasPending() && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'released',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await say(ADD_THOSE, session, deps, discourse);
    const cancel = await say('never mind', session, deps, discourse);
    assert(
      'cancellation preserves existing cancel law',
      cancel.source === 'pending_resume' && !session.hasPending() && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'cancelled',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const innerLlm = deps.classifyLLM;
    deps.llmReady = true;
    deps.classifyLLM = async () => ({
      status: 'ok',
      intents: [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
    });
    const ask = await say('I need to go pick up milk and eggs later.', session, deps, discourse);
    assert(
      'confirmation pending isolation: llm_confirm still armed',
      ask.handled && session.peekPendingKey() === 'llm_confirm:list_add' && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'llm_confirm:list_add',
    );
    const roses = await say('roses', session, deps, discourse);
    assert(
      'roses cannot satisfy a confirmation pending',
      roses.source === 'pending_resume' && session.peekPendingKey() === 'llm_confirm:list_add' && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'still llm_confirm',
    );
    deps.classifyLLM = innerLlm;
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const first = await say('grab milk and eggs', session, deps, discourse);
    assert(
      'clarify:operational_list remains distinct',
      first.handled && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY,
      (v) => v === true,
      CLARIFY_OPERATIONAL_LIST_KEY,
    );
    const roses = await say('roses', session, deps, discourse);
    assert(
      'item-shaped roses does not fill operational-list domain',
      roses.source === 'pending_resume' && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY && groceryBodies(db as never).length === 0,
      (v) => v === true,
      'domain pending retained',
    );
    const grocery = await say('for groceries', session, deps, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'operational-list grocery resume still writes milk and eggs',
      grocery.source === 'pending_resume' && bodies.includes('milk') && bodies.includes('eggs') && !session.hasPending(),
      (v) => v === true,
      'milk+eggs',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const milk = await say('add milk to my grocery list', session, deps, discourse);
    assert(
      'ordinary RWI milk write remains green',
      milk.handled && milk.source === 'capture' && groceryBodies(db as never).includes('milk'),
      (v) => v === true,
      'milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const out = await say('add milk to my grocery list actually make that oat milk', session, deps, discourse);
    const bodies = groceryBodies(db as never);
    assert(
      'Same-Utterance Self-Repair remains green',
      out.handled && bodies.filter((b) => b === 'oat milk').length === 1 && !bodies.includes('milk'),
      (v) => v === true,
      'oat milk',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishCandidateSet('grocery', ['eggs', 'chocolate milk']);
    const out = await say(ADD_THOSE, session, deps, discourse);
    const bodies = groceryBodies(db as never).sort();
    assert(
      'candidateSet demonstrative still writes live items',
      out.handled && out.source === 'capture' && bodies.includes('eggs') && bodies.includes('chocolate milk') && session.peekPendingKey() !== CLARIFY_LIST_ADD_ITEM_KEY,
      (v) => v === true,
      'eggs + chocolate milk',
    );
  }

  console.log(`\n${BOLD}Fail-Closed List Clarification Continuation V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('listAddItemClarificationContinuation');
if (isDirect) {
  runListAddItemClarificationContinuationV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
