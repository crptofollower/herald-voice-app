// Offline capture regression tests — no device required.
// Run: npx tsx offlineCapture.mjs

import {
  isCalendarReadIntent,
  isMedicalCaptureIntent,
} from "../../src/db/factDB.ts";

const RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m", BOLD = "\x1b[1m";

const TESTS = [
  ["cal read next week", "Do I have anything on my calendar next week", true, false],
  ["cal read variant", "What's on my calendar next week", true, false],
  ["med capture", "I'm taking lisinopril 10mg daily", false, true],
  ["med i have condition", "I have diabetes", false, true],
  ["not med i have cal", "Do I have anything on my calendar next week", true, false],
];

let passed = 0;
const failures = [];

for (const [label, phrase, expectCal, expectMed] of TESTS) {
  const cal = isCalendarReadIntent(phrase);
  const med = isMedicalCaptureIntent(phrase);
  const ok = cal === expectCal && med === expectMed;
  if (ok) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}`);
  } else {
    failures.push({ label, phrase, expectCal, expectMed, cal, med });
    console.log(`${RED}❌ FAIL${RESET}  ${label} — cal=${cal} med=${med}`);
  }
}

console.log(`\n${BOLD}${passed}/${TESTS.length} passed${RESET}`);
if (failures.length) process.exit(1);
