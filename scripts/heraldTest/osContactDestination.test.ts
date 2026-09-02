// scripts/heraldTest/osContactDestination.test.ts
// Deterministic CALL/SMS OS destination resolution (identity vs capability).
//
// Runner: npx tsx scripts/heraldTest/osContactDestination.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import type { Contact } from '../../src/db/contactsDB.ts';
import {
  firstUsablePhoneDigits,
  osNameFullyCovered,
  osNameQuery,
  refineOsNameQuery,
  selectPhoneableOsDestinations,
} from '../../src/utils/osContactDestination.ts';
import {
  resolveContactCallIntent,
  DOMAIN_WRITERS,
  type CommitResult,
} from '../../src/routing/routeIntent.ts';
import { dispatchAction } from '../../src/screens/chat/dispatch.ts';
import type { DispatchDeps } from '../../src/screens/chat/dispatch.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';

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
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    fact TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence TEXT NOT NULL DEFAULT 'stated',
    created_at TEXT NOT NULL
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
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.name,
    row.relationship ?? null,
    row.phone ?? null,
    row.importance ?? 5,
    now,
    now,
    null,
  );
}

function dialPhone(result: CommitResult): string | undefined {
  return result.status === 'committed' && result.effect?.kind === 'dial' ? result.effect.phone : undefined;
}

const SIX_JANES = [
  { id: '1', name: 'Jane Adams', phoneNumbers: [{ number: '5550000001' }] },
  { id: '2', name: 'Jane Brown', phoneNumbers: [{ number: '5550000002' }] },
  { id: '3', name: 'Jane Clark', phoneNumbers: [{ number: '5550000003' }] },
  { id: '4', name: 'Jane Davis', phoneNumbers: [{ number: '5550000004' }] },
  { id: '5', name: 'Jane Evans', phoneNumbers: [{ number: '5550000005' }] },
  { id: '6', name: 'Jane Smith', phoneNumbers: [{ number: '5550000006' }] },
];

function makeSmsDeps(opts: {
  resolveContactPhone: DispatchDeps['resolveContactPhone'];
  openURLs?: string[];
  messages?: string[];
}): DispatchDeps {
  const messages = opts.messages ?? [];
  const openURLs = opts.openURLs ?? [];
  const session = new ConversationSession();
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
    pendingContactCollectRef: { current: null },
    platformOS: 'android',
    openURL: async (url) => { openURLs.push(url); },
  };
}

