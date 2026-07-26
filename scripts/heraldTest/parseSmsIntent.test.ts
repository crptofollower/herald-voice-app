// scripts/heraldTest/parseSmsIntent.test.ts
// parseSmsIntent contact/message extraction contract tests.
//
// Runner: npx tsx scripts/heraldTest/parseSmsIntent.test.ts

import { parseSmsIntent } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

type SmsParse = { contact: string; message: string };

const CASES: Array<{ label: string; input: string; expected: SmsParse | null }> = [
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
  // Optional `(?:my\s+<rel>\s+)?` strips relationship before a proper name.
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
  // normalizeSmsMyRelContact — contact was "my", message started with <rel>
  {
    label: 'T-PSI-8 text my wife (empty body)',
    input: 'text my wife',
    expected: { contact: 'wife', message: '' },
  },
  {
    label: 'T-PSI-9 text my sister (empty body)',
    input: 'text my sister',
    expected: { contact: 'sister', message: '' },
  },
  {
    label: "T-PSI-10 text my wife + body",
    input: "text my wife I'll be home late",
    expected: { contact: 'wife', message: "I'll be home late" },
  },
  // Bare contact-only — parseSmsIntent stays null so contactOnly can claim
  {
    label: 'T-PSI-11 text wife → null (contactOnly path)',
    input: 'text wife',
    expected: null,
  },
  {
    label: 'T-PSI-12 text Sarah → null (literal name path)',
    input: 'text Sarah',
    expected: null,
  },
  // "Myra" must not match my+rel normalization (substring/prefix of "my")
  {
    label: 'T-PSI-13 text Myra → null (no my+rel false positive)',
    input: 'text Myra',
    expected: null,
  },
  {
    label: 'T-PSI-14 text my brother + body',
    input: 'text my brother tell him happy birthday',
    expected: { contact: 'brother', message: 'tell him happy birthday' },
  },
  {
    label: 'T-PSI-15 can you text my wife',
    input: 'can you text my wife',
    expected: { contact: 'wife', message: '' },
  },
  {
    label: 'T-PSI-16 send a text to my wife',
    input: 'send a text to my wife',
    expected: { contact: 'wife', message: '' },
  },
  // myRelAsContact must fall through to name-shape (not return rel as contact)
  {
    label: 'T-PSI-17 text my son Josh (name only)',
    input: 'text my son Josh',
    expected: { contact: 'Josh', message: '' },
  },
  {
    label: 'T-PSI-18 message my daughter Emma (name only)',
    input: 'message my daughter Emma',
    expected: { contact: 'Emma', message: '' },
  },
  {
    label: 'T-PSI-19 text my son Josh + body',
    input: 'text my son Josh what time are you leaving',
    expected: { contact: 'Josh', message: 'what time are you leaving' },
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
    if (expected === null) {
      assert(label, got, v => v === null, 'null');
    } else {
      assert(
        label,
        got,
        v => v !== null
          && (v as SmsParse).contact === expected.contact
          && (v as SmsParse).message === expected.message,
        JSON.stringify(expected),
      );
    }
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}parseSmsIntent: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('parseSmsIntent.test.ts')) {
  runParseSmsIntentTests().catch(console.error);
}
