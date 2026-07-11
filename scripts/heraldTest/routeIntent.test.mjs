// Herald routeIntent Test Gate
// Imports REAL classifyQuery + mirrored routeIntent — tests can never drift from code.
//
// Run from: C:\Users\miked\scripts\herald-app\scripts\heraldTest\
//   npx tsx routeIntent.test.mjs
//
// Before every run — sync then test:
//   cd C:\Users\miked\scripts\herald-app
//   Copy-Item src\routing\tierRouter.ts  scripts\heraldTest\src\routing\tierRouter.ts  -Force
//   Copy-Item src\routing\routeIntent.ts scripts\heraldTest\src\routing\routeIntent.ts -Force
//   (llmLayers type stub lives at scripts\heraldTest\src\hooks\llmLayers.ts — type-only, no device imports)
//   Copy-Item src\utils\parseTime.ts     scripts\heraldTest\src\utils\parseTime.ts     -Force
//   Copy-Item src\utils\phone.ts         scripts\heraldTest\src\utils\phone.ts         -Force
//   cd scripts\heraldTest
//   npx tsx routeIntent.test.mjs

import { classifyQuery } from "../../src/routing/tierRouter.ts";
import { routeIntent } from "../../src/routing/routeIntent.ts";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

/** Scripted LLM intents per utterance — null means "pass" / declined. */
const LLM_MOCKS = {
  "what medication am i on": {
    type: "medical_capture",
    drug: "metformin",
    dosage: "500mg",
    raw: "what medication am i on",
  },
  "who is my wife": {
    type: "family_capture",
    relation: "wife",
    name: "Shannon",
  },
  "who is my doctor": {
    type: "medical_capture",
    drug: "metformin",
    raw: "who is my doctor",
  },
  "what's on my grocery list": {
    type: "list_add",
    items: ["milk"],
    listName: "grocery",
  },
  "can you hear me": null,
  "are you there": null,
  hello: null,
  "my car insurance is allstate": {
    type: "insurance_capture",
    insType: "car",
    carrier: "Allstate",
  },
  "swap out allstate for progressive": {
    type: "insurance_capture",
    insType: "car",
    carrier: "Progressive",
  },
  "i started taking metformin 500 mg": {
    type: "medical_capture",
    drug: "metformin",
    dosage: "500 mg",
    raw: "i started taking metformin 500 mg",
  },
  "my plumber is joe": {
    type: "service_capture",
    category: "plumber",
    name: "Joe",
  },
  "my wife is shannon": {
    type: "family_capture",
    relation: "wife",
    name: "Shannon",
  },
  "add milk and eggs to my grocery list": {
    type: "list_add",
    items: ["milk", "eggs"],
    listName: "grocery",
  },
  "i need to call the doctor": {
    type: "todo_add",
    body: "call the doctor",
  },
  "remind me to call the dentist at 3pm": {
    type: "todo_add",
    body: "call the dentist",
  },
  "i called the doctor": {
    type: "todo_complete",
    hint: "call the doctor",
  },
  "remove the milk from my grocery list": {
    type: "list_remove",
    item: "milk",
    listName: "grocery",
  },
  "i got the eggs": {
    type: "list_remove",
    item: "eggs",
    listName: "grocery",
  },
};

function mockClassifyLLM(text) {
  const scripted = LLM_MOCKS[text];
  return Promise.resolve(scripted ?? null);
}

