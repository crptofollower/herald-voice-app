// scripts/heraldTest/todoCompleteSignals.test.ts
// TODO_COMPLETE_SIGNALS routing — "I already <verb>" must complete todos;
// bare "I already …" without a completion verb must not.
//
// Runner: npx tsx scripts/heraldTest/todoCompleteSignals.test.ts
// Gate:   wired from run.mjs

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery, scanResidualIntent } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Minimal tables classifyQuery may touch on fall-through after a miss.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function actionType(d: { actionIntent?: { type?: string } }): string | undefined {
  return d.actionIntent?.type;
}

export async function runTodoCompleteSignalsTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
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

  console.log(`\n${BOLD}-- Todo-Complete Signals Tests ---------------------------${RESET}`);

  const positives = [
    'I already paid the bill',
    'I already called the doctor',
    'I already finished that',
    'I already did it',
    'I already took care of that',
  ];
  for (const phrase of positives) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`pos "${phrase}" → todo_complete`, actionType(d), (v) => v === 'todo_complete', 'todo_complete');
  }

  const negatives = [
    'I already showed this one to you',
    'I already know about that',
    'I already watched that video',
    'I already told you my name',
    'Like Kit can you open YouTube for me I think I already showed this one to you',
    'I already have YouTube open',
    'I already know what is on my to-do list',
  ];
  for (const phrase of negatives) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`neg "${phrase}" ≠ todo_complete`, actionType(d), (v) => v !== 'todo_complete', 'not todo_complete');
  }

  const regressions = [
    'I called the doctor',
    'I finished that',
    'I did it',
    'I paid the bill',
    'I dropped off the package',
    'I returned the library books',
    'I filed the paperwork',
    'cross that off',
    'mark that done',
    'that is done',
    'I went to the store',
    'I stopped by the pharmacy',
  ];
  for (const phrase of regressions) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`reg "${phrase}" → todo_complete`, actionType(d), (v) => v === 'todo_complete', 'todo_complete');
  }

  // Bare past acquisition is not list_remove and not todo_complete.
  {
    freshDB();
    const d = await classifyQuery('I picked up the prescription');
    assert(
      'reg "I picked up the prescription" → not list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
    assert(
      'reg "I picked up the prescription" → not todo_complete',
      actionType(d),
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
  }

  console.log(`\n${BOLD}-- Todo-Add Body Capture ---------------------------------${RESET}`);

  {
    freshDB();
    const compound = 'Remove that — yeah, but I need to work out and start dinner.';
    const d = await classifyQuery(compound);
    assert('compound TODO_ADD does not commit as todo_add',
      actionType(d), (v) => v !== 'todo_add', 'not todo_add');
    assert('compound TODO_ADD clarifies instead of storing leading material',
      { reason: d.reason, body: (d.actionIntent as { body?: string } | undefined)?.body, reply: d.tier1Response },
      (v) => {
        const x = v as { reason?: string; body?: string; reply?: string };
        return x.reason === 'action:todo_add_compound'
          && !x.body
          && typeof x.reply === 'string'
          && !/remove that/i.test(x.reply);
      },
      'action:todo_add_compound, no body');
  }

  const ordinaryAdds: { phrase: string; body: string }[] = [
    { phrase: 'I need to work out', body: 'work out' },
    { phrase: 'I have to call the dentist', body: 'call the dentist' },
    { phrase: 'I gotta wash the car', body: 'wash the car' },
    { phrase: 'I need to start dinner', body: 'start dinner' },
    { phrase: 'I should email Jane', body: 'email Jane' },
    { phrase: 'I must file the taxes', body: 'file the taxes' },
    { phrase: "don't let me forget to buy stamps", body: 'to buy stamps' },
    { phrase: 'Kit, I need to work out', body: 'work out' },
  ];
  for (const { phrase, body } of ordinaryAdds) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`ordinary "${phrase}" → todo_add body "${body}"`,
      { type: actionType(d), body: (d.actionIntent as { body?: string } | undefined)?.body },
      (v) => {
        const x = v as { type?: string; body?: string };
        return x.type === 'todo_add' && x.body === body;
      },
      `todo_add / ${body}`);
  }

  console.log(`\n${BOLD}-- Residual Capture Bound -------------------------------${RESET}`);

  {
    freshDB();
    const d = await classifyQuery('I need to work out and start dinner');
    assert('multi-word todo "work out and start dinner" stays one body',
      (d.actionIntent as { body?: string } | undefined)?.body,
      (v) => v === 'work out and start dinner',
      'work out and start dinner');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to work out today');
    assert('"I need to work out today" is not todo_add (dated contract)',
      actionType(d), (v) => v !== 'todo_add', 'not todo_add');
  }
  {
    freshDB();
    const d = await classifyQuery("We're out of milk");
    assert('simple contextual grocery → list_add milk',
      { type: actionType(d), items: (d.actionIntent as { items?: string[] } | undefined)?.items },
      (v) => {
        const x = v as { type?: string; items?: string[] };
        return x.type === 'list_add' && x.items?.length === 1 && x.items[0] === 'milk';
      },
      'list_add [milk]');
  }
  {
    freshDB();
    const d = await classifyQuery("We're out of peanut butter");
    assert('multi-word grocery item peanut butter stays intact',
      (d.actionIntent as { items?: string[] } | undefined)?.items,
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'peanut butter',
      '[peanut butter]');
  }
  {
    freshDB();
    const d = await classifyQuery("We're out of milk and eggs");
    assert('grocery "milk and eggs" conjunction stays one item',
      (d.actionIntent as { items?: string[] } | undefined)?.items,
      (v) => Array.isArray(v) && v.length === 1 && v[0] === 'milk and eggs',
      '[milk and eggs]');
  }
  {
    freshDB();
    const residual = await scanResidualIntent(
      'Call Hunter and I need to work out and what is the weather',
      'call',
    );
    assert('residual todo does not persist the weather-question tail',
      { type: residual?.actionIntent?.type, body: (residual?.actionIntent as { body?: string } | undefined)?.body },
      (v) => {
        const x = v as { type?: string; body?: string };
        return x.type === 'todo_add' && x.body === 'work out';
      },
      'todo_add / work out');
  }
  {
    freshDB();
    const residual = await scanResidualIntent(
      "Call Hunter and we're out of milk and what is the weather",
      'call',
    );
    assert('residual grocery does not persist the weather-question tail',
      { type: residual?.actionIntent?.type, items: (residual?.actionIntent as { items?: string[] } | undefined)?.items },
      (v) => {
        const x = v as { type?: string; items?: string[] };
        return x.type === 'list_add' && x.items?.length === 1 && x.items[0] === 'milk';
      },
      'list_add [milk]');
  }
  {
    freshDB();
    const residual = await scanResidualIntent(
      'I need to pick up milk from the grocery store and I need to work out',
      'list_add',
    );
    assert('residual todo after grocery-acquisition primary is only the later clause',
      { type: residual?.actionIntent?.type, body: (residual?.actionIntent as { body?: string } | undefined)?.body },
      (v) => {
        const x = v as { type?: string; body?: string };
        return x.type === 'todo_add' && x.body === 'work out' && !/milk/i.test(x.body ?? '');
      },
      'todo_add / work out');
  }
  {
    freshDB();
    const residual = await scanResidualIntent(
      'Call Hunter and I need to work out and start dinner',
      'call',
    );
    assert('residual todo keeps legitimate and-conjunction body',
      (residual?.actionIntent as { body?: string } | undefined)?.body,
      (v) => v === 'work out and start dinner',
      'work out and start dinner');
  }

  {
    freshDB();
    const d = await classifyQuery('What do I still need to get done?');
    assert('interrogative get-done is not grocery list_add of done',
      { type: actionType(d), items: (d.actionIntent as { items?: string[] } | undefined)?.items, reason: d.reason },
      (v) => {
        const x = v as { type?: string; items?: string[]; reason?: string };
        return x.type !== 'list_add' && x.reason !== 'action:list_add:contextual' && !(x.items ?? []).includes('done');
      },
      'not list_add [done]');
  }
  {
    freshDB();
    const d = await classifyQuery('What do I need to get done today?');
    assert('"What do I need to get done today?" remains todo_read',
      actionType(d), (v) => v === 'todo_read', 'todo_read');
  }
  {
    freshDB();
    const d = await classifyQuery('We need to get milk');
    assert('unmarked we-need-to-get is not person-dependent grocery write',
      { type: actionType(d), reason: d.reason },
      (v) => {
        const x = v as { type?: string; reason?: string };
        return x.type !== 'todo_add' && x.type !== 'list_add' && x.reason === 'default';
      },
      '3:default');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to get milk');
    assert('unmarked I-need-to-get milk is not immediate todo_add',
      { type: actionType(d), body: (d.actionIntent as { body?: string } | undefined)?.body, reason: d.reason },
      (v) => {
        const x = v as { type?: string; body?: string; reason?: string };
        return x.type !== 'todo_add' && x.body !== 'get milk' && x.type !== 'list_add' && x.reason === 'default';
      },
      '3:default not get milk');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to call the dentist');
    assert('task-shaped I-need-to-call remains todo_add',
      { type: actionType(d), body: (d.actionIntent as { body?: string } | undefined)?.body },
      (v) => {
        const x = v as { type?: string; body?: string };
        return x.type === 'todo_add' && /^call the dentist/.test(x.body ?? '');
      },
      'todo_add call the dentist');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to water the plants');
    assert('task-shaped I-need-to-water remains todo_add',
      actionType(d), (v) => v === 'todo_add', 'todo_add');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to get my car inspected');
    assert('I-need-to-get car inspected is not grocery list_add',
      { type: actionType(d), reason: d.reason },
      (v) => {
        const x = v as { type?: string; reason?: string };
        return x.type !== 'list_add' && x.reason !== 'action:list_add:contextual';
      },
      'not grocery');
  }
  {
    freshDB();
    const d = await classifyQuery('We need to get bread');
    assert('unmarked we-need-to-get bread matches I-need-to-get path',
      { type: actionType(d), reason: d.reason },
      (v) => {
        const x = v as { type?: string; reason?: string };
        return x.type !== 'todo_add' && x.type !== 'list_add' && x.reason === 'default';
      },
      '3:default');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to pick up eggs');
    assert('unmarked I-need-to-pick-up is not person-dependent todo write',
      { type: actionType(d), reason: d.reason },
      (v) => {
        const x = v as { type?: string; reason?: string };
        return x.type !== 'todo_add' && x.type !== 'list_add' && x.reason === 'default';
      },
      '3:default');
  }
  {
    freshDB();
    const d = await classifyQuery('I need to get milk from the grocery store');
    assert('store-marked acquisition remains grocery',
      { type: actionType(d), reason: d.reason, listName: (d.actionIntent as { listName?: string } | undefined)?.listName },
      (v) => {
        const x = v as { type?: string; reason?: string; listName?: string };
        return x.type === 'list_add' && x.listName === 'grocery' && x.reason === 'action:list_add:acquisition_grocery';
      },
      'acquisition_grocery');
  }
  {
    freshDB();
    const d = await classifyQuery("We're out of bread");
    assert('out-of bread remains contextual grocery',
      { type: actionType(d), items: (d.actionIntent as { items?: string[] } | undefined)?.items },
      (v) => {
        const x = v as { type?: string; items?: string[] };
        return x.type === 'list_add' && x.items?.length === 1 && x.items[0] === 'bread';
      },
      'list_add [bread]');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TodoCompleteSignals: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('todoCompleteSignals.test.ts')) {
  runTodoCompleteSignalsTests().catch(console.error);
}
