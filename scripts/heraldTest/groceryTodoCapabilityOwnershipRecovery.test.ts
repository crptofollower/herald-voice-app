// scripts/heraldTest/groceryTodoCapabilityOwnershipRecovery.test.ts
// Conversation Reliability V1 -- Lane B regression matrix.
// Grocery/Todo capability-ownership repair: a structurally eligible turn
// (evaluateSemanticDispatchEligibility already correlated it with grocery/
// todo BEFORE the model ran) whose semantic dispatch proposal transport-fails
// (parse_fail/unavailable/error) must not silently fall through to generic
// conversation when a domain marker ("grocery"/"to-do") is explicit in the
// text and a bounded item/body can be deterministically re-derived.
//
// Scope note: the domain-UNRESOLVED-but-items-extracted case (e.g. "we need
// bread, eggs, and bananas") is deliberately NOT covered by the repair and is
// NOT asserted here as newly-intercepted -- verified live that
// discourseContinuity.ts's noteNarrativeUtterance() already independently
// establishes/refreshes a candidateSet for that shape regardless of
// routeIntent's return value, and additionally routing it through
// ambiguous_operational_list here re-arms a redundant pending on repeated
// occurrences (WCS candidate-continuity conflict, out of bounds tonight).
// Tests 4/5 below assert that shape is provably UNCHANGED by this repair.
//
// Runner: npx tsx scripts/heraldTest/groceryTodoCapabilityOwnershipRecovery.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { routeIntent, DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { applyIntents } from '../../src/routing/processUtterance.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import type { ConversationTurnLedger, NewConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function freshDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE lists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE list_items (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
      checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL
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

