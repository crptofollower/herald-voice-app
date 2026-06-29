// Herald Router Test Gate
// Imports the REAL tierRouter + parseTime + phone — tests can never drift from code.
// DB modules are stubbed (classification needs no real SQLite).
//
// Run from: C:\Users\miked\scripts\herald-app\scripts\heraldTest\
//   npx tsx run.mjs
//
// Before every build — sync then run:
//   cd C:\Users\miked\scripts\herald-app
//   Copy-Item src\routing\tierRouter.ts scripts\heraldTest\src\routing\tierRouter.ts -Force
//   Copy-Item src\utils\parseTime.ts    scripts\heraldTest\src\utils\parseTime.ts    -Force
//   Copy-Item src\utils\phone.ts        scripts\heraldTest\src\utils\phone.ts        -Force
//   cd scripts\heraldTest
//   npx tsx run.mjs

import { classifyQuery } from "./src/routing/tierRouter.ts";
import { normalizePhone } from "./src/utils/phone.ts";
import { normalizeInput } from "./src/utils/normalizeInput.ts";
import { extractDosage } from "../../src/utils/detectMedicalEvent.ts";
import { runDispatchContractTests } from './dispatchContract.test.mjs';

function kindOf(d) {
  if (d.actionIntent) return d.actionIntent.type;
  if (d.tier === 2) return "memory_probe";
  if (d.reason?.includes("family")) return "family";
  if (d.reason?.includes("calendar")) return "calendar";
  if (d.reason?.includes("medical")) return "medical";
  if (d.reason?.includes("profile")) return "profile";
  return "tier3";
}

