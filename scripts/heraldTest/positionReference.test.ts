// Bounded position-reference interpretation — semantic family + collisions.
// Runner: npx tsx scripts/heraldTest/positionReference.test.ts

import { interpretPositionReference, isPositionMutationLanguage } from '../../src/routing/positionReference.ts';
import { parseGroceryReadPosition, parseCuedListPositions } from '../../src/routing/orderedPresentation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function pos(n: number) {
  return (v: ReturnType<typeof interpretPositionReference>) =>
    v.kind === 'position_reference' && v.positions.length === 1 && v.positions[0] === n;
}

export async function runPositionReferenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: any) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Position reference interpretation --------------------${RESET}\n`);

  const family: [string, string, number][] = [
    ['PR1 one', "What's the third one?", 3],
    ['PR2 thing', "What's the third thing?", 3],
    ['PR3 item', "What's the third item?", 3],
    ['PR4 and ellipsis', 'And the third?', 3],
    ['PR5 how about ellipsis', 'How about the third?', 3],
    ['PR6 what about ellipsis', 'What about the third?', 3],
    ['PR7 whats ellipsis', "What's the third?", 3],
    ['PR8 number three', 'What about number three?', 3],
    ['PR9 which one inversion', 'Which one was third?', 3],
    ['PR10 which thing inversion', 'Which thing was third?', 3],
    ['PR11 remind wrapper', 'Remind me what the third item was.', 3],
    ['PR12 that one again', 'What was that third one again?', 3],
    ['PR13 number three bare', 'number three', 3],
    ['PR14 item three', 'item three', 3],
    ['PR15 hash', '#3', 3],
    ['PR16 filler', 'Okay, what about the third one?', 3],
    ['PR17 second thing', "What's the second thing?", 2],
  ];
  for (const [label, phrase, n] of family) {
    assert(label, interpretPositionReference(phrase), pos(n), `position ${n}`);
  }

  assert('PR18 named sentence still extracts N', interpretPositionReference('What was the second thing on my grocery list?'),
    pos(2), 'position 2');
  assert('PR19 parseGroceryReadPosition thing', parseGroceryReadPosition("What's the third thing?"),
    v => v === 3, '3');
  assert('PR20 competing', interpretPositionReference('the first one and the third one'),
    v => v.kind === 'ambiguous' && v.reason === 'competing_positions' && v.positions.join(',') === '1,3',
    'ambiguous 1,3');
  assert('PR21 numbers list', parseCuedListPositions('numbers 2, 4, and 5'),
    v => Array.isArray(v) && v.join(',') === '2,4,5', '[2,4,5]');

  assert('PR22 date on the third', interpretPositionReference('I saw him on the third.'),
    v => v.kind === 'unsafe' && v.reason === 'date_like', 'date_like');
  assert('PR23 the 23rd', interpretPositionReference('the 23rd'),
    v => v.kind === 'none', 'none');
  assert('PR24 dose', interpretPositionReference('Take 25 mg.'),
    v => v.kind === 'unsafe' && v.reason === 'dose', 'dose');
  assert('PR25 time', interpretPositionReference('At 3:00.'),
    v => v.kind === 'unsafe' && v.reason === 'time', 'time');
  assert('PR26 red one', interpretPositionReference('The red one.'),
    v => v.kind === 'none', 'none');
  assert('PR27 mutation default is unsafe', interpretPositionReference('Remove the second thing on my grocery list.'),
    v => v.kind === 'unsafe' && v.reason === 'mutation', 'mutation');
  assert('PR37 mutation can extract N', interpretPositionReference('Remove the second thing.', { allowMutationLanguage: true }),
    pos(2), 'position 2');
  assert('PR38 take-off span extracts N', interpretPositionReference('Take the third thing off my grocery list.', { allowMutationLanguage: true }),
    pos(3), 'position 3');
  assert('PR39 I got extracts N', interpretPositionReference('I got the third item.', { allowMutationLanguage: true }),
    pos(3), 'position 3');
  assert('PR40 read parser still refuses mutation', parseGroceryReadPosition('Remove the second thing.'),
    v => v === null, 'null');
  assert('PR41 cued parser still refuses mutation', parseCuedListPositions('Delete the fourth item.'),
    v => v === null, 'null');
  assert('PR28 it', interpretPositionReference('It'), v => v.kind === 'none', 'none');
  assert('PR29 this one', interpretPositionReference('This one'), v => v.kind === 'none', 'none');
  assert('PR30 next', interpretPositionReference('the next one'),
    v => v.kind === 'ambiguous' && v.reason === 'relative', 'relative');
  assert('PR31 previous', interpretPositionReference('the previous one'),
    v => v.kind === 'ambiguous' && v.reason === 'relative', 'relative');
  assert('PR32 other one', interpretPositionReference('the other one'),
    v => v.kind === 'ambiguous' && v.reason === 'other_anaphor', 'other_anaphor');
  assert('PR33 after eggs', interpretPositionReference('the one after eggs'),
    v => v.kind === 'none', 'none');
  assert('PR34 appointment 23rd', interpretPositionReference('My appointment is on the 23rd.'),
    v => v.kind === 'unsafe' && v.reason === 'date_like', 'date_like');
  assert('PR35 no interpretation', interpretPositionReference('what time is it'),
    v => v.kind === 'none', 'none');
  assert('PR36 no IDs on object', interpretPositionReference("What's the third thing?"),
    v => v.kind === 'position_reference' && !('id' in v) && !('body' in v) && !('ids' in v),
    'no id/body');
  assert('PR42 isPositionMutationLanguage remove', isPositionMutationLanguage('Remove the second thing.'),
    v => v === true, 'true');
  assert('PR43 isPositionMutationLanguage read', isPositionMutationLanguage("What's the second thing?"),
    v => v === false, 'false');

  const total = passed + failures.length;
  console.log(`\n${BOLD}Position reference: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('positionReference.test.ts')) {
  runPositionReferenceTests().catch(console.error);
}
