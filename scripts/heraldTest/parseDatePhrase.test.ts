// scripts/heraldTest/parseDatePhrase.test.ts
// parseDatePhrase contract — MEDICAL_SURFACING_DESIGN_SPEC §2.2b.
// Locks today/tomorrow/weekday/month grammar; null on anything else.
//
// Runner: npx tsx scripts/heraldTest/parseDatePhrase.test.ts

import { parseDatePhrase } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Fixed anchors — Jul 12 2026 is Sunday, Jul 13 2026 is Monday.
const SUNDAY = new Date(2026, 6, 12);
const MONDAY = new Date(2026, 6, 13);
const JUL_11 = new Date(2026, 6, 11); // before July 15
const JUL_16 = new Date(2026, 6, 16); // after July 15

export async function runParseDatePhraseTests() {
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

  console.log(`\n${BOLD}-- parseDatePhrase Contract Tests -----------------------------${RESET}\n`);

  assert(
    'PDP1 tomorrow → next calendar day',
    parseDatePhrase('tomorrow', SUNDAY),
    (v) => v === '2026-07-13',
    '2026-07-13',
  );

  assert(
    'PDP2 today → reference day',
    parseDatePhrase('today', SUNDAY),
    (v) => v === '2026-07-12',
    '2026-07-12',
  );

  assert(
    'PDP3 bare sunday → nearest Sunday, today-inclusive',
    parseDatePhrase('sunday', SUNDAY),
    (v) => v === '2026-07-12',
    '2026-07-12',
  );

  assert(
    'PDP4 this sunday → same as bare',
    parseDatePhrase('this sunday', SUNDAY),
    (v) => v === '2026-07-12',
    '2026-07-12',
  );

  assert(
    'PDP5 next sunday on a Sunday → 7 days out, not today',
    parseDatePhrase('next sunday', SUNDAY),
    (v) => v === '2026-07-19',
    '2026-07-19',
  );

  assert(
    'PDP6 next sunday when today is NOT Sunday → same as bare nearest',
    parseDatePhrase('next sunday', MONDAY),
    (v) => v === parseDatePhrase('sunday', MONDAY) && v === '2026-07-19',
    '2026-07-19 (same as bare sunday from Monday)',
  );

  assert(
    'PDP7 july 15th before the date → this year',
    parseDatePhrase('july 15th', JUL_11),
    (v) => v === '2026-07-15',
    '2026-07-15',
  );

  assert(
    'PDP8 july 15th after the date → rolls to next year',
    parseDatePhrase('july 15th', JUL_16),
    (v) => v === '2027-07-15',
    '2027-07-15',
  );

  assert(
    'PDP9 sometime next month → null (never guess)',
    parseDatePhrase('sometime next month', SUNDAY),
    (v) => v === null,
    'null',
  );

  assert(
    'PDP10 empty string → null',
    parseDatePhrase('', SUNDAY),
    (v) => v === null,
    'null',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}parseDatePhrase: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('parseDatePhrase.test.ts')) {
  runParseDatePhraseTests().catch(console.error);
}