const TESTS = [
  // Time / Date
  ["time",                 "what time is it",                                1, "time"],
  ["date",                 "what day is it",                                 1, "date"],
  ["date variant",         "what is today's date",                           1, "date"],
  ["date not weather",     "what's the weather today",                       3, "tier3"],

  // Alarms
  ["alarm am",             "can you set an alarm for 7am",                   1, "alarm"],
  ["alarm dotted",         "wake me up at 7:15 a.m.",                        1, "alarm"],
  ["alarm pm",             "set an alarm for 9:30 pm",                       1, "alarm"],

  // Timers
  ["timer minutes",        "set a timer for 20 minutes",                     1, "timer"],
  ["timer polite",         "can you set a timer for 20 minutes",             1, "timer"],
  ["timer phrased",        "can you set a 30 minute timer",                  1, "timer"],
  ["timer 1 hour",         "set a 1 hour timer",                             1, "timer"],
  ["alarm->timer",         "set alarm for 20 minutes",                       1, "timer"],

  // SMS
  ["sms body",             "text sarah i'm on my way",                       1, "sms"],
  ["sms no body",          "can you text shannon",                           1, "sms"],
  ["sms send to",          "send a message to hunter saying i'll be late",   1, "sms"],

  // Call
  ["call direct",          "call hunter",                                    1, "call"],
  ["call polite",          "can you call shannon",                           1, "call"],

  // Reminders
  ["reminder med",         "remind me to take my medication at 11:30",       1, "reminder"],
  ["reminder pill pm",     "remind me to take my pill at 8:00 p.m.",         1, "reminder"],
  ["reminder vs call",     "can you set a reminder to call the doctor at 3", 1, "reminder"],

  // Note capture
  ["note beats call",      "can you make a note to call the bank",           1, "note_capture"],
  ["note simple",          "make a note to pick up dry cleaning",            1, "note_capture"],
  ["note beats name",      "can you make a note to call shannon tomorrow",   1, "note_capture"],

  // Note read
  ["note read",            "what are my notes",                              1, "note_read"],
  ["note possessive",      "what's on my notes",                             1, "note_read"],
  ["note are there",       "are there any notes",                            1, "note_read"],
  ["note is there",        "is there anything on my notes",                  1, "note_read"],
  ["note any",             "any notes",                                      1, "note_read"],

  // List add
  ["list add",             "add chocolate milk to my grocery list",          1, "list_add"],
  ["list add shorthand",   "put eggs on my list",                            1, "list_add"],

  // List read
  ["list whats on",        "what's on my grocery list",                      1, "list_read"],
  ["list is there",        "is there anything on my grocery list",           1, "list_read"],
  ["list do i have",       "do i have anything on my grocery list",          1, "list_read"],
  ["list do i have a",     "do i have a grocery list",                       1, "list_read"],

  // Calendar
  ["cal today",            "what do i have today",                           1, "calendar"],
  ["cal tomorrow",         "what do i have tomorrow",                        1, "calendar"],
  ["cal flights",          "do i have any flights this week",                1, "calendar"],
  ["cal next week",        "do i have anything on my calendar next week",    1, "calendar"],
  ["cal next week 2",      "what's on my calendar next week",                1, "calendar"],
  ["cal write",            "add dentist appointment to my calendar tomorrow at 2pm", 1, "calendar_write"],
  ["cal write put",        "put team meeting on my calendar at 3pm",         1, "calendar_write"],

  // Medical — standard
  ["med meds",             "what medications am i on",                       1, "medical"],
  ["med doctor",           "who is my doctor",                               1, "medical"],

  // Medical — Mickey phrases
  ["med what do i take",   "what do i take",                                 1, "medical"],
  ["med what am i taking", "what am i taking",                               1, "medical"],
  ["med what am i on",     "what am i on",                                   1, "medical"],
  ["med my meds",          "my meds",                                        1, "medical"],
  ["med my medications",   "my medications",                                 1, "medical"],

  // ── Build A: capture guardrails + meds remove/clear ──
  // NOTE: corroboration (chocolate→confirm vs metformin→write) lives in
  // ChatScreen, NOT the router — both route to medical_capture here. These
  // cases lock ROUTING only; the confirm-vs-write gate is tested on-device.
  ["list not medical (off)",   "take chocolate milk off my grocery list",   1, "list_remove"],
  ["list not medical (rm)",    "remove oranges from my grocery list",       1, "list_remove"],
  ["med remove not add",       "stop taking metformin",                     1, "medical_remove"],
  ["med clear",                "clear my medications",                      1, "medical_clear"],
  ["insurance read not update","who's my insurance with",                   1, "household_read"],
  ["household remove delete",   "delete my plumber",                        1, "household_remove"],
  ["household remove no more",  "i don't have a plumber anymore",           1, "household_remove"],
  ["med capture statement",    "I'm taking chocolate milk",                 1, "medical_capture"],
  ["med capture dosage",       "I take metformin 500mg",                    1, "medical_capture"],

  // Profile — standard
  ["profile name",         "what's my name",                                 1, "profile"],
  ["profile do you know",  "do you know my name",                            1, "profile"],
  ["profile last name",    "what's my last name",                            1, "profile"],
  ["profile where",        "where do i live",                                1, "profile"],
  ["profile location",     "where am i located",                             1, "profile"],

  // Profile — Mickey phrases
  ["profile age",          "what's my age",                                  1, "profile"],
  ["profile how old",      "how old am i",                                   1, "profile"],

  // Family relationship name — the wife-name routing fix (was wrongly going to profile)
  ["family wife do u know","do you know my wife's name",                     1, "family"],
  ["family wife name",     "what's my wife's name",                          1, "family"],
  ["family who is wife",   "who's my wife",                                  1, "family"],
  ["family daughter name", "what is my daughter's name",                     1, "family"],
  ["family who husband",   "who is my husband",                              1, "family"],

  // Device-keyboard guard: SAME queries with CURLY apostrophes (Samsung/STT emit these).
  // The front-door normalizer must fold them so routing still works. Regression guard.
  ["curly wife name",      "what\u2019s my wife\u2019s name",                1, "family"],
  ["curly who wife",       "who\u2019s my wife",                             1, "family"],
  ["curly profile name",   "what\u2019s my name",                            1, "profile"],

  // Memory probe (Tier 2)
  ["probe know about me",  "what do you know about me",                      2, "memory_probe"],
  ["probe told you",       "what have i told you",                           2, "memory_probe"],

  // Tier 3
  ["t3 weather",           "what's the weather in dallas",                   3, "tier3"],
  ["t3 news",              "what's the latest news",                         3, "tier3"],
  ["t3 sports",            "did the cowboys win",                             3, "tier3"],
  ["t3 open",              "how do i make sourdough",                        3, "tier3"],
  ["t3 fact",              "my wife's name is shannon",                      3, "tier3"],
];

