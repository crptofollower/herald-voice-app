// scripts/heraldTest/immediateSemanticRecapDiagnostics.test.ts
// Device acceptance gate (2026-09-xx): HERALD_IMMEDIATE_RECAP_DIAG proof.
// Observability only — this file proves the diagnostic event (a) fires for
// every code path, (b) never changes what answerImmediateSemanticRecap
// actually returns, and (c) never logs a raw resolverKey value or anything
// beyond the bounded focus contract already present in the ledger.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';

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

function rec(overrides: Partial<ConversationTurnRecord> & { focus: ConversationTurnRecord['focus'] }): ConversationTurnRecord {
  return {
    turnIndex: 1,
    establishedAt: Date.now(),
    utterance: 'x',
    intentType: null,
    operation: 'capture',
    outcome: 'committed',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    ...overrides,
  };
}

/** Captures console.warn calls matching the diag prefix during `fn`, restores
 *  console.warn unconditionally afterward (even on throw). */
async function captureDiagEvents<T>(fn: () => Promise<T>): Promise<{ result: T; events: any[]; rawLines: string[] }> {
  const original = console.warn;
  const rawLines: string[] = [];
  console.warn = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(' ');
    rawLines.push(line);
  };
  try {
    const result = await fn();
    const events = rawLines
      .filter((l) => l.startsWith('HERALD_IMMEDIATE_RECAP_DIAG '))
      .map((l) => JSON.parse(l.slice('HERALD_IMMEDIATE_RECAP_DIAG '.length)));
    return { result, events, rawLines };
  } finally {
    console.warn = original;
  }
}

