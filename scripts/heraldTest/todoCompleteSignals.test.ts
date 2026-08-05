// scripts/heraldTest/todoCompleteSignals.test.ts
// TODO_COMPLETE_SIGNALS routing — "I already <verb>" must complete todos;
// bare "I already …" without a completion verb must not.
//
// Runner: npx tsx scripts/heraldTest/todoCompleteSignals.test.ts
// Gate:   wired from run.mjs

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

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

  // Pre-existing router order (list_remove before todo_complete — see tierRouter
  // comment at the list_remove gate). "I picked up …" / "I got …" acquisition
  // phrasing is claimed by list_remove; this is not a TODO_COMPLETE_SIGNALS
  // regression from the "I already" tightening.
  {
    freshDB();
    const d = await classifyQuery('I picked up the prescription');
    assert(
      'reg "I picked up the prescription" → list_remove (pre-existing order)',
      actionType(d),
      (v) => v === 'list_remove',
      'list_remove',
    );
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