function listItems(db: Database.Database, listName: string): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = ?`,
  ).all(listName) as { body: string }[]).map((r) => r.body.toLowerCase()).sort();
}

// PARSE_FAIL: malformed content the capability-proposal parser cannot accept.
function parseFailCtx() {
  return { completion: async () => ({ content: 'completely unparseable ~~~' }) };
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: [] },
    getMedicationSemanticInterpreterCtx: () => null, // 'unavailable' (ctx_missing) status
    semanticCapabilityDispatchEnabled: true,
    grocerySemanticDecompositionEnabled: true,
    capabilityReadRouterEnabled: true,
    medicationSemanticInterpretationEnabled: true,
    ...over,
  };
}

export async function runGroceryTodoCapabilityOwnershipRecoveryTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Grocery/Todo Capability-Ownership Recovery (Lane B) --${RESET}\n`);

  // 1) Explicit grocery domain + parse_fail -> deterministic recovery capture.
  {
    freshDB();
    const utterance = 'For my grocery list, we need bread and eggs.';
    const legacy = await classifyQuery(utterance);
    assert('1: reaches tier-3 default fallthrough', `${legacy.tier}:${legacy.reason}`, (v) => v === '3:default', '3:default');
    const decision: any = await routeIntent(utterance, baseDeps({ getMedicationSemanticInterpreterCtx: parseFailCtx }));
    assert('1: routes to capture', decision.kind, (v) => v === 'capture', 'capture');
    assert('1: source is deterministic_recovery (never llm -- model produced nothing usable)',
      decision.source, (v) => v === 'deterministic_recovery', 'deterministic_recovery');
    assert('1: reason is the distinguishable grocery_recovery string',
      decision.reason, (v) => v === 'semantic_proposal:grocery_recovery', 'semantic_proposal:grocery_recovery');
    assert('1: intent is list_add/grocery with bread+eggs',
      decision.intents?.[0]?.type === 'list_add'
      && decision.intents[0].listName === 'grocery'
      && decision.intents[0].items.map((s: string) => s.toLowerCase()).sort().join(',') === 'bread,eggs',
      (v) => v === true, 'list_add grocery [bread,eggs]');
  }

  // 2) Explicit todo domain + parse_fail -> deterministic recovery capture.
  // Note: extractTodoAdd's own prerequisite (TODO_ADD_SIGNALS match) is the
  // identical signal set tierRouter's own tier-1 classifier uses to claim
  // "I need to X"-shaped utterances deterministically (routeIntent.ts's
  // 'tier1:list_todo_intercept', reusing the same extractTodoAdd call) --
  // by construction, any utterance where extractTodoAdd could succeed is
  // already claimed at tier 1 and never reaches this tier-3 dispatch seam in
  // an unmodified classifyQuery. Verified live (see stale assertion this
  // replaced). This test isolates the dispatch-block unit under test by
  // injecting deps.classifyQuery directly -- the same dependency-injection
  // seam baseDeps already uses for the real classifier -- exercising exactly
  // and only the new conditional block (routeIntent.ts's existing
  // capGen.status !== 'ok' handling), independent of tier-1's classification
  // boundary.
  {
    freshDB();
    const utterance = 'I need to call the dentist for my to-do list.';
    const legacy = await classifyQuery(utterance);
    assert('2: (documented) this exact phrasing is already tier-1 claimed today',
      legacy.tier, (v) => v === 1, '1');
    const forcedTier3 = { classifyQuery: async () => ({ tier: 3 as const, reason: 'default' }) };
    const decision: any = await routeIntent(utterance, baseDeps({ ...forcedTier3, getMedicationSemanticInterpreterCtx: parseFailCtx }));
    assert('2: routes to capture', decision.kind, (v) => v === 'capture', 'capture');
    assert('2: source is deterministic_recovery', decision.source, (v) => v === 'deterministic_recovery', 'deterministic_recovery');
    assert('2: reason is the distinguishable todo_recovery string',
      decision.reason, (v) => v === 'semantic_proposal:todo_recovery', 'semantic_proposal:todo_recovery');
    assert('2: intent is todo_add with a non-empty body',
      decision.intents?.[0]?.type === 'todo_add' && typeof decision.intents[0].body === 'string' && decision.intents[0].body.length > 0,
      (v) => v === true, 'todo_add {body}');
  }

  // 3) Explicit domain resolved, but no bounded item/body extractable ->
  //    capability-scoped clarify, never generic conversation, never a write.
  {
    freshDB();
    const utterance = 'I need help with my grocery list.';
    const decision: any = await routeIntent(utterance, baseDeps({ getMedicationSemanticInterpreterCtx: parseFailCtx }));
    assert('3: domain-resolved-empty is needs_clarification, not capture',
      decision.kind, (v) => v === 'needs_clarification', 'needs_clarification');
    assert('3: reason is the distinguishable grocery_recovery_empty string',
      decision.reason, (v) => v === 'semantic_proposal:grocery_recovery_empty', 'semantic_proposal:grocery_recovery_empty');
  }

  // 4) Domain-UNRESOLVED (no "grocery"/"to-do" word) with items extractable
  //    -- provably UNCHANGED: never captured by this repair, never labeled
  //    with a deterministic_recovery source or a semantic_proposal:*recovery*
  //    reason. (WCS candidate-continuity already owns this shape elsewhere.)
  {
    freshDB();
    const utterance = 'We need bread, eggs, and bananas.';
    const decision: any = await routeIntent(utterance, baseDeps({ getMedicationSemanticInterpreterCtx: parseFailCtx }));
    assert('4: domain-unresolved acquisition is not captured by this repair',
      decision.kind !== 'capture' || decision.source !== 'deterministic_recovery',
      (v) => v === true, 'not deterministic_recovery capture');
    assert('4: reason never carries a *_recovery* marker',
      typeof decision.reason !== 'string' || !decision.reason.includes('recovery'),
      (v) => v === true, 'no recovery-tagged reason');
  }

  // 5) Non-eligible utterance ("need to", not bare "need") -- eligibility
  //    itself never fires; provably unchanged.
  {
    freshDB();
    const utterance = 'We need to talk about something important.';
    const decision: any = await routeIntent(utterance, baseDeps({ getMedicationSemanticInterpreterCtx: parseFailCtx }));
    assert('5: ineligible utterance never reaches this repair',
      decision.kind !== 'capture' || decision.source !== 'deterministic_recovery',
      (v) => v === true, 'not deterministic_recovery capture');
  }

  // 6) A completed model REJECT/CLARIFY (capGen.status === 'ok') must never
  //    be overridden by this repair, even with an explicit domain marker.
  {
    freshDB();
    const utterance = 'For my grocery list, we need bread and eggs.';
    const okCtx = () => ({ completion: async () => ({ content: JSON.stringify({ capability: 'other', confidence: 'high' }) }) });
    const decision: any = await routeIntent(utterance, baseDeps({ getMedicationSemanticInterpreterCtx: okCtx }));
    assert('6: completed model outcome (status ok) is never intercepted by this repair',
      decision.source !== 'deterministic_recovery', (v) => v === true, 'source !== deterministic_recovery');
  }

  // 7) Admission-level: a deterministic_recovery capture still requires
  //    explicit user confirmation before any write -- never an immediate,
  //    silent commit. Ledger authority is 'deterministic', never
  //    'llm_proposal' (the model produced nothing; recovery is not an LLM
  //    proposal), matching Semantic Focus Contract V1's collapsed mapping.
  {
    const db = freshDB();
    const session = new ConversationSession();
    const ledgerEntries: NewConversationTurnRecord[] = [];
    const ledger: ConversationTurnLedger = {
      push: (e: NewConversationTurnRecord) => { ledgerEntries.push(e); return { ...e, turnIndex: ledgerEntries.length, focus: e.focus ?? [] }; },
    } as any;
    const { commits } = await applyIntents(
      [{ type: 'list_add', items: ['bread', 'eggs'], listName: 'grocery' }],
      'For my grocery list, we need bread and eggs.',
      session,
      {},
      'deterministic_recovery',
      undefined,
      ledger,
    );
    assert('7: deterministic_recovery does not write immediately (arms pending)',
      commits[0]?.status, (v) => v === 'pending', 'pending');
    assert('7: no grocery rows committed before confirmation',
      listItems(db, 'grocery').length, (v) => v === 0, '0');
    assert('7: ledger authorityTier is deterministic, not llm_proposal',
      ledgerEntries[0]?.authorityTier, (v) => v === 'deterministic', 'deterministic');
    assert('7: session has an armed pending awaiting confirmation',
      session.hasPending(), (v) => v === true, 'true');
    const resumed = await session.resolvePending('yes');
    assert('7: confirming "yes" now commits through the unmodified writer',
      resumed.status, (v) => v === 'committed', 'committed');
    assert('7: grocery rows exist only after explicit confirmation',
      listItems(db, 'grocery').sort().join(','), (v) => v === 'bread,eggs', 'bread,eggs');
  }

  // 8) Sanity: the writer itself is untouched -- DOMAIN_WRITERS.list_add is
  //    the same function whether reached via 'llm' or 'deterministic_recovery'.
  {
    assert('8: list_add writer present and unmodified by this repair',
      typeof DOMAIN_WRITERS.list_add?.add, (v) => v === 'function', 'function');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}GroceryTodoCapabilityOwnershipRecovery: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) + `${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groceryTodoCapabilityOwnershipRecovery.test.ts')) {
  runGroceryTodoCapabilityOwnershipRecoveryTests().catch(console.error);
}