export async function runImmediateSemanticRecapDiagnosticsTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      const orig = console.log;
      orig(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  console.log(`\n${BOLD}-- Diagnostic reachability: exactly one event per call --${RESET}`);
  {
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const { events } = await captureDiagEvents(() => answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [commit] }));
    assert('exactly one HERALD_IMMEDIATE_RECAP_DIAG event per invocation', events.length, 1);
    assertTrue('event marks invoked:true', events[0]?.invoked === true);
  }

  console.log(`\n${BOLD}-- Behavior unchanged: outcome identical with diagnostics observed --${RESET}`);
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I started taking lisinopril 10 milligrams every morning.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);
    const { result, events } = await captureDiagEvents(() =>
      answerImmediateSemanticRecap("What did I just tell you I'm taking?", { ledgerEntries: ledger.peek(Date.now()) }),
    );
    assertTrue('BEHAVIOR-UNCHANGED: outcome handled', result.handled === true);
    assert('BEHAVIOR-UNCHANGED: outcome kind matches pre-instrumentation expectation', result.handled ? result.kind : null, 'authoritative_reread');
    assertTrue('BEHAVIOR-UNCHANGED: reply names the real medication', result.handled && result.reply.toLowerCase().includes('lisinopril'));
    assert('diag event agrees: finalResult matches actual outcome', events[0]?.finalResult, 'answered_authoritative');
    assert('diag event: stageAMatched true (seen wording)', events[0]?.stageAMatched, true);
    assert('diag event: adapterFound true', events[0]?.adapterFound, true);
    assert('diag event: rereadOutcome success', events[0]?.rereadOutcome, 'success');
    void db;
  }

  console.log(`\n${BOLD}-- No raw resolverKey ever logged (bounded focus fields only) --${RESET}`);
  {
    const SECRET_RESOLVER_KEY = 'med_super_secret_row_id_123456';
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: SECRET_RESOLVER_KEY, referable: true, tier: 'authoritative' }] });
    const { rawLines } = await captureDiagEvents(() => answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [commit] }));
    const fullLog = rawLines.join('\n');
    assertTrue('PRIVACY: raw resolverKey value never appears in any logged line', !fullLog.includes(SECRET_RESOLVER_KEY));
    const diagLine = rawLines.find((l) => l.startsWith('HERALD_IMMEDIATE_RECAP_DIAG '))!;
    const event = JSON.parse(diagLine.slice('HERALD_IMMEDIATE_RECAP_DIAG '.length));
    assertTrue('PRIVACY: candidate carries hasResolverKey boolean, not the value', event.candidates[0]?.hasResolverKey === true && !('resolverKey' in event.candidates[0]));
  }

  console.log(`\n${BOLD}-- Bounded text: long utterance/displayValue truncated in the log --${RESET}`);
  {
    const longDisplay = 'x'.repeat(500);
    const commit = rec({ focus: [{ kind: 'thing', displayValue: longDisplay, referable: true, tier: 'conversational' }] });
    const longUtterance = 'What did I just tell you? ' + 'y'.repeat(500);
    const { events } = await captureDiagEvents(() => answerImmediateSemanticRecap(longUtterance, { ledgerEntries: [commit] }));
    assertTrue('BOUNDED: logged utteranceNormalized is truncated, not the full 500+ chars', events[0]?.utteranceNormalized.length <= 200);
    assertTrue('BOUNDED: logged candidate displayValue is truncated, not the full 500 chars', events[0]?.candidates[0]?.displayValue.length <= 100);
  }

  console.log(`\n${BOLD}-- Coverage: representative paths each produce an accurate event --${RESET}`);
  {
    // Stage A matched, zero candidates.
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [] }));
    assert('no-candidate path: finalResult', events[0]?.finalResult, 'no_candidate');
    assert('no-candidate path: candidateCount', events[0]?.candidateCount, 0);
    assertTrue('no-candidate path: outcome unaffected (still honest miss)', result.handled === true && result.kind === 'honest_miss');
  }
  {
    // Stage A matched, ambiguous (2 distinct candidates).
    const a = rec({ turnIndex: 1, establishedAt: 1000, focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const b = rec({ turnIndex: 2, establishedAt: 2000, focus: [{ kind: 'thing', displayValue: 'metformin', resolverKey: 'med_2', referable: true, tier: 'authoritative' }] });
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [a, b] }));
    assert('ambiguous path: finalResult', events[0]?.finalResult, 'clarify_ambiguous');
    assert('ambiguous path: candidateCount', events[0]?.candidateCount, 2);
    assertTrue('ambiguous path: outcome unaffected (still clarify)', result.handled === true && result.kind === 'clarify_ambiguous');
  }
  {
    // Stage A did NOT match, no interpreter context → not-recap, stageB not_invoked.
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'authoritative', resolverKey: 'med_1' }] });
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('How is the weather today?', { ledgerEntries: [commit] }));
    assertTrue('not-recap path: outcome unaffected (not handled)', result.handled === false);
    assert('not-recap path: stageAMatched false', events[0]?.stageAMatched, false);
    assert('not-recap path: finalResult', events[0]?.finalResult, 'not_recap');
  }
  {
    // Stage A did NOT match; getInterpreterCtx exists as a function but
    // returns null when called (a real ctx-not-ready device state) →
    // generateRecapInterpretationProposal itself reports 'unavailable'.
    // Distinct from deps.getInterpreterCtx being absent entirely (covered
    // by the earlier "not-recap path" case above, which logs
    // 'no_interpreter_context' precisely because the function itself was
    // never supplied).
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'authoritative', resolverKey: 'med_1' }] });
    const { events } = await captureDiagEvents(() => answerImmediateSemanticRecap('Which medicine was I talking about?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => null,
    }));
    assert('ctx-returns-null path: stageB status', events[0]?.stageB?.status, 'unavailable');
  }
  {
    // Stage B invoked and confidently selects → authoritative reread, but adapter reports stale (deactivated).
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Lisinopril 10 mg.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);
    db.prepare(`UPDATE medications SET removed_at = ? WHERE name = 'Lisinopril'`).run(new Date().toISOString());
    const mockCtx = { completion: async () => ({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.9}' }) } as any;
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('Which medicine was I talking about?', {
      ledgerEntries: ledger.peek(Date.now()),
      getInterpreterCtx: () => mockCtx,
    }));
    assert('stale-reference path: finalResult', events[0]?.finalResult, 'stale_reference_miss');
    assert('stale-reference path: rereadOutcome', events[0]?.rereadOutcome, 'stale_miss');
    assert('stale-reference path: adapterFound true (adapter existed, row just gone)', events[0]?.adapterFound, true);
    assertTrue('stale-reference path: outcome unaffected (still honest miss reply)', result.handled === true && result.kind === 'honest_miss');
    assert('stale-reference path: stageB status ok with selection', events[0]?.stageB?.status, 'ok');
    assert('stale-reference path: stageB selectedIndex', events[0]?.stageB?.selectedIndex, 0);
  }
  {
    // Stage B invoked, low confidence → not recap.
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', referable: true, tier: 'authoritative', resolverKey: 'med_1' }] });
    const mockCtx = { completion: async () => ({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.1}' }) } as any;
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('What was that thing I said?', {
      ledgerEntries: [commit],
      getInterpreterCtx: () => mockCtx,
    }));
    assertTrue('low-confidence path: outcome unaffected (not handled)', result.handled === false);
    assert('low-confidence path: stageB confidence logged', events[0]?.stageB?.confidence, 0.1);
    assert('low-confidence path: finalResult', events[0]?.finalResult, 'not_recap');
  }
  {
    // Capability gap: authoritative tier, resolverKey present, but no adapter registered for this intentType.
    const commit = rec({ intentType: 'no_such_domain', focus: [{ kind: 'thing', displayValue: 'Something', resolverKey: 'x_1', referable: true, tier: 'authoritative' }] });
    const { result, events } = await captureDiagEvents(() => answerImmediateSemanticRecap('What did I just tell you?', { ledgerEntries: [commit] }));
    assert('capability-gap path: finalResult', events[0]?.finalResult, 'capability_gap');
    assert('capability-gap path: adapterFound false', events[0]?.adapterFound, false);
    assertTrue('capability-gap path: outcome unaffected', result.handled === true && result.kind === 'capability_gap');
  }

  console.log(`\n${BOLD}-- Source-lock: diagnostics are additive-only, never gate control flow --${RESET}`);
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/immediateSemanticRecap.ts');
    const src = fs.readFileSync(modulePath, 'utf8');
    // The diagnostic sink must never be read inside a condition that could
    // change behavior — only ever written to (`diagSink.x = ...`), never
    // branched on (`if (diagSink...)` other than the existence check
    // `if (diagSink)` which guards the WRITE itself, not a decision).
    assertTrue('source-lock: no branch reads a diagSink field (only guards the write)', !/if \(diagSink\.\w+/.test(src));
    assertTrue('source-lock: emitDiag return value is never used (void side effect)', !/=\s*emitDiag\(/.test(src) && !/return\s+emitDiag\(/.test(src));
    assertTrue('source-lock: logImmediateRecapDiag return value is never used', !/=\s*logImmediateRecapDiag\(/.test(src));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ImmediateSemanticRecapDiagnostics: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('immediateSemanticRecapDiagnostics.test.ts')) {
  runImmediateSemanticRecapDiagnosticsTests().catch(console.error);
}
