// SMS Contact Continuation V1 — preserve SMS task/body while resolving recipient.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { type Contact, findContactByRelationship } from '../../src/db/contactsDB.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  CALL_TEXT_RECOVERY_KEY,
  SMS_OS_DISAMBIGUATE_KEY,
} from '../../src/routing/callTextReadiness.ts';
import { dispatchAction } from '../../src/screens/chat/dispatch.ts';
import type { DispatchDeps } from '../../src/screens/chat/dispatch.ts';
import { DOMAIN_WRITERS, resolveContactCallIntent } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const DIST_BODY = 'it was good talking with you yesterday';

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
  CREATE TABLE IF NOT EXISTS local_profile (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

function smsBody(url: string): string | null {
  const i = url.indexOf('?body=');
  if (i < 0) return '';
  return decodeURIComponent(url.slice(i + 6));
}

function makeSmsDeps(opts: {
  resolveContactPhone?: DispatchDeps['resolveContactPhone'];
  openURLs?: string[];
  messages?: string[];
  session?: ConversationSession;
  pendingRef?: { current: DispatchDeps['pendingContactCollectRef']['current'] };
}): DispatchDeps {
  const messages = opts.messages ?? [];
  const openURLs = opts.openURLs ?? [];
  const session = opts.session ?? new ConversationSession();
  const pendingRef = opts.pendingRef ?? { current: null };
  return {
    session,
    addMessage: (m) => { messages.push(m.content); },
    speak: () => {},
    setInputText: () => {},
    sendingRef: { current: false },
    generateId: (prefix) => `${prefix}_t`,
    llmStatus: 'ready',
    getCtx: () => null,
    resolveContactPhone: opts.resolveContactPhone ?? (async () => null),
    handleCalendarAction: async () => {},
    handleMapsAction: async () => {},
    launchAndroidTimer: async () => false,
    handleLaunchActionRef: { current: null },
    pendingContactCollectRef: pendingRef,
    platformOS: 'android',
    openURL: async (url) => { openURLs.push(url); },
  };
}

const routeDeps = {
  classifyQuery,
  classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
  llmReady: false,
  captureContext: { contacts: [] as string[], lists: [] as string[] },
};

function contactCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NULL').get() as { n: number }).n;
}

