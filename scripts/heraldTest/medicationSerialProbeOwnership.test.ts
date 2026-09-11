// scripts/heraldTest/medicationSerialProbeOwnership.test.ts
// Conversational Latency V1 / Slice C.1 — leftover medication serial probe
// owns dispatch-OFF tier3/default only.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/capabilityRouting.ts';
import { MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/medicationSemanticInterpretation.ts';
import { GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/grocerySemanticDecomposition.ts';
import { TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/todoSemanticCapture.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';

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

const DISPATCH_OTHER = '{"capability":"other","confidence":"high"}';
const ONE_PASS_MED = JSON.stringify({
  capability: 'medication.capture',
  confidence: 'high',
  mentions: ['Eliquis'],
  predicate: 'is',
  focus: 'Eliquis',
  score: 0.9,
});
const MED_OK = JSON.stringify({
  mentions: ['Eliquis'],
  predicate: 'is',
  focus: 'Eliquis',
  confidence: 0.9,
});
const MED_UTTERANCE = 'Eliquis is my blood thinner prescription.';

export async function runMedicationSerialProbeOwnershipTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medication serial probe ownership (Slice C.1) --${RESET}\n`);

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_OTHER, MED_OK]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent(MED_UTTERANCE, baseDeps(ctx, { semanticCapabilityDispatchEnabled: false })));
    const joined = lines.join('\n');
    assert('dispatch-OFF default still uses serial medication fallback',
      result.kind === 'capture' && counts.medication === 1,
      (v) => v === true, 'capture + 1 medication');
    assert('dispatch-OFF serial fallback emits specialist inference',
      /SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined) && /"specialist":"medication"/.test(joined),
      (v) => v === true, 'specialist start medication');
    assert('dispatch-OFF serial fallback does not skip-log',
      /SEMANTIC_MEDICATION_SERIAL_SKIP/.test(joined), (v) => v === false, 'false');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_MED, MED_OK]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent(MED_UTTERANCE, baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('dispatch-ON default one-pass does not run serial medication specialist',
      result.kind === 'capture' && counts.dispatch === 1 && counts.medication === 0,
      (v) => v === true, 'capture dispatch-only');
    assert('dispatch-ON default logs eligibility and no serial skip',
      /SEMANTIC_DISPATCH_ELIGIBILITY/.test(joined) && !/SEMANTIC_MEDICATION_SERIAL_SKIP/.test(joined)
      && !/SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined),
      (v) => v === true, 'eligibility, no serial specialist');
  }

  {
    freshDB();
    const classified = await classifyQuery("what's the weather like");
    assert('weather query is live:data',
      `${classified.tier}:${classified.reason}`, (v) => v === '3:live:data', '3:live:data');
    const { ctx, counts } = countingCtx([MED_OK]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent("what's the weather like", baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('live:data does not run serial medication specialist',
      counts.medication === 0 && counts.total === 0,
      (v) => v === true, '0 completions');
    assert('live:data remains backend', result.kind, (v) => v === 'backend', 'backend');
    assert('live:data skip-logs non-default serial probe',
      /SEMANTIC_MEDICATION_SERIAL_SKIP/.test(joined)
      && /"reason":"non_default_route"/.test(joined)
      && /"routeReason":"live:data"/.test(joined)
      && !/SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined),
      (v) => v === true, 'serial skip live:data');
  }

  {
    freshDB();
    const utterance = 'We need to pick up milk and eggs.';
    const classified = await classifyQuery(utterance);
    assert('unmarked multi-object acquisition is non-default tier3',
      classified.tier === 3 && classified.reason !== 'default',
      (v) => v === true, 'tier3 non-default');
    const { ctx, counts } = countingCtx([MED_OK]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent(utterance, baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('non-default tier3 does not run serial medication specialist',
      counts.medication === 0 && counts.total === 0,
      (v) => v === true, '0 completions');
    assert('non-default tier3 skip-logs serial probe',
      /SEMANTIC_MEDICATION_SERIAL_SKIP/.test(joined)
      && /"reason":"non_default_route"/.test(joined)
      && !/SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined),
      (v) => v === true, 'serial skip');
    assert('non-default tier3 is not medication capture',
      result.kind, (v) => v !== 'capture', 'not capture');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([MED_OK]);
    const decision = await routeIntent('I need to call the dentist.', baseDeps(ctx));
    assert('T1 todo_add is unchanged',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'deterministic',
      (v) => v === true, 'deterministic');
    assert('T1 does not run serial medication specialist', counts.total, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([MED_OK]);
    const decision = await routeIntent('what have I told you', baseDeps(ctx));
    assert('T2 memory probe is unchanged', decision.kind, (v) => v === 'memory_probe', 'memory_probe');
    assert('T2 does not run serial medication specialist', counts.total, (v) => v === 0, '0');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicationSerialProbeOwnership: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicationSerialProbeOwnership.test.ts')) {
  runMedicationSerialProbeOwnershipTests().catch(console.error);
}
