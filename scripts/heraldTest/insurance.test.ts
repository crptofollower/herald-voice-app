// scripts/heraldTest/insurance.test.ts
// Insurance-capture contract tests (S-DISCLOSE build arc, step 4c).
// RED-first: detectInsuranceCapture + DOMAIN_WRITERS['insurance_capture'] land
// in a follow-on commit; this file pins the target contract now.
//
// Runner: npx tsx scripts/heraldTest/insurance.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { detectInsuranceCapture } from '../../src/utils/householdCapture.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS insurance_policies (
    id TEXT PRIMARY KEY,
    type TEXT,
    carrier TEXT,
    agent_name TEXT,
    agent_phone TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT
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

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function policyRows(db: Database.Database) {
  return db.prepare(`SELECT carrier, is_active, type FROM insurance_policies ORDER BY created_at ASC`).all() as {
    carrier: string; is_active: number; type: string;
  }[];
}

function activeCarrier(db: Database.Database, carrier: string): { carrier: string; is_active: number } | undefined {
  return db.prepare(
    `SELECT carrier, is_active FROM insurance_policies WHERE carrier = ? AND is_active = 1`,
  ).get(carrier) as { carrier: string; is_active: number } | undefined;
}

async function addPending(intent: IntentRecord): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['insurance_capture']!.add(intent, '');
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  return result;
}

async function armSession(
  session: ConversationSession,
  intent: IntentRecord,
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await addPending(intent);
  session.setPending({
    pendingKey: result.pendingKey,
    resume: result.resume,
    kind: result.kind ?? 'standard',
    reaskPrompt: result.reaskPrompt,
  });
  return result;
}

const HOME_STATE_FARM: IntentRecord = {
  type: 'insurance_capture',
  insType: 'home',
  carrier: 'State Farm',
};

