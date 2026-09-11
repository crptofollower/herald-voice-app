// scripts/heraldTest/onePassSemanticWrite.test.ts
// Conversational Latency V1 / Slice B — one dispatch proposal, no specialist
// completion, same grounding/admission/confirmation.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  parseCapabilityProposal,
  CAPABILITY_PROPOSAL_SYSTEM_PROMPT,
} from '../../src/routing/capabilityRouting.ts';
import { todoSemanticProposalFromDispatchWrite } from '../../src/routing/todoSemanticCapture.ts';
import { grocerySemanticProposalFromDispatchWrite } from '../../src/routing/grocerySemanticDecomposition.ts';
import { medicationSemanticProposalFromDispatchWrite } from '../../src/routing/medicationSemanticInterpretation.ts';
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

type CallCounts = { dispatch: number; medication: number; grocery: number; todo: number; total: number };

function classifySystem(content: string): 'dispatch' | 'medication' | 'grocery' | 'todo' | 'other' {
  if (content === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) return 'dispatch';
  if (content === MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'medication';
  if (content === GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'grocery';
  if (content === TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'todo';
  return 'other';
}

function countingCtx(script: string[]) {
  const counts: CallCounts = { dispatch: 0, medication: 0, grocery: 0, todo: 0, total: 0 };
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

const ONE_PASS_TODO = JSON.stringify({
  capability: 'todo.capture',
  confidence: 'high',
  op: 'todo_capture',
  candidates: ['water the plants'],
  score: 0.92,
});
const ONE_PASS_GROCERY = JSON.stringify({
  capability: 'grocery.capture',
  confidence: 'high',
  op: 'grocery_capture',
  candidates: ['milk', 'eggs', 'bread'],
  score: 0.92,
});
const ONE_PASS_MED = JSON.stringify({
  capability: 'medication.capture',
  confidence: 'high',
  mentions: ['Eliquis'],
  predicate: 'is',
  focus: 'Eliquis',
  score: 0.9,
});
const DISPATCH_TODO_BARE = '{"capability":"todo.capture","confidence":"high"}';
const DISPATCH_READ = '{"capability":"medication.read_summary","confidence":"high"}';
const GROCERY_SPECIALIST = JSON.stringify({
  capability: 'grocery_capture',
  candidates: ['milk', 'eggs', 'bread'],
  confidence: 0.92,
});

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

function grocerySet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

export async function runOnePassSemanticWriteTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- One-pass semantic write (Slice B) --${RESET}\n`);

  {
    const p = parseCapabilityProposal(ONE_PASS_TODO);
    const lifted = p ? todoSemanticProposalFromDispatchWrite(p) : null;
    assert('todo lift preserves specialist candidate shape',
      lifted?.capability === 'todo_capture' && lifted.candidates[0] === 'water the plants' && lifted.confidence === 0.92,
      (v) => v === true, 'todo_capture water the plants 0.92');
  }

  {
    const p = parseCapabilityProposal(DISPATCH_TODO_BARE);
    assert('bare todo.capture does not manufacture a specialist proposal',
      p ? todoSemanticProposalFromDispatchWrite(p) : 'no-parse',
      (v) => v === null, 'null');
  }

  {
    const p = parseCapabilityProposal(ONE_PASS_GROCERY);
    const lifted = p ? grocerySemanticProposalFromDispatchWrite(p) : null;
    assert('grocery lift preserves specialist candidate shape',
      lifted?.capability === 'grocery_capture' && lifted.candidates.length === 3 && lifted.confidence === 0.92,
      (v) => v === true, 'grocery_capture 3 0.92');
  }

  {
    const p = parseCapabilityProposal(ONE_PASS_MED);
    const lifted = p ? medicationSemanticProposalFromDispatchWrite(p) : null;
    assert('medication lift preserves specialist proposal shape',
      lifted?.focus === 'Eliquis' && lifted.mentions[0] === 'Eliquis' && lifted.confidence === 0.9,
      (v) => v === true, 'Eliquis');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const decision = await routeIntent('We need to water the plants.', baseDeps(ctx));
    assert('TODO one-pass is llm capture',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'llm',
      (v) => v === true, 'capture llm');
    assert('TODO one-pass is P2 confirmation (todo_add)',
      (decision as { intents?: { type: string }[] }).intents?.[0]?.type === 'todo_add',
      (v) => v === true, 'todo_add');
    assert('TODO one-pass dispatch once, no specialist completion',
      counts.dispatch === 1 && counts.todo === 0 && counts.total === 1,
      (v) => v === true, '1 dispatch 0 todo');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_GROCERY]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx));
    assert('GROCERY one-pass is llm capture',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'llm',
      (v) => v === true, 'capture llm');
    assert('GROCERY one-pass dispatch once, no specialist completion',
      counts.dispatch === 1 && counts.grocery === 0 && counts.total === 1,
      (v) => v === true, '1 dispatch 0 grocery');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_MED]);
    const decision = await routeIntent('Eliquis is my blood thinner prescription.', baseDeps(ctx));
    assert('MED one-pass is llm medical_capture',
      decision.kind === 'capture'
      && (decision as { intents?: { type: string }[] }).intents?.[0]?.type === 'medical_capture',
      (v) => v === true, 'medical_capture');
    assert('MED one-pass dispatch once, no specialist completion',
      counts.dispatch === 1 && counts.medication === 0 && counts.total === 1,
      (v) => v === true, '1 dispatch 0 medication');
  }

  {
    const harness = openJourneyDb();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const deps = {
      ...harness.deps,
      ...baseDeps(ctx),
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    };
    const t1 = await processUtterance(normalizeInput('We need to water the plants.'), harness.session, deps);
    assert('TODO confirmation still pending before yes',
      t1.handled && 'commits' in t1 && t1.commits.some((c) => c.status === 'pending'),
      (v) => v === true, 'pending');
    assert('TODO confirmation did not invoke specialist completion', counts.todo, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_TODO_BARE, GROCERY_SPECIALIST]);
    const decision = await routeIntent('We need to water the plants.', baseDeps(ctx));
    assert('malformed one-pass write payload fails closed (no capture)',
      decision.kind, (v) => v !== 'capture', 'not capture');
    assert('malformed one-pass does not run a second specialist completion',
      counts.dispatch === 1 && counts.todo === 0 && counts.grocery === 0,
      (v) => v === true, 'dispatch only');
  }

  {
    freshDB();
    const ungrounded = JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      candidates: ['fly to mars'],
      score: 0.99,
    });
    const { ctx, counts } = countingCtx([ungrounded]);
    const decision = await routeIntent('We need to water the plants.', baseDeps(ctx));
    assert('ungrounded one-pass candidate is not admitted',
      decision.kind, (v) => v !== 'capture', 'not capture');
    assert('ungrounded one-pass does not invent a specialist retry',
      counts.todo, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx } = countingCtx([ONE_PASS_TODO]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent('We need to water the plants.', baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('instrumentation logs dispatch inference',
      /SEMANTIC_DISPATCH_INFERENCE_START/.test(joined) && /SEMANTIC_DISPATCH_INFERENCE_END/.test(joined),
      (v) => v === true, 'dispatch start/end');
    assert('instrumentation does not log specialist inference on one-pass write',
      /SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined),
      (v) => v === false, 'no specialist start');
    assert('instrumentation still logs grounding and admission',
      /SEMANTIC_GROUNDING_DONE/.test(joined) && /SEMANTIC_ADMISSION_DONE/.test(joined),
      (v) => v === true, 'grounding+admission');
    assert('instrumented one-pass still admits todo capture',
      result.kind, (v) => v === 'capture', 'capture');
  }

  {
    const db = freshDB();
    db.prepare(
      `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
       VALUES (?, ?, NULL, NULL, 1, ?, NULL);`,
    ).run('med_Lisinopril', 'Lisinopril', new Date().toISOString());
    const { ctx, counts } = countingCtx([DISPATCH_READ]);
    const decision = await routeIntent('What medications did I tell you I\'m taking?', baseDeps(ctx));
    assert('semantic read still one dispatch completion',
      decision.kind === 'device_read' && counts.dispatch === 1 && counts.total === 1,
      (v) => v === true, 'device_read 1 completion');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([
      '{"capability":"other","confidence":"high"}',
      JSON.stringify({ mentions: ['Eliquis'], predicate: 'is', focus: 'Eliquis', confidence: 0.9 }),
      GROCERY_SPECIALIST,
    ]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx, {
      semanticCapabilityDispatchEnabled: false,
    }));
    assert('dispatch FLAG-OFF still uses specialist completions for grocery P2',
      decision.kind === 'capture' && counts.grocery === 1,
      (v) => v === true, 'capture + grocery specialist');
  }

  {
    const harness = openJourneyDb();
    const { ctx } = countingCtx([ONE_PASS_GROCERY]);
    const deps = {
      ...harness.deps,
      ...baseDeps(ctx),
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    };
    await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, deps);
    assert('one-pass grocery does not write before confirmation',
      grocerySet(harness.db), (v) => Array.isArray(v) && v.length === 0, '[]');
    await processUtterance('yes', harness.session, deps);
    assert('one-pass grocery yes still uses list_add writer',
      grocerySet(harness.db),
      (v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(['bread', 'eggs', 'milk']),
      '["bread","eggs","milk"]');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([ONE_PASS_TODO]);
    const decision = await routeIntent('I need to call the dentist.', baseDeps(ctx));
    assert('deterministic todo_add is unchanged',
      decision.kind === 'capture' && (decision as { source?: string }).source === 'deterministic',
      (v) => v === true, 'deterministic capture');
    assert('deterministic todo_add does not run dispatch', counts.total, (v) => v === 0, '0');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}OnePassSemanticWrite: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('onePassSemanticWrite.test.ts')) {
  runOnePassSemanticWriteTests().catch(console.error);
}
