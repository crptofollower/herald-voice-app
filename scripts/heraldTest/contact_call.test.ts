// scripts/heraldTest/contact_call.test.ts
// contact_call writer + routeIntent intercept contract tests (S-DISCLOSE C-3).
//
// Runner: npx tsx scripts/heraldTest/contact_call.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS, routeIntent, resolveContactCallIntent, mapCallIntents } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';
import type { Contact } from '../../src/db/contactsDB.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    relationship TEXT,
    phone TEXT,
    address TEXT,
    email TEXT,
    birthday TEXT,
    importance INTEGER DEFAULT 5,
    entity_id TEXT,
    os_contact_id TEXT,
    notes TEXT,
    last_contact TEXT,
    is_emergency INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function insertContact(
  db: Database.Database,
  row: Pick<Contact, 'id' | 'name'> & Partial<Contact> & { removed_at?: string | null },
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.importance ?? 5,
    row.created_at ?? now,
    row.updated_at ?? now,
    row.removed_at ?? null,
  );
}

function contactCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NULL`).get() as { n: number }).n;
}

function dialPhone(result: CommitResult): string | undefined {
  return result.status === 'committed' && result.effect?.kind === 'dial' ? result.effect.phone : undefined;
}

async function addPending(intent: IntentRecord): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
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

export async function runContactCallTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- contact_call Contract Tests -----------------------------${RESET}\n`);

  // ── T-CT-1: call intercept → capture, not device_action ─────────────────
  {
    freshDB();
    const decision = await routeIntent('call Shannon', {
      classifyQuery: async () => ({
        tier: 1 as const,
        actionIntent: { type: 'call', contact: 'Shannon' },
        reason: 'test:call',
      }),
      classifyLLM: null,
      llmReady: false,
      resolveContact: async () => null,
    });
    assert('T-CT-1 call Shannon intercept → capture contact_call, not device_action',
      decision,
      v => v.kind === 'capture'
        && v.intents.length === 1
        && v.intents[0].type === 'contact_call'
        && (v.intents[0] as { contact: string }).contact === 'Shannon',
      'kind capture, one contact_call intent for Shannon');
  }

  // ── T-CT-2: zero herald + zero device → collect → valid 10-digit ──────────
  {
    const db = freshDB();
    const intent = await resolveContactCallIntent('Alex', 'call Alex', { resolveContact: async () => null });
    const pending = await addPending(intent);
    const before = contactCount(db);
    const result = await pending.resume('555 123 4567');
    const after = contactCount(db);
    assert('T-CT-2 collect → valid 10-digit → row written + committed dial effect',
      { result, before, after, phone: dialPhone(result) },
      v => v.before === 0
        && v.after === 1
        && v.result.status === 'committed'
        && v.phone === '5551234567',
      'row count 0→1, committed, dial phone 5551234567');
  }

  // ── T-CT-3: exactly one herald match → committed + effect, no pending ─────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_shan', name: 'Shannon', phone: '555-010-0200', importance: 8 });
    const intent = await resolveContactCallIntent('Shannon', 'call Shannon', { resolveContact: async () => null });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-3 one herald match → committed dial directly, no pending',
      { status: result.status, phone: dialPhone(result) },
      v => v.status === 'committed' && v.phone === '5550100200',
      'committed, dial 5550100200');
  }

  // ── T-CT-4: multiple herald → disambiguation pending with best-guess handle
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-4 multiple herald matches → pending disambiguation names best guess',
      pending,
      v => v.status === 'pending'
        && /more than one daughter/i.test(v.prompt)
        && /daughter/i.test(v.prompt)
        && /Emily/i.test(v.prompt),
      'pending, prompt names daughter relationship + Emily (highest importance)');
  }

  // ── T-CT-5: disambiguation YES → guessed candidate phone in effect ────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const pending = await addPending(intent);
    const result = await pending.resume('yes');
    assert('T-CT-5 disambiguation YES → top candidate phone in dial effect',
      dialPhone(result),
      v => v === '5550100101',
      'dial 5550100101');
  }

  // ── T-CT-6: disambiguation NO → pick second candidate ─────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const pending = await addPending(intent);
    const alt = await pending.resume('no');
    if (alt.status !== 'pending') throw new Error('T-CT-6 setup: expected alternate pick pending');
    const result = await alt.resume('Anna');
    assert('T-CT-6 disambiguation NO → alternatives named; pick second → Anna dial effect',
      { prompt: alt.prompt, phone: dialPhone(result) },
      v => typeof v.prompt === 'string' && /Anna/i.test(v.prompt) && v.phone === '5550200202',
      'prompt names Anna, dial 5550200202');
  }

  // ── T-CT-7: ambiguous reply → domain noop empty ack, re-ask not release ───
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const disambigIntent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const disambigPending = await addPending(disambigIntent);
    const disambigDomain = await disambigPending.resume('maybe');
    const disambigSession = new ConversationSession();
    await armSession(disambigSession, disambigIntent);
    const disambigLadder = await disambigSession.resolvePending('maybe');

    const collectIntent = await resolveContactCallIntent('Alex', 'call Alex', { resolveContact: async () => null });
    const collectPending = await addPending(collectIntent);
    const collectDomain = await collectPending.resume('purple');
    const collectSession = new ConversationSession();
    await armSession(collectSession, collectIntent);
    const collectLadder = await collectSession.resolvePending('purple');

    const deviceIntent: IntentRecord = {
      type: 'contact_call', contact: 'Mike', devicePhone: '5559876543', deviceName: 'Mike Johnson', raw: 'call Mike',
    };
    const devicePending = await addPending(deviceIntent);
    const deviceDomain = await devicePending.resume('huh');
    const deviceSession = new ConversationSession();
    await armSession(deviceSession, deviceIntent);
    const deviceLadder = await deviceSession.resolvePending('huh');

    assert('T-CT-7 ambiguous at any stage → domain noop empty ack, ladder pending, never implicit NO',
      {
        disambigDomain, disambigLadder, disambigPending: disambigSession.hasPending(),
        collectDomain, collectLadder, collectPending: collectSession.hasPending(),
        deviceDomain, deviceLadder, devicePending: deviceSession.hasPending(),
      },
      v => v.disambigDomain.status === 'noop' && v.disambigDomain.ack === ''
        && v.disambigLadder.status === 'pending' && v.disambigPending === true
        && v.collectDomain.status === 'noop' && v.collectDomain.ack === ''
        && v.collectLadder.status === 'pending' && v.collectPending === true
        && v.deviceDomain.status === 'noop' && v.deviceDomain.ack === ''
        && v.deviceLadder.status === 'pending' && v.devicePending === true,
      'noop+empty ack from domain; session re-asks; still armed');
  }

  // ── T-CT-8: budget exhaustion → release ack, zero contacts written ────────
  {
    const db = freshDB();
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('Alex', 'call Alex', { resolveContact: async () => null });
    await armSession(session, intent);
    await session.resolvePending('purple');
    const result = await session.resolvePending('banana');
    assert('T-CT-8 two ambiguous replies → release ack, session cleared, 0 rows',
      { result, pending: session.hasPending(), rows: contactCount(db) },
      v => v.result.status === 'noop'
        && /come back to that/i.test(v.result.ack)
        && v.pending === false
        && v.rows === 0,
      'release noop, cleared, 0 contacts');
  }

  // ── T-CT-9: never mind → cancel ack, zero contacts written ────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    await armSession(session, intent);
    const result = await session.resolvePending('never mind');
    assert('T-CT-9 never mind → cancel ack, session cleared, no new rows',
      { result, pending: session.hasPending(), rows: contactCount(db) },
      v => v.result.status === 'noop'
        && /won't do that/i.test(v.result.ack)
        && v.pending === false
        && v.rows === 2,
      'cancel ack, released, only seed rows remain');
  }

  // ── T-CT-10: device confirm YES writes row + dial; NO noop redirect ───────
  {
    const dbYes = freshDB();
    const yesIntent: IntentRecord = {
      type: 'contact_call', contact: 'Mike', devicePhone: '5559876543', deviceName: 'Mike Johnson', raw: 'call Mike',
    };
    const yesPending = await addPending(yesIntent);
    const yesBefore = contactCount(dbYes);
    const yesResult = await yesPending.resume('yes');
    const yesAfter = contactCount(dbYes);

    const dbNo = freshDB();
    const noIntent: IntentRecord = {
      type: 'contact_call', contact: 'Mike', devicePhone: '5559876543', deviceName: 'Mike Johnson', raw: 'call Mike',
    };
    const noPending = await addPending(noIntent);
    const noResult = await noPending.resume('no');

    assert('T-CT-10 device YES → row written + dial effect; NO → redirect noop, zero writes',
      {
        yes: { before: yesBefore, after: yesAfter, phone: dialPhone(yesResult) },
        no: { ack: noResult.status === 'noop' ? noResult.ack : '', rows: contactCount(dbNo), dial: dialPhone(noResult) },
      },
      v => v.yes.before === 0 && v.yes.after === 1 && v.yes.phone === '5559876543'
        && /who were you trying to reach/i.test(v.no.ack)
        && v.no.rows === 0
        && v.no.dial === undefined,
      'YES: row+dial; NO: redirect ack, 0 rows, no dial');
  }

  // ── T-CT-11: invalid phone during collect → reaskPrompt, no row ─────────────
  {
    const db = freshDB();
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('Alex', 'call Alex', { resolveContact: async () => null });
    const armed = await armSession(session, intent);
    const domain = await armed.resume('123');
    const ladder = await session.resolvePending('123');
    assert('T-CT-11 invalid phone → domain noop empty; session reasks with 10-digit prompt; no row',
      { domain, ladder, rows: contactCount(db), reask: armed.reaskPrompt },
      v => v.domain.status === 'noop' && v.domain.ack === ''
        && v.ladder.status === 'pending'
        && typeof v.ladder.prompt === 'string'
        && /10-digit/i.test(v.ladder.prompt)
        && /10-digit/i.test(v.reask)
        && v.rows === 0,
      'noop empty, reask mentions 10-digit, 0 rows');
  }

  // ── T-CT-12: mapCallIntents — the Commit A mechanism (DD-2) ────────────────
  // Raw LLM 'call' intents map to contact_call BEFORE allConverted; contact is
  // cleaned of trailing "at/on/with…" phrasing; non-call intents pass through
  // untouched; an empty-contact call is NOT force-mapped (falls through).
  {
    freshDB();
    const noResolve = { resolveContact: async () => null };

    const mappedPlain = await mapCallIntents(
      [{ type: 'call', contact: 'Shannon' } as unknown as IntentRecord],
      'call Shannon',
      noResolve,
    );
    assert('T-CT-12a {type:call, contact:Shannon} → contact_call for Shannon',
      mappedPlain,
      v => Array.isArray(v) && v.length === 1
        && v[0].type === 'contact_call'
        && (v[0] as { contact: string }).contact === 'Shannon',
      'one contact_call intent, contact Shannon');

    const mappedTrailing = await mapCallIntents(
      [{ type: 'call', contact: 'Mom at 5pm' } as unknown as IntentRecord],
      'call Mom at 5pm',
      noResolve,
    );
    assert('T-CT-12b trailing phrase stripped → contact_call for Mom',
      mappedTrailing,
      v => v.length === 1
        && v[0].type === 'contact_call'
        && (v[0] as { contact: string }).contact === 'Mom',
      'contact_call, contact cleaned to Mom');

    const passthrough = { type: 'list_add', items: ['milk'], listName: 'grocery' } as unknown as IntentRecord;
    const mappedOther = await mapCallIntents([passthrough], 'add milk', noResolve);
    assert('T-CT-12c non-call intent passes through untouched',
      mappedOther,
      v => v.length === 1 && v[0] === passthrough,
      'same list_add reference, unmodified');

    const emptyContact = await mapCallIntents(
      [{ type: 'call', contact: '' } as unknown as IntentRecord],
      'call',
      noResolve,
    );
    assert('T-CT-12d empty-contact call is NOT force-mapped (falls through as-is)',
      emptyContact,
      v => v.length === 1 && v[0].type === 'call',
      'unmapped, still type call — no fabricated contact_call');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ContactCall: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('contact_call.test.ts')) {
  runContactCallTests().catch(console.error);
}