export async function runInsuranceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Insurance-Capture Contract Tests -----------------------${RESET}\n`);

  // ── T-INS-1: deterministic capture ──────────────────────────────────────
  {
    const intents = detectInsuranceCapture('my home insurance is State Farm');
    assert('T-INS-1 detectInsuranceCapture home/State Farm → one insurance_capture intent',
      intents,
      v => Array.isArray(v) && v.length === 1
        && (v as IntentRecord[])[0].type === 'insurance_capture'
        && (v as IntentRecord[])[0].carrier === 'State Farm'
        && (v as IntentRecord[])[0].insType === 'home',
      "one intent, type insurance_capture, carrier State Farm, insType home");
  }

  // ── T-INS-2: YES commits with verified row ────────────────────────────────
  {
    const db = freshDB();
    const pending = await addPending(HOME_STATE_FARM);
    const result = await pending.resume('yes');
    assert('T-INS-2 add pending → resume(yes) → committed ack + active State Farm row',
      { result, row: activeCarrier(db, 'State Farm') },
      v => v.result.status === 'committed'
        && /State Farm/i.test(v.result.ack)
        && v.row?.carrier === 'State Farm'
        && v.row?.is_active === 1,
      'committed, ack names State Farm, row active');
  }

  // ── T-INS-3: NO branches to correction pending ────────────────────────────
  {
    const pending = await addPending(HOME_STATE_FARM);
    const result = await pending.resume('no');
    assert('T-INS-3 confirm resume(no) → correction pending, not noop/release',
      result,
      v => v.status === 'pending'
        && v.prompt === "No problem — what's the correct carrier?",
      "pending, prompt exactly No problem — what's the correct carrier?");
  }

  // ── T-INS-4: domain reaskPrompt on Graceful Confusion ─────────────────────
  {
    freshDB();
    const session = new ConversationSession();
    const armed = await armSession(session, HOME_STATE_FARM);
    const result = await session.resolvePending('what do you mean');
    assert('T-INS-4 unresolvable reply re-asks with domain reaskPrompt containing carrier',
      { result, pending: session.hasPending(), armedReask: armed.reaskPrompt },
      v => v.result.status === 'pending'
        && typeof v.result.prompt === 'string'
        && /State Farm/i.test(v.result.prompt)
        && v.pending === true,
      'pending, prompt contains carrier, session still armed');
  }

  // ── T-INS-5: standard budget exhaustion, no write ─────────────────────────
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armSession(session, HOME_STATE_FARM);
    await session.resolvePending('purple');
    const result = await session.resolvePending('banana');
    assert('T-INS-5 two ambiguous replies → standard release, no insurance row',
      { result, pending: session.hasPending(), rows: policyRows(db).length },
      v => v.result.status === 'noop'
        && /come back to that/i.test(v.result.ack)
        && v.pending === false
        && v.rows === 0,
      'noop release, session cleared, 0 rows');
  }

  // ── T-INS-6: cancel escape ────────────────────────────────────────────────
  {
    const db = freshDB();
    const session = new ConversationSession();
    await armSession(session, HOME_STATE_FARM);
    const result = await session.resolvePending('never mind');
    assert('T-INS-6 never mind → cancel ack, session cleared, no row written',
      { result, pending: session.hasPending(), rows: policyRows(db).length },
      v => v.result.status === 'noop'
        && typeof v.result.ack === 'string'
        && v.result.ack.length > 0
        && v.pending === false
        && v.rows === 0,
      'cancel ack, released, 0 rows');
  }

  // ── T-INS-7: full correction turn ─────────────────────────────────────────
  {
    const db = freshDB();
    const confirm = await addPending(HOME_STATE_FARM);
    const correctionAsk = await confirm.resume('no');
    if (correctionAsk.status !== 'pending') throw new Error('T-INS-7 setup: expected correction pending');
    const reconfirm = await correctionAsk.resume('Progressive');
    if (reconfirm.status !== 'pending') throw new Error('T-INS-7 setup: expected reconfirm pending');
    const committed = await reconfirm.resume('yes');
    assert('T-INS-7 no → correction → Progressive confirm → yes commits Progressive row',
      { committed, row: activeCarrier(db, 'Progressive'), prompt: reconfirm.prompt },
      v => v.committed.status === 'committed'
        && /Progressive/i.test(v.prompt)
        && v.row?.carrier === 'Progressive'
        && v.row?.is_active === 1,
      'committed Progressive, reconfirm prompt named Progressive');
  }

  // ── T-INS-8: unknown placeholder → ask carrier → GEICO ──────────────────
  {
    const db = freshDB();
    const ask = await addPending({ type: 'insurance_capture', insType: 'auto', carrier: 'unknown' });
    const confirm = await ask.resume('Geico');
    if (confirm.status !== 'pending') throw new Error('T-INS-8 setup: expected confirm pending');
    const committed = await confirm.resume('yes');
    assert('T-INS-8 unknown carrier → ask → Geico confirm with GEICO → yes commits GEICO row',
      { askPrompt: ask.prompt, confirmPrompt: confirm.prompt, committed, row: activeCarrier(db, 'GEICO') },
      v => /who'?s your insurance with/i.test(v.askPrompt)
        && /GEICO/i.test(v.confirmPrompt)
        && v.committed.status === 'committed'
        && v.row?.carrier === 'GEICO'
        && v.row?.is_active === 1,
      'ask prompt, GEICO confirm, committed active row');
  }

  // ── T-INS-9: supersession within type ─────────────────────────────────────
  {
    const db = freshDB();
    const first = await addPending({ type: 'insurance_capture', insType: 'home', carrier: 'Allstate' });
    await first.resume('yes');
    const second = await addPending({ type: 'insurance_capture', insType: 'home', carrier: 'State Farm' });
    await second.resume('yes');
    const rows = policyRows(db);
    assert('T-INS-9 home supersession: Allstate inactive, State Farm active',
      rows,
      v => Array.isArray(v)
        && v.some(r => r.carrier === 'Allstate' && r.is_active === 0)
        && v.some(r => r.carrier === 'State Farm' && r.is_active === 1),
      'Allstate is_active=0, State Farm is_active=1');
  }

  // ── T-INS-10: change/switch/now phrasing ──────────────────────────────────
  {
    const phrases = [
      'change my insurance to Geico',
      'I switched my insurance to Progressive',
      'my insurance is now State Farm',
    ];
    const results = phrases.map(p => detectInsuranceCapture(p));
    assert('T-INS-10 change/switch/now phrases each yield valid carrier capture',
      results,
      v => Array.isArray(v) && v.length === 3
        && v.every(r => Array.isArray(r) && r.length > 0 && typeof (r as IntentRecord[])[0].carrier === 'string' && (r as IntentRecord[])[0].carrier.trim().length > 0),
      '3 non-empty captures with valid carrier each');
  }

  // ── T-INS-11: tier-1 profile_update intercept → capture ───────────────────
  {
    const decision = await routeIntent('my insurance is Geico', {
      classifyQuery: async () => ({
        tier: 1 as const,
        actionIntent: { type: 'profile_update', field: 'insurance', value: 'Geico' },
        reason: 'test',
      }),
      classifyLLM: null,
      llmReady: false,
    });
    assert('T-INS-11 profile_update insurance intercept → capture insurance_capture',
      decision,
      v => v.kind === 'capture'
        && v.intents.length === 1
        && v.intents[0].type === 'insurance_capture',
      "kind capture, one insurance_capture intent");
  }

  // ── T-INS-12: Law 0 escapes mid-pending ───────────────────────────────────
  {
    freshDB();
    const session = new ConversationSession();
    await armSession(session, HOME_STATE_FARM);
    const outcome = await processUtterance('I need help right now', session, {
      classifyQuery: async () => ({ tier: 3 as const }),
      classifyLLM: null,
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    } as any);
    assert('T-INS-12 emergency mid insurance pending → source emergency, pending released',
      { outcome, pending: session.hasPending() },
      v => v.outcome.handled === true
        && v.outcome.source === 'emergency'
        && v.pending === false,
      'emergency, session cleared');
  }

  // ── T-INS-13: read guard returns empty ────────────────────────────────────
  {
    const intents = detectInsuranceCapture('who is my home insurance with');
    assert('T-INS-13 read utterance → no capture',
      intents,
      v => Array.isArray(v) && v.length === 0,
      '[]');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Insurance: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('insurance.test.ts')) {
  runInsuranceTests().catch(console.error);
}