export async function runSmsContactContinuationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- SMS Contact Continuation V1 ---------------------------${RESET}\n`);

  const osJoshSmith = async (q: string) => {
    const key = q.trim().toLowerCase();
    if (key.includes('josh') && key.includes('smith')) {
      return { phone: '5551234567', name: 'Josh Smith', source: 'device' as const };
    }
    return null;
  };

  // A — SMS task survives OS name refinement
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const pendingRef = { current: null as DispatchDeps['pendingContactCollectRef']['current'] };
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, pendingRef, resolveContactPhone: osJoshSmith }),
    );
    assert('SCC-A arms session missing_phone; collect-ref not co-owned',
      { key: session.peekPendingKey(), pendingRef: pendingRef.current, openURLs },
      v => v.key === CALL_TEXT_RECOVERY_KEY
        && v.pendingRef === null
        && v.openURLs.length === 0,
      'call_text_recovery owns SMS; no legacy ref');
    const refined = await session.resolvePending("It's under Josh Smith.");
    assert('SCC-A name refinement resumes SMS with exact body',
      { refined, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.refined.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5551234567')
        && v.body === DIST_BODY
        && v.pending === false,
      'Josh Smith + original body');
  }

  // B — exact body preservation across repair turns
  {
    const db = freshDB();
    insertContact(db, { id: 'c_j', name: 'Josh' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: osJoshSmith }),
    );
    await session.resolvePending('He is my brother.');
    const done = await session.resolvePending("It's under Josh Smith.");
    assert('SCC-B body exact after non-phone then name refinement',
      { done, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.done.status === 'committed' && v.body === DIST_BODY,
      'no paraphrase/regeneration');
  }

  // C — multi-turn repair retains task until resolution
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: osJoshSmith }),
    );
    const mid = await session.resolvePending('He is my brother.');
    assert('SCC-C mid repair keeps pending without sms',
      { mid, openURLs, pending: session.hasPending(), key: session.peekPendingKey() },
      v => v.openURLs.length === 0
        && v.pending === true
        && v.key === CALL_TEXT_RECOVERY_KEY
        && (v.mid.status === 'pending' || v.mid.status === 'noop'),
      'bounded repair; task alive');
    const done = await session.resolvePending("It's under Josh Smith.");
    assert('SCC-C resolves after second refinement',
      { done, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.done.status === 'committed' && v.body === DIST_BODY,
      'SMS completes');
  }

  // D — cancel clears pending SMS
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: async () => null }),
    );
    const cancel = await session.resolvePending('Never mind.');
    await session.resolvePending("It's under Josh Smith.");
    assert('SCC-D cancel clears SMS task; later refinement cannot resurrect',
      { cancel, openURLs, pending: session.hasPending() },
      v => v.cancel.status === 'noop'
        && /won't do that/i.test(v.cancel.ack)
        && v.openURLs.length === 0
        && v.pending === false,
      'cancel escape');
  }

  // E — explicit new intent preempts stale SMS
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: async () => null }),
    );
    const outcome = await processUtterance('set a timer for 20 minutes', session, routeDeps);
    assert('SCC-E timer preempts stale SMS recovery',
      { outcome, pending: session.hasPending(), openURLs },
      v => v.pending === false
        && v.openURLs.length === 0
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.kind === 'device_action'
        && v.outcome.routeDecision.actionIntent.type === 'timer',
      'deterministic interruption');
  }

  // F — no pending task must not fabricate SMS
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const outcome = await processUtterance("It's under Josh Smith.", session, {
      ...routeDeps,
      classifyQuery: async (t) => {
        const base = await classifyQuery(t);
        return base;
      },
    });
    assert('SCC-F orphan name refinement does not open SMS',
      { outcome, openURLs, pending: session.hasPending() },
      v => v.openURLs.length === 0 && v.pending === false,
      'no fabricated task');
  }

  // G — phone number repair preserves body
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: async () => null }),
    );
    const done = await session.resolvePending('Their number is 555-987-6543.');
    assert('SCC-G phone repair opens SMS with original body',
      { done, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.done.status === 'committed'
        && v.openURLs[0]?.startsWith('sms:5559876543')
        && v.body === DIST_BODY,
      'phone + body');
  }

  // H — CALL surname repair regression (contact_call authority unchanged)
  {
    const db = freshDB();
    const intent = await resolveContactCallIntent('son', 'call my son', { resolveContact: async () => null });
    const resolveContact = async (n: string) =>
      n.toLowerCase().includes('durand')
        ? {
            phone: null,
            name: 'son',
            source: 'device' as const,
            candidateNames: ['Josh Durand', 'Grant Durand'],
            deviceCandidates: [
              { name: 'Josh Durand', phone: '9725550101' },
              { name: 'Grant Durand', phone: '9725550102' },
            ],
          }
        : null;
    const pending = await DOMAIN_WRITERS['contact_call']!.add(intent, 'call my son', { resolveContact });
    assert('SCC-H CALL collect arms on missing son',
      pending,
      v => v.status === 'pending' && /son|number/i.test(v.prompt),
      'contact_call pending');
    const mid = pending.status === 'pending' ? await pending.resume('Durand') : null;
    const done = mid && mid.status === 'pending' ? await mid.resume('Josh') : mid;
    assert('SCC-H Durand then Josh dials Josh Durand',
      done,
      v => v?.status === 'committed' && /Calling Josh Durand/i.test(v.ack ?? ''),
      'CALL recovery unchanged');
  }

  // I — ambiguous OS contacts: body survives disambiguation
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const osPaulPhone = async () => ({
      phone: null as null,
      name: 'Paul',
      source: 'device' as const,
      candidateNames: ['Paul Cioffre', 'Paul Smith'],
      deviceCandidates: [
        { name: 'Paul Cioffre', phone: '18178468607' },
        { name: 'Paul Smith', phone: '5553010002' },
      ],
    });
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: DIST_BODY },
      `Text Paul: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone }),
    );
    assert('SCC-I OS ambiguity arms sms_disambiguate with body retained in closure',
      { key: session.peekPendingKey(), openURLs },
      v => v.key === SMS_OS_DISAMBIGUATE_KEY && v.openURLs.length === 0,
      'OS disambiguation pending');
    const pick = await session.resolvePending('Cioffre');
    assert('SCC-I pick commits exact body',
      { pick, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.pick.status === 'committed' && v.body === DIST_BODY,
      'body through OS disambiguation');
  }

  // J — relationship utterance must not erase SMS task or write family memory
  {
    const db = freshDB();
    insertContact(db, { id: 'c_j', name: 'Josh' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const before = contactCount(db);
    await dispatchAction(
      { type: 'sms', contact: 'Josh', message: DIST_BODY },
      `Text Josh: ${DIST_BODY}`,
      makeSmsDeps({ session, openURLs, resolveContactPhone: osJoshSmith }),
    );
    const brother = await session.resolvePending('He is my brother.');
    const byRel = findContactByRelationship('brother');
    assert('SCC-J brother repair keeps pending; no relationship write',
      { brother, openURLs, pending: session.hasPending(), key: session.peekPendingKey(), byRel, before, after: contactCount(db) },
      v => v.pending === true
        && v.key === CALL_TEXT_RECOVERY_KEY
        && v.openURLs.length === 0
        && v.byRel == null
        && v.before === v.after
        && v.brother.status === 'pending',
      'task retained; no silent brother capture');
    const done = await session.resolvePending("It's under Josh Smith.");
    assert('SCC-J still completes SMS after relationship clarification',
      { done, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.done.status === 'committed' && v.body === DIST_BODY,
      'SMS resumes');
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1]?.endsWith('smsContactContinuation.test.ts')) {
  runSmsContactContinuationTests().catch(console.error);
}
