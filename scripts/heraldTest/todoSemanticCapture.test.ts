// scripts/heraldTest/todoSemanticCapture.test.ts
// Semantic todo.capture V1 — P2 confirmation into DOMAIN_WRITERS.todo_add.
// Semantic classes, not founder-specific wording.

import Database from 'better-sqlite3';
import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  parseTodoSemanticProposal,
  admitTodoSemanticP2,
  groundTodoCandidates,
  formatTodoCaptureConfirmPrompt,
  generateTodoSemanticProposal,
  TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT,
  type TodoSemanticProposal,
} from '../../src/routing/todoSemanticCapture.ts';
import { GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/grocerySemanticDecomposition.ts';
import { CAPABILITY_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/capabilityRouting.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function todoSet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'todos' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

function grocerySet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

function proposal(over: Partial<TodoSemanticProposal> = {}): TodoSemanticProposal {
  return {
    capability: 'todo_capture',
    candidates: ['water the plants'],
    confidence: 0.92,
    ...over,
  };
}

const DISPATCH_TODO = '{"capability":"todo.capture","confidence":"high"}';
const DISPATCH_GROCERY = '{"capability":"grocery.capture","confidence":"high"}';
const GROCERY_OK = JSON.stringify({
  capability: 'grocery_capture',
  candidates: ['milk', 'eggs', 'bread'],
  confidence: 0.92,
});

function fakeCtx(p: TodoSemanticProposal | string, dispatchJson = DISPATCH_TODO) {
  const content = typeof p === 'string' ? p : JSON.stringify(p);
  return {
    completion: async (opts?: { messages?: Array<{ content?: string }> }) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      if (sys === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) {
        return { content: dispatchJson };
      }
      if (sys === GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) {
        return { content: GROCERY_OK };
      }
      if (sys === TODO_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) {
        return { content };
      }
      return { content };
    },
  } as any;
}

function enabledDeps(
  harness: ReturnType<typeof openJourneyDb>,
  ctx: ReturnType<typeof fakeCtx> | null,
) {
  return {
    ...harness.deps,
    getMedicationSemanticInterpreterCtx: ctx ? () => ctx : () => null,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    semanticCapabilityDispatchEnabled: true,
    grocerySemanticDecompositionEnabled: true,
  };
}

export async function runTodoSemanticCaptureTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  const setEq = (want: string[]) => (v: unknown) =>
    Array.isArray(v) && JSON.stringify(v) === JSON.stringify([...want].sort());

  console.log(`\n${BOLD}-- Semantic todo.capture V1 --${RESET}\n`);

  {
    const p = parseTodoSemanticProposal('{"capability":"todo_capture","candidates":["water the plants"],"confidence":0.8}');
    assert('PARSE1 well-formed proposal accepted', p, (v) => !!v && (v as TodoSemanticProposal).candidates[0] === 'water the plants', 'parsed task');
  }
  {
    const p = parseTodoSemanticProposal('{"capability":"todo","candidates":["water the plants"],"confidence":0.8}');
    assert('PARSE2 unknown capability rejected', p, (v) => v === null, 'null');
  }
  {
    const p = parseTodoSemanticProposal('{"capability":"todo_capture","candidates":["water the plants"],"confidence":2}');
    assert('PARSE3 out-of-range confidence rejected', p, (v) => v === null, 'null');
  }

  {
    const raw = 'We need to water the plants and mail the package.';
    const grounded = groundTodoCandidates(raw, ['water the plants', 'mail the package']);
    assert('GROUND1 punctuation-free spans ground', grounded, (v) => Array.isArray(v) && v.length === 2, '2 spans');
    const hall = groundTodoCandidates(raw, ['water the plants', 'fly to mars']);
    assert('GROUND2 hallucinated candidate rejects whole set', hall, (v) => v === null, 'null');
  }

  {
    const d = admitTodoSemanticP2('We need to water the plants.', proposal(), { hasPending: false });
    assert('ADMIT-P2 natural task admits when grounded', d.decision, (v) => v === 'ADMIT', 'ADMIT');
  }
  {
    const d = admitTodoSemanticP2('I bought milk yesterday.', proposal({ candidates: ['milk'] }), { hasPending: false });
    assert('ADMIT-P2 past event refused', d.decision, (v) => v === 'REJECT', 'REJECT');
  }
  {
    const d = admitTodoSemanticP2('We need to water the plants.', proposal({ capability: 'uncertain' }), { hasPending: false });
    assert('ADMIT-P2 uncertain capability does not admit', d.decision, (v) => v !== 'ADMIT', 'not ADMIT');
  }
  {
    const d = admitTodoSemanticP2('We need to water the plants.', proposal({ confidence: 0.2 }), { hasPending: false });
    assert('ADMIT-P2 low confidence clarifies', d.decision, (v) => v === 'CLARIFY', 'CLARIFY');
  }
  {
    const d = admitTodoSemanticP2('We need to water the plants.', proposal(), { hasPending: true });
    assert('ADMIT-P2 pending owns turn', d.decision, (v) => v === 'DEFER', 'DEFER');
  }

  {
    const utterance = 'We need to water the plants.';
    const harness = openJourneyDb();
    const legacy = await classifyQuery(utterance);
    assert('TSC1 classifyQuery is default fall-through',
      `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    const t1 = await processUtterance(normalizeInput(utterance), harness.session, deps);
    assert('TSC1 single-task does not persist before confirmation', todoSet(harness.db), setEq([]), '[]');
    assert('TSC1 single-task confirmation required', t1.commits.some((c) => c.status === 'pending'), (v) => v === true, 'pending');
    assert('TSC1 prompt names the task', t1.responseText,
      (v) => typeof v === 'string' && /water the plants/i.test(v) && /to-do list/i.test(v),
      formatTodoCaptureConfirmPrompt(['water the plants']));
    const t2 = await processUtterance('yes', harness.session, deps);
    assert('TSC1 yes persists one todo_add row', todoSet(harness.db), setEq(['water the plants']), '["water the plants"]');
    assert('TSC1 yes commit-truth ack', t2.commits.some((c) => c.status === 'committed'), (v) => v === true, 'committed');
    assert('TSC1 does not write grocery', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const utterance = 'We need to water the plants and mail the package.';
    const harness = openJourneyDb();
    const legacy = await classifyQuery(utterance);
    assert('TSC2 classifyQuery is default fall-through',
      `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
    const deps = enabledDeps(harness, fakeCtx(proposal({
      candidates: ['water the plants', 'mail the package'],
    })));
    const t1 = await processUtterance(normalizeInput(utterance), harness.session, deps);
    assert('TSC2 multi-task does not persist before confirmation', todoSet(harness.db), setEq([]), '[]');
    assert('TSC2 multi-task confirmation required', t1.commits.some((c) => c.status === 'pending'), (v) => v === true, 'pending');
    await processUtterance('yes', harness.session, deps);
    assert('TSC2 yes persists one row per grounded task',
      todoSet(harness.db), setEq(['mail the package', 'water the plants']), '["mail the package","water the plants"]');
    assert('TSC2 does not write grocery', grocerySet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ candidates: ['water the plants', 'fly to mars'] })));
    await processUtterance(normalizeInput('We need to water the plants.'), harness.session, deps);
    assert('TSC3 grounding failure never persists', todoSet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ confidence: 0.2 })));
    const t1 = await processUtterance(normalizeInput('We need to water the plants.'), harness.session, deps);
    assert('TSC4 low confidence does not persist', todoSet(harness.db), setEq([]), '[]');
    assert('TSC4 low confidence is not a write pending',
      (t1 as { commits?: { status: string }[] }).commits?.some((c) => c.status === 'pending') ?? false, (v) => v === false, 'no pending');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal({ capability: 'not_todo_capture' })));
    await processUtterance(normalizeInput('We need to water the plants.'), harness.session, deps);
    assert('TSC5 specialist refusal does not persist', todoSet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(GROCERY_OK, DISPATCH_GROCERY));
    const t1 = await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, deps);
    assert('TSC6 grocery P2 still confirmation-gated', grocerySet(harness.db), setEq([]), '[]');
    assert('TSC6 grocery P2 still pending', t1.commits.some((c) => c.status === 'pending'), (v) => v === true, 'pending');
    await processUtterance('yes', harness.session, deps);
    assert('TSC6 grocery writer still owns grocery items', grocerySet(harness.db), setEq(['bread', 'eggs', 'milk']), '["bread","eggs","milk"]');
    assert('TSC6 grocery path does not write todos', todoSet(harness.db), setEq([]), '[]');
  }

  {
    const harness = openJourneyDb();
    const deps = enabledDeps(harness, fakeCtx(proposal()));
    const t1 = await processUtterance(normalizeInput('I need to call the dentist.'), harness.session, deps);
    assert('TSC7 deterministic todo_add still immediate', t1.commits.some((c) => c.status === 'committed'), (v) => v === true, 'committed');
    assert('TSC7 deterministic todo_add has no confirm pending',
      t1.commits.some((c) => c.status === 'pending'), (v) => v === false, 'no pending');
    assert('TSC7 deterministic body is unchanged', todoSet(harness.db), setEq(['call the dentist.']), '["call the dentist."]');
  }

  {
    const r = await generateTodoSemanticProposal('We need to water the plants.', () => null);
    assert('TSC8 generate unavailable without ctx', r.status, (v) => v === 'unavailable', 'unavailable');
  }

  {
    openJourneyDb();
    const ctx = fakeCtx(proposal());
    const decision = await routeIntent('We need to water the plants.', {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: [] },
      getMedicationSemanticInterpreterCtx: () => ctx,
      semanticCapabilityDispatchEnabled: true,
    });
    assert('TSC9 semantic capture is todo_add not list_add',
      (decision as any).kind === 'capture'
      && (decision as any).intents?.every((i: { type: string }) => i.type === 'todo_add')
      && (decision as any).intents?.length === 1
      && (decision as any).source === 'llm',
      (v) => v === true, 'one llm todo_add');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TodoSemanticCapture: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('todoSemanticCapture.test.ts')) {
  runTodoSemanticCaptureTests().catch(console.error);
}
