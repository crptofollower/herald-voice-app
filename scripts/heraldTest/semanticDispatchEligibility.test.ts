// scripts/heraldTest/semanticDispatchEligibility.test.ts
// Conversational Latency V1 / Slice C — pre-dispatch capability eligibility.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { evaluateSemanticDispatchEligibility } from '../../src/routing/semanticDispatchEligibility.ts';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/capabilityRouting.ts';
import { MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/medicationSemanticInterpretation.ts';
import { GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/grocerySemanticDecomposition.ts';
import { TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/todoSemanticCapture.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_LLM_ENABLED } from '../../src/constants/features.ts';
import { generateViaSelectedWorker } from '../../src/conversation/conversationalWorker.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_SRC = readFileSync(join(HERE, '../../src/routing/routeIntent.ts'), 'utf8');
const WORKER_SRC = readFileSync(join(HERE, '../../src/conversation/conversationalWorker.ts'), 'utf8');

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE medications (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
      prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
      is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT NOT NULL,
      removed_at TEXT
    );
    CREATE TABLE medical_contacts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, specialty TEXT, phone TEXT,
      address TEXT, is_primary INTEGER DEFAULT 0, notes TEXT,
      created_at TEXT NOT NULL, removed_at TEXT
    );
  `);
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

function classifySystem(content: string): 'dispatch' | 'medication' | 'grocery' | 'todo' | 'other' {
  if (content === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) return 'dispatch';
  if (content === MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'medication';
  if (content === GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'grocery';
  if (content === TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'todo';
  return 'other';
}

function countingCtx(script: string[]) {
  const counts = { dispatch: 0, medication: 0, grocery: 0, todo: 0, total: 0 };
  let i = 0;
  const ctx = {
    completion: async (opts: { messages?: Array<{ content?: string }> }) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      const kind = classifySystem(sys);
      counts.total++;
      if (kind === 'dispatch') counts.dispatch++;
      if (kind === 'medication') counts.medication++;
      if (kind === 'grocery') counts.grocery++;
      if (kind === 'todo') counts.todo++;
      const content = script[i] ?? '';
      i++;
      return { content };
    },
  };
  return { ctx, counts };
}

function baseDeps(ctx: unknown, over: Record<string, unknown> = {}) {
  return {
    classifyQuery,
    classifyLLM: null as ((t: string) => Promise<ClassifyOutcome>) | null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: [] },
    getMedicationSemanticInterpreterCtx: ctx ? () => ctx : () => null,
    semanticCapabilityDispatchEnabled: true,
    grocerySemanticDecompositionEnabled: true,
    capabilityReadRouterEnabled: true,
    medicationSemanticInterpretationEnabled: true,
    ...over,
  };
}

function captureLatencyLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.includes('[LATENCY-INSTRUMENT]')) lines.push(line);
    orig.apply(console, args as []);
  };
  return fn().then((result) => {
    console.log = orig;
    return { result, lines };
  }, (err) => {
    console.log = orig;
    throw err;
  });
}

const ONE_PASS_TODO = JSON.stringify({
  capability: 'todo.capture',
  confidence: 'high',
  op: 'todo_capture',
  candidates: ['clean the garage'],
  score: 0.92,
});

export async function runSemanticDispatchEligibilityTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Semantic dispatch eligibility (Slice C) --${RESET}\n`);

  {
    const g = evaluateSemanticDispatchEligibility('The concert last night was louder than I expected.');
    assert('narrative conversation is not eligible',
      g.eligible === false && g.reason === 'none', (v) => v === true, 'false none');
  }

  {
    const g = evaluateSemanticDispatchEligibility('We need to clean the garage.');
    assert('obligation we-need-to is eligible without choosing todo',
      g.eligible === true && g.reason === 'obligation_family', (v) => v === true, 'obligation_family');
  }

  {
    const g = evaluateSemanticDispatchEligibility('We need to pick up detergent.');
    assert('acquisition pick-up is eligible',
      g.eligible === true && g.reason === 'acquisition', (v) => v === true, 'acquisition');
  }

  {
    const g = evaluateSemanticDispatchEligibility('Lisinopril is my blood pressure prescription.');
    assert('medication-domain assertion is eligible',
      g.eligible === true && (g.reason === 'medication_domain' || g.reason === 'medical_event'),
      (v) => v === true, 'medication evidence');
  }

  {
    const g = evaluateSemanticDispatchEligibility('What medications am I taking?');
    assert('medication catalog-shaped query is eligible',
      g.eligible === true, (v) => v === true, 'true');
  }

  {
    const g = evaluateSemanticDispatchEligibility('Please add oats to my grocery list.');
    assert('explicit list-add instruction is eligible',
      g.eligible === true && (g.reason === 'instruction' || g.reason === 'list_add'),
      (v) => v === true, 'instruction or list_add');
  }

  {
    const g = evaluateSemanticDispatchEligibility('We need to water the plants.');
    assert('unmarked we-need-to remains eligible without destination',
      g.eligible === true && g.reason === 'obligation_family', (v) => v === true, 'obligation_family');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent('The concert last night was louder than I expected.', baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('ineligible narrative does not invoke dispatch inference',
      counts.dispatch === 0 && counts.total === 0 && !/SEMANTIC_DISPATCH_INFERENCE_START/.test(joined),
      (v) => v === true, '0 completions');
    assert('ineligible narrative logs eligibility false',
      /SEMANTIC_DISPATCH_ELIGIBILITY/.test(joined) && /"eligible":false/.test(joined) && /"reason":"none"/.test(joined),
      (v) => v === true, 'eligible false');
    assert('ineligible narrative is not capture',
      result.kind, (v) => v !== 'capture', 'not capture');
    assert('ineligible narrative does not invoke specialists',
      counts.medication + counts.grocery + counts.todo, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent('We need to clean the garage.', baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('obligation remains default fallthrough',
      `${(await classifyQuery('We need to clean the garage.')).tier}:${(await classifyQuery('We need to clean the garage.')).reason}`,
      (v) => v === '3:default', '3:default');
    assert('eligible obligation still runs dispatch',
      counts.dispatch === 1 && /SEMANTIC_DISPATCH_INFERENCE_START/.test(joined) && /"eligible":true/.test(joined),
      (v) => v === true, 'dispatch + eligible true');
    assert('eligible obligation does not decide destination in the gate',
      result.kind === 'capture' && (result as { intents?: { type: string }[] }).intents?.[0]?.type === 'todo_add',
      (v) => v === true, 'dispatch interprets as todo_add');
  }

  {
    freshDB();
    const json = JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['detergent'],
      score: 0.93,
    });
    const { ctx, counts } = countingCtx([json]);
    const decision = await routeIntent('We need to pick up detergent.', baseDeps(ctx));
    assert('eligible acquisition can still one-pass grocery',
      decision.kind === 'capture' && counts.dispatch === 1 && counts.grocery === 0,
      (v) => v === true, 'capture dispatch-only');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const decision = await routeIntent('I need to call the dentist.', baseDeps(ctx));
    assert('T1 todo_add is unaffected by the eligibility gate',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'deterministic',
      (v) => v === true, 'deterministic');
    assert('T1 todo_add does not run dispatch', counts.total, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const decision = await routeIntent("what's on my grocery list", baseDeps(ctx));
    assert('T1 list_read is unaffected by the eligibility gate',
      decision.kind === 'device_read' && (decision as { reason?: string }).reason === 'action:list_read',
      (v) => v === true, 'action:list_read');
    assert('T1 list_read does not run dispatch', counts.total, (v) => v === 0, '0');
  }

  {
    const harness = openJourneyDb();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const deps = {
      ...harness.deps,
      ...baseDeps(ctx),
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    };
    const t1 = await processUtterance(normalizeInput('We need to clean the garage.'), harness.session, deps);
    assert('eligible one-pass still arms confirmation pending',
      t1.handled && 'commits' in t1 && t1.commits.some((c) => c.status === 'pending'),
      (v) => v === true, 'pending');
    const pendingTurn = await processUtterance('yes', harness.session, deps);
    assert('armed pending still owns the next turn',
      pendingTurn.handled === true && pendingTurn.source === 'pending_resume',
      (v) => v === true, 'pending_resume');
    assert('pending path did not add a dispatch completion', counts.dispatch, (v) => v === 1, '1 from first turn');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const decision = await routeIntent('The concert last night was louder than I expected.', baseDeps(ctx));
    assert('ineligible path cannot create llm capture pending',
      decision.kind !== 'capture' && counts.total === 0,
      (v) => v === true, 'no capture no model');
  }

  {
    assert('retired classifier flag remains off', LOCAL_LLM_ENABLED, (v) => v === false, 'false');
    const out = await generateViaSelectedWorker(null, { userText: 'hello', hotEntries: [] });
    assert('Qwen socket still has no writer path on null worker',
      out.status === 'unavailable' && out.reason === 'no-ctx',
      (v) => v === true, 'no-ctx');
    assert('routeIntent does not invoke Qwen',
      /generateViaSelectedWorker|resolveEphemeralSeam/.test(ROUTE_SRC),
      (v) => v === false, 'false');
    const banned = ['DOMAIN_WRITERS', 'medicalDB', 'factDB', 'schema', 'routeIntent'];
    assert('conversational worker still has no write/action imports',
      banned.filter((token) => WORKER_SRC.includes(token)),
      (v) => Array.isArray(v) && v.length === 0, '[]');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}SemanticDispatchEligibility: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('semanticDispatchEligibility.test.ts')) {
  runSemanticDispatchEligibilityTests().catch(console.error);
}
