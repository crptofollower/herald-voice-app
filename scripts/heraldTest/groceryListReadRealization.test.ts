// scripts/heraldTest/groceryListReadRealization.test.ts
import {
  realizeGroceryListReadAct,
  isGroceryListReadSummarySpeech,
} from '../../src/conversation/groceryListReadRealization.ts';
import { composeOpenListSpeech, getPresentedOpenListItems } from '../../src/db/listRead.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function namesInOrder(text: string, names: string[]): boolean {
  let from = 0;
  for (const name of names) {
    const idx = text.toLowerCase().indexOf(name.toLowerCase(), from);
    if (idx < 0) return false;
    from = idx + name.length;
  }
  return true;
}

function say(
  input: string,
  session: ReturnType<typeof openJourneyDb>['session'],
  deps: ReturnType<typeof openJourneyDb>['deps'],
  discourse: DiscourseContinuityHolder,
) {
  return processUtterance(normalizeInput(input), session, deps, null, null, null, null, null, discourse);
}

function groceryReadText(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  if (!outcome.handled && outcome.routeDecision.kind === 'device_read') {
    return outcome.routeDecision.response;
  }
  return '';
}

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

  assert('empty grocery speech truthful',
    realizeGroceryListReadAct({ kind: 'empty' }),
    (v) => v === 'Your grocery list is empty.', 'empty copy');
  assert('one item names the body',
    realizeGroceryListReadAct({ kind: 'items', items: ['eggs'] }),
    (v) => typeof v === 'string' && /eggs/i.test(v) && !/butter|bread/i.test(v),
    'names eggs only');
  assert('two items name both in order',
    realizeGroceryListReadAct({ kind: 'items', items: ['eggs', 'butter'] }),
    (v) => typeof v === 'string' && namesInOrder(v, ['eggs', 'butter']),
    'eggs then butter');
  assert('three items name every body in order',
    realizeGroceryListReadAct({ kind: 'items', items: ['eggs', 'butter', 'bread'] }),
    (v) => typeof v === 'string' && namesInOrder(v, ['eggs', 'butter', 'bread']),
    'eggs, butter, bread');
  assert('stored body is spoken as stored',
    realizeGroceryListReadAct({ kind: 'items', items: ['milk.'] }),
    (v) => typeof v === 'string' && String(v).includes('milk.'),
    'milk.');
  assert('composeOpenListSpeech grocery names presented bodies',
    composeOpenListSpeech('grocery', [
      { id: 'a', body: 'Bananas' },
      { id: 'b', body: 'Dates' },
      { id: 'c', body: 'Milk' },
    ]),
    (v) => typeof v === 'string' && namesInOrder(v, ['Bananas', 'Dates', 'Milk']) && !/oranges/i.test(v),
    'Bananas, Dates, Milk');
  assert('composeOpenListSpeech grocery empty stays empty copy',
    composeOpenListSpeech('grocery', []),
    (v) => v === 'Your grocery list is empty.', 'empty');
  assert('non-grocery lists still name items',
    composeOpenListSpeech('shopping', [{ id: 'a', body: 'nails' }]),
    (v) => v === 'On your shopping list: nails.', 'shopping dump');
  assert('summary detector accepts named grocery read speech',
    isGroceryListReadSummarySpeech(realizeGroceryListReadAct({ kind: 'items', items: ['eggs', 'butter'] })),
    (v) => v === true, 'true');
  assert('summary detector rejects removal ack',
    isGroceryListReadSummarySpeech('Done — Milk is off.'),
    (v) => v === false, 'false');

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const empty = await say("What's on my grocery list?", session, deps, discourse);
    assert('empty list_read is truthful',
      groceryReadText(empty),
      (v) => v === 'Your grocery list is empty.' && !empty.handled,
      'empty');
    await say('add eggs to my grocery list', session, deps, discourse);
    const one = await say("What's on my grocery list?", session, deps, discourse);
    const oneText = groceryReadText(one);
    assert('one-item list_read names eggs',
      oneText,
      (v) => typeof v === 'string' && /eggs/i.test(v) && !/butter|bread/i.test(v),
      'eggs');
    await say('add butter to my grocery list', session, deps, discourse);
    const two = await say("What's on my grocery list?", session, deps, discourse);
    assert('two-item list_read names eggs then butter',
      groceryReadText(two),
      (v) => typeof v === 'string' && namesInOrder(v, ['eggs', 'butter']),
      'eggs, butter');
    await say('add bread to my grocery list', session, deps, discourse);
    const three = await say("What's on my grocery list?", session, deps, discourse);
    const threeText = groceryReadText(three);
    const presented = getPresentedOpenListItems('grocery').map((i) => i.body);
    assert('3+ list_read names every current item in authoritative order',
      { threeText, presented },
      (v) => {
        const o = v as { threeText: string; presented: string[] };
        return o.presented.length === 3 && namesInOrder(o.threeText, o.presented) && !/oranges/i.test(o.threeText);
      },
      'eggs, butter, bread');
    db.prepare(`UPDATE list_items SET checked = 1, removed_at = ? WHERE lower(body) = 'butter'`).run(new Date().toISOString());
    const afterRemove = await say("What's on my grocery list?", session, deps, discourse);
    const afterText = groceryReadText(afterRemove);
    const remaining = getPresentedOpenListItems('grocery').map((i) => i.body.toLowerCase());
    assert('completed/removed items follow existing open-list semantics',
      { afterText, remaining },
      (v) => {
        const o = v as { afterText: string; remaining: string[] };
        return o.remaining.includes('eggs') && o.remaining.includes('bread') && !o.remaining.includes('butter')
          && namesInOrder(o.afterText, ['eggs', 'bread']) && !/butter/i.test(o.afterText);
      },
      'eggs and bread, no butter');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const add = await say('add eggs to my grocery list', session, deps, discourse);
    assert('ordinary list-add still commits',
      add.handled && add.source === 'capture' && getPresentedOpenListItems('grocery').some((i) => /eggs/i.test(i.body)),
      (v) => v === true,
      'eggs committed');
    const those = await say('add those to my grocery list', session, deps, discourse);
    assert('fail-closed clarification still arms',
      !those.handled
        && those.routeDecision.kind === 'device_read'
        && those.routeDecision.reason === 'unresolved_list_referent'
        && session.peekPendingKey() === 'clarify:list_add_item',
      (v) => v === true,
      'clarify:list_add_item');
    await say('Butter.', session, deps, discourse);
    await say('Also add bread.', session, deps, discourse);
    const read = await say("What's on my grocery list?", session, deps, discourse);
    const text = groceryReadText(read);
    const bodies = getPresentedOpenListItems('grocery').map((i) => i.body.toLowerCase());
    assert('composed eggs→clarify→butter→bread list_read names all current items',
      { text, bodies },
      (v) => {
        const o = v as { text: string; bodies: string[] };
        return o.bodies.includes('eggs') && o.bodies.includes('butter') && o.bodies.includes('bread')
          && namesInOrder(o.text, ['eggs', 'butter', 'bread'])
          && !/those/i.test(o.text);
      },
      'eggs, butter, bread');
  }

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
