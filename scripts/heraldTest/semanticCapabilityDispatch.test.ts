// scripts/heraldTest/semanticCapabilityDispatch.test.ts
// Semantic Capability Dispatch V1 — one proposal, at most one domain interpreter.
// Semantic classes and routing counts, not founder-specific wording.
// Flag ON is injected; production default remains OFF.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  parseCapabilityProposal,
  CAPABILITY_IDS,
  CAPABILITY_PROPOSAL_SYSTEM_PROMPT,
  type CapabilityId,
} from '../../src/routing/capabilityRouting.ts';
import { MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/medicationSemanticInterpretation.ts';
import { GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT } from '../../src/routing/grocerySemanticDecomposition.ts';
import { SEMANTIC_CAPABILITY_DISPATCH_ENABLED } from '../../src/constants/features.ts';
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

function seedMedication(db: any, name: string) {
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, NULL, NULL, 1, ?, NULL);`,
  ).run(`med_${name}`, name, new Date().toISOString());
}

function medicationRowCount(db: any): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n;
}

function grocerySet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

type CallCounts = { dispatch: number; medication: number; grocery: number; total: number };

function classifySystem(content: string): 'dispatch' | 'medication' | 'grocery' | 'other' {
  if (content === CAPABILITY_PROPOSAL_SYSTEM_PROMPT) return 'dispatch';
  if (content === MEDICATION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'medication';
  if (content === GROCERY_SEMANTIC_PROPOSAL_SYSTEM_PROMPT) return 'grocery';
  return 'other';
}

function countingCtx(script: string[]) {
  const counts: CallCounts = { dispatch: 0, medication: 0, grocery: 0, total: 0 };
  let i = 0;
  const ctx = {
    completion: async (opts: any) => {
      const sys = String(opts?.messages?.[0]?.content ?? '');
      const kind = classifySystem(sys);
      counts.total++;
      if (kind === 'dispatch') counts.dispatch++;
      if (kind === 'medication') counts.medication++;
      if (kind === 'grocery') counts.grocery++;
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
const DISPATCH_READ = '{"capability":"medication.read_summary","confidence":"high"}';
const DISPATCH_LIST_READ = '{"capability":"list.read","confidence":"high"}';

const GROCERY_OK = JSON.stringify({
  capability: 'grocery_capture',
  candidates: ['milk', 'eggs', 'bread'],
  confidence: 0.92,
});
const GROCERY_HALLUC = JSON.stringify({
  capability: 'grocery_capture',
  candidates: ['milk', 'saffron'],
  confidence: 0.92,
});
const MED_OK = JSON.stringify({
  mentions: ['Eliquis'],
  predicate: 'is',
  focus: 'Eliquis',
  confidence: 0.9,
});
const MED_NO_EVIDENCE = JSON.stringify({
  mentions: ['vacation'],
  predicate: 'taking',
  focus: 'vacation',
  confidence: 0.9,
});

function baseDeps(ctx: any, over: Record<string, unknown> = {}) {
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

export async function runSemanticCapabilityDispatchTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Semantic Capability Dispatch V1 --${RESET}\n`);

  assert('FLAG default is ON', SEMANTIC_CAPABILITY_DISPATCH_ENABLED, (v) => v === true, 'true');
  assert('vocabulary includes grocery.capture',
    CAPABILITY_IDS.includes('grocery.capture' as CapabilityId), (v) => v === true, 'true');
  assert('parse accepts grocery.capture',
    parseCapabilityProposal(DISPATCH_GROCERY),
    (v) => (v as { capability?: string } | null)?.capability === 'grocery.capture', 'grocery.capture');
  assert('parse accepts uncertain',
    parseCapabilityProposal(DISPATCH_UNCERTAIN),
    (v) => (v as { capability?: string } | null)?.capability === 'uncertain', 'uncertain');

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_OTHER, GROCERY_OK, MED_OK]);
    const decision = await routeIntent('how was your weekend', baseDeps(ctx));
    assert('UNRELATED kind is not capture/read',
      decision.kind === 'needs_clarification' || decision.kind === 'not_ready',
      (v) => v === true, 'clarify/fallback');
    assert('UNRELATED dispatch once', counts.dispatch, (v) => v === 1, '1');
    assert('UNRELATED zero medication interpreter', counts.medication, (v) => v === 0, '0');
    assert('UNRELATED zero grocery interpreter', counts.grocery, (v) => v === 0, '0');
    assert('UNRELATED at most one domain interpreter', counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_GROCERY, GROCERY_OK, MED_OK]);
    const utterance = 'We need milk eggs and bread.';
    const legacy = await classifyQuery(utterance);
    assert('GROCERY-P2 classifyQuery is default fall-through',
      `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
    const decision = await routeIntent(utterance, baseDeps(ctx));
    assert('GROCERY-P2 routes to capture', decision.kind, (v) => v === 'capture', 'capture');
    assert('GROCERY-P2 is list_add grocery',
      (decision as any).intents?.[0]?.type === 'list_add' && (decision as any).intents?.[0]?.listName === 'grocery',
      (v) => v === true, 'list_add grocery');
    assert('GROCERY-P2 confirmation-gated (llm source)', (decision as any).source, (v) => v === 'llm', 'llm');
    assert('GROCERY-P2 dispatch once', counts.dispatch, (v) => v === 1, '1');
    assert('GROCERY-P2 grocery interpreter once', counts.grocery, (v) => v === 1, '1');
    assert('GROCERY-P2 zero medication interpreter', counts.medication, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_MED, MED_OK, GROCERY_OK]);
    const utterance = 'Eliquis is my blood thinner prescription.';
    const legacy = await classifyQuery(utterance);
    assert('MED-SEM classifyQuery is default fall-through',
      `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
    const decision = await routeIntent(utterance, baseDeps(ctx));
    assert('MED-SEM routes to capture', decision.kind, (v) => v === 'capture', 'capture');
    assert('MED-SEM is medical_capture',
      (decision as any).intents?.[0]?.type, (v) => v === 'medical_capture', 'medical_capture');
    assert('MED-SEM dispatch once', counts.dispatch, (v) => v === 1, '1');
    assert('MED-SEM medication interpreter once', counts.medication, (v) => v === 1, '1');
    assert('MED-SEM zero grocery interpreter', counts.grocery, (v) => v === 0, '0');
  }

  {
    const db = freshDB();
    seedMedication(db, 'Lisinopril');
    const { ctx, counts } = countingCtx([DISPATCH_READ, MED_OK, GROCERY_OK]);
    const decision = await routeIntent('What medications did I tell you I\'m taking?', baseDeps(ctx));
    assert('READ is device_read', decision.kind, (v) => v === 'device_read', 'device_read');
    assert('READ uses medical:summary', (decision as any).reason, (v) => v === 'medical:summary', 'medical:summary');
    assert('READ is a single dispatch completion', counts.dispatch, (v) => v === 1, '1');
    assert('READ adds no domain interpreters', counts.medication + counts.grocery, (v) => v === 0, '0');
    assert('READ total completions is 1', counts.total, (v) => v === 1, '1');
  }

  {
    const harness = openJourneyDb();
    const { ctx, counts } = countingCtx([DISPATCH_GROCERY, GROCERY_HALLUC, MED_OK]);
    await processUtterance(normalizeInput('We need milk.'), harness.session, {
      ...harness.deps,
      ...baseDeps(ctx),
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    });
    assert('WRONG-GROCERY persists nothing', grocerySet(harness.db), (v) => Array.isArray(v) && v.length === 0, '[]');
    assert('WRONG-GROCERY still one grocery interpreter', counts.grocery, (v) => v === 1, '1');
    assert('WRONG-GROCERY zero medication interpreter', counts.medication, (v) => v === 0, '0');
  }

  {
    const db = freshDB();
    const before = medicationRowCount(db);
    const { ctx, counts } = countingCtx([DISPATCH_MED, MED_NO_EVIDENCE, GROCERY_OK]);
    const decision = await routeIntent('We are taking a vacation next month.', baseDeps(ctx));
    assert('WRONG-MED is not capture', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('WRONG-MED did not persist medications', medicationRowCount(db), (v) => v === before, `${before}`);
    assert('WRONG-MED medication interpreter once', counts.medication, (v) => v === 1, '1');
    assert('WRONG-MED zero grocery interpreter', counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_OTHER, GROCERY_OK, MED_OK]);
    await routeIntent('tell me a joke', baseDeps(ctx));
    assert('OTHER zero domain interpreters', counts.medication + counts.grocery, (v) => v === 0, '0');
    assert('OTHER dispatch once', counts.dispatch, (v) => v === 1, '1');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_UNCERTAIN, GROCERY_OK, MED_OK]);
    const decision = await routeIntent('maybe that thing we talked about', baseDeps(ctx));
    assert('UNCERTAIN is not capture', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('UNCERTAIN does not serial-probe domains', counts.medication + counts.grocery, (v) => v === 0, '0');
    assert('UNCERTAIN dispatch once', counts.dispatch, (v) => v === 1, '1');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_LIST_READ, GROCERY_OK, MED_OK]);
    await routeIntent('how was your weekend', baseDeps(ctx));
    assert('LIST.READ off-ramp does not invoke write interpreters',
      counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { counts } = countingCtx([DISPATCH_GROCERY, GROCERY_OK]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(null));
    assert('UNAVAILABLE dispatch does not capture grocery', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('UNAVAILABLE does not invoke domain interpreters', counts.total, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx(['completely unparseable ~~~', GROCERY_OK, MED_OK]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx));
    assert('PARSE-FAIL is not capture', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('PARSE-FAIL does not serial-probe domains', counts.medication + counts.grocery, (v) => v === 0, '0');
    assert('PARSE-FAIL dispatch attempted once', counts.dispatch, (v) => v === 1, '1');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx(['__throw__', GROCERY_OK, MED_OK]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx));
    assert('TIMEOUT/throw is not capture', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('TIMEOUT/throw does not serial-probe domains', counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([GROCERY_OK, GROCERY_OK, GROCERY_OK]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx, {
      semanticCapabilityDispatchEnabled: false,
    }));
    assert('FLAG-OFF grocery still reaches P2 via legacy serial probe',
      decision.kind, (v) => v === 'capture', 'capture');
    assert('FLAG-OFF still runs capability-read parse attempt', counts.dispatch, (v) => v === 1, '1');
    assert('FLAG-OFF still runs medication interpreter then grocery',
      counts.medication === 1 && counts.grocery === 1, (v) => v === true, 'med 1 grocery 1');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_GROCERY, GROCERY_OK, MED_OK]);
    const decision = await routeIntent('We need milk eggs and bread.', baseDeps(ctx, {
      grocerySemanticDecompositionEnabled: false,
    }));
    assert('GROCERY-FLAG-OFF cannot bypass grocery rollout', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('GROCERY-FLAG-OFF does not invoke grocery interpreter', counts.grocery, (v) => v === 0, '0');
    assert('GROCERY-FLAG-OFF does not fall through to medication', counts.medication, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_MED, MED_OK, GROCERY_OK]);
    const decision = await routeIntent('Eliquis is my blood thinner prescription.', baseDeps(ctx, {
      medicationSemanticInterpretationEnabled: false,
    }));
    assert('MED-FLAG-OFF does not admit from dispatch alone', decision.kind, (v) => v !== 'capture', 'not capture');
    assert('MED-FLAG-OFF does not invoke medication interpreter', counts.medication, (v) => v === 0, '0');
    assert('MED-FLAG-OFF does not fall through to grocery', counts.grocery, (v) => v === 0, '0');
  }

  {
    const db = freshDB();
    seedMedication(db, 'Metformin');
    const { ctx, counts } = countingCtx([DISPATCH_READ, MED_OK, GROCERY_OK]);
    const decision = await routeIntent('What medications did I tell you I\'m taking?', baseDeps(ctx, {
      capabilityReadRouterEnabled: false,
    }));
    assert('READ-FLAG-OFF does not execute the read', decision.kind, (v) => v !== 'device_read', 'not device_read');
    assert('READ-FLAG-OFF does not probe write interpreters',
      counts.medication + counts.grocery, (v) => v === 0, '0');
  }

  {
    freshDB();
    const { ctx, counts } = countingCtx([DISPATCH_READ, MED_OK, GROCERY_OK]);
    const decision = await routeIntent('I started taking metformin 500 milligrams twice a day.', baseDeps(ctx));
    assert('FLOOR medication capture is not stolen by dispatch',
      decision.kind, (v) => v === 'capture', 'capture');
    assert('FLOOR capture is deterministic', (decision as any).source, (v) => v === 'deterministic', 'deterministic');
    assert('FLOOR does not run dispatch', counts.dispatch, (v) => v === 0, '0');
  }

  {
    const harness = openJourneyDb();
    const { ctx } = countingCtx([DISPATCH_GROCERY, GROCERY_OK]);
    const deps = {
      ...harness.deps,
      ...baseDeps(ctx),
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    };
    const t1 = await processUtterance(normalizeInput('We need milk eggs and bread.'), harness.session, deps);
    assert('P2-CONFIRM does not persist before yes', grocerySet(harness.db),
      (v) => Array.isArray(v) && v.length === 0, '[]');
    assert('P2-CONFIRM arms pending', t1.commits.some((c) => c.status === 'pending'), (v) => v === true, 'pending');
    await processUtterance('yes', harness.session, deps);
    assert('P2-CONFIRM yes persists grounded items', grocerySet(harness.db),
      (v) => Array.isArray(v) && JSON.stringify(v) === JSON.stringify(['bread', 'eggs', 'milk']),
      '["bread","eggs","milk"]');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}SemanticCapabilityDispatch: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('semanticCapabilityDispatch.test.ts')) {
  runSemanticCapabilityDispatchTests().catch(console.error);
}
