// scripts/heraldTest/passFilter.test.ts
// Foundation fix contract — 2026-08-05 hybrid session.
//
// Locks the routeIntent.ts pass-filter: the classifier's own honest
// "unclear / none of the above" signal ({type:'pass'}) must never be
// treated as a capture instruction. A pass-only LLM result must become
// needs_clarification; a mixed [validIntent, pass] result must keep only
// the valid intent. See routeIntent.ts:1704 (the filter) and
// processUtterance.ts:93 (allConverted — why an unfiltered 'pass' used to
// masquerade as 'capture' and dead-end in ChatScreen's legacy
// dispatchLocalIntent default case instead of the honest needs_clarification
// tail).
//
// HARNESS LIMIT (explicit, per session directive): ChatScreen.tsx's second,
// redundant classifyWithLLM call (ChatScreen.tsx:1300-1312) lives inside a
// React component with a live llama.rn context — it is not reachable from
// this headless tsx harness. What IS provable here: routeIntent's OWN
// internal classifyLLM call happens exactly once per routeIntent() call,
// both before and after this fix (F5) — and, by the kind:'needs_clarification'
// assertions below (F1/F2/F4), that ChatScreen's early-return at
// ChatScreen.tsx:1268 fires before the code path containing the second call
// is ever reached. The second-call *elimination* itself is a code-trace
// proof (session transcript), not a harness-executable one.
//
// Runner: npx tsx scripts/heraldTest/passFilter.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import type { ClassifyOutcome } from '../../src/hooks/llmLayers.ts';

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

// A nonsense utterance guaranteed to miss every tier-1 signal, every
// deterministic capturer, and every TIER2/TIER3 signal — reaches the LLM
// tier-3 fallback branch in routeIntent, same as an ordinary chit-chat
// phrase would before the UX fix existed.
const NONSENSE = 'purple elephant hovercraft nonsense';

export async function runPassFilterTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }

  console.log(`\n${BOLD}-- Pass-Filter Contract Tests (routeIntent.ts:1704) --------${RESET}\n`);

  // ── F1: pass-only LLM result → needs_clarification, not capture ──
  {
    freshDB();
    const decision = await routeIntent(NONSENSE, {
      classifyQuery,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] } as ClassifyOutcome),
      llmReady: true,
    });
    assert('F1a pass-only → kind is needs_clarification', decision.kind,
      (v) => v === 'needs_clarification', 'needs_clarification');
    assert('F1b pass-only → kind is NOT capture', decision.kind,
      (v) => v !== 'capture', 'not capture');
  }

  // ── F2: pass-only → reason carries the classifier's own honest tier-3
  // default reason (not silently rewritten), proving no invented content ──
  {
    freshDB();
    const decision = await routeIntent(NONSENSE, {
      classifyQuery,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] } as ClassifyOutcome),
      llmReady: true,
    });
    assert('F2 pass-only → reason is the honest tier-3 default', decision.reason,
      (v) => v === 'default', 'default');
  }

  // ── F3: mixed [validIntent, pass] → only the valid intent survives ──
  {
    freshDB();
    const decision = await routeIntent(NONSENSE, {
      classifyQuery,
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'todo_add', body: 'call the dentist' }, { type: 'pass' }],
      } as ClassifyOutcome),
      llmReady: true,
    });
    assert('F3a mixed output → kind is capture', decision.kind,
      (v) => v === 'capture', 'capture');
    assert('F3b mixed output → exactly one surviving intent', 'intents' in decision ? decision.intents.length : -1,
      (v) => v === 1, '1');
    assert('F3c mixed output → surviving intent is the valid one, untouched', 'intents' in decision ? decision.intents[0] : null,
      (v) => !!v && (v as any).type === 'todo_add' && (v as any).body === 'call the dentist',
      "{type:'todo_add', body:'call the dentist'}");
  }

  // ── F4: processUtterance end-to-end — pass-only never reaches the commit
  // loop (never reaches a DOMAIN_WRITER, i.e. never reaches dispatch) ──
  {
    freshDB();
    const session = new ConversationSession();
    const outcome = await processUtterance(NONSENSE, session, {
      classifyQuery,
      classifyLLM: async () => ({ status: 'ok', intents: [{ type: 'pass' }] } as ClassifyOutcome),
      llmReady: true,
    });
    assert('F4a pass-only end-to-end → handled is false (never entered commit loop)', outcome.handled,
      (v) => v === false, 'false');
    assert('F4b pass-only end-to-end → routeDecision.kind is needs_clarification',
      outcome.handled === false ? outcome.routeDecision.kind : null,
      (v) => v === 'needs_clarification', 'needs_clarification');
    assert('F4c pass-only end-to-end → no pending state armed', session.hasPending(),
      (v) => v === false, 'false');
  }

  // ── F5: routeIntent's own classifyLLM call happens exactly once per call
  // (harness-provable half of the "no second call" requirement — see file
  // header for what this does and does not prove) ──
  {
    freshDB();
    let callCount = 0;
    const session = new ConversationSession();
    await processUtterance(NONSENSE, session, {
      classifyQuery,
      classifyLLM: async () => { callCount += 1; return { status: 'ok', intents: [{ type: 'pass' }] } as ClassifyOutcome; },
      llmReady: true,
    });
    assert('F5 routeIntent invokes classifyLLM exactly once per utterance', callCount,
      (v) => v === 1, '1');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Pass-Filter: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('passFilter.test.ts')) {
  runPassFilterTests().catch(console.error);
}
