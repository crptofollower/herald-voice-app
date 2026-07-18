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
import { findContactByName, findContactByRelationship } from '../../src/db/contactsDB.ts';

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
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    fact TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'stated',
    source_date TEXT NOT NULL,
    last_used TEXT,
    use_count INTEGER DEFAULT 0,
    entity_id TEXT,
    importance_score INTEGER DEFAULT 50,
    valid_until TEXT,
    context_type TEXT DEFAULT 'historical'
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
    assert('T-CT-11 invalid phone → domain noop empty; session reasks inviting name or number; no row',
      { domain, ladder, rows: contactCount(db), reask: armed.reaskPrompt },
      v => v.domain.status === 'noop' && v.domain.ack === ''
        && v.ladder.status === 'pending'
        && typeof v.ladder.prompt === 'string'
        && /name/i.test(v.ladder.prompt) && /number/i.test(v.ladder.prompt)
        && /name/i.test(v.reask) && /number/i.test(v.reask)
        && v.rows === 0,
      'noop empty, reask mentions name or number, 0 rows');
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

  // ── T-CT-13: name-hop bridge must NOT inherit relationship onto namesakes ──
  // Phoneless "father-in-law" row + two phoneable Davids with no relationship of
  // their own. Bridge finds the Davids by name; must not paint FIL onto them.
  {
    const db = freshDB();
    insertContact(db, { id: 'c_fil', name: 'David', relationship: 'father-in-law', importance: 7 });
    insertContact(db, { id: 'c_moss', name: 'David Mossholder', phone: '555-111-1111', importance: 9 });
    insertContact(db, { id: 'c_clev', name: 'David Clevenger', phone: '555-222-2222', importance: 5 });
    const intent = await resolveContactCallIntent('father-in-law', 'call my father-in-law', { resolveContact: async () => null });
    const cands = (intent as { candidates?: Array<{ name: string; relationship?: string | null }> }).candidates ?? [];
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-13 bridged namesakes keep no inherited relationship',
      { cands, pending },
      v => {
        if (v.pending.status !== 'pending') return false;
        // Candidates themselves must never carry the FIL label from the
        // phoneless row — this is the law this case guards (name-hop bridge
        // must not paint m.relationship onto an unrelated namesake). The
        // PROMPT'S wording for this scenario is asserted separately in
        // T-CT-15 (no-relationship-evidence honest ask, added 2026-07-17
        // alongside the false-confidence-guess fix — a version of this test
        // used to also assert the old Mossholder-guess prompt shape here;
        // that assertion was locking in the bug, not guarding against it,
        // and has been removed).
        return v.cands.length >= 2 && v.cands.every(c => !c.relationship?.trim());
      },
      'candidates carry no inherited relationship; prompt shape covered by T-CT-15');
  }

  // ── T-CT-14: phoneless sibling disclosure (cold-start silent-narrowing fix) ─
  {
    const db = freshDB();
    insertContact(db, { id: 'c_hunter', name: 'Hunter', relationship: 'son', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_grant', name: 'Grant', relationship: 'son', importance: 5 });
    const intent = await resolveContactCallIntent('son', 'call my son', { resolveContact: async () => null });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14a one phoned + one phoneless → dials Hunter and ack names Grant',
      { status: result.status, phone: dialPhone(result), ack: result.status === 'committed' ? result.ack : '' },
      v => v.status === 'committed'
        && v.phone === '5550100101'
        && /Calling Hunter/i.test(v.ack)
        && /Grant/i.test(v.ack)
        && /don't have a number for Grant yet/i.test(v.ack)
        && !/\b(his|her)\b/i.test(v.ack),
      'committed dial Hunter; ack discloses Grant neutrally');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_emily', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_anna', name: 'Anna', relationship: 'daughter', importance: 5 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14a2 phoneless daughter → ack names Anna with no his/her',
      { status: result.status, phone: dialPhone(result), ack: result.status === 'committed' ? result.ack : '' },
      v => v.status === 'committed'
        && v.phone === '5550100101'
        && /Calling Emily/i.test(v.ack)
        && /don't have a number for Anna yet/i.test(v.ack)
        && !/\b(his|her)\b/i.test(v.ack),
      'committed dial Emily; Anna disclosed without gendered pronoun');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14b both phoned → still disambiguateStage (no silent dial)',
      pending,
      v => v.status === 'pending' && /more than one daughter/i.test(v.prompt),
      'pending disambiguation');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_one', name: 'Shannon', relationship: 'wife', phone: '555-030-0300', importance: 9 });
    const intent = await resolveContactCallIntent('wife', 'call my wife', { resolveContact: async () => null });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14c single phoned match → plain Calling ack, no disclosure',
      { status: result.status, ack: result.status === 'committed' ? result.ack : '' },
      v => v.status === 'committed'
        && v.ack === 'Calling Shannon.'
        && !/I also know/i.test(v.ack),
      'Calling Shannon. only');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_phoned', name: 'Hunter', relationship: 'son', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_d1', name: 'Grant', relationship: 'son', importance: 5 });
    insertContact(db, { id: 'c_d2', name: 'Emily', relationship: 'son', importance: 4 });
    insertContact(db, { id: 'c_d3', name: 'Sam', relationship: 'son', importance: 3 });
    insertContact(db, { id: 'c_d4', name: 'Alex', relationship: 'son', importance: 2 });
    const intent = await resolveContactCallIntent('son', 'call my son', { resolveContact: async () => null });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14d 4+ phoneless → ack caps at 2 names + and N others',
      { status: result.status, ack: result.status === 'committed' ? result.ack : '' },
      v => v.status === 'committed'
        && /Calling Hunter/i.test(v.ack)
        && /and 2 others/i.test(v.ack)
        && /don't have their numbers yet/i.test(v.ack),
      'capped disclosure with and 2 others');
  }
  {
    freshDB();
    const intent = await resolveContactCallIntent('Alex', 'call Alex', { resolveContact: async () => null });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-CT-14e withPhone===0 → collect stage unchanged (no phonelessNames dial)',
      pending,
      v => v.status === 'pending' && /don't have a number for Alex/i.test(v.prompt),
      'collect pending');
  }

  // ── T-CT-15..19: no-relationship-evidence disambiguation + natural corrections ─
  // OS-device bridge shape: multi-candidate, no relationship on any row. Must not
  // guess a name; must accept last name / sentence correction / phone.
  function filBridgeIntent(): IntentRecord {
    return {
      type: 'contact_call',
      contact: 'father-in-law',
      candidates: [
        { name: 'David Mossholder', phone: '2145551212', importance: 5 },
        { name: 'David Clevenger', phone: '2145553434', importance: 5 },
      ],
      raw: 'call my father-in-law',
    };
  }

  // ── T-CT-15: no-relationship-evidence pending never guesses a name ──────────
  {
    freshDB();
    const pending = await addPending(filBridgeIntent());
    assert('T-CT-15 no-relationship-evidence pending never guesses a name',
      pending,
      v => v.status === 'pending'
        && !/Mossholder/i.test(v.prompt)
        && !/Clevenger/i.test(v.prompt)
        && /last name|give me the number/i.test(v.prompt),
      'pending asks last name/number; does not name Mossholder or Clevenger');
  }

  // ── T-CT-16: bare last-name reply resolves via matchCandidate ─────────────
  {
    freshDB();
    const pending = await addPending(filBridgeIntent());
    const result = await pending.resume('Clevenger');
    assert('T-CT-16 bare last-name reply → dial David Clevenger',
      dialPhone(result),
      v => v === '2145553434',
      'dial 2145553434');
  }

  // ── T-CT-17: natural-sentence correction resolves (production field bug) ──
  {
    freshDB();
    const pending = await addPending(filBridgeIntent());
    const result = await pending.resume('no my father-in-law is David clevenger');
    assert('T-CT-17 natural-sentence correction → dial David Clevenger',
      dialPhone(result),
      v => v === '2145553434',
      'dial 2145553434');
  }

  // ── T-CT-18: bare phone number reply commits directly ─────────────────────
  {
    const db = freshDB();
    const pending = await addPending(filBridgeIntent());
    const before = contactCount(db);
    const result = await pending.resume('214 555 9999');
    const after = contactCount(db);
    assert('T-CT-18 bare phone reply → row written + committed dial effect',
      { result, before, after, phone: dialPhone(result) },
      v => v.before === 0
        && v.after === 1
        && v.result.status === 'committed'
        && v.phone === '2145559999',
      'row count 0→1, committed, dial phone 2145559999');
  }

  // ── T-CT-19: natural-sentence correction on relationship-evidence path ────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_high', name: 'Emily', relationship: 'daughter', phone: '555-010-0101', importance: 9 });
    insertContact(db, { id: 'c_low', name: 'Anna', relationship: 'daughter', phone: '555-020-0202', importance: 3 });
    const intent = await resolveContactCallIntent('daughter', 'call my daughter', { resolveContact: async () => null });
    const pending = await addPending(intent);
    const alt = await pending.resume('no');
    if (alt.status !== 'pending') throw new Error('T-CT-19 setup: expected alternate pick pending');
    const result = await alt.resume("no it's Anna");
    assert('T-CT-19 relationship-evidence path: natural-sentence pick → Anna dial',
      { prompt: alt.prompt, phone: dialPhone(result) },
      v => typeof v.prompt === 'string' && /Anna/i.test(v.prompt) && v.phone === '5550200202',
      'prompt names Anna, dial 5550200202');
  }

  // ── T-CT-20: successful name-match resolution persists the relationship ───
  {
    freshDB();
    const pending = await addPending(filBridgeIntent());
    const result = await pending.resume('Clevenger');
    const stored = findContactByName('David Clevenger');
    assert('T-CT-20 name-match resolution persists father-in-law on David Clevenger',
      { phone: dialPhone(result), stored },
      v => v.phone === '2145553434'
        && !!v.stored
        && v.stored.name === 'David Clevenger'
        && v.stored.relationship === 'father-in-law',
      'dial 2145553434; contact row has relationship father-in-law');
  }

  // ── T-CT-21: plain-name lookup must NOT fabricate a relationship ──────────
  {
    freshDB();
    const intent: IntentRecord = {
      type: 'contact_call',
      contact: 'sarah',
      candidates: [
        { name: 'Sarah Miller', phone: '2145551111', importance: 5 },
        { name: 'Sarah Jones', phone: '2145552222', importance: 5 },
      ],
      raw: 'call sarah',
    };
    const pending = await addPending(intent);
    const result = await pending.resume('Miller');
    const fabricated = findContactByRelationship('sarah');
    assert('T-CT-21 plain-name lookup does not fabricate relationship sarah',
      { phone: dialPhone(result), fabricated },
      v => v.phone === '2145551111' && v.fabricated === null,
      'dial Sarah Miller; no contact with relationship sarah');
  }

  // ── T-CT-22: hyphenated label matches natural three-word speech ───────────
  {
    freshDB();
    const pending = await addPending(filBridgeIntent());
    const result = await pending.resume('My father in law is David Clevenger');
    assert('T-CT-22 natural three-word father in law → dial David Clevenger',
      dialPhone(result),
      v => v === '2145553434',
      'dial 2145553434');
  }

  // ── T-CT-23: persisting a resolution retires the stale placeholder's tag ──
  {
    const db = freshDB();
    insertContact(db, { id: 'c_fil', name: 'David', relationship: 'father-in-law', importance: 7 });
    const pending = await addPending(filBridgeIntent());
    const result = await pending.resume('Clevenger');
    const holder = findContactByRelationship('father-in-law');
    const filCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM contacts WHERE LOWER(relationship) = 'father-in-law' AND removed_at IS NULL`,
    ).get() as { n: number }).n;
    const placeholder = db.prepare(
      `SELECT name, relationship, removed_at FROM contacts WHERE id = 'c_fil'`,
    ).get() as { name: string; relationship: string | null; removed_at: string | null };
    assert('T-CT-23 resolution retires stale placeholder relationship tag',
      { phone: dialPhone(result), holder, filCount, placeholder },
      v => v.phone === '2145553434'
        && v.filCount === 1
        && !!v.holder
        && v.holder.name === 'David Clevenger'
        && v.placeholder?.name === 'David'
        && v.placeholder.relationship == null
        && v.placeholder.removed_at == null,
      'one FIL holder David Clevenger; placeholder David still live with relationship cleared');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ContactCall: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('contact_call.test.ts')) {
  runContactCallTests().catch(console.error);
}