export async function runOsContactDestinationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- OS Contact Destination Tests ---------------------------${RESET}\n`);

  {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const files = [
      path.join(srcDir, 'utils/osContactDestination.ts'),
      path.join(srcDir, 'routing/routeIntent.ts'),
      path.join(srcDir, 'screens/chat/dispatch.ts'),
    ];
    const hits = files.flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return /qwen|classifyWithLLM|classifyLLM/i.test(src) && f.endsWith('osContactDestination.ts')
        ? [path.basename(f)]
        : [];
    });
    assert('T-OCR-SRC destination helper has no Qwen/LLM contact choice',
      hits,
      v => (v as string[]).length === 0,
      'osContactDestination is pure');
    const destSrc = fs.readFileSync(path.join(srcDir, 'utils/osContactDestination.ts'), 'utf8');
    assert('T-OCR-SRC helper never truncates with slice(0, 5)',
      destSrc.includes('.slice(0, 5)'),
      v => v === false,
      'no top-five truncation');
  }

  assert('T-OCR-Q wife Jane Smith → OS query Jane Smith, not wife Jane Smith',
    osNameQuery('wife Jane Smith'),
    v => v === 'Jane Smith',
    'Jane Smith');
  assert('T-OCR-Q my wife Jane Smith → Jane Smith',
    osNameQuery('my wife Jane Smith'),
    v => v === 'Jane Smith',
    'Jane Smith');
  assert('T-OCR-Q relationship-only falls back to Herald given name',
    osNameQuery('wife', 'Jane'),
    v => v === 'Jane',
    'Jane');
  assert('T-OCR-Q refine Jane + It\'s Smith → Jane Smith',
    refineOsNameQuery('Jane', "It's Smith."),
    v => /^jane smith$/i.test(v),
    'Jane Smith');
  assert('T-OCR-Q refine subset correction Paul show → Paul drops leftover token',
    refineOsNameQuery('Paul show', 'Paul'),
    v => /^paul$/i.test(v),
    'Paul');
  assert('T-OCR-Q refine does not start a Smith-only search',
    refineOsNameQuery('Jane', 'Smith'),
    v => /jane/i.test(v) && /smith/i.test(v),
    'both tokens');
  assert('T-OCR-COV Jane vs Jane Smith is not fully covered',
    osNameFullyCovered('Jane', 'Jane Smith'),
    v => v === false,
    'underspecified given name');
  assert('T-OCR-COV Jane Smith vs Jane Smith is fully covered',
    osNameFullyCovered('Jane Smith', 'Jane Smith'),
    v => v === true,
    'full name');
  assert('T-OCR-PHONE later usable number wins over empty index 0',
    firstUsablePhoneDigits([{ number: '' }, { number: '555-222-3333' }]),
    v => v === '5552223333',
    '5552223333');
  {
    const given = selectPhoneableOsDestinations(SIX_JANES, 'jane');
    const refined = selectPhoneableOsDestinations(SIX_JANES, 'jane smith');
    assert('T-OCR-RANK six Janes stay visible; Jane Smith remains after refine',
      { n: given.length, smith: refined.map(c => c.name) },
      v => v.n === 6 && v.smith.length === 1 && v.smith[0] === 'Jane Smith',
      '6 given-name hits; unique Jane Smith after surname');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: null,
        name: 'Jane',
        source: 'device' as const,
        candidateNames: ['Jane Smith', 'Jane Brown', 'Jane Jones'],
        deviceCandidates: [
          { name: 'Jane Smith', phone: '5551110001' },
          { name: 'Jane Brown', phone: '5551110002' },
          { name: 'Jane Jones', phone: '5551110003' },
        ],
      }),
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OCR-CALL-A known wife, three OS Janes → clarify, no dial',
      { status: pending.status, phone: dialPhone(pending), n: intent.candidates?.length },
      v => v.status === 'pending' && !v.phone && (v.n ?? 0) >= 3,
      'pending ambiguity; no guessed dial');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const book = async (q: string) => {
      const n = q.trim().toLowerCase();
      if (n === 'jane smith') {
        return { phone: '5551110001', name: 'Jane Smith', source: 'device' as const };
      }
      if (n === 'jane') {
        return { phone: '5551110001', name: 'Jane Smith', source: 'device' as const };
      }
      return {
        phone: null,
        name: 'Jane',
        source: 'device' as const,
        candidateNames: ['Jane Smith', 'Jane Brown', 'Jane Jones'],
        deviceCandidates: [
          { name: 'Jane Smith', phone: '5551110001' },
          { name: 'Jane Brown', phone: '5551110002' },
          { name: 'Jane Jones', phone: '5551110003' },
        ],
      };
    };
    const intent = await resolveContactCallIntent('Jane', 'call Jane', { resolveContact: book });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '', { resolveContact: book });
    if (pending.status !== 'pending') throw new Error(`expected pending, got ${pending.status}`);
    const resumed = await pending.resume("It's Smith.");
    assert('T-OCR-CALL-B Call Jane then It\'s Smith → unique Jane Smith dials',
      { status: resumed.status, phone: dialPhone(resumed) },
      v => v.status === 'committed' && v.phone === '5551110001',
      'combined identity evidence; no Smith-only guess');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const seen: string[] = [];
    const book = async (q: string) => {
      seen.push(q);
      if (/jane smith/i.test(q) && !/wife/i.test(q)) {
        return { phone: '5551110001', name: 'Jane Smith', source: 'device' as const };
      }
      return null;
    };
    const intent = await resolveContactCallIntent('wife', 'call my wife Jane Smith', { resolveContact: book });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '', { resolveContact: book });
    assert('T-OCR-CALL-C full name with relationship → OS Jane Smith, unique dial',
      { status: result.status, phone: dialPhone(result), seen, intentPhone: (intent.candidates?.[0]?.phone ?? '').trim() },
      v => v.status === 'committed'
        && v.phone === '5551110001'
        && v.seen.every(q => !/\bwife\b/i.test(q))
        && v.seen.some(q => /jane smith/i.test(q)),
      'OS query is Jane Smith; CALL proceeds');
  }

  {
    freshDB();
    const intent = await resolveContactCallIntent('Jane Smith', 'call Jane Smith', {
      resolveContact: async () => ({
        phone: null,
        name: 'Jane Smith',
        source: 'device' as const,
        candidateNames: ['Jane Smith', 'Jane Smith'],
        deviceCandidates: [
          { name: 'Jane Smith', phone: '5551110001' },
          { name: 'Jane Smith', phone: '5551110009' },
        ],
      }),
    });
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OCR-CALL-D two phoneable Jane Smith records → clarify, never arbitrary dial',
      { status: pending.status, phone: dialPhone(pending), n: intent.candidates?.length },
      v => v.status === 'pending' && !v.phone && (v.n ?? 0) >= 2,
      'ambiguous full name stays fail-closed');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const openURLs: string[] = [];
    const messages: string[] = [];
    const deps = makeSmsDeps({
      messages,
      openURLs,
      resolveContactPhone: async () => ({
        phone: null,
        name: 'Jane',
        source: 'device',
        candidateNames: ['Jane Smith', 'Jane Brown', 'Jane Jones'],
        deviceCandidates: [
          { name: 'Jane Smith', phone: '5551110001' },
          { name: 'Jane Brown', phone: '5551110002' },
          { name: 'Jane Jones', phone: '5551110003' },
        ],
      }),
    });
    await dispatchAction({ type: 'sms', contact: 'wife', message: 'hi' }, 'text my wife hi', deps);
    assert('T-OCR-SMS-A ambiguous OS Janes → no sms: handoff',
      { openURLs, messages },
      v => v.openURLs.length === 0 && v.messages.some((m: string) => /more than one/i.test(m)),
      'SMS clarifies; no fabricated number');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const openURLs: string[] = [];
    const messages: string[] = [];
    const deps = makeSmsDeps({
      messages,
      openURLs,
      resolveContactPhone: async (q: string) => {
        if (/jane smith/i.test(q) && !/wife/i.test(q)) {
          return { phone: '5551110001', name: 'Jane Smith', source: 'device' as const };
        }
        return {
          phone: null,
          name: 'Jane',
          source: 'device' as const,
          candidateNames: ['Jane Smith', 'Jane Brown'],
          deviceCandidates: [
            { name: 'Jane Smith', phone: '5551110001' },
            { name: 'Jane Brown', phone: '5551110002' },
          ],
        };
      },
    });
    await dispatchAction({ type: 'sms', contact: 'wife Jane Smith', message: 'hi' }, 'text my wife Jane Smith hi', deps);
    assert('T-OCR-SMS-E unique Jane Smith → sms: handoff only after unique destination',
      { openURLs, messages },
      v => v.openURLs.some((u: string) => u.startsWith('sms:5551110001'))
        && !v.openURLs.some((u: string) => /undefined|null/i.test(u)),
      'sms:5551110001');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_w', name: 'Jane', relationship: 'wife', importance: 7 });
    const intent = await resolveContactCallIntent('wife', 'call my wife', {
      resolveContact: async () => ({
        phone: '5550001111',
        name: 'Jane Smith',
        source: 'device' as const,
      }),
    });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OCR-CALL-NEG unique Jane Smith for given-name Jane is not a silent dial',
      { status: result.status, phone: dialPhone(result) },
      v => v.status === 'pending' && !v.phone,
      'underspecified unique OS stays collect');
  }

  {
    freshDB();
    const intent = await resolveContactCallIntent('Jane Smith', 'call Jane Smith', {
      resolveContact: async () => ({
        phone: '5551110001',
        name: 'Jane Smith',
        source: 'device' as const,
      }),
    });
    const result = await DOMAIN_WRITERS['contact_call']!.add(intent, '');
    assert('T-OCR-CALL-NEG no fabricated phone — unique full name uses provided digits only',
      { status: result.status, phone: dialPhone(result) },
      v => (v.status === 'committed' && v.phone === '5551110001')
        || (v.status === 'pending' && !v.phone),
      'device confirm or dial with real number');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}OS Contact Destination: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('osContactDestination.test.ts')) {
  runOsContactDestinationTests().catch(console.error);
}
