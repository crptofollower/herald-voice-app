// scripts/heraldTest/osAmbiguity.test.ts
// OS ambiguity contract for CALL + TEXT (named-person + pure-relationship).
// Locks ChatScreen.resolveContactPhone Pass-2 selection + routeIntent /
// dispatch interaction (prompt → selection → action / re-prompt).
//
// Runner: npx tsx scripts/heraldTest/osAmbiguity.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  nameMatchesQuery,
  findContactByRelationship,
  type Contact,
} from '../../src/db/contactsDB.ts';
import {
  resolveContactCallIntent,
  DOMAIN_WRITERS,
  type CommitResult,
} from '../../src/routing/routeIntent.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { dispatchAction } from '../../src/screens/chat/dispatch.ts';
import type { DispatchDeps } from '../../src/screens/chat/dispatch.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

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
  row: Pick<Contact, 'id' | 'name'> & Partial<Contact>,
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, address, email, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.address ?? null,
    row.email ?? null,
    row.importance ?? 5,
    now,
    now,
    null,
  );
}

function contactCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NULL`).get() as { n: number }).n;
}

function dialPhone(result: CommitResult): string | undefined {
  return result.status === 'committed' && result.effect?.kind === 'dial' ? result.effect.phone : undefined;
}

type OsContact = {
  id?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phoneNumbers?: Array<{ number?: string }>;
};

/**
 * Mirror of ChatScreen.resolveContactPhone Pass-2 phoneable selection
 * (union exact+partial → dedupe → phoneable). Kept in sync via T-OSA-SRC-*.
 */
function phoneableOsMatches(data: OsContact[], clean: string): OsContact[] {
  const exactMatches = data.filter(c =>
    c.name?.toLowerCase() === clean ||
    c.firstName?.toLowerCase() === clean ||
    c.lastName?.toLowerCase() === clean
  );
  const partialMatches = data.filter(c => nameMatchesQuery(c.name, clean));
  const deduped = new Map<string, OsContact>();
  for (const c of [...exactMatches, ...partialMatches]) {
    const phoneDigits = c.phoneNumbers?.[0]?.number?.replace(/\D/g, '') ?? '';
    const key = c.id
      ? `id:${c.id}`
      : `np:${(c.name ?? '').trim().toLowerCase()}|${phoneDigits}`;
    if (!deduped.has(key)) deduped.set(key, c);
  }
  return [...deduped.values()].filter(c => !!c.phoneNumbers?.[0]?.number?.trim());
}

function osShapeFromPhoneable(phoneable: OsContact[], nameOrRelation: string) {
  if (phoneable.length === 0) return null;
  if (phoneable.length === 1) {
    const match = phoneable[0];
    return {
      phone: match.phoneNumbers![0].number!.replace(/\D/g, ''),
      name: match.name ?? nameOrRelation,
      source: 'device' as const,
    };
  }
  const candidateNames = phoneable
    .map(c => c.name)
    .filter((n): n is string => !!n)
    .slice(0, 5);
  const deviceCandidates = phoneable
    .map(c => ({
      name: c.name ?? nameOrRelation,
      phone: c.phoneNumbers![0].number!.replace(/\D/g, ''),
    }))
    .slice(0, 5);
  return {
    phone: null as null,
    name: nameOrRelation,
    source: 'device' as const,
    candidateNames,
    deviceCandidates,
  };
}

type ResolveContactResult =
  | { phone: string; name: string; contactId?: string; source: 'herald' | 'device' }
  | { phone: null; name: string; source: 'device'; candidateNames: string[]; deviceCandidates: { name: string; phone: string }[] }
  | null;

async function addPending(
  intent: IntentRecord,
  ctx?: { resolveContact?: (n: string) => Promise<ResolveContactResult> },
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '', ctx);
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  return result;
}

function makeSmsDeps(opts: {
  resolveContactPhone: DispatchDeps['resolveContactPhone'];
  openURLs?: string[];
  messages?: string[];
  pendingRef?: { current: DispatchDeps['pendingContactCollectRef']['current'] };
  session?: ConversationSession;
}): DispatchDeps {
  const messages = opts.messages ?? [];
  const openURLs = opts.openURLs ?? [];
  const pendingRef = opts.pendingRef ?? { current: null };
  const session = opts.session ?? new ConversationSession();
  return {
    session,
    addMessage: (m) => { messages.push(m.content); },
    speak: () => {},
    setInputText: () => {},
    sendingRef: { current: false },
    generateId: (prefix) => `${prefix}_t`,
    llmStatus: 'ready',
    getCtx: () => null,
    resolveContactPhone: opts.resolveContactPhone,
    handleCalendarAction: async () => {},
    handleMapsAction: async () => {},
    launchAndroidTimer: async () => false,
    handleLaunchActionRef: { current: null },
    pendingContactCollectRef: pendingRef,
    platformOS: 'android',
    openURL: async (url) => { openURLs.push(url); },
  };
}

export async function runOsAmbiguityTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- OS Ambiguity Contract Tests ---------------------------${RESET}\n`);

  const chatScreenPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/screens/ChatScreen.tsx',
  );
  const chatSrc = fs.readFileSync(chatScreenPath, 'utf8');
  const resolveFnStart = chatSrc.indexOf('const resolveContactPhone = async');
  const resolveFnEnd = chatSrc.indexOf('resolveContactPhoneRef.current = resolveContactPhone');
  const resolveFnSrc = resolveFnStart >= 0 && resolveFnEnd > resolveFnStart
    ? chatSrc.slice(resolveFnStart, resolveFnEnd)
    : '';

  // ── Source locks: ChatScreen.resolveContactPhone Pass-2 ─────────────────
  assert('T-OSA-SRC-1 no exact-only short-circuit ternary in resolveContactPhone',
    resolveFnSrc.includes('exactMatches.length > 0 ? exactMatches : partialMatches'),
    v => v === false,
    'ternary absent from resolveContactPhone');
  assert('T-OSA-SRC-2 phoneable.length >= 2 ambiguity gate present in resolveContactPhone',
    /phoneable\.length\s*>=\s*2/.test(resolveFnSrc),
    v => v === true,
    'phoneable.length >= 2 present');

  // ── Named-person: ChatScreen OS match algorithm (mirrors Pass-2) ─────────
  {
    const data: OsContact[] = [
      { id: '1', name: 'Paul', phoneNumbers: [{ number: '' }] },
      { id: '2', name: 'Paula Reed', phoneNumbers: [] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    const shape = osShapeFromPhoneable(phoneable, 'Paul');
    assert('T-OSA-MATCH-0 zero phoneable OS matches → null',
      { n: phoneable.length, shape },
      v => v.n === 0 && v.shape === null,
      'null');
  }
  {
    const data: OsContact[] = [
      { id: '1', name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
      { id: '2', name: 'Paul Jones', phoneNumbers: [{ number: '' }] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    const shape = osShapeFromPhoneable(phoneable, 'Paul');
    assert('T-OSA-MATCH-1 exactly one phoneable → single definitive result',
      shape,
      v => !!v && 'phone' in v && v.phone === '5551112222' && v.name === 'Paul Smith' && !('candidateNames' in v),
      "{ phone, name: 'Paul Smith', source: 'device' }");
  }
  {
    const data: OsContact[] = [
      { id: '1', name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
      { id: '2', name: 'Paul Jones', phoneNumbers: [{ number: '555-333-4444' }] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    const shape = osShapeFromPhoneable(phoneable, 'Paul');
    assert('T-OSA-MATCH-2 multiple phoneable → ambiguity shape with real names, no single phone',
      shape,
      v => !!v && v.phone === null
        && Array.isArray(v.candidateNames)
        && v.candidateNames.includes('Paul Smith')
        && v.candidateNames.includes('Paul Jones')
        && Array.isArray(v.deviceCandidates)
        && v.deviceCandidates.length === 2,
      'phone:null + both names in candidateNames/deviceCandidates');
  }
  {
    // Exact "Paul" + partial "Paul Smith" must both survive (no exact-only short-circuit).
    const data: OsContact[] = [
      { id: 'exact', name: 'Paul', phoneNumbers: [{ number: '555-000-0001' }] },
      { id: 'partial', name: 'Paul Smith', phoneNumbers: [{ number: '555-000-0002' }] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    assert('T-OSA-MATCH-3 exact + partial coexist → all phoneable remain visible',
      phoneable.map(c => c.name).sort(),
      v => Array.isArray(v) && v.length === 2 && v[0] === 'Paul' && v[1] === 'Paul Smith',
      "['Paul', 'Paul Smith']");
  }
  {
    const data: OsContact[] = [
      { id: 'dup', name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
      { id: 'dup', name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
      { id: 'other', name: 'Paul Jones', phoneNumbers: [{ number: '555-333-4444' }] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    assert('T-OSA-MATCH-4 duplicate id deduped without dropping distinct people',
      phoneable.map(c => c.id).sort(),
      v => Array.isArray(v) && v.length === 2 && v.includes('dup') && v.includes('other'),
      "['dup', 'other']");
  }
  {
    // No id — distinct name+phone pairs must both remain.
    const data: OsContact[] = [
      { name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
      { name: 'Paul Smith', phoneNumbers: [{ number: '555-999-8888' }] },
    ];
    const phoneable = phoneableOsMatches(data, 'paul');
    assert('T-OSA-MATCH-5 distinct name+phone pairs kept (no false collapse)',
      phoneable.map(c => c.phoneNumbers![0].number!.replace(/\D/g, '')).sort(),
      v => Array.isArray(v) && v.length === 2 && v[0] === '5551112222' && v[1] === '5559998888',
      'two distinct phones');
  }
  {
    const data: OsContact[] = [
      { id: '2', name: 'Paul Jones', phoneNumbers: [{ number: '555-333-4444' }] },
      { id: '1', name: 'Paul Smith', phoneNumbers: [{ number: '555-111-2222' }] },
    ];
    const shape = osShapeFromPhoneable(phoneableOsMatches(data, 'paul'), 'Paul');
    assert('T-OSA-MATCH-6 ≥2 phoneable never returns a single phone (no top-1)',
      shape,
      v => !!v && v.phone === null && (v.deviceCandidates?.length ?? 0) >= 2,
      'phone:null with ≥2 deviceCandidates');
  }

  // ── CALL named-person: resolveContactCallIntent + contact_call writer ─────
  {
    freshDB();
    const intent = await resolveContactCallIntent('Paul', 'call Paul', {
      resolveContact: async () => null,
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-CALL-0 zero phoneable OS → honest collect',
      { intent, pending },
      v => !('devicePhone' in v.intent && (v.intent as { devicePhone?: string }).devicePhone)
        && !((v.intent as { candidates?: unknown[] }).candidates?.length)
        && v.pending.status === 'pending'
        && /don't have a number for Paul/i.test(v.pending.prompt),
      'collect pending for Paul');
  }
  {
    freshDB();
    const intent = await resolveContactCallIntent('Paul', 'call Paul', {
      resolveContact: async () => ({
        phone: '5551112222',
        name: 'Paul Smith',
        source: 'device',
      }),
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-CALL-1 exactly one phoneable OS → device confirm (action may proceed)',
      { intent, pending },
      v => (v.intent as { devicePhone?: string }).devicePhone === '5551112222'
        && v.pending.status === 'pending'
        && /Paul Smith/i.test(v.pending.prompt)
        && /want me to call/i.test(v.pending.prompt),
      'deviceConfirm for Paul Smith');
    const yes = await pending.resume('yes');
    assert('T-OSA-CALL-1b confirm YES → dial Paul Smith',
      dialPhone(yes),
      v => v === '5551112222',
      'dial 5551112222');
  }
  {
    freshDB();
    const intent = await resolveContactCallIntent('Paul', 'call Paul', {
      resolveContact: async () => ({
        phone: null,
        name: 'Paul',
        source: 'device',
        candidateNames: ['Paul Smith', 'Paul Jones'],
        deviceCandidates: [
          { name: 'Paul Smith', phone: '5551112222' },
          { name: 'Paul Jones', phone: '5553334444' },
        ],
      }),
    });
    const cands = (intent as { candidates?: Array<{ name: string; phone: string }> }).candidates ?? [];
    assert('T-OSA-CALL-2 multi phoneable → intent ambiguity shape with real names, no single phone',
      { cands, devicePhone: (intent as { devicePhone?: string }).devicePhone },
      v => v.devicePhone == null
        && v.cands.length === 2
        && v.cands.some(c => c.name === 'Paul Smith' && c.phone === '5551112222')
        && v.cands.some(c => c.name === 'Paul Jones' && c.phone === '5553334444'),
      'two named candidates; no devicePhone');
    const pending = await addPending(intent);
    assert('T-OSA-CALL-2b multi → pending (never silent dial / top-1)',
      { status: pending.status, phone: dialPhone(pending as CommitResult) },
      v => v.status === 'pending' && !v.phone,
      'pending, no dial');
  }
  {
    const db = freshDB();
    const intent = await resolveContactCallIntent('Paul', 'call Paul', {
      resolveContact: async () => ({
        phone: null,
        name: 'Paul',
        source: 'device',
        candidateNames: ['Paul Smith', 'Paul Jones'],
        deviceCandidates: [
          { name: 'Paul Smith', phone: '5551112222' },
          { name: 'Paul Jones', phone: '5553334444' },
        ],
      }),
    });
    const pending = await addPending(intent);
    const before = contactCount(db);
    const picked = await pending.resume('Paul Jones');
    const after = contactCount(db);
    assert('T-OSA-CALL-3 select exact displayed name → dial that candidate',
      { phone: dialPhone(picked), after, before },
      v => v.phone === '5553334444' && v.after === v.before,
      'dial Paul Jones 5553334444; no new contact write required');
  }
  {
    const db = freshDB();
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('Paul', 'call Paul', {
      resolveContact: async () => ({
        phone: null,
        name: 'Paul',
        source: 'device',
        candidateNames: ['Paul Smith', 'Paul Jones'],
        deviceCandidates: [
          { name: 'Paul Smith', phone: '5551112222' },
          { name: 'Paul Jones', phone: '5553334444' },
        ],
      }),
    });
    const pending = await addPending(intent);
    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: pending.kind ?? 'standard',
      reaskPrompt: pending.reaskPrompt,
    });
    const before = contactCount(db);
    const bad = await session.resolvePending('zzzz-not-a-person');
    const afterBad = contactCount(db);
    assert('T-OSA-CALL-4 invalid selection → re-prompt; session stays pending; no collect write',
      {
        status: bad.status,
        phone: dialPhone(bad),
        before,
        afterBad,
        stillPending: session.hasPending(),
      },
      v => (v.status === 'pending' || v.status === 'noop')
        && !v.phone
        && v.before === v.afterBad
        && v.stillPending === true,
      're-prompt pending; no dial; no contact write');

    const ok = await session.resolvePending('Paul Jones');
    const afterOk = contactCount(db);
    const byRel = findContactByRelationship('paul');
    assert('T-OSA-CALL-4b later valid displayed name → dial; no contact/relationship write',
      { phone: dialPhone(ok), afterOk, before, byRel, status: ok.status },
      v => v.status === 'committed'
        && v.phone === '5553334444'
        && v.afterOk === v.before
        && v.byRel == null,
      'dial Paul Jones 5553334444; zero new rows');
  }

  // ── CALL pure-relationship fallback (preserves c30ed9a1) ────────────────
  {
    freshDB();
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => null,
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-REL-0 zero candidates → existing honest collect prompt',
      pending,
      v => v.status === 'pending' && /don't have a number for wife|don't know who your wife/i.test(v.prompt),
      'honest collect for wife');
  }
  {
    freshDB();
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: '5550300300',
        name: 'Shannon Martys',
        source: 'device',
      }),
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-REL-1 one OS candidate → existing single-match device confirm',
      pending,
      v => v.status === 'pending' && /Shannon Martys/i.test(v.prompt) && /want me to call/i.test(v.prompt),
      'deviceConfirm Shannon Martys');
  }
  {
    freshDB();
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: null,
        name: 'wife',
        source: 'device',
        candidateNames: ['Shannon A', 'Shannon B'],
        deviceCandidates: [
          { name: 'Shannon A', phone: '5551111111' },
          { name: 'Shannon B', phone: '5552222222' },
        ],
      }),
    });
    const pending = await addPending(intent);
    assert('T-OSA-REL-2 multiple candidates → named disambiguation prompt (c30ed9a1)',
      pending,
      v => v.status === 'pending'
        && /I found a few in your contacts/i.test(v.prompt)
        && /Shannon A/i.test(v.prompt)
        && /Shannon B/i.test(v.prompt)
        && !/did you mean/i.test(v.prompt),
      'named which-one prompt');
  }
  {
    const db = freshDB();
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: null,
        name: 'wife',
        source: 'device',
        candidateNames: ['Shannon A', 'Shannon B'],
        deviceCandidates: [
          { name: 'Shannon A', phone: '5551111111' },
          { name: 'Shannon B', phone: '5552222222' },
        ],
      }),
    });
    const pending = await addPending(intent);
    const before = contactCount(db);
    const picked = await pending.resume('Shannon B');
    const after = contactCount(db);
    const byRel = findContactByRelationship('wife');
    assert('T-OSA-REL-3 user selection → dial only; no relationship / contact write',
      { phone: dialPhone(picked), before, after, byRel },
      v => v.phone === '5552222222' && v.before === 0 && v.after === 0 && v.byRel == null,
      'dial Shannon B; zero rows; no wife relationship');
  }
  {
    const db = freshDB();
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: null,
        name: 'wife',
        source: 'device',
        candidateNames: ['Shannon A', 'Shannon B'],
        deviceCandidates: [
          { name: 'Shannon A', phone: '5551111111' },
          { name: 'Shannon B', phone: '5552222222' },
        ],
      }),
    });
    const pending = await addPending(intent);
    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: pending.kind ?? 'standard',
      reaskPrompt: pending.reaskPrompt,
    });
    const before = contactCount(db);
    const bad = await session.resolvePending('not-in-list');
    const afterBad = contactCount(db);
    assert('T-OSA-REL-4 invalid selection → re-prompt; session stays pending; no write',
      {
        status: bad.status,
        phone: dialPhone(bad),
        before,
        afterBad,
        stillPending: session.hasPending(),
      },
      v => (v.status === 'pending' || v.status === 'noop')
        && !v.phone
        && v.before === v.afterBad
        && v.stillPending === true,
      're-prompt pending; no dial; no write');

    const ok = await session.resolvePending('Shannon B');
    const afterOk = contactCount(db);
    const byRel = findContactByRelationship('wife');
    assert('T-OSA-REL-4b later valid displayed name → dial; no contact/relationship write',
      { phone: dialPhone(ok), afterOk, before, byRel, status: ok.status },
      v => v.status === 'committed'
        && v.phone === '5552222222'
        && v.afterOk === v.before
        && v.byRel == null,
      'dial Shannon B 5552222222; zero rows; no wife relationship');
  }

  // ── Controls: Herald wife / named Herald unchanged ───────────────────────
  {
    const db = freshDB();
    insertContact(db, { id: 'c_wife', name: 'Shannon', relationship: 'wife', phone: '555-030-0300', importance: 9 });
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => { throw new Error('OS must not run for Herald single'); },
    });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-CTL-CALL-wife Herald single Shannon still dials (no OS)',
      { status: result.status, phone: dialPhone(result), ack: result.status === 'committed' ? result.ack : '' },
      v => v.status === 'committed' && v.phone === '5550300300' && /Calling Shannon/i.test(v.ack),
      'Calling Shannon from Herald');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_paul', name: 'Paul Smith', phone: '555-777-8888', importance: 7 });
    const intent = await resolveContactCallIntent('Paul Smith', 'call Paul Smith', {
      resolveContact: async () => { throw new Error('OS must not run for Herald named'); },
    });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-CTL-CALL-named Herald contact unchanged',
      { status: result.status, phone: dialPhone(result) },
      v => v.status === 'committed' && v.phone === '5557778888',
      'Herald Paul Smith dial');
  }

  // ── TEXT named-person via dispatchAction (full prompt → select → open) ───
  {
    freshDB();
    const messages: string[] = [];
    const openURLs: string[] = [];
    const pendingRef = { current: null as DispatchDeps['pendingContactCollectRef']['current'] };
    const deps = makeSmsDeps({
      messages,
      openURLs,
      pendingRef,
      resolveContactPhone: async () => null,
    });
    await dispatchAction({ type: 'sms', contact: 'Paul', message: '' }, 'text Paul', deps);
    assert('T-OSA-TEXT-0 zero phoneable OS → honest number collect',
      { messages, pending: pendingRef.current },
      v => v.messages.some((m: string) => /don't have a number for Paul/i.test(m))
        && v.pending?.action === 'text'
        && v.pending?.name === 'Paul',
      'ask for number; pendingContactCollectRef set');
  }
  {
    freshDB();
    const openURLs: string[] = [];
    const messages: string[] = [];
    const deps = makeSmsDeps({
      messages,
      openURLs,
      resolveContactPhone: async () => ({
        phone: '5551112222',
        name: 'Paul Smith',
        source: 'device',
      }),
    });
    await dispatchAction({ type: 'sms', contact: 'Paul', message: 'hi' }, 'text Paul hi', deps);
    assert('T-OSA-TEXT-1 exactly one phoneable → open message (action proceeds)',
      { openURLs, messages },
      v => v.openURLs.some((u: string) => u.startsWith('sms:5551112222'))
        && v.messages.some((m: string) => /Opening a message to Paul Smith/i.test(m)),
      'sms:5551112222 opened');
  }
  {
    freshDB();
    const messages: string[] = [];
    const openURLs: string[] = [];
    const session = new ConversationSession();
    const pendingRef = { current: null as DispatchDeps['pendingContactCollectRef']['current'] };
    const osBook: Record<string, ResolveContactResult> = {
      paul: {
        phone: null,
        name: 'Paul',
        source: 'device',
        candidateNames: ['Paul Smith', 'Paul Jones'],
        deviceCandidates: [
          { name: 'Paul Smith', phone: '5551112222' },
          { name: 'Paul Jones', phone: '5553334444' },
        ],
      },
      'paul jones': {
        phone: '5553334444',
        name: 'Paul Jones',
        source: 'device',
      },
      'paul smith': {
        phone: '5551112222',
        name: 'Paul Smith',
        source: 'device',
      },
    };
    const deps = makeSmsDeps({
      messages,
      openURLs,
      session,
      pendingRef,
      resolveContactPhone: async (q) => {
        const key = q.trim().toLowerCase();
        return osBook[key] ?? osBook[key.replace(/^(?:my|the|a)\s+/, '')] ?? null;
      },
    });
    await dispatchAction({ type: 'sms', contact: 'Paul', message: '' }, 'text Paul', deps);
    assert('T-OSA-TEXT-2 multi phoneable → ambiguity prompt with real names; no sms URL yet',
      { messages, openURLs, hasPending: session.hasPending() },
      v => v.openURLs.length === 0
        && v.hasPending === true
        && v.messages.some((m: string) => /more than one Paul/i.test(m))
        && v.messages.some((m: string) => /Paul Smith/i.test(m) && /Paul Jones/i.test(m)),
      'names in prompt; no openURL');

    // Invalid selection → noop / re-prompt; no collect write
    const bad = await session.resolvePending('zzzz-not-a-person');
    assert('T-OSA-TEXT-3 invalid selection → re-prompt; no number-collect write',
      { bad, pendingRef: pendingRef.current, openURLs, stillPending: session.hasPending() },
      v => v.openURLs.length === 0
        && v.pendingRef == null
        && (v.bad.status === 'pending' || v.bad.status === 'noop')
        && v.stillPending === true,
      're-prompt pending; no collect ref; no sms open');

    const ok = await session.resolvePending('Paul Jones');
    assert('T-OSA-TEXT-4 select exact displayed name → open message to that candidate',
      { ok, openURLs },
      v => v.openURLs.some((u: string) => u.startsWith('sms:5553334444'))
        && (v.ok as CommitResult).status === 'committed',
      'sms:5553334444');
  }

  // ── TEXT pure-relationship + Herald controls ─────────────────────────────
  {
    const db = freshDB();
    const messages: string[] = [];
    const openURLs: string[] = [];
    const session = new ConversationSession();
    const pendingRef = { current: null as DispatchDeps['pendingContactCollectRef']['current'] };
    const deps = makeSmsDeps({
      messages,
      openURLs,
      session,
      pendingRef,
      resolveContactPhone: async (q) => {
        const key = q.trim().toLowerCase();
        if (key === 'shannon a') {
          return { phone: '5551111111', name: 'Shannon A', source: 'device' as const };
        }
        if (key === 'shannon b') {
          return { phone: '5552222222', name: 'Shannon B', source: 'device' as const };
        }
        return {
          phone: null,
          name: 'wife',
          source: 'device' as const,
          candidateNames: ['Shannon A', 'Shannon B'],
          deviceCandidates: [
            { name: 'Shannon A', phone: '5551111111' },
            { name: 'Shannon B', phone: '5552222222' },
          ],
        };
      },
    });
    // identity none for wife → OS fallthrough
    await dispatchAction({ type: 'sms', contact: 'wife', message: '' }, 'text my wife', deps);
    assert('T-OSA-TEXT-REL-1 multi OS for relationship label → named ask (no top-1)',
      { messages, openURLs },
      v => v.openURLs.length === 0
        && v.messages.some((m: string) => /Shannon A/i.test(m) && /Shannon B/i.test(m)),
      'both names; no sms yet');
    const before = contactCount(db);
    await session.resolvePending('Shannon A');
    const byRel = findContactByRelationship('wife');
    assert('T-OSA-TEXT-REL-2 selection opens message; no relationship write',
      { openURLs, byRel, before, after: contactCount(db) },
      v => v.openURLs.some((u: string) => u.startsWith('sms:5551111111'))
        && v.byRel == null
        && v.before === 0
        && v.after === 0,
      'sms Shannon A; no wife row');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_wife', name: 'Shannon', relationship: 'wife', phone: '555-030-0300', importance: 9 });
    const openURLs: string[] = [];
    const messages: string[] = [];
    const deps = makeSmsDeps({
      messages,
      openURLs,
      resolveContactPhone: async () => { throw new Error('OS must not run for Herald wife'); },
    });
    await dispatchAction({ type: 'sms', contact: 'wife', message: '' }, 'text my wife', deps);
    assert('T-OSA-CTL-TEXT-wife Herald single Shannon still texts (no OS)',
      { openURLs, messages },
      v => v.openURLs.some((u: string) => u.startsWith('sms:5550300300'))
        && v.messages.some((m: string) => /Opening a message to Shannon/i.test(m)),
      'sms Shannon from Herald');
  }
  {
    // c30ed9a1 presentation intact: relationship multi still uses named "I found a few" on CALL
    freshDB();
    const intent = await resolveContactCallIntent('father-in-law', 'call my father-in-law', {
      resolveContact: async () => ({
        phone: null,
        name: 'father-in-law',
        source: 'device',
        candidateNames: ['David Mossholder', 'David Clevenger'],
        deviceCandidates: [
          { name: 'David Mossholder', phone: '2145551212' },
          { name: 'David Clevenger', phone: '2145553434' },
        ],
      }),
    });
    const pending = await addPending(intent);
    assert('T-OSA-CTL-c30ed9a1 relationship presentation remains named multi-ask',
      pending,
      v => /I found a few in your contacts/i.test(v.prompt)
        && /Mossholder/i.test(v.prompt)
        && /Clevenger/i.test(v.prompt),
      'c30ed9a1 named prompt intact');
  }

  // ── Resume-boundary regressions (snapshot phone + shared matcher) ────────
  {
    // SMS: select displayed candidate opens SMS from pending phone — no second OS lookup.
    freshDB();
    const messages: string[] = [];
    const openURLs: string[] = [];
    const session = new ConversationSession();
    let osLookups = 0;
    const deps = makeSmsDeps({
      messages,
      openURLs,
      session,
      resolveContactPhone: async (q) => {
        osLookups += 1;
        const key = q.trim().toLowerCase().replace(/^(?:my|the|a)\s+/, '');
        if (key === 'mom') {
          return {
            phone: null,
            name: 'Mom',
            source: 'device',
            candidateNames: ['Mom', 'My Mom'],
            deviceCandidates: [
              { name: 'Mom', phone: '5550001111' },
              { name: 'My Mom', phone: '5550002222' },
            ],
          };
        }
        // Any resume-time re-lookup would hit here and must not run.
        throw new Error(`unexpected second OS lookup for: ${q}`);
      },
    });
    await dispatchAction({ type: 'sms', contact: 'Mom', message: '' }, 'text Mom', deps);
    assert('T-OSA-SMS-SNAP-1 multi candidate → named ask; discovery OS lookup only',
      { messages, openURLs, osLookups, hasPending: session.hasPending() },
      v => v.openURLs.length === 0
        && v.hasPending === true
        && v.osLookups === 1
        && v.messages.some((m: string) => /Mom/i.test(m) && /My Mom/i.test(m)),
      'pending with both names; one OS call');

    const bad = await session.resolvePending('zzzz-not-a-person');
    assert('T-OSA-SMS-SNAP-2 invalid reply → re-prompt; still no second OS lookup',
      { bad, openURLs, osLookups, stillPending: session.hasPending() },
      v => v.openURLs.length === 0
        && v.osLookups === 1
        && v.stillPending === true
        && (v.bad.status === 'pending' || v.bad.status === 'noop'),
      're-prompt; lookup count stays 1');

    const ok = await session.resolvePending('My Mom');
    assert('T-OSA-SMS-SNAP-3 select displayed candidate → open SMS; no second OS lookup',
      { ok, openURLs, osLookups },
      v => v.osLookups === 1
        && v.openURLs.some((u: string) => u.startsWith('sms:5550002222'))
        && (v.ok as CommitResult).status === 'committed',
      'sms:5550002222 from snapshot phone');
  }
  {
    // CALL: "My Dad" must bind to stored snapshot via matchCandidateToken (not label-strip matcher).
    const db = freshDB();
    const session = new ConversationSession();
    const intent = await resolveContactCallIntent('Dad', 'call Dad', {
      resolveContact: async () => ({
        phone: null,
        name: 'Dad',
        source: 'device',
        candidateNames: ['Mikes Dad', 'My Dad', 'Dad-home'],
        deviceCandidates: [
          { name: 'Mikes Dad', phone: '5551001001' },
          { name: 'My Dad', phone: '5551001002' },
          { name: 'Dad-home', phone: '5551001003' },
        ],
      }),
    });
    const pending = await addPending(intent);
    assert('T-OSA-CALL-SNAP-1 multi Dad candidates → named which-one ask',
      pending,
      v => v.status === 'pending'
        && /I found a few in your contacts/i.test(v.prompt)
        && /My Dad/i.test(v.prompt)
        && /Mikes Dad/i.test(v.prompt),
      'named multi prompt with My Dad');

    session.setPending({
      pendingKey: pending.pendingKey,
      resume: pending.resume,
      kind: pending.kind ?? 'standard',
      reaskPrompt: pending.reaskPrompt,
    });
    const before = contactCount(db);
    const bad = await session.resolvePending('zzzz-not-a-person');
    assert('T-OSA-CALL-SNAP-2 invalid reply → re-prompt; no dial; no write',
      {
        status: bad.status,
        phone: dialPhone(bad),
        stillPending: session.hasPending(),
        before,
        after: contactCount(db),
      },
      v => (v.status === 'pending' || v.status === 'noop')
        && !v.phone
        && v.stillPending === true
        && v.before === v.after,
      're-prompt pending');

    const ok = await session.resolvePending('My Dad');
    assert('T-OSA-CALL-SNAP-3 reply "My Dad" binds snapshot → dial that phone',
      { status: ok.status, phone: dialPhone(ok), after: contactCount(db), before },
      v => v.status === 'committed'
        && v.phone === '5551001002'
        && v.after === v.before,
      'dial My Dad 5551001002; no write');
  }
  {
    // Normalization variants against the same stored representation.
    freshDB();
    const intent = await resolveContactCallIntent('Dad', 'call Dad', {
      resolveContact: async () => ({
        phone: null,
        name: 'Dad',
        source: 'device',
        candidateNames: ['Mikes Dad', 'My Dad', 'Dad-home'],
        deviceCandidates: [
          { name: 'Mikes Dad', phone: '5551001001' },
          { name: 'My Dad', phone: '5551001002' },
          { name: 'Dad-home', phone: '5551001003' },
        ],
      }),
    });
    const pending = await addPending(intent);
    const a = await pending.resume('my dad');
    assert('T-OSA-CALL-SNAP-4 normalize variant "my dad" → dial My Dad',
      { status: a.status, phone: dialPhone(a) },
      v => v.status === 'committed' && v.phone === '5551001002',
      'my dad → 5551001002');
  }
  {
    // Control: Josh remains Herald identity path (no OS when seeded).
    const db = freshDB();
    insertContact(db, { id: 'c_josh', name: 'Josh Durand', phone: '9725550101', importance: 9 });
    const intent = await resolveContactCallIntent('Josh', 'call Josh', {
      resolveContact: async () => { throw new Error('OS must not run for Herald Josh'); },
    });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OSA-CTL-CALL-Josh Herald identity path unchanged',
      { status: result.status, phone: dialPhone(result) },
      v => v.status === 'committed' && v.phone === '9725550101',
      'Calling Josh from Herald');
  }
  {
    // No diagnostic residue in production sources.
    const roots = [
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/routeIntent.ts'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/chat/dispatch.ts'),
    ];
    const hits = roots.flatMap(f => {
      const src = fs.readFileSync(f, 'utf8');
      return src.includes('[OSA-DIAG]') ? [path.basename(f)] : [];
    });
    assert('T-OSA-SRC-DIAG no [OSA-DIAG] residue in production sources',
      hits,
      v => (v as string[]).length === 0,
      'ChatScreen / routeIntent / dispatch clean');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}OS Ambiguity: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('osAmbiguity.test.ts')) {
  runOsAmbiguityTests().catch(console.error);
}