/** @type {Array<[string, string, { kind: string; actionType?: string; intentType?: string; reason?: string; responseEquals?: string }, { kind: string; actionType?: string; intentType?: string; reason?: string; responseEquals?: string }]>} */
const CASES = [
  [
    "med read beats LLM",
    "what medication am i on",
    { kind: "device_read" },
    { kind: "device_read" },
  ],
  [
    "family read beats LLM",
    "who is my wife",
    { kind: "device_read" },
    { kind: "device_read" },
  ],
  [
    "doctor read beats LLM",
    "who is my doctor",
    { kind: "device_read" },
    { kind: "device_read" },
  ],
  [
    "list read beats LLM",
    "what's on my grocery list",
    { kind: "device_action", actionType: "list_read" },
    { kind: "device_action", actionType: "list_read" },
  ],
  [
    "hear me → backend",
    "can you hear me",
    { kind: "backend" },
    { kind: "backend" },
  ],
  [
    "are you there → backend",
    "are you there",
    { kind: "backend" },
    { kind: "backend" },
  ],
  [
    "hello → backend",
    "hello",
    { kind: "backend" },
    { kind: "backend" },
  ],
  [
    "insurance statement",
    "my car insurance is allstate",
    { kind: "backend" },
    { kind: "capture", intentType: "insurance_capture" },
  ],
  [
    "insurance swap",
    "swap out allstate for progressive",
    { kind: "backend" },
    { kind: "capture", intentType: "insurance_capture" },
  ],
  [
    "med capture deterministic",
    "i started taking metformin 500 mg",
    { kind: "device_action", actionType: "medical_capture" },
    { kind: "device_action", actionType: "medical_capture" },
  ],
  [
    "service capture gap-fill",
    "my plumber is joe",
    { kind: "backend" },
    { kind: "capture", intentType: "service_capture" },
  ],
  [
    "family capture gap-fill",
    "my wife is shannon",
    { kind: "backend" },
    { kind: "capture", intentType: "family_capture" },
  ],
  [
    "list add beats LLM",
    "add milk and eggs to my grocery list",
    { kind: "device_action", actionType: "list_add" },
    { kind: "device_action", actionType: "list_add" },
  ],
  [
    "todo add",
    "i need to call the doctor",
    { kind: "device_action", actionType: "todo_add" },
    { kind: "device_action", actionType: "todo_add" },
  ],
  [
    "reminder",
    "remind me to call the dentist at 3pm",
    { kind: "device_action", actionType: "reminder" },
    { kind: "device_action", actionType: "reminder" },
  ],
  [
    "todo complete",
    "i called the doctor",
    { kind: "device_action", actionType: "todo_complete" },
    { kind: "device_action", actionType: "todo_complete" },
  ],
  [
    "list remove explicit",
    "remove the milk from my grocery list",
    { kind: "device_action", actionType: "list_remove" },
    { kind: "device_action", actionType: "list_remove" },
  ],
  [
    "i got → todo_complete (router order)",
    "i got the eggs",
    { kind: "device_action", actionType: "todo_complete" },
    { kind: "device_action", actionType: "todo_complete" },
  ],
  [
    "named weekday + calendar → unresolved (not today)",
    "what's on my calendar next Tuesday",
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseEquals: "I can only tell you about today, tomorrow, this week, or next week right now.",
    },
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseEquals: "I can only tell you about today, tomorrow, this week, or next week right now.",
    },
  ],
  [
    // Locks hasNamedWeekday && isCalendarIntent: must not fall through to
    // calendar:today speech ("Your calendar is clear today" / "You have … today").
    // Honest-miss copy mentions "today" as a supported window — assert against
    // the today-listing shape, not a raw substring ban on the word "today".
    "named weekday + calendar for next Tuesday → unresolved (not today listing)",
    "what's on my calendar for next Tuesday",
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseNotMatching: /\b(Your calendar is clear today|You have .+ today)\b/i,
    },
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseNotMatching: /\b(Your calendar is clear today|You have .+ today)\b/i,
    },
  ],
  [
    "named weekday + scheduled → unresolved (not next week)",
    "do I have anything scheduled next Tuesday",
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseEquals: "I can only tell you about today, tomorrow, this week, or next week right now.",
    },
    {
      kind: "device_read",
      reason: "calendar:unresolved_weekday",
      responseEquals: "I can only tell you about today, tomorrow, this week, or next week right now.",
    },
  ],
  [
    "plain today calendar still calendar:today",
    "what's on my calendar today",
    { kind: "device_read", reason: "calendar:today" },
    { kind: "device_read", reason: "calendar:today" },
  ],
  [
    "weekday in alarm phrase not caught by weekday gate",
    "wake me up monday morning",
    { kind: "device_action", actionType: "alarm" },
    { kind: "device_action", actionType: "alarm" },
  ],
];

