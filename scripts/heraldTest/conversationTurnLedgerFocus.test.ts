// scripts/heraldTest/conversationTurnLedgerFocus.test.ts
// Semantic Focus Contract V1 — Slice 3 (carrier/schema) + Slice 4 (proof in
// medical_capture / list_add / todo_add only).
//
// ARCHITECTURAL AMENDMENT — AUTHORITY HAS ONE OWNER: a domain never
// supplies its own authority tier. These tests prove that guarantee both
// structurally (DomainFocusEnvelope has no tier field — source-lock) and
// behaviorally (classifyFocusAuthority/buildFocusEntry are the only
// functions that ever construct a `tier`, and they derive it solely from
// commit status + capture source + resolver-key presence).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { classifyFocusAuthority, buildFocusEntry } from '../../src/routing/conversationTurnLedgerWrite.ts';
import type { DomainFocusEnvelope } from '../../src/routing/routeIntent.ts';

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

export async function runConversationTurnLedgerFocusTests() {
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

  console.log(`\n${BOLD}-- Semantic Focus Contract V1 — schema source-lock --${RESET}`);
  {
    const routeIntentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/routeIntent.ts');
    const src = fs.readFileSync(routeIntentPath, 'utf8');
    const envelopeBlock = src.match(/export type DomainFocusEnvelope = \{[\s\S]*?\n\};/)?.[0] ?? '';
    assertTrue('schema: DomainFocusEnvelope block found in source', envelopeBlock.length > 0);
    assertTrue('TRUST-1: DomainFocusEnvelope has NO tier/authority field', !/\btier\b/.test(envelopeBlock) && !/\bauthority\b/i.test(envelopeBlock));
    assertTrue('schema: DomainFocusEnvelope has the 5 expected identity fields', ['kind', 'displayValue', 'resolverKey', 'referable', 'role'].every((f) => envelopeBlock.includes(f)));
  }
  {
    const ledgerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/conversationTurnLedger.ts');
    const src = fs.readFileSync(ledgerPath, 'utf8');
    // Comments may discuss these types by name (documentation); what matters
    // is that the module has no `import` bringing them in — i.e. no actual
    // dependency, only prose explaining the deliberate absence of one.
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    assertTrue('schema: ledger module has no import statement at all (fully standalone)', importLines.trim().length === 0);
  }

  console.log(`\n${BOLD}-- classifyFocusAuthority — the ONE authority-classification function --${RESET}`);
  assert('TRUST-4: committed + NO resolverKey → NOT authoritative (status alone is insufficient)',
    classifyFocusAuthority({ status: 'committed', source: 'deterministic', resolverKey: undefined }), 'deterministic_unconfirmed');
  assert('committed + empty-string resolverKey → NOT authoritative (empty treated as absent)',
    classifyFocusAuthority({ status: 'committed', source: 'llm', resolverKey: '' }), 'llm_proposal');
  assert('committed + real resolverKey → authoritative',
    classifyFocusAuthority({ status: 'committed', source: 'deterministic', resolverKey: 'med_123' }), 'authoritative');
  assert('committed + real resolverKey, source llm → STILL authoritative (status+resolverKey decide, not source)',
    classifyFocusAuthority({ status: 'committed', source: 'llm', resolverKey: 'med_123' }), 'authoritative');
  assert('TRUST-2: pending + source llm + no resolverKey → llm_proposal (never authoritative)',
    classifyFocusAuthority({ status: 'pending', source: 'llm', resolverKey: undefined }), 'llm_proposal');
  assert('TRUST-3: pending + source deterministic + no resolverKey → deterministic_unconfirmed (never authoritative)',
    classifyFocusAuthority({ status: 'pending', source: 'deterministic', resolverKey: undefined }), 'deterministic_unconfirmed');
  assert('pending + resolverKey present but status not committed → still NOT authoritative',
    classifyFocusAuthority({ status: 'pending', source: 'deterministic', resolverKey: 'med_123' }), 'deterministic_unconfirmed');
  assert('failed status → never authoritative regardless of source',
    classifyFocusAuthority({ status: 'failed', source: 'llm', resolverKey: undefined }), 'llm_proposal');
  assert('noop status → never authoritative regardless of source',
    classifyFocusAuthority({ status: 'noop', source: 'deterministic', resolverKey: undefined }), 'deterministic_unconfirmed');

  console.log(`\n${BOLD}-- buildFocusEntry — wraps envelope + facts, cannot be handed a tier --${RESET}`);
  {
    assert('missing-focus stays legal: undefined envelope → []', buildFocusEntry(undefined, { status: 'committed', source: 'deterministic' }), []);
    const envelope: DomainFocusEnvelope = { kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true };
    const built = buildFocusEntry(envelope, { status: 'committed', source: 'deterministic' });
    assert('built entry carries identity fields unchanged', { kind: built[0]?.kind, displayValue: built[0]?.displayValue, resolverKey: built[0]?.resolverKey, referable: built[0]?.referable }, { kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true });
    assert('built entry tier computed as authoritative', built[0]?.tier, 'authoritative');

    // A caller cannot smuggle a tier through the envelope even via `as any` —
    // buildFocusEntry only ever reads kind/displayValue/resolverKey/referable/role.
    const smuggled = { ...envelope, tier: 'authoritative' } as unknown as DomainFocusEnvelope;
    const builtFromPending = buildFocusEntry(smuggled, { status: 'pending', source: 'llm' });
    assert('TRUST: a smuggled tier on the envelope is ignored — recomputed from facts instead', builtFromPending[0]?.tier, 'llm_proposal');
  }

  console.log(`\n${BOLD}-- Generalization: hypothetical future domain, zero glue changes --${RESET}`);
  {
    // A domain Herald does not have — proves buildFocusEntry/classifyFocusAuthority
    // are generic over ANY correctly-shaped envelope, not just the 3 proven domains.
    const vehicleEnvelope: DomainFocusEnvelope = { kind: 'event', displayValue: 'oil change for the Civic', resolverKey: 'vehicle_maint_9', referable: true };
    const committed = buildFocusEntry(vehicleEnvelope, { status: 'committed', source: 'deterministic' });
    assert('hypothetical vehicle-maintenance domain classifies correctly with zero glue changes', committed[0]?.tier, 'authoritative');
    const proposed = buildFocusEntry({ kind: 'event', displayValue: 'oil change', referable: true }, { status: 'pending', source: 'llm' });
    assert('hypothetical domain pending/llm classifies correctly with zero glue changes', proposed[0]?.tier, 'llm_proposal');
  }
  {
    const writePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/conversationTurnLedgerWrite.ts');
    const src = fs.readFileSync(writePath, 'utf8');
    const forbiddenTokens = [`'medical_capture'`, `'list_add'`, `'todo_add'`, '.drug', '.items', '.dosage', 'intent.type ==='];
    for (const token of forbiddenTokens) {
      assertTrue(`no-domain-logic: conversationTurnLedgerWrite.ts contains no "${token}"`, !src.includes(token));
    }
  }

  console.log(`\n${BOLD}-- Three-domain proof — real DB, real writers --${RESET}`);

  // ── 1. medical_capture ──────────────────────────────────────────────────
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const t1 = await processUtterance('I take Eliquis 5 mg twice a day.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('medical: turn 1 handled as capture', t1.handled === true && t1.source === 'capture');
    const r1 = ledger.peek(Date.now());
    assert('medical proposal: exactly one focus entry', r1[0]?.focus.length, 1);
    assert('medical proposal: kind is thing', r1[0]?.focus[0]?.kind, 'thing');
    assert('medical proposal: displayValue is the medication name', r1[0]?.focus[0]?.displayValue, 'Eliquis');
    assert('medical proposal: NO resolverKey yet (not committed)', r1[0]?.focus[0]?.resolverKey, undefined);
    assert('SLICE4-PROOF: pending deterministic medication proposal does NOT become authoritative', r1[0]?.focus[0]?.tier, 'deterministic_unconfirmed');

    const t2 = await processUtterance('Yes.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('medical: turn 2 handled as pending_resume', t2.handled === true && t2.source === 'pending_resume');
    const r2 = ledger.peek(Date.now());
    assert('medical commit: exactly one focus entry', r2[1]?.focus.length, 1);
    assert('SLICE4-PROOF: successful commit is authoritative', r2[1]?.focus[0]?.tier, 'authoritative');
    const resolverKey = r2[1]?.focus[0]?.resolverKey;
    assertTrue('SLICE4-PROOF: authoritative resolverKey is a real, non-empty medication row id', typeof resolverKey === 'string' && resolverKey.length > 0);
    const activeMeds = db.prepare(`SELECT id FROM medications WHERE id = ?`).get(resolverKey);
    assertTrue('SLICE4-PROOF: that resolverKey actually resolves to a real row in the medications table', activeMeds != null);
  }

  // ── 1b. medical_capture — LLM-origin proposal stays proposal-tier ───────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'medical_capture', drug: 'Metformin', raw: 'I take Metformin' }],
      'I take Metformin',
      session, undefined, 'llm', { domainConfirmOwnsCapture: true }, ledger,
    );
    assertTrue('medical LLM-origin: writer own pending returned', commits[0]?.status === 'pending');
    const r = ledger.peek(Date.now());
    assert('SLICE4-PROOF: LLM-origin medication proposal remains proposal-tier until confirmed', r[0]?.focus[0]?.tier, 'llm_proposal');
    assert('medical LLM-origin: no resolverKey pre-confirmation', r[0]?.focus[0]?.resolverKey, undefined);
  }

  // ── 1c. medical_capture — malformed capture fails, no focus fabricated ──
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await applyIntents([{ type: 'medical_capture', raw: '' }], '', session, undefined, 'deterministic', undefined, ledger);
    const r = ledger.peek(Date.now());
    assert('medical failed capture: missing-focus outcome remains legal (Slice 2 behavior unchanged)', r[0]?.focus, []);
    assert('medical failed capture: outcome recorded as failed', r[0]?.outcome, 'failed');
  }

  // ── 2. list_add ──────────────────────────────────────────────────────────
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'list_add', items: ['milk', 'eggs', 'bananas'], listName: 'grocery' }],
      'add milk, eggs, and bananas',
      session, undefined, 'deterministic', undefined, ledger,
    );
    assertTrue('list: commit succeeded', commits[0]?.status === 'committed');
    const r = ledger.peek(Date.now());
    assert('SLICE4-PROOF: exactly ONE focus entry despite 3 items (no invented item-level focus)', r[0]?.focus.length, 1);
    assert('SLICE4-PROOF: list focus kind is collection', r[0]?.focus[0]?.kind, 'collection');
    assert('SLICE4-PROOF: list commit is authoritative', r[0]?.focus[0]?.tier, 'authoritative');
    const listResolverKey = r[0]?.focus[0]?.resolverKey;
    assertTrue('SLICE4-PROOF: list resolverKey is a real, non-empty list id', typeof listResolverKey === 'string' && listResolverKey.length > 0);
    const listRow = db.prepare(`SELECT id FROM lists WHERE id = ?`).get(listResolverKey);
    assertTrue('SLICE4-PROOF: that resolverKey actually resolves to a real row in the lists table', listRow != null);
  }

  // ── 3. todo_add ──────────────────────────────────────────────────────────
  {
    const { db, session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'todo_add', body: 'call the dentist' }],
      'remind me to call the dentist',
      session, undefined, 'deterministic', undefined, ledger,
    );
    assertTrue('todo: commit succeeded', commits[0]?.status === 'committed');
    const r = ledger.peek(Date.now());
    assert('SLICE4-PROOF: todo focus kind is item', r[0]?.focus[0]?.kind, 'item');
    assert('SLICE4-PROOF: todo focus displayValue is the body text', r[0]?.focus[0]?.displayValue, 'call the dentist');
    assert('SLICE4-PROOF: todo commit is authoritative', r[0]?.focus[0]?.tier, 'authoritative');
    const todoResolverKey = r[0]?.focus[0]?.resolverKey;
    assertTrue('SLICE4-PROOF: todo resolverKey is a real, non-empty item id', typeof todoResolverKey === 'string' && todoResolverKey.length > 0);
    const itemRow = db.prepare(`SELECT id, body FROM list_items WHERE id = ?`).get(todoResolverKey) as { body: string } | undefined;
    assertTrue('SLICE4-PROOF: that resolverKey actually resolves to a real row in list_items', itemRow != null && itemRow.body === 'call the dentist');
  }

  // ── declined outcome ──────────────────────────────────────────────────────
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Lisinopril 10 mg.', session, deps, null, null, null, null, null, null, ledger);
    await processUtterance('No.', session, deps, null, null, null, null, null, null, ledger);
    const r = ledger.peek(Date.now());
    assert('declined outcome: no focus fabricated on decline', r[1]?.focus, []);
    assert('declined outcome: recorded as declined', r[1]?.outcome, 'declined');
  }

  console.log(`\n${BOLD}-- Remaining trust tests (5-8) --${RESET}`);

  // TRUST-5: authoritative requires BOTH conditions simultaneously (already
  // exercised piecewise above — this asserts the conjunction explicitly).
  assertTrue('TRUST-5: authoritative requires committed status AND resolverKey together (neither alone suffices)',
    classifyFocusAuthority({ status: 'committed', source: 'deterministic', resolverKey: undefined }) !== 'authoritative'
    && classifyFocusAuthority({ status: 'pending', source: 'deterministic', resolverKey: 'x' }) !== 'authoritative'
    && classifyFocusAuthority({ status: 'committed', source: 'deterministic', resolverKey: 'x' }) === 'authoritative');

  // TRUST-6: ledger still has no DB write capability (re-verified after Slice 3/4 edits).
  {
    const ledgerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/conversationTurnLedger.ts');
    const src = fs.readFileSync(ledgerPath, 'utf8');
    assertTrue('TRUST-6: ledger module still imports no db module', !/from ['"]\.\.\/db\//.test(src));
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    assertTrue('TRUST-6: ledger module has no import of CommitResult (no actual dependency, comments aside)', !importLines.includes('CommitResult'));
  }

  // TRUST-7: focus failure cannot roll back or invalidate a successful commit.
  {
    const { session, deps } = freshDb();
    // No ledger passed at all — proves focus/ledger computation is fully
    // decoupled from the commit itself; the writer succeeds identically.
    const { commits } = await applyIntents(
      [{ type: 'todo_add', body: 'buy stamps' }],
      'remind me to buy stamps',
      session, undefined, 'deterministic', undefined, undefined,
    );
    assertTrue('TRUST-7: commit succeeds identically with no ledger/focus consumer at all', commits[0]?.status === 'committed');
  }

  // TRUST-8: pending deterministic state remains separate from ledger focus.
  {
    const { session, deps } = freshDb();
    const ledger = createConversationTurnLedger();
    await processUtterance('I take Atorvastatin 20 mg.', session, deps, null, null, null, null, null, null, ledger);
    assertTrue('TRUST-8: session still owns the pending slot, not the ledger', session.hasPending());
    assertTrue('TRUST-8: ledger exposes no pending-slot API', !('hasPending' in ledger) && !('setPending' in ledger));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationTurnLedgerFocus: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationTurnLedgerFocus.test.ts')) {
  runConversationTurnLedgerFocusTests().catch(console.error);
}
