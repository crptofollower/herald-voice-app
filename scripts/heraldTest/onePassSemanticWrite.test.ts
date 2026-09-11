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
  CAPABILITY_PROPOSAL_RESPONSE_FORMAT,
} from '../../src/routing/capabilityRouting.ts';
import {
  admitTodoSemanticP2,
  diagnoseTodoDispatchWriteLift,
  groundTodoCandidates,
  todoSemanticProposalFromDispatchWrite,
} from '../../src/routing/todoSemanticCapture.ts';
import {
  admitGrocerySemanticP2,
  diagnoseGroceryDispatchWriteLift,
  grocerySemanticProposalFromDispatchWrite,
  groundGroceryCandidates,
} from '../../src/routing/grocerySemanticDecomposition.ts';
import {
  admitMedicationSemanticProposal,
  diagnoseMedicationDispatchWriteLift,
  medicationSemanticProposalFromDispatchWrite,
} from '../../src/routing/medicationSemanticInterpretation.ts';
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

  console.log(`\n${BOLD}-- One-pass semantic write (Slice B / B.1) --${RESET}\n`);

  {
    const schema = (CAPABILITY_PROPOSAL_RESPONSE_FORMAT.json_schema as { schema: { oneOf: Array<{
      required?: string[];
      properties?: { capability?: { enum?: string[] } };
    }> } }).schema;
    assert('dispatch schema uses oneOf write vs read branches',
      Array.isArray(schema.oneOf) && schema.oneOf.length === 4,
      (v) => v === true, '4 branches');
    assert('read/off-ramp branch requires only capability+confidence',
      schema.oneOf[0]?.required,
      (v) => Array.isArray(v) && v.length === 2 && v.includes('capability') && v.includes('confidence'),
      'capability confidence');
    assert('todo.capture schema requires op+candidates+score',
      schema.oneOf[1]?.required,
      (v) => Array.isArray(v) && v.includes('op') && v.includes('candidates') && v.includes('score'),
      'todo write required');
    assert('grocery.capture schema requires op+candidates+score',
      schema.oneOf[2]?.required,
      (v) => Array.isArray(v) && v.includes('op') && v.includes('candidates') && v.includes('score'),
      'grocery write required');
    assert('medication.capture schema requires mentions+predicate+focus+score',
      schema.oneOf[3]?.required,
      (v) => Array.isArray(v) && v.includes('mentions') && v.includes('predicate') && v.includes('focus') && v.includes('score'),
      'medication write required');
    assert('read/off-ramp enum excludes write capabilities',
      schema.oneOf[0]?.properties?.capability?.enum,
      (v) => Array.isArray(v) && !v.includes('todo.capture') && !v.includes('grocery.capture') && !v.includes('medication.capture'),
      'no writes in read enum');
  }

  {
    assert('dispatch prompt requires verbatim write spans',
      /exact contiguous span/.test(CAPABILITY_PROPOSAL_SYSTEM_PROMPT)
      && /Do not paraphrase/.test(CAPABILITY_PROPOSAL_SYSTEM_PROMPT)
      && /multi-word/.test(CAPABILITY_PROPOSAL_SYSTEM_PROMPT),
      (v) => v === true, 'verbatim contract');
    assert('dispatch prompt does not encode device-proof write sentences',
      /paper towels|water the plants|\bPaul\b/.test(CAPABILITY_PROPOSAL_SYSTEM_PROMPT),
      (v) => v === false, 'no device sentences');
  }

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

  {
    const json = JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      candidates: ['feed the cat'],
      score: 0.91,
    });
    const p = parseCapabilityProposal(json);
    const lifted = p ? todoSemanticProposalFromDispatchWrite(p) : null;
    assert('todo one-pass lifts verbatim task span',
      lifted?.capability === 'todo_capture' && lifted.candidates[0] === 'feed the cat' && lifted.confidence === 0.91,
      (v) => v === true, 'feed the cat');
    assert('todo lift success diagnostic is ok',
      p ? diagnoseTodoDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'ok', 'ok');
  }

  {
    const json = JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['almond milk'],
      score: 0.93,
    });
    const p = parseCapabilityProposal(json);
    const lifted = p ? grocerySemanticProposalFromDispatchWrite(p) : null;
    assert('grocery one-pass lifts verbatim multi-word item',
      lifted?.capability === 'grocery_capture' && lifted.candidates[0] === 'almond milk',
      (v) => v === true, 'almond milk');
    const grounded = groundGroceryCandidates('We need almond milk.', lifted?.candidates ?? []);
    assert('existing grocery grounding accepts the verbatim multi-word span',
      grounded?.[0], (v) => v === 'almond milk', 'almond milk');
    const paraphrased = groundGroceryCandidates('We need almond milk.', ['almond milks']);
    assert('existing grocery grounding still rejects a non-verbatim candidate',
      paraphrased, (v) => v === null, 'null');
  }

  {
    const json = JSON.stringify({
      capability: 'medication.capture',
      confidence: 'high',
      mentions: ['Lisinopril'],
      predicate: 'is',
      focus: 'Lisinopril',
      score: 0.88,
    });
    const p = parseCapabilityProposal(json);
    const lifted = p ? medicationSemanticProposalFromDispatchWrite(p) : null;
    assert('medication one-pass still lifts mentions/predicate/focus/score',
      lifted?.focus === 'Lisinopril' && lifted.mentions[0] === 'Lisinopril' && lifted.predicate === 'is' && lifted.confidence === 0.88,
      (v) => v === true, 'Lisinopril');
  }

  {
    const p = parseCapabilityProposal(DISPATCH_TODO_BARE);
    assert('missing write payload diagnostic is missing_write',
      p ? diagnoseTodoDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'missing_write', 'missing_write');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['feed the cat'],
      score: 0.9,
    }));
    assert('wrong-family op diagnostic is wrong_family_op',
      p ? diagnoseTodoDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'wrong_family_op', 'wrong_family_op');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      score: 0.9,
    }));
    assert('missing candidates diagnostic is missing_candidates',
      p ? diagnoseTodoDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'missing_candidates', 'missing_candidates');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['almond milk'],
    }));
    assert('missing score diagnostic is missing_score',
      p ? diagnoseGroceryDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'missing_score', 'missing_score');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'todo.capture',
      confidence: 'high',
      op: 'todo_capture',
      candidates: [],
      score: 0.9,
    }));
    const diag = p ? diagnoseTodoDispatchWriteLift(p) : null;
    assert('empty candidates still lifts for admission to refuse',
      diag?.lifted?.candidates.length === 0 && diag.reason === 'empty_candidates',
      (v) => v === true, 'empty_candidates');
    const admitted = diag?.lifted
      ? admitTodoSemanticP2('We need to feed the cat.', diag.lifted, { hasPending: false })
      : null;
    assert('empty todo candidates do not admit',
      admitted?.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: [],
      score: 0.9,
    }));
    const lifted = p ? grocerySemanticProposalFromDispatchWrite(p) : null;
    const admitted = lifted
      ? admitGrocerySemanticP2('We need almond milk.', lifted, { hasPending: false })
      : null;
    assert('empty grocery candidates do not admit',
      admitted?.decision, (v) => v === 'REJECT', 'REJECT');
  }

  {
    const p = parseCapabilityProposal(JSON.stringify({
      capability: 'medication.capture',
      confidence: 'high',
      predicate: 'is',
      focus: 'Lisinopril',
      score: 0.9,
    }));
    assert('missing mentions diagnostic is missing_mentions',
      p ? diagnoseMedicationDispatchWriteLift(p).reason : 'no-parse',
      (v) => v === 'missing_mentions', 'missing_mentions');
  }

  {
    const p = parseCapabilityProposal(DISPATCH_READ);
    assert('semantic read parse does not require a write payload',
      p?.capability === 'medication.read_summary' && p.write === undefined,
      (v) => v === true, 'read_summary no write');
  }

  {
    assert('todo grounding remains verbatim-span only',
      groundTodoCandidates('We need to feed the cat.', ['feed the cat'])?.[0] === 'feed the cat'
      && groundTodoCandidates('We need to feed the cat.', ['feeding cats']) === null,
      (v) => v === true, 'verbatim only');
  }

  {
    const d = admitTodoSemanticP2(
      'We need to feed the cat.',
      { capability: 'todo_capture', candidates: ['feed the cat'], confidence: 0.91 },
      { hasPending: false },
    );
    assert('todo P2 admission is unchanged for a grounded one-pass shape',
      d.decision === 'ADMIT' && d.decision === 'ADMIT' && d.candidates[0] === 'feed the cat',
      (v) => v === true, 'ADMIT');
  }

  {
    const d = admitGrocerySemanticP2(
      'We need almond milk.',
      { capability: 'grocery_capture', candidates: ['almond milk'], confidence: 0.93 },
      { hasPending: false },
    );
    assert('grocery P2 admission is unchanged for a grounded multi-word item',
      d.decision === 'ADMIT' && d.decision === 'ADMIT' && d.candidates[0] === 'almond milk',
      (v) => v === true, 'ADMIT');
  }

  {
    const d = admitMedicationSemanticProposal(
      'Lisinopril is my blood pressure prescription.',
      { mentions: ['Lisinopril'], predicate: 'is', focus: 'Lisinopril', confidence: 0.88 },
      { hasPending: false },
    );
    assert('medication admission is unchanged for a lifted one-pass shape',
      d.decision === 'ADMIT' && (d as { drug?: string }).drug === 'Lisinopril',
      (v) => v === true, 'ADMIT Lisinopril');
  }

  {
    freshDB();
    const json = JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['almond milk'],
      score: 0.93,
    });
    const { ctx, counts } = countingCtx([json]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent('We need almond milk.', baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('multi-word grocery one-pass admits without specialist inference',
      result.kind === 'capture' && counts.grocery === 0 && counts.dispatch === 1,
      (v) => v === true, 'capture dispatch-only');
    assert('grounding failure/success logs remain on the one-pass path',
      /SEMANTIC_GROUNDING_DONE/.test(joined) && /SEMANTIC_ADMISSION_DONE/.test(joined)
      && !/SEMANTIC_SPECIALIST_INFERENCE_START/.test(joined),
      (v) => v === true, 'grounding+admission no specialist');
  }

  {
    freshDB();
    const ungrounded = JSON.stringify({
      capability: 'grocery.capture',
      confidence: 'high',
      op: 'grocery_capture',
      candidates: ['saffron extract'],
      score: 0.99,
    });
    const { ctx } = countingCtx([ungrounded]);
    const { result, lines } = await captureLatencyLines(() =>
      routeIntent('We need almond milk.', baseDeps(ctx)));
    const joined = lines.join('\n');
    assert('ungrounded grocery candidate still fails closed',
      result.kind, (v) => v !== 'capture', 'not capture');
    assert('grounding failure logs the candidate string',
      /saffron extract/.test(joined) && /ungrounded_candidate/.test(joined),
      (v) => v === true, 'candidate string');
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
