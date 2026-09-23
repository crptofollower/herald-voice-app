// scripts/heraldTest/conversationTurnLedgerCoverage.test.ts
// Conversation Continuity Contract V1 — Slice 2 coverage contract, trust
// contract, and required representative-outcome test cases.
//
// Three kinds of evidence, each doing a different job:
//  1. Real integration tests (real better-sqlite3 DB, real ConversationSession,
//     real applyIntents/processUtterance) for every outcome reachable without
//     a React runtime: medical_capture propose+confirm, list_add commit,
//     todo_add commit, TTL/eviction.
//  2. A data-driven coverage-contract test asserting every RouteDecision['kind']
//     has an explicit, named ledger policy (record or exemption) — this is
//     the exact test that would have caught the 2026-09-08 diagnostic's
//     failure class (a route outcome silently gaining no continuity write).
//  3. Source-lock tests (reading the real ChatScreen.tsx/processUtterance.ts
//     text, same technique hotNarrativeRing.test.ts already uses for its own
//     SEAM/EVIDENCE assertions) for the hooks that live in React component
//     code and cannot be driven by a plain script: device_read, device_action,
//     clarify_request, and conversational/ephemeral acceptance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { ROUTE_OUTCOME_LEDGER_POLICY } from '../../src/routing/conversationTurnLedgerWrite.ts';
import type { RouteDecision } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT,
    is_active INTEGER DEFAULT 1, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT,
    status TEXT DEFAULT 'noted', surfaced_at TEXT, visit_outcome TEXT,
    outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists(id)
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };
  return { db, session, deps };
}

export async function runConversationTurnLedgerCoverageTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — Slice 2 required outcome cases (real DB) --${RESET}`);

  // ── Medication capture (propose, LLM-sourced, confirm-gated) + commit ──
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const t1 = await processUtterance('I take Eliquis 5 mg twice a day.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('med capture: turn 1 handled as capture (pending)', t1.handled === true && t1.source === 'capture');
    const afterT1 = ledger.peek(Date.now());
    assert('med capture: turn 1 pushed exactly one record', afterT1.length, 1);
    assert('med capture: turn 1 record is capture/pending', [afterT1[0]?.operation, afterT1[0]?.outcome], ['capture', 'pending']);
    assert('med capture: turn 1 intentType is the raw IntentRecord type', afterT1[0]?.intentType, 'medical_capture');
    // Tier-1 deterministic regex match wins for this phrasing (confirmed by
    // the actual classifyQuery trace) — capture source is 'deterministic',
    // not 'llm'. This is a corrected test expectation, not a code change.
    assert('med capture: turn 1 authorityTier reflects the actual (deterministic) capture source', afterT1[0]?.authorityTier, 'deterministic');
    // Semantic Focus Contract V1 — Slice 3/4 (superseded this Slice-2-era
    // expectation): medical_capture now populates focus generically via
    // the writer + glue layer. Full dedicated proof lives in
    // conversationTurnLedgerFocus.test.ts; this assertion is updated only
    // so this file's own record stays accurate, not duplicated in depth.
    assert('med capture: turn 1 focus now populated (proposal-tier) — see conversationTurnLedgerFocus.test.ts for full proof', afterT1[0]?.focus[0]?.tier, 'deterministic_unconfirmed');

    const t2 = await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('med capture: turn 2 handled as pending_resume', t2.handled === true && t2.source === 'pending_resume');
    const afterT2 = ledger.peek(Date.now());
    assert('med capture: exactly two records total (no double-count across the two turns)', afterT2.length, 2);
    assert('med capture: turn 2 record is capture/committed', [afterT2[1]?.operation, afterT2[1]?.outcome], ['capture', 'committed']);
    assert('med capture: turn 2 intentType honestly null (original IntentRecord not available at resolvePending)', afterT2[1]?.intentType, null);
    assertTrue('med capture: turn 2 turnIndex strictly greater than turn 1 (ledger monotonic sequence)', afterT2[1]!.turnIndex > afterT2[0]!.turnIndex);
  }

  // ── Grocery / list_add commit (deterministic, immediate) ───────────────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
      'add milk and eggs to my grocery list',
      session,
      undefined,
      'deterministic',
      undefined,
      ledger,
    );
    assertTrue('grocery: commit actually committed against the real DB', commits[0]?.status === 'committed');
    const rec = ledger.peek(Date.now());
    assert('grocery: exactly one record pushed', rec.length, 1);
    assert('grocery: record is capture/committed', [rec[0]?.operation, rec[0]?.outcome], ['capture', 'committed']);
    assert('grocery: intentType is the raw passthrough "list_add"', rec[0]?.intentType, 'list_add');
    assert('grocery: authorityTier deterministic', rec[0]?.authorityTier, 'deterministic');
  }

  // ── To-do / todo_add commit (deterministic, immediate) ──────────────────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'todo_add', body: 'call the dentist' }],
      'remind me to call the dentist',
      session,
      undefined,
      'deterministic',
      undefined,
      ledger,
    );
    assertTrue('todo: commit actually committed against the real DB', commits[0]?.status === 'committed');
    const rec = ledger.peek(Date.now());
    assert('todo: exactly one record pushed', rec.length, 1);
    assert('todo: record is capture/committed', [rec[0]?.operation, rec[0]?.outcome], ['capture', 'committed']);
    assert('todo: intentType is the raw passthrough "todo_add"', rec[0]?.intentType, 'todo_add');
  }

  // ── Declined confirm does not fabricate a "committed" record ────────────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Metformin 500 mg.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('No.', session, deps, null, null, null, null, null, null, ledger);
    const rec = ledger.peek(Date.now());
    assert('decline: two records (propose + decline), neither committed', rec.map((r) => r.outcome), ['pending', 'declined']);
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — TTL/eviction under real turn cadence --${RESET}`);
  // ── TTL/eviction proven against the same ledger instance across many
  // real turns (not just synthetic pushes — see conversationTurnLedger.test.ts
  // for the isolated-module version of this proof) ───────────────────────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    // Uses list_add (not todo_add) deliberately: todo_add's writer generates
    // item ids from Date.now() alone (routeIntent.ts), which can collide
    // across rapid successive calls in a tight test loop — a pre-existing
    // writer characteristic, not something this slice touches or should
    // paper over. list_add's writer includes a random suffix and does not
    // collide, and proves the same ledger-accumulation behavior.
    for (let i = 0; i < 3; i++) {
      await applyIntents(
        [{ type: 'list_add', items: [`item-${i}`], listName: 'grocery' }],
        `add item ${i} to my grocery list`,
        session, undefined, 'deterministic', undefined, ledger,
      );
    }
    assert('real-turn TTL: three real commits produce three records', ledger.peek(Date.now()).length, 3);
    ledger.clear();
    assert('real-turn TTL: clear empties the ledger built from real turns', ledger.peek(Date.now()).length, 0);
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — coverage contract --${RESET}`);

  // ── Every RouteDecision.kind must have an explicit, named policy ───────
  // This list is the RouteDecision['kind'] union as of this slice (routeIntent.ts).
  // A future kind added to that union without a corresponding
  // ROUTE_OUTCOME_LEDGER_POLICY entry must fail this test — that is the
  // exact 2026-09-08 failure class (a meaningful outcome silently gaining
  // no continuity write) this contract exists to prevent.
  const KNOWN_ROUTE_DECISION_KINDS: RouteDecision['kind'][] = [
    'device_read', 'device_action', 'capture', 'interpretation_hold', 'phone_repair_needed',
    'medical_read_pending', 'not_ready', 'memory_probe', 'backend', 'needs_clarification',
  ];
  for (const kind of KNOWN_ROUTE_DECISION_KINDS) {
    assertTrue(`coverage: RouteDecision.kind '${kind}' has an explicit ledger policy entry`, kind in ROUTE_OUTCOME_LEDGER_POLICY);
  }
  assert(
    'coverage: policy table has no extra/stale kinds beyond the known union',
    Object.keys(ROUTE_OUTCOME_LEDGER_POLICY).sort(),
    [...KNOWN_ROUTE_DECISION_KINDS].sort(),
  );
  // Cross-check against the ACTUAL production union via source text, so a
  // kind added to RouteDecision in routeIntent.ts without updating this
  // test's KNOWN_ROUTE_DECISION_KINDS list is itself caught (belt + suspenders).
  {
    const routeIntentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/routeIntent.ts');
    const src = fs.readFileSync(routeIntentPath, 'utf8');
    const unionBlock = src.match(/export type RouteDecision =\s*([\s\S]*?)\n\n/)?.[1] ?? '';
    const kindsInSource = [...unionBlock.matchAll(/kind:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assertTrue('coverage: at least the known kinds are present in routeIntent.ts source (source-lock)', KNOWN_ROUTE_DECISION_KINDS.every((k) => kindsInSource.includes(k)));
    assert('coverage: routeIntent.ts source declares exactly the known kinds (no drift)', [...kindsInSource].sort(), [...KNOWN_ROUTE_DECISION_KINDS].sort());
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — trust contract --${RESET}`);

  // ── Ledger cannot itself commit / has no write authority ───────────────
  {
    const ledgerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/conversationTurnLedger.ts');
    const writePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/conversationTurnLedgerWrite.ts');
    const ledgerSrc = fs.readFileSync(ledgerPath, 'utf8');
    const writeSrc = fs.readFileSync(writePath, 'utf8');
    assertTrue('trust: ledger module never imports a DB module', !/from ['"]\.\.\/db\//.test(ledgerSrc));
    assertTrue('trust: ledger module never imports ConversationSession (pending state stays separate)', !ledgerSrc.includes('conversationSession'));
    assertTrue('trust: write-policy module never imports a DB module', !/from ['"]\.\.\/db\//.test(writeSrc));
    assertTrue('trust: write-policy module never imports ConversationSession (pending state stays separate)', !writeSrc.includes('conversationSession'));
    assertTrue('trust: write-policy module never calls a DOMAIN_WRITERS writer directly', !writeSrc.includes('.add('));
  }

  // ── Pending deterministic state remains separate (Law 2 unaffected) ────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Metformin 500 mg.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('trust: session still owns the pending slot, not the ledger', session.hasPending());
    assertTrue('trust: ledger exposes no pending-slot API of its own', !('hasPending' in ledger) && !('setPending' in ledger));
  }

  // ── Existing holder behavior unchanged — proven two ways ────────────────
  // (a) source-lock: this slice never edited these files at all.
  // (b) the full existing 4306-test suite (run.mjs) passes unchanged with
  //     this slice's edits in place — see session report; not re-asserted
  //     here to avoid duplicating that suite's own ~90 files of coverage.
  {
    const untouchedFiles = [
      '../../src/utils/hotNarrativeRing.ts',
      '../../src/routing/discourseContinuity.ts',
      '../../src/routing/conversationalSubject.ts',
      '../../src/routing/medicationPresentation.ts',
      '../../src/routing/orderedPresentation.ts',
      '../../src/routing/calendarPresentation.ts',
    ];
    for (const rel of untouchedFiles) {
      const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel);
      assertTrue(`existing holder untouched: ${rel} still has no reference to conversationTurnLedger`, !fs.readFileSync(p, 'utf8').includes('conversationTurnLedger'));
    }
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — ChatScreen.tsx hook source-lock --${RESET}`);
  // Hooks 3/4 live in React component code (device_read, device_action,
  // needs_clarification/ephemeral-seam outcomes) and cannot be driven by a
  // plain script — proven by source-lock, the same technique
  // hotNarrativeRing.test.ts already uses for its own SEAM assertions.
  {
    const chatPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
    const chatSrc = fs.readFileSync(chatPath, 'utf8');

    assertTrue('ChatScreen: ledger ref declared alongside the other continuity holders', /const conversationLedgerRef = useRef<ConversationTurnLedger>\(createConversationTurnLedger\(\)\)/.test(chatSrc));
    assertTrue('ChatScreen: processUtterance call threads the ledger through', /discourseRef\.current, conversationLedgerRef\.current, reminiscenceArcRef\.current, recoveryObligationRef\.current\)/.test(chatSrc));
    assertTrue(
      'ChatScreen: device_read (online tier-1) pushes a read/presented record',
      /noteDeterministicChitChatContext\(rdTier1Response\);\s*\n\s*conversationLedgerRef\.current\.push\(\{\s*\n\s*establishedAt: Date\.now\(\),\s*\n\s*utterance: text,\s*\n\s*intentType: null,\s*\n\s*operation: 'read',\s*\n\s*outcome: 'presented',/.test(chatSrc),
    );
    assertTrue(
      'ChatScreen: device_action pushes an action/presented record',
      /await dispatchAction\(rdActionIntent, text, buildDispatchDeps\(\)\);\s*\n\s*conversationLedgerRef\.current\.push\(\{\s*\n\s*establishedAt: Date\.now\(\),\s*\n\s*utterance: text,\s*\n\s*intentType: rdActionIntent\.type,\s*\n\s*operation: 'action',/.test(chatSrc),
    );
    assertTrue(
      'ChatScreen: needs_clarification (online) pushes a record after the seam resolves, before addMessage',
      /ledgerAuthorityTier = 'deterministic';\s*\n\s*\}\s*\n\s*\}\s*\n\s*conversationLedgerRef\.current\.push\(\{/.test(chatSrc),
    );
    assertTrue(
      'ChatScreen: offline_fallback ephemeral path also pushes a record',
      /offlineReply = seamOutcome\.reply;[\s\S]*?conversationLedgerRef\.current\.push\(\{\s*\n\s*establishedAt: Date\.now\(\),\s*\n\s*utterance: text,\s*\n\s*intentType: null,\s*\n\s*operation: ledgerOperation,/.test(chatSrc),
    );
    assertTrue(
      'ChatScreen: all 5 direct applyIntents call sites thread the ledger through',
      (chatSrc.match(/conversationLedgerRef\.current\)/g) || []).length + (chatSrc.match(/conversationLedgerRef\.current,\s*\n\s*\);/g) || []).length >= 5,
    );
    assertTrue('ChatScreen: emergency clear path untouched (Slice 2 does not wire Law 0)', !/hotRingRef\.current\.clear\(\);\s*\n\s*conversationLedgerRef/.test(chatSrc));
  }

  console.log(`\n${BOLD}-- Conversation Turn Ledger — disclosed gaps (not silently missing) --${RESET}`);
  assertTrue(
    'disclosed gap: clarify_resolution operation is not assigned by any Slice 2 write site (read-side, out of scope)',
    !/operation: 'clarify_resolution'/.test(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx'), 'utf8'))
    && !/operation: 'clarify_resolution'/.test(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/processUtterance.ts'), 'utf8')),
  );
  // (focus is now populated for medical_capture/list_add/todo_add as of
  // Semantic Focus Contract V1 Slice 3/4 — see conversationTurnLedgerFocus.test.ts
  // for that contract's full proof, including the authority-tier guarantee.
  // `committedRef` as a separate top-level field was removed in Slice 3 —
  // the equivalent reference now lives inside each focus entry's
  // `resolverKey`, which is where DomainFocusEnvelope always produces it.)

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationTurnLedgerCoverage: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationTurnLedgerCoverage.test.ts')) {
  runConversationTurnLedgerCoverageTests().catch(console.error);
}
