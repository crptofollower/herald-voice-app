// scripts/heraldTest/mutationAuthorityBoundary.test.ts
// todo_complete / list_remove claim authority: genuine mutation vs narrative.
//
// Runner: npx tsx scripts/heraldTest/mutationAuthorityBoundary.test.ts
// Gate:   wired from run.mjs

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { boundMutationObject } from '../../src/utils/instructionSignals.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

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

export async function runMutationAuthorityBoundaryTests() {
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

  console.log(`\n${BOLD}-- Mutation Authority Boundary ---------------------------${RESET}`);

  console.log(`\n${BOLD}Positive — todo completion${RESET}`);
  for (const phrase of [
    'I finished the taxes',
    'I called the dentist',
    'cross that off',
  ]) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`pos todo "${phrase}"`, actionType(d), (v) => v === 'todo_complete', 'todo_complete');
  }

  console.log(`\n${BOLD}Positive — list removal${RESET}`);
  {
    freshDB();
    const d = await classifyQuery('remove oranges from my grocery list');
    assert('pos explicit list_remove', actionType(d), (v) => v === 'list_remove', 'list_remove');
  }

  console.log(`\n${BOLD}Negative — bare past acquisition is not list_remove${RESET}`);
  {
    freshDB();
    const d = await classifyQuery('I got eggs');
    assert(
      'bare I-got report ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('we bought milk');
    assert(
      'bare we-bought report ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('I picked up the prescription');
    assert(
      'bare I-picked-up report ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
    assert(
      'bare I-picked-up report ≠ todo_complete',
      actionType(d),
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
  }

  console.log(`\n${BOLD}Ambiguous genuine mutation stays deterministic${RESET}`);
  {
    freshDB();
    const d = await classifyQuery('I finished that thing from yesterday');
    assert(
      'ambiguous finished-anaphor remains todo_complete',
      actionType(d),
      (v) => v === 'todo_complete',
      'todo_complete',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('I got that');
    assert(
      'bare I-got anaphor ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }

  console.log(`\n${BOLD}Negative — life narrative / todo${RESET}`);
  {
    freshDB();
    const d = await classifyQuery(
      'I went to see an old college friend named Rodney',
    );
    assert(
      'T6-structure visit narrative ≠ todo_complete',
      actionType(d),
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('I went to see my neighbor after work');
    assert(
      'purpose-infinitive visit narrative ≠ todo_complete',
      actionType(d),
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
  }

  console.log(`\n${BOLD}Negative — life narrative / grocery${RESET}`);
  {
    freshDB();
    const d = await classifyQuery(
      "My wife and I went to the grocery store yesterday we bought cantaloupe and bananas but we didn't get any meat I need to do that tomorrow",
    );
    assert(
      'T13-structure shopping report ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
    assert(
      'T13-structure shopping report ≠ todo_complete',
      actionType(d),
      (v) => v !== 'todo_complete',
      'not todo_complete',
    );
  }
  {
    freshDB();
    const d = await classifyQuery(
      'We walked around the market we bought flowers because they were pretty',
    );
    assert(
      'mid-clause we-bought report ≠ list_remove',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }

  console.log(`\n${BOLD}Tail bounding${RESET}`);
  {
    freshDB();
    const d = await classifyQuery('I got milk but I need to get eggs');
    assert(
      'I-got report is not list_remove; but-clause is not an inferred grocery item',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('I got eggs I need to do that tomorrow');
    assert(
      'I-got report is not list_remove; I-need-to tail is not a grocery item',
      actionType(d),
      (v) => v !== 'list_remove',
      'not list_remove',
    );
  }
  {
    freshDB();
    const d = await classifyQuery('I finished the report and then I sat down');
    assert(
      'finished + and-then remains todo_complete',
      actionType(d),
      (v) => v === 'todo_complete',
      'todo_complete',
    );
  }
  {
    freshDB();
    const d = await classifyQuery("take milk off my list because it's gone");
    assert(
      'explicit remove item does not swallow because-clause',
      (d.actionIntent as { item?: string } | undefined)?.item,
      (v) => v === 'milk',
      'milk',
    );
  }
  {
    assert(
      'boundMutationObject cuts because / and then / I need to',
      [
        boundMutationObject('milk because it spoiled'),
        boundMutationObject('eggs and then we left'),
        boundMutationObject('bread I need to get ham'),
      ],
      (v) => {
        const x = v as string[];
        return x[0] === 'milk' && x[1] === 'eggs' && x[2] === 'bread';
      },
      'milk / eggs / bread',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MutationAuthorityBoundary: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('mutationAuthorityBoundary.test.ts')) {
  runMutationAuthorityBoundaryTests().catch(console.error);
}