function describeDecision(d) {
  if (d.kind === "device_action") {
    return `device_action/${d.actionIntent.type}`;
  }
  if (d.kind === "capture") {
    return `capture/${d.intent.type}`;
  }
  if (d.kind === "device_read" && d.reason) {
    return `device_read/${d.reason}`;
  }
  return d.kind;
}

function describeExpect(e) {
  if (e.actionType) return `${e.kind}/${e.actionType}`;
  if (e.intentType) return `${e.kind}/${e.intentType}`;
  if (e.reason) {
    const extra = e.responseEquals ? ` (honest miss)` : "";
    return `${e.kind}/${e.reason}${extra}`;
  }
  return e.kind;
}

function matches(decision, expect) {
  if (decision.kind !== expect.kind) return false;
  if (expect.actionType) {
    return (
      decision.kind === "device_action" &&
      decision.actionIntent?.type === expect.actionType
    );
  }
  if (expect.intentType) {
    return decision.kind === "capture" && decision.intent.type === expect.intentType;
  }
  if (expect.reason && decision.reason !== expect.reason) return false;
  if (expect.responseEquals && decision.response !== expect.responseEquals) return false;
  if (expect.responseNotMatching && expect.responseNotMatching.test(decision.response || "")) {
    return false;
  }
  return true;
}

let passed = 0;
const failures = [];
const TOTAL = CASES.length * 2;

console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  HERALD routeIntent TEST SUITE — ${TOTAL} tests${RESET}`);
console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`);

for (const [label, text, expectOff, expectOn] of CASES) {
  for (const [mode, llmReady, expect] of [
    ["llmOff", false, expectOff],
    ["llmOn", true, expectOn],
  ]) {
    const runLabel = `${label} [${mode}]`;
    let decision;
    try {
      decision = await routeIntent(text, {
        classifyQuery,
        classifyLLM: llmReady ? mockClassifyLLM : null,
        llmReady,
      });
    } catch (e) {
      failures.push({
        label: runLabel,
        phrase: text,
        expected: describeExpect(expect),
        got: `THREW: ${e.message}`,
      });
      console.log(
        `${RED}❌ FAIL${RESET}  ${runLabel}\n      ${DIM}"${text}"${RESET}\n      ${RED}→ THREW: ${e.message}${RESET}\n`,
      );
      continue;
    }

    const ok = matches(decision, expect);
    if (ok) {
      passed++;
      console.log(
        `${GREEN}✅ PASS${RESET}  ${runLabel}\n      ${DIM}"${text}" → ${describeDecision(decision)}${RESET}\n`,
      );
    } else {
      failures.push({
        label: runLabel,
        phrase: text,
        expected: describeExpect(expect),
        got: describeDecision(decision),
      });
      console.log(
        `${RED}❌ FAIL${RESET}  ${runLabel}\n      ${DIM}"${text}"${RESET}\n      ${RED}→ got ${describeDecision(decision)}, expected ${describeExpect(expect)}${RESET}\n`,
      );
    }
  }
}

console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`);
console.log(
  `${BOLD}  RESULTS: ${GREEN}${passed} passed${RESET}${BOLD} / ${failures.length > 0 ? RED : GREEN}${failures.length} failed${RESET}${BOLD} / ${TOTAL} total${RESET}`,
);
console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`);

if (failures.length) {
  console.log(`${RED}${BOLD}FAILURES — fix these before building:${RESET}\n`);
  for (const f of failures) {
    console.log(
      `  ${RED}✗ ${f.label}${RESET}\n    phrase:   "${f.phrase}"\n    expected: ${f.expected}\n    got:      ${f.got}\n`,
    );
  }
  console.log(`${RED}${BOLD}❌ DO NOT BUILD — fix failing tests first${RESET}\n`);
  process.exit(1);
} else {
  console.log(`${GREEN}${BOLD}✅ ALL GREEN — safe to build${RESET}\n`);
  process.exit(0);
}
