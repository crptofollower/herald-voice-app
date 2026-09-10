// scripts/heraldTest/groceryListReadRealization.test.ts
import {
  realizeGroceryListReadAct,
  isGroceryListReadSummarySpeech,
} from '../../src/conversation/groceryListReadRealization.ts';
import { composeOpenListSpeech } from '../../src/db/listRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runGroceryListReadRealizationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Grocery list-read realization --${RESET}\n`);

  assert('empty grocery speech unchanged',
    realizeGroceryListReadAct({ kind: 'empty' }),
    (v) => v === 'Your grocery list is empty.', 'empty copy');
  assert('one item is count summary not a dump',
    realizeGroceryListReadAct({ kind: 'count', itemCount: 1 }),
    (v) => v === "You've got one thing.", 'one thing');
  assert('five items is count summary',
    realizeGroceryListReadAct({ kind: 'count', itemCount: 5 }),
    (v) => v === "You've got 5 things.", '5 things');
  assert('composeOpenListSpeech grocery uses count not item dump',
    composeOpenListSpeech('grocery', [
      { id: 'a', body: 'Bananas' },
      { id: 'b', body: 'Dates' },
      { id: 'c', body: 'Milk' },
    ]),
    (v) => v === "You've got 3 things." && typeof v === 'string' && !/Bananas/.test(v),
    "You've got 3 things.");
  assert('non-grocery lists still name items',
    composeOpenListSpeech('shopping', [{ id: 'a', body: 'nails' }]),
    (v) => v === 'On your shopping list: nails.', 'shopping dump');
  assert('summary detector accepts grocery read speech',
    isGroceryListReadSummarySpeech("You've got 5 things."),
    (v) => v === true, 'true');
  assert('summary detector rejects removal ack',
    isGroceryListReadSummarySpeech('Done — Milk is off.'),
    (v) => v === false, 'false');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}groceryListReadRealization: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groceryListReadRealization.test.ts')) {
  runGroceryListReadRealizationTests().catch(console.error);
}
