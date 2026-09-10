// scripts/heraldTest/semanticDispatchDiagnostics.test.ts
// Bounded Semantic Capability Dispatch device diagnostics.
// Routing results and model-call budgets must be unchanged.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  generateCapabilityProposal,
  SEMANTIC_DISPATCH_DIAG_TAG,
  CAPABILITY_PROPOSAL_SYSTEM_PROMPT,
  type SemanticDispatchDiag,
} from '../../src/routing/capabilityRouting.ts';
import { MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/medicationSemanticInterpretation.ts';
import { GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/grocerySemanticDecomposition.ts';
import { TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/todoSemanticCapture.ts';
import { withLlamaContextExclusive } from '../../src/utils/llamaContextExclusive.ts';
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

function captureDispatchDiags<T>(fn: () => Promise<T>): Promise<{ result: T; diags: SemanticDispatchDiag[] }> {
  const diags: SemanticDispatchDiag[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    const prefix = `[${SEMANTIC_DISPATCH_DIAG_TAG}] `;
    if (line.startsWith(prefix)) {
      diags.push(JSON.parse(line.slice(prefix.length)) as SemanticDispatchDiag);
    }
    orig.apply(console, args as []);
  };
  return fn().then((result) => {
    console.warn = orig;
    return { result, diags };
  }, (err) => {
    console.warn = orig;
    throw err;
  });
}

type CallCounts = { dispatch: number; medication: number; grocery: number; todo: number };

function countingCtx(script: string[]) {
  const counts: CallCounts = { dispatch: 0, medication: 0, grocery: 0, todo: 0 };
  let i = 0;
  const ctx = {
    completion: async (opts: { messages?: Array<{ content?: string }> }) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      if (sys === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) counts.dispatch++;
      if (sys === MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) counts.medication++;
      if (sys === GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) counts.grocery++;
      if (sys === TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) counts.todo++;
      const content = script[i] ?? '';
      i++;
      if (content === '__throw__') throw new Error('interpreter unavailable');
      return { content };
    },
  };
  return { ctx, counts };
}

const DISPATCH_OTHER = '{"capability":"other","confidence":"high"}';
const DISPATCH_UNCERTAIN = '{"capability":"uncertain","confidence":"high"}';
const DISPATCH_GROCERY = '{"capability":"grocery.capture","confidence":"high"}';
const DISPATCH_MED = '{"capability":"medication.capture","confidence":"high"}';
const DISPATCH_LIST_READ = '{"capability":"list.read","confidence":"high"}';
const DISPATCH_LIST_READ_LOW = '{"capability":"list.read","confidence":"low"}';
const DISPATCH_TODO_CAPTURE = '{"capability":"todo.capture","confidence":"high"}';
const DISPATCH_TODO_READ = '{"capability":"todo.read","confidence":"high"}';
const DISPATCH_TODO_READ_LOW = '{"capability":"todo.read","confidence":"low"}';
const GROCERY_OK = JSON.stringify({
  capability: 'grocery_capture',
  candidates: ['milk', 'eggs', 'bread'],
  confidence: 0.92,
});
const TODO_OK = JSON.stringify({
  capability: 'todo_capture',
  candidates: ['water the plants'],
  confidence: 0.92,
});
const MED_OK = JSON.stringify({
  mentions: ['Eliquis'],
  predicate: 'is',
  focus: 'Eliquis',
  confidence: 0.9,
});

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

export async function runSemanticDispatchDiagnosticsTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Semantic Capability Dispatch diagnostics --${RESET}\n`);

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_OTHER]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx)));
    assert('T3 default emits exactly one dispatch diagnostic', diags.length, (v) => v === 1, '1');
    assert('T3 default invoked true', diags[0]?.invoked, (v) => v === true, 'true');
    assert('T3 default does not change fallback kind', result.kind, (v) => v === 'needs_clarification', 'needs_clarification');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_OTHER]);
    const { diags } = await captureDispatchDiags(() =>
      routeIntent('add chocolate milk to my grocery list', baseDeps(ctx)));
    assert('T1 deterministic emits no dispatch diagnostic', diags.length, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_GROCERY, GROCERY_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('We need milk eggs and bread.', baseDeps(ctx)));
    assert('GROCERY specialistInvoked grocery', diags[0]?.specialistInvoked, (v) => v === 'grocery', 'grocery');
    assert('GROCERY proposedCapability grocery.capture', diags[0]?.proposedCapability, (v) => v === 'grocery.capture', 'grocery.capture');
    assert('GROCERY specialistResult admit', diags[0]?.specialistResult, (v) => v === 'admit', 'admit');
    assert('GROCERY finalOutcome specialist_admit', diags[0]?.finalOutcome, (v) => v === 'specialist_admit', 'specialist_admit');
    assert('GROCERY one diagnostic', diags.length, (v) => v === 1, '1');
    assert('GROCERY model budget unchanged',
      counts.dispatch === 1 && counts.grocery === 1 && counts.medication === 0 && counts.todo === 0,
      (v) => v === true, '1 dispatch 1 grocery 0 med 0 todo');
    assert('GROCERY route still capture', result.kind, (v) => v === 'capture', 'capture');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_TODO_CAPTURE, TODO_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('We need to water the plants.', baseDeps(ctx)));
    assert('TODO specialistInvoked todo', diags[0]?.specialistInvoked, (v) => v === 'todo', 'todo');
    assert('TODO proposedCapability todo.capture', diags[0]?.proposedCapability, (v) => v === 'todo.capture', 'todo.capture');
    assert('TODO specialistResult admit', diags[0]?.specialistResult, (v) => v === 'admit', 'admit');
    assert('TODO finalOutcome specialist_admit', diags[0]?.finalOutcome, (v) => v === 'specialist_admit', 'specialist_admit');
    assert('TODO one diagnostic', diags.length, (v) => v === 1, '1');
    assert('TODO model budget one specialist',
      counts.dispatch === 1 && counts.todo === 1 && counts.grocery === 0 && counts.medication === 0,
      (v) => v === true, '1 dispatch 1 todo 0 grocery 0 med');
    assert('TODO route still capture', result.kind, (v) => v === 'capture', 'capture');
    assert('TODO handoff is todo_add',
      (result as any).intents?.[0]?.type, (v) => v === 'todo_add', 'todo_add');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_MED, MED_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('Eliquis is my blood thinner prescription.', baseDeps(ctx)));
    assert('MED specialistInvoked medication', diags[0]?.specialistInvoked, (v) => v === 'medication', 'medication');
    assert('MED proposedCapability medication.capture', diags[0]?.proposedCapability, (v) => v === 'medication.capture', 'medication.capture');
    assert('MED specialistResult admit', diags[0]?.specialistResult, (v) => v === 'admit', 'admit');
    assert('MED model budget unchanged',
      counts.dispatch === 1 && counts.medication === 1 && counts.grocery === 0,
      (v) => v === true, '1 dispatch 1 med 0 grocery');
    assert('MED route still capture', result.kind, (v) => v === 'capture', 'capture');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_OTHER, GROCERY_OK, MED_OK]);
    const { diags } = await captureDispatchDiags(() =>
      routeIntent('tell me a joke', baseDeps(ctx)));
    assert('OTHER specialist none', diags[0]?.specialistInvoked, (v) => v === 'none', 'none');
    assert('OTHER generation ok', diags[0]?.generationStatus, (v) => v === 'ok', 'ok');
    assert('OTHER finalOutcome fallback', diags[0]?.finalOutcome, (v) => v === 'fallback', 'fallback');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_LIST_READ, GROCERY_OK, MED_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx)));
    assert('LIST.READ diagnostic finalOutcome read_admit', diags[0]?.finalOutcome, (v) => v === 'read_admit', 'read_admit');
    assert('LIST.READ diagnostic specialistInvoked none', diags[0]?.specialistInvoked, (v) => v === 'none', 'none');
    assert('LIST.READ diagnostic specialistResult not_run', diags[0]?.specialistResult, (v) => v === 'not_run', 'not_run');
    assert('LIST.READ diagnostic selectedCapability list.read', diags[0]?.selectedCapability, (v) => v === 'list.read', 'list.read');
    assert('LIST.READ diagnostic route is device_read', result.kind, (v) => v === 'device_read', 'device_read');
    assert('LIST.READ diagnostic zero write specialists',
      counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_TODO_READ, GROCERY_OK, MED_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx)));
    assert('TODO.READ diagnostic finalOutcome read_admit', diags[0]?.finalOutcome, (v) => v === 'read_admit', 'read_admit');
    assert('TODO.READ diagnostic specialistInvoked none', diags[0]?.specialistInvoked, (v) => v === 'none', 'none');
    assert('TODO.READ diagnostic selectedCapability todo.read', diags[0]?.selectedCapability, (v) => v === 'todo.read', 'todo.read');
    assert('TODO.READ diagnostic route is device_read', result.kind, (v) => v === 'device_read', 'device_read');
    assert('TODO.READ diagnostic uses todo reader not grocery',
      (result as { response?: string }).response,
      (v) => v === "You're all clear — nothing on your to-do list.",
      "You're all clear — nothing on your to-do list.");
    assert('TODO.READ diagnostic zero write specialists',
      counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_TODO_READ_LOW, GROCERY_OK, MED_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx)));
    assert('TODO.READ low diagnostic finalOutcome fallback', diags[0]?.finalOutcome, (v) => v === 'fallback', 'fallback');
    assert('TODO.READ low is not device_read', result.kind, (v) => v !== 'device_read', 'not device_read');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_LIST_READ_LOW, GROCERY_OK, MED_OK]);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx)));
    assert('LIST.READ low diagnostic finalOutcome fallback', diags[0]?.finalOutcome, (v) => v === 'fallback', 'fallback');
    assert('LIST.READ low diagnostic specialist none', diags[0]?.specialistInvoked, (v) => v === 'none', 'none');
    assert('LIST.READ low is not device_read', result.kind, (v) => v !== 'device_read', 'not device_read');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_UNCERTAIN, GROCERY_OK, MED_OK]);
    const { diags } = await captureDispatchDiags(() =>
      routeIntent('maybe that thing we talked about', baseDeps(ctx)));
    assert('UNCERTAIN specialist none', diags[0]?.specialistInvoked, (v) => v === 'none', 'none');
    assert('UNCERTAIN proposedCapability uncertain', diags[0]?.proposedCapability, (v) => v === 'uncertain', 'uncertain');
  }

  {
    freshDB();
    const { ctx } = countingCtx(['completely unparseable ~~~']);
    const { result, diags } = await captureDispatchDiags(() =>
      routeIntent('We need milk eggs and bread.', baseDeps(ctx)));
    assert('PARSE_FAIL generationStatus parse_fail', diags[0]?.generationStatus, (v) => v === 'parse_fail', 'parse_fail');
    assert('PARSE_FAIL no proposed capability', diags[0]?.proposedCapability, (v) => v === null, 'null');
    assert('PARSE_FAIL diagnostic has no raw model text',
      JSON.stringify(diags[0] ?? {}),
      (v) => typeof v === 'string' && !/unparseable/i.test(v as string), 'no raw');
    assert('PARSE_FAIL route unchanged (not capture)', result.kind, (v) => v !== 'capture', 'not capture');
  }

  {
    freshDB();
    const missing = await generateCapabilityProposal('how was your weekend', () => null);
    assert('GEN ctx_missing reason',
      missing.status === 'unavailable' && (missing as { reason?: string }).reason === 'ctx_missing',
      (v) => v === true, 'unavailable/ctx_missing');
    const { diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(null)));
    assert('NULL CTX generationStatus unavailable', diags[0]?.generationStatus, (v) => v === 'unavailable', 'unavailable');
    assert('NULL CTX unavailableReason ctx_missing', diags[0]?.unavailableReason, (v) => v === 'ctx_missing', 'ctx_missing');
    assert('NULL CTX one diagnostic', diags.length, (v) => v === 1, '1');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_OTHER]);
    const held = await withLlamaContextExclusive('probe', 'wait', async () => {
      return captureDispatchDiags(() => routeIntent('how was your weekend', baseDeps(ctx)));
    });
    const { diags } = held.ok ? held.value : { diags: [] as SemanticDispatchDiag[] };
    assert('BUSY CTX unavailableReason ctx_busy', diags[0]?.unavailableReason, (v) => v === 'ctx_busy', 'ctx_busy');
    assert('BUSY CTX generationStatus unavailable', diags[0]?.generationStatus, (v) => v === 'unavailable', 'unavailable');
    assert('BUSY CTX does not start dispatch completion', counts.dispatch, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx } = countingCtx([DISPATCH_OTHER]);
    const { diags } = await captureDispatchDiags(() =>
      routeIntent('how was your weekend', baseDeps(ctx, { semanticCapabilityDispatchEnabled: false })));
    assert('DISPATCH FLAG OFF emits no dispatch diagnostic', diags.length, (v) => v === 0, '0');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}SemanticDispatchDiagnostics: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('semanticDispatchDiagnostics.test.ts')) {
  runSemanticDispatchDiagnosticsTests().catch(console.error);
}
