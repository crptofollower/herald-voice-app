// Historic ChatScreen todo_complete keyword matcher — moved to listRead.
// Pins current semantics: tokenize, drop stopwords, highest score wins,
// first-item tie (`score > bestScore` only). Do not "improve".

import { matchTodoCompleteItem, type PresentedListItem } from '../../src/db/listRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runTodoCompleteMatcherTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Todo-complete matcher (moved ChatScreen scorer) --------${RESET}\n`);

  const dentist: PresentedListItem = { id: 'todo_1', body: 'call the dentist' };
  const pharmacy: PresentedListItem = { id: 'todo_2', body: 'pick up pharmacy' };

  {
    const hit = matchTodoCompleteItem('I called the dentist.', [dentist, pharmacy]);
    assert('unique hit', hit?.id, (v) => v === 'todo_1', 'todo_1');
  }
  {
    const miss = matchTodoCompleteItem('I called the plumber.', [dentist, pharmacy]);
    assert('miss', miss, (v) => v === null, 'null');
  }
  {
    const empty = matchTodoCompleteItem('I called the dentist.', []);
    assert('empty list', empty, (v) => v === null, 'null');
  }
  {
    const a: PresentedListItem = { id: 'first', body: 'call the dentist' };
    const b: PresentedListItem = { id: 'second', body: 'call the dentist office' };
    const tie = matchTodoCompleteItem('I called the dentist.', [a, b]);
    assert('tie preserves first-highest', tie?.id, (v) => v === 'first', 'first');
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ todoCompleteMatcher: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ todoCompleteMatcher: ${passed}/${total} passed${RESET}`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('todoCompleteMatcher.test.ts')) {
  runTodoCompleteMatcherTests().then((r) => process.exit(r.failed ? 1 : 0));
}
