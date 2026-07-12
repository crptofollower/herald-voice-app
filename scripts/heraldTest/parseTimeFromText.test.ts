// scripts/heraldTest/parseTimeFromText.test.ts
// parseTimeFromText / alarm / reminder / calendar-write — space-separated minutes.
//
// Runner: npx tsx scripts/heraldTest/parseTimeFromText.test.ts

import {
  parseTimeFromText,
  parseAlarmIntent,
  parseReminderIntent,
  parseCalendarWriteIntent,
} from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runParseTimeFromTextTests() {
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

  console.log(`\n${BOLD}-- parseTimeFromText Contract Tests (space-separated minutes) --${RESET}\n`);

  assert(
    'PT1 "at 3 15" → hour 15 (PM bump), minute 15',
    parseTimeFromText('at 3 15'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 15;
    },
    '{ hour: 15, minute: 15 }',
  );

  assert(
    'PT2 "at 3 45" → hour 15, minute 45',
    parseTimeFromText('at 3 45'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 45;
    },
    '{ hour: 15, minute: 45 }',
  );

  assert(
    'PT3 "at 3:15" colon form still → hour 15, minute 15',
    parseTimeFromText('at 3:15'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 15;
    },
    '{ hour: 15, minute: 15 }',
  );

  assert(
    'PT4 "at 3" no minutes → hour 15, minute 0',
    parseTimeFromText('at 3'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 0;
    },
    '{ hour: 15, minute: 0 }',
  );

  assert(
    'PT5 "at 3 75" invalid minutes → minute 0 (not 75)',
    parseTimeFromText('at 3 75'),
    (v) => {
      const t = v as { hour: number; minute: number } | null;
      return t?.hour === 15 && t?.minute === 0;
    },
    '{ hour: 15, minute: 0 }',
  );

  assert(
    'PT6 parseAlarmIntent "set an alarm for 7 15" → time "07:15"',
    parseAlarmIntent('set an alarm for 7 15')?.time,
    (v) => v === '07:15',
    '"07:15"',
  );

  assert(
    'PT7 parseReminderIntent "remind me to call mom at 3 15" → time "15:15"',
    parseReminderIntent('remind me to call mom at 3 15')?.time,
    (v) => v === '15:15',
    '"15:15"',
  );

  assert(
    'PT8 parseCalendarWriteIntent "add dentist to my calendar at 3 15" → time segment "15:15"',
    parseCalendarWriteIntent('add dentist to my calendar at 3 15')?.split('|')[2],
    (v) => v === '15:15',
    '"15:15"',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}parseTimeFromText: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('parseTimeFromText.test.ts')) {
  runParseTimeFromTextTests().catch(console.error);
}
