// scripts/heraldTest/medClear.test.ts
// Medical-clear contract tests (S-DISCLOSE build arc, step 4 partial).
// Confirms authority lives in medical_capture.clear() — dispatch only arms the
// primitive-governed pending. Headless against better-sqlite3 + ConversationSession.
//
// Runner: npx tsx scripts/heraldTest/medClear.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { writeMedication, getActiveMedications } from '../../src/db/medicalDB.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dosage TEXT,
    frequency TEXT,
    prescribing_doctor TEXT,
    start_date TEXT,
    end_date TEXT,
    is_active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT,
    removed_at TEXT
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB(withMeds = false) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  if (withMeds) {
    writeMedication({ name: 'Tylenol', dosage: '500mg', is_active: 1 });
    writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
  }
  return db;
}

async function armFromClear(
  session: ConversationSession,
  resumeSpy?: { called: boolean },
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['medical_capture']!.clear();
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  const resume = resumeSpy
    ? async (text: string) => { resumeSpy.called = true; return result.resume(text); }
    : result.resume;
  session.setPending({ pendingKey: result.pendingKey, resume, kind: result.kind });
  return result;
}

export async function runMedClearTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Medical-Clear Contract Tests ---------------------------${RESET}\n`);

  // ── M1: clear() with active meds → pending destructive, never commits ─────
  {
    freshDB(true);
    const result = await DOMAIN_WRITERS['medical_capture']!.clear();
    assert('M1 clear() with active meds returns pending destructive — never commits immediately', result,
      v => v.status === 'pending' && v.kind === 'destructive' && getActiveMedications().length === 2,
      'pending/destructive, meds still active');
  }

  // ── M2: clear() with zero meds → noop, nothing armed ──────────────────────
  {
    freshDB(false);
    const session = new ConversationSession();
    const result = await DOMAIN_WRITERS['medical_capture']!.clear();
    assert('M2 clear() with zero meds returns noop; nothing armed', { result, armed: session.hasPending() },
      v => v.result.status === 'noop' && /don't have any medications/i.test(v.result.ack) && v.armed === false,
      'noop ack, session empty');
  }

  // ── M3: arm → yes → committed; meds cleared ─────────────────────────────
  {
    freshDB(true);
    const session = new ConversationSession();
    await armFromClear(session);
    const result = await session.resolvePending('yes');
    assert('M3 arm → yes → committed; meds actually cleared', { result, count: getActiveMedications().length },
      v => v.result.status === 'committed' && v.count === 0, 'committed, 0 active');
  }

  // ── M4: arm → no → leave-as-is; meds intact ───────────────────────────────
  {
    freshDB(true);
    const session = new ConversationSession();
    await armFromClear(session);
    const result = await session.resolvePending('no');
    assert('M4 arm → no → noop with leave-as-is ack; meds intact', { ack: result.status === 'noop' ? result.ack : '', count: getActiveMedications().length },
      v => /left your medications/i.test(v.ack) && v.count === 2, 'leave-as-is, 2 active');
  }

  // ── M5: arm → ambiguous → destructive release; meds intact ────────────────
  {
    freshDB(true);
    const session = new ConversationSession();
    await armFromClear(session);
    const result = await session.resolvePending('what about tylenol');
    assert('M5 arm → ambiguous reply → released with destructive release line; meds intact; slot empty',
      { ack: result.status === 'noop' ? result.ack : '', pending: session.hasPending(), count: getActiveMedications().length },
      v => /leave everything as it is/i.test(v.ack) && v.pending === false && v.count === 2,
      'destructive release, empty slot, meds intact');
  }

  // ── M6: arm → never mind → CANCEL_RE; meds intact ─────────────────────────
  {
    freshDB(true);
    const session = new ConversationSession();
    await armFromClear(session);
    const result = await session.resolvePending('never mind');
    assert('M6 arm → never mind → CANCEL_RE catches it; meds intact',
      { pending: session.hasPending(), count: getActiveMedications().length, ack: result.status === 'noop' ? result.ack : '' },
      v => v.pending === false && v.count === 2 && typeof v.ack === 'string' && v.ack.length > 0,
      'released, cancel ack, meds intact');
  }

  // ── M7: arm → C-J emergency → Law 0 escapes; resume never invoked ─────────
  {
    freshDB(true);
    const session = new ConversationSession();
    const resumeSpy = { called: false };
    await armFromClear(session, resumeSpy);
    const outcome = await processUtterance('Ok I really need help now', session, {
      classifyQuery: async () => ({ tier: 3 as const }),
      classifyLLM: null,
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    } as any);
    assert('M7 arm → "Ok I really need help now" → Law 0 escapes, pending released, meds intact, resume never invoked',
      { outcome, pending: session.hasPending(), count: getActiveMedications().length, resumeCalled: resumeSpy.called },
      v => v.outcome.handled === true && v.outcome.source === 'emergency' && v.pending === false && v.count === 2 && v.resumeCalled === false,
      'emergency, released, meds intact, resume never called');
  }

  // ── M8: applyIntents-style kind passthrough → budget 1, not 2 ─────────────
  {
    freshDB(true);
    const session = new ConversationSession();
    const pending = await DOMAIN_WRITERS['medical_capture']!.clear();
    if (pending.status !== 'pending') throw new Error('expected pending');
    session.setPending({ pendingKey: pending.pendingKey, resume: pending.resume, kind: pending.kind });
    await session.resolvePending('purple');
    assert('M8 pending armed via applyIntents-style setPending with kind passthrough gets budget 1, not 2',
      session.hasPending(), v => v === false, 'released after one ambiguous (budget 1)');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Med-Clear: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medClear.test.ts')) {
  runMedClearTests().catch(console.error);
}
