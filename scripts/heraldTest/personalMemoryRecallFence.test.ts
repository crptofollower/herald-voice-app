// scripts/heraldTest/personalMemoryRecallFence.test.ts
// Fix 2 — Site-A recall-speech-act fence (routeIntent.ts, immediately before
// classifyLLM). processUtterance → routeIntent is the live path. A hostile
// classifyLLM stub would arm "Say yes and I'll remember that." if the fence
// failed to own the utterance. llmReady:true. Real classifyQuery.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const LLM_CONFIRM = "Say yes and I'll remember that.";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS service_providers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, visit_outcome TEXT,
    outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

const HOSTILE_CAPTURE: ClassifyOutcome = {
  status: 'ok',
  intents: [{ type: 'service_capture', category: 'electrician', name: 'Bob' }],
};

async function speak(text: string) {
  const db = freshDB();
  const session = new ConversationSession();
  let llmCalls = 0;
  const outcome = await processUtterance(text, session, {
    classifyQuery,
    classifyLLM: async () => {
      llmCalls += 1;
      return HOSTILE_CAPTURE;
    },
    llmReady: true,
    captureContext: { contacts: [], lists: [] },
  });
  const providers = db.prepare(
    "SELECT * FROM service_providers WHERE removed_at IS NULL",
  ).all() as Array<{ name: string; category: string }>;
  const contacts = db.prepare(
    "SELECT * FROM contacts WHERE removed_at IS NULL",
  ).all();
  const medical = db.prepare(
    "SELECT * FROM medical_records WHERE removed_at IS NULL",
  ).all();
  return { db, session, outcome, llmCalls, providers, contacts, medical };
}

function isLlmConfirm(outcome: Awaited<ReturnType<typeof processUtterance>>, session: ConversationSession): boolean {
  if (session.hasPending()) return true;
  if (outcome.handled && 'responseText' in outcome && outcome.responseText === LLM_CONFIRM) return true;
  return false;
}

export async function runPersonalMemoryRecallFenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Personal-Memory Recall Fence (Site A, processUtterance) --${RESET}\n`);

  // Negative 1 — device-proven household recall
  {
    const r = await speak('Do you remember what my electrician said');
    assert('R1a electrician recall does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R1b electrician recall does not arm LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no pending / no confirm prompt');
    assert('R1c electrician recall writes nothing', r.providers.length + r.contacts.length + r.medical.length, (v) => v === 0, '0 rows');
    assert('R1d electrician recall is needs_clarification', r.outcome,
      (v) => v.handled === false && v.routeDecision.kind === 'needs_clarification',
      'handled:false needs_clarification');
  }

  // Negative 2 — what-did + service category
  {
    const r = await speak('What did my plumber say');
    assert('R2a plumber what-did does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R2b plumber what-did does not arm LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no pending / no confirm prompt');
    assert('R2c plumber what-did writes nothing', r.providers.length + r.contacts.length + r.medical.length, (v) => v === 0, '0 rows');
    assert('R2d plumber what-did is needs_clarification', r.outcome,
      (v) => v.handled === false && v.routeDecision.kind === 'needs_clarification',
      'handled:false needs_clarification');
  }

  // Negative 3 — unclaimed medical recall (not Fix 1 visit-outcome)
  {
    const r = await speak('Do you remember what my doctor said');
    assert('R3a doctor recall does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R3b doctor recall does not arm LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no pending / no confirm prompt');
    assert('R3c doctor recall writes nothing', r.providers.length + r.contacts.length + r.medical.length, (v) => v === 0, '0 rows');
    assert('R3d doctor recall is needs_clarification', r.outcome,
      (v) => v.handled === false && v.routeDecision.kind === 'needs_clarification',
      'handled:false needs_clarification');
  }

  // Negative 4 — family recall that reaches Site A (not "…wife said")
  {
    const r = await speak('Do you remember my wife');
    assert('R4a family recall does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R4b family recall does not arm LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no pending / no confirm prompt');
    assert('R4c family recall writes nothing', r.providers.length + r.contacts.length + r.medical.length, (v) => v === 0, '0 rows');
    assert('R4d family recall is needs_clarification', r.outcome,
      (v) => v.handled === false && v.routeDecision.kind === 'needs_clarification',
      'handled:false needs_clarification');
  }

  // Positive 5 — legitimate plumber capture still writes
  {
    const r = await speak('My plumber is Bob');
    assert('R5a plumber capture does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R5b plumber capture is not an LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no LLM confirm');
    assert('R5c plumber capture commits Bob', r.providers,
      (v) => Array.isArray(v) && v.length === 1 && v[0].name === 'Bob' && v[0].category === 'plumber',
      'one plumber row, Bob');
  }

  // Positive 6 — legitimate electrician capture still writes
  {
    const r = await speak('My electrician is Ed');
    assert('R6a electrician capture does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R6b electrician capture is not an LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no LLM confirm');
    assert('R6c electrician capture commits Ed', r.providers,
      (v) => Array.isArray(v) && v.length === 1 && v[0].name === 'Ed' && v[0].category === 'electrician',
      'one electrician row, Ed');
  }

  // Positive 7 — canonical household read claimed before Site A
  {
    const r = await speak("who's my plumber");
    assert('R7a household read does not call classifyLLM', r.llmCalls, (v) => v === 0, '0');
    assert('R7b household read does not arm LLM confirm', isLlmConfirm(r.outcome, r.session), (v) => v === false, 'no pending / no confirm prompt');
    assert('R7c household read remains device_action household_read', r.outcome,
      (v) => v.handled === false
        && v.routeDecision.kind === 'device_action'
        && v.routeDecision.actionIntent.type === 'household_read',
      'device_action household_read');
    assert('R7d household read writes nothing', r.providers.length, (v) => v === 0, '0 rows');
  }

  // Step 4 — retired 57.x predicate cases as routing-level authority proofs.
  // A live conversational context must not let personal truth or device actions
  // reach reason:'default' or hostile LLM capture. Real classifyQuery; hostile stub.
  console.log(`\n${BOLD}-- Step 4 routing authority (retired 57.x) -------------------${RESET}\n`);

  async function routeWithHostile(text: string) {
    freshDB();
    let llmCalls = 0;
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: async () => {
        llmCalls += 1;
        return HOSTILE_CAPTURE;
      },
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    return { decision, llmCalls };
  }

  const ROUTE_57: {
    label: string;
    text: string;
    kind: string;
    reason: string;
    maxLlmCalls?: number;
  }[] = [
    {
      label: 'S4-1 remember about me',
      text: 'What do you remember about me?',
      kind: 'needs_clarification',
      reason: 'personal_memory:recall_declined',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-2 doctor said',
      text: 'What did my doctor say?',
      kind: 'device_read',
      reason: 'medical:visit_outcome_read',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-3 Hunter phone',
      text: "What's Hunter's phone number?",
      kind: 'device_read',
      reason: 'contact:phone_lookup:miss',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-4 call daughter',
      text: 'Are you going to call my daughter?',
      kind: 'capture',
      reason: 'routeIntent:contact_call_intercept',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-5 text son',
      text: 'Will you text my son?',
      kind: 'device_action',
      reason: 'action:sms',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-6 did you say doctor',
      text: 'Did you say the doctor told me to come back?',
      kind: 'needs_clarification',
      reason: 'personal_memory:recall_declined',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-7 what did you say Hunter',
      text: 'What did you say about Hunter?',
      kind: 'needs_clarification',
      reason: 'personal_memory:recall_declined',
      maxLlmCalls: 0,
    },
    {
      label: 'S4-8 are you saying Sarah',
      text: 'Are you saying Sarah texted?',
      kind: 'needs_clarification',
      reason: 'personal_memory:recall_declined',
      maxLlmCalls: 0,
    },
  ];

  for (const row of ROUTE_57) {
    const { decision, llmCalls } = await routeWithHostile(row.text);
    assert(`${row.label} kind`, decision.kind, (v) => v === row.kind, row.kind);
    assert(
      `${row.label} reason`,
      'reason' in decision ? decision.reason : undefined,
      (v) => v === row.reason,
      row.reason,
    );
    if (row.maxLlmCalls != null) {
      assert(`${row.label} no hostile LLM`, llmCalls, (v) => v <= row.maxLlmCalls!, `≤ ${row.maxLlmCalls}`);
    }
    assert(
      `${row.label} never default`,
      'reason' in decision ? decision.reason : undefined,
      (v) => v !== 'default',
      'not default',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Personal-Memory Recall Fence: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('personalMemoryRecallFence.test.ts')) {
  runPersonalMemoryRecallFenceTests().catch(console.error);
}