// Phone validator gate — the phone-digit read-back fix (src/utils/phone.ts).
// [label, input, expectValid, expectIssue]
const PHONE_TESTS = [
  ["phone clean",          "972-555-0100",     true,  "ok"],
  ["phone extra digit",    "972-5555-0100",    false, "long"],   // the reported bug
  ["phone country code",   "1-972-555-0100",   true,  "ok"],
  ["phone too short",      "555-0100",         false, "short"],
  ["phone spoken spaces",  "(972) 555 0100",   true,  "ok"],
  ["phone empty",          "",                 false, "empty"],
];

// Input front door — normalizeInput (src/utils/normalizeInput.ts).
// [label, raw, expectedNormalized]
const NORMALIZE_TESTS = [
  ["norm curly apostrophe", "what\u2019s my wife\u2019s name", "what's my wife's name"],
  ["norm curly quotes",     "\u201Chello\u201D",               '"hello"'],
  ["norm em dash",          "a \u2014 b",                       "a - b"],
  ["norm ellipsis",         "wait\u2026",                       "wait..."],
  ["norm nbsp+collapse",    "call\u00A0Joe   now",              "call Joe now"],
  ["norm zero-width",       "wi\u200Bfe",                       "wife"],
  ["norm trim",             "   hi there  ",                    "hi there"],
  ["norm clean passthru",   "what's my name",                   "what's my name"],
];

const DOSAGE_TESTS = [
  ["dosage decimal",      "I take Lisinopril 12.5mg",  "12.5mg"],
  ["dosage whole",        "I take metformin 500mg",     "500mg"],
  ["dosage with space",   "lisinopril 10 mg",           "10mg"],
  ["dosage decimal mcg",  "I take 2.5 mcg",             "2.5mcg"],
];

const RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m", BOLD = "\x1b[1m", DIM = "\x1b[2m";
let passed = 0;
const failures = [];
const TOTAL = TESTS.length + PHONE_TESTS.length + NORMALIZE_TESTS.length + DOSAGE_TESTS.length;
const EXPECTED_TOTAL = 148;

console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  HERALD ROUTER + PHONE TEST SUITE — ${TOTAL} tests${RESET}`);
console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`);

for (const [label, phrase, tier, kind] of TESTS) {
  let d;
  try { d = await classifyQuery(phrase); }
  catch (e) {
    failures.push({ label, phrase, expected: `tier${tier}/${kind}`, got: `THREW: ${e.message}` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}"${phrase}"${RESET}\n      ${RED}→ THREW: ${e.message}${RESET}\n`);
    continue;
  }
  const gotKind = kindOf(d);
  const ok = d.tier === tier && gotKind === kind;
  if (ok) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}"${phrase}" → ${gotKind}${RESET}\n`);
  } else {
    failures.push({ label, phrase, expected: `tier${tier}/${kind}`, got: `tier${d.tier}/${gotKind} (${d.reason})` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}"${phrase}"${RESET}\n      ${RED}→ got tier${d.tier}:${gotKind}, expected tier${tier}:${kind}${RESET}\n`);
  }
}

for (const [label, input, expValid, expIssue] of PHONE_TESTS) {
  let r;
  try { r = normalizePhone(input); }
  catch (e) {
    failures.push({ label, phrase: input, expected: `${expValid}/${expIssue}`, got: `THREW: ${e.message}` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}"${input}"${RESET}\n      ${RED}→ THREW: ${e.message}${RESET}\n`);
    continue;
  }
  const ok = r.valid === expValid && r.issue === expIssue;
  if (ok) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}"${input}" → valid=${r.valid} issue=${r.issue} spoken=${r.spoken}${RESET}\n`);
  } else {
    failures.push({ label, phrase: input, expected: `valid=${expValid}/${expIssue}`, got: `valid=${r.valid}/${r.issue}` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}"${input}"${RESET}\n      ${RED}→ got valid=${r.valid}/${r.issue}, expected valid=${expValid}/${expIssue}${RESET}\n`);
  }
}

