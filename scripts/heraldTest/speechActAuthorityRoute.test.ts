// scripts/heraldTest/speechActAuthorityRoute.test.ts
// CONV-C1 — route-level ownership: refused proposals fall through like pass.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import type { ClassifyOutcome, IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function freshDB() {
  const db = new Database(':memory:');
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

function mockClassify(intents: IntentRecord[]): ClassifyOutcome {
  return { status: 'ok', intents };
}

export async function runSpeechActAuthorityRouteTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Speech-Act Authority Route (CONV-C1) -------------------${RESET}\n`);

  const HOSTILE_FAMILY: IntentRecord = {
    type: 'family_capture',
    relation: 'brother',
    name: 'Josh',
  };

  // ── R1: primary isolation — narration must not become llm capture ───────────
  {
    freshDB();
    const decision = await routeIntent('My brother Josh called me today.', {
      classifyQuery,
      classifyLLM: async () => mockClassify([HOSTILE_FAMILY]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('R1a brother Josh narration → needs_clarification', decision.kind,
      v => v === 'needs_clarification', 'needs_clarification');
    assert('R1b brother Josh narration → NOT capture', decision.kind,
      v => v !== 'capture', 'not capture');
    assert('R1c brother Josh narration → honest default reason', decision.reason,
      v => v === 'default', 'default');
  }

  // ── R2: explicit capture controls still reach llm capture ─────────────────
  {
    freshDB();
    const decision = await routeIntent("Remember my brother's name is Josh.", {
      classifyQuery,
      classifyLLM: async () => mockClassify([HOSTILE_FAMILY]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('R2a remember brother Josh → capture', decision.kind,
      v => v === 'capture', 'capture');
    assert('R2b remember brother Josh → deterministic or llm capture',
      'source' in decision ? decision.source : null,
      v => v === 'llm' || v === 'deterministic',
      'llm or deterministic');
  }

  {
    freshDB();
    const decision = await routeIntent('My brother is Josh.', {
      classifyQuery,
      classifyLLM: async () => mockClassify([HOSTILE_FAMILY]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('R2c my brother is Josh → capture', decision.kind,
      v => v === 'capture', 'capture');
  }

  // ── R3: D3 refusal at route seam (tier-3 stub — tier-1 owns most D3-shaped utterances) ──
  {
    freshDB();
    const tier3Default = async () => ({ tier: 3 as const, reason: 'default' });
    const decision = await routeIntent('I called Josh yesterday.', {
      classifyQuery: tier3Default,
      classifyLLM: async () => mockClassify([{ type: 'todo_add', body: 'call Josh' }]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('R3a completed past + todo_add at LLM seam → needs_clarification', decision.kind,
      v => v === 'needs_clarification', 'needs_clarification');
  }

  // ── R4: end-to-end — refused proposal never arms llm confirm ──────────────
  {
    freshDB();
    const session = new ConversationSession();
    const outcome = await processUtterance('My brother Josh called me today.', session, {
      classifyQuery,
      classifyLLM: async () => mockClassify([HOSTILE_FAMILY]),
      llmReady: true,
      captureContext: { contacts: [], lists: [] },
    });
    assert('R4a refused narration → handled false', outcome.handled,
      v => v === false, 'false');
    assert('R4b refused narration → needs_clarification',
      outcome.handled === false ? outcome.routeDecision.kind : null,
      v => v === 'needs_clarification', 'needs_clarification');
    assert('R4c refused narration → no pending confirm', session.hasPending(),
      v => v === false, 'false');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Speech-Act Route: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('speechActAuthorityRoute.test.ts')) {
  runSpeechActAuthorityRouteTests().catch(console.error);
}
