// scripts/heraldTest/parseSmsIntent.test.ts
// parseSmsIntent contact/message extraction contract tests.
//
// Runner: npx tsx scripts/heraldTest/parseSmsIntent.test.ts

import { parseSmsIntent } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

type SmsParse = { contact: string; message: string };

const CASES: Array<{ label: string; input: string; expected: SmsParse }> = [
  // Regression — existing behavior
  {
    label: 'T-PSI-1 text + body',
    input: "text sarah i'm on my way",
    expected: { contact: 'sarah', message: "i'm on my way" },
  },
  {
    label: 'T-PSI-2 send message to + saying',
    input: "send a message to hunter saying i'll be late",
    expected: { contact: 'hunter', message: "i'll be late" },
  },
  {
    label: 'T-PSI-3 tell + that',
    input: "tell sarah that i'm running late",
    expected: { contact: 'sarah', message: "i'm running late" },
  },
  {
    label: 'T-PSI-4 titled contact',
    input: 'text Dr. Smith hello there',
    expected: { contact: 'Dr. Smith', message: 'hello there' },
  },
  // New — relationship prefix stripped before name capture
  {
    label: 'T-PSI-5 text my son + name + body',
    input: 'text my son Hunter what time are you leaving',
    expected: { contact: 'Hunter', message: 'what time are you leaving' },
  },
  {
    label: 'T-PSI-6 message my daughter + name + body',
    input: "message my daughter Emma I'll be there soon",
    expected: { contact: 'Emma', message: "I'll be there soon" },
  },
  {
    label: 'T-PSI-7 tell my wife + name + body',
    input: "tell my wife Sarah dinner's ready",
    expected: { contact: 'Sarah', message: "dinner's ready" },
  },
];

export async function runParseSmsIntentTests() {
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

  console.log(`\n${BOLD}-- parseSmsIntent Contract Tests -----------------------------${RESET}\n`);

  for (const { label, input, expected } of CASES) {
    const got = parseSmsIntent(input);
    assert(
      label,
      got,
      v => v !== null
        && (v as SmsParse).contact === expected.contact
        && (v as SmsParse).message === expected.message,
      JSON.stringify(expected),
    );
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}parseSmsIntent: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('parseSmsIntent.test.ts')) {
  runParseSmsIntentTests().catch(console.error);
}