for (const [label, raw, expected] of NORMALIZE_TESTS) {
  let got;
  try { got = normalizeInput(raw); }
  catch (e) {
    failures.push({ label, phrase: raw, expected, got: `THREW: ${e.message}` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${JSON.stringify(raw)}${RESET}\n      ${RED}→ THREW: ${e.message}${RESET}\n`);
    continue;
  }
  const ok = got === expected;
  if (ok) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}${JSON.stringify(raw)} → ${JSON.stringify(got)}${RESET}\n`);
  } else {
    failures.push({ label, phrase: raw, expected: JSON.stringify(expected), got: JSON.stringify(got) });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${JSON.stringify(raw)}${RESET}\n      ${RED}→ got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}${RESET}\n`);
  }
}

for (const [label, input, expected] of DOSAGE_TESTS) {
  let got;
  try { got = extractDosage(input); }
  catch (e) {
    failures.push({ label, phrase: input, expected, got: `THREW: ${e.message}` });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${JSON.stringify(input)}${RESET}\n      ${RED}→ THREW: ${e.message}${RESET}\n`);
    continue;
  }
  const ok = got === expected;
  if (ok) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${label}\n      ${DIM}${JSON.stringify(input)} → ${JSON.stringify(got)}${RESET}\n`);
  } else {
    failures.push({ label, phrase: input, expected: JSON.stringify(expected), got: JSON.stringify(got) });
    console.log(`${RED}❌ FAIL${RESET}  ${label}\n      ${DIM}${JSON.stringify(input)}${RESET}\n      ${RED}→ got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}${RESET}\n`);
  }
}

// ─── Contract suites — wired here so one command gates everything ───────────
const { runHouseholdContractTests } = await import('./householdContract.test.mjs');
const { runMedicalContractTests }   = await import('./medicalContract.test.mjs');
const hResult = await runHouseholdContractTests();
const mResult = await runMedicalContractTests();
const dResult = await runDispatchContractTests();
const contractPassed = hResult.passed + mResult.passed + dResult.passed;
const contractFailed = hResult.failed + mResult.failed + dResult.failed;
const contractTotal = hResult.total + mResult.total + dResult.total;

console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  RESULTS: ${GREEN}${passed + contractPassed} passed${RESET}${BOLD} / ${failures.length + contractFailed > 0 ? RED : GREEN}${failures.length + contractFailed} failed${RESET}${BOLD} / ${TOTAL + contractTotal} total${RESET}`);
console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`);

if (TOTAL + contractTotal !== EXPECTED_TOTAL) {
  console.log(`${RED}${BOLD}❌ GATE COUNT MISMATCH — expected ${EXPECTED_TOTAL} tests, found ${TOTAL}.${RESET}`);
  console.log(`${RED}The suite changed size — tests may have been lost. DO NOT BUILD. If intentional, update EXPECTED_TOTAL.${RESET}\n`);
  process.exit(1);
}

if (failures.length || contractFailed) {
  if (failures.length) {
    console.log(`${RED}${BOLD}FAILURES — fix these before building:${RESET}\n`);
    for (const f of failures) {
      console.log(`  ${RED}✗ ${f.label}${RESET}\n    phrase:   "${f.phrase}"\n    expected: ${f.expected}\n    got:      ${f.got}\n`);
    }
  }
  if (contractFailed) {
    console.log(`${RED}  ${contractFailed} contract test(s) failed — see output above${RESET}\n`);
  }
  console.log(`${RED}${BOLD}❌ DO NOT BUILD — fix failing tests first${RESET}\n`);
  process.exit(1);
} else {
  console.log(`${GREEN}${BOLD}✅ ALL GREEN — safe to build${RESET}\n`);
  process.exit(0);
}
