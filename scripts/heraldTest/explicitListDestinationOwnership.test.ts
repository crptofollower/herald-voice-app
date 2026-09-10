// scripts/heraldTest/explicitListDestinationOwnership.test.ts
// M1 — explicit named-list destination owns the turn over generic todo_add.
// Structural classes, not founder wording. Does not add list/todo grammar.

import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { extractTodoAdd } from '../../src/utils/instructionSignals.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function groceryBodies(db: { prepare: (s: string) => { all: () => { body: string }[] } }): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

function todoBodies(db: { prepare: (s: string) => { all: () => { body: string }[] } }): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'todo' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

export async function runExplicitListDestinationOwnershipTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Explicit list destination ownership (M1) --${RESET}\n`);

  const groceryNeedAdd = 'I need to add milk eggs and bread to my grocery list';
  assert('EXTRACT todo remainder that is named-list add does not admit todo',
    extractTodoAdd(groceryNeedAdd), (v) => v === null, 'null');

  {
    const d = await classifyQuery(groceryNeedAdd);
    assert('CLASS grocery named-list after need-to is list_add',
      d.actionIntent?.type, (v) => v === 'list_add', 'list_add');
    assert('CLASS grocery named-list destination is grocery',
      (d.actionIntent as { listName?: string } | undefined)?.listName, (v) => v === 'grocery', 'grocery');
    assert('CLASS grocery named-list is not todo_add',
      d.actionIntent?.type, (v) => v !== 'todo_add', 'not todo_add');
    assert('CLASS grocery named-list is tier 1', d.tier, (v) => v === 1, '1');
  }

  {
    const d = await classifyQuery('I have to put oats on my shopping list');
    assert('CLASS shopping named-list after have-to is list_add',
      d.actionIntent?.type, (v) => v === 'list_add', 'list_add');
    assert('CLASS shopping destination owns the turn',
      (d.actionIntent as { listName?: string } | undefined)?.listName, (v) => v === 'shopping', 'shopping');
  }

  {
    const d = await classifyQuery('I need to call the dentist');
    assert('CLASS genuine todo without list destination stays todo_add',
      d.actionIntent?.type, (v) => v === 'todo_add', 'todo_add');
    assert('CLASS genuine todo body is the task remainder',
      (d.actionIntent as { body?: string } | undefined)?.body,
      (v) => typeof v === 'string' && /call the dentist/i.test(v), 'call the dentist');
  }

  {
    const d = await classifyQuery('I should mail the package');
    assert('CLASS should-prefix todo without list destination stays todo_add',
      d.actionIntent?.type, (v) => v === 'todo_add', 'todo_add');
  }

  {
    const compound = 'I need to call the dentist and add milk to my grocery list';
    assert('EXTRACT later list-add conjunct does not void leading todo remainder',
      extractTodoAdd(compound)?.kind, (v) => v === 'add', 'add');
    const d = await classifyQuery(compound);
    assert('CLASS leading genuine todo is not stolen by a later named-list conjunct',
      d.actionIntent?.type, (v) => v === 'todo_add', 'todo_add');
  }

  {
    const d = await classifyQuery('add chocolate milk to my grocery list');
    assert('CLASS imperative grocery add without todo prefix stays list_add',
      d.actionIntent?.type, (v) => v === 'list_add', 'list_add');
  }

  {
    const d = await classifyQuery("what is on my to-do list");
    assert('CLASS todo read is unchanged',
      d.actionIntent?.type, (v) => v === 'todo_read', 'todo_read');
  }

  {
    const d = await classifyQuery('I finished calling the dentist');
    const isComplete = d.actionIntent?.type === 'todo_complete';
    const isNotStolenList = d.actionIntent?.type !== 'list_add';
    assert('CLASS todo complete is not rewritten as list_add',
      isComplete || isNotStolenList, (v) => v === true, 'todo_complete or at least not list_add');
  }

  {
    const harness = openJourneyDb();
    const ctx = {
      completion: async (opts?: { messages?: Array<{ content?: string }> }) => {
        const sys = String(opts?.messages?.[0]?.content ?? '');
        if (sys.includes('Pick exactly one capability')) {
          return { content: '{"capability":"grocery.capture","confidence":"high"}' };
        }
        return {
          content: JSON.stringify({
            capability: 'grocery_capture',
            candidates: ['milk', 'eggs', 'bread'],
            confidence: 0.92,
          }),
        };
      },
    };
    const t1 = await processUtterance(normalizeInput(groceryNeedAdd), harness.session, {
      ...harness.deps,
      getMedicationSemanticInterpreterCtx: () => ctx as any,
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
      llmReady: false,
    });
    assert('WRITE grocery named-list persist is grocery not todo',
      groceryBodies(harness.db),
      (v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(['bread', 'eggs', 'milk']),
      '["bread","eggs","milk"]');
    assert('WRITE todo list stays empty',
      todoBodies(harness.db), (v) => Array.isArray(v) && v.length === 0, '[]');
    assert('WRITE is not pending confirmation (P1 deterministic grocery)',
      t1.commits.some((c) => c.status === 'pending'), (v) => v === false, 'no pending');
  }

  {
    const decision = await routeIntent(groceryNeedAdd, {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: [] },
    });
    assert('ROUTE is deterministic capture',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'deterministic',
      (v) => v === true, 'capture/deterministic');
    assert('ROUTE intent is list_add (dispatch not required)',
      (decision as { intents?: Array<{ type: string }> }).intents?.[0]?.type,
      (v) => v === 'list_add', 'list_add');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ExplicitListDestinationOwnership: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('explicitListDestinationOwnership.test.ts')) {
  runExplicitListDestinationOwnershipTests().catch(console.error);
}
