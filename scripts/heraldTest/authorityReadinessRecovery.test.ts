// Call/Text Authority-Readiness Graceful Recovery V1 — vertical slice.
// Missing/ambiguous person, missing text content, continuation, budget, topic change.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { type Contact } from '../../src/db/contactsDB.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  advanceCallTextTask,
  CALL_TEXT_RECOVERY_KEY,
  CAPTURE_FIRST_MISS,
  CAPTURE_SECOND_MISS,
  GRACEFUL_STOP_WHO,
  SMS_OS_DISAMBIGUATE_KEY,
} from '../../src/routing/callTextReadiness.ts';
import { proposeConstrainedCandidate } from '../../src/routing/candidateConstrainedMatch.ts';
import { dispatchAction, releaseOverlappingContactCollect } from '../../src/screens/chat/dispatch.ts';
import type { DispatchDeps } from '../../src/screens/chat/dispatch.ts';
import { resolvePersonIdentity } from '../../src/db/contactsDB.ts';

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

export async function runAuthorityReadinessRecoveryTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Authority-Readiness Recovery (Call/Text slice) --------${RESET}\n`);

  // Direct Call Mickey — unique, no recovery pending introduced
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    const deps = makeSmsDeps({ session, openURLs, messages });
    await dispatchAction({ type: 'call', contact: 'Mickey' }, 'Call Mickey.', deps);
    assert('ARR-DIRECT-CALL unique Mickey does not arm call_text_recovery',
      { key: session.peekPendingKey(), messages, invented: messages.some(m => /Who do you mean/i.test(m)) },
      v => v.key !== CALL_TEXT_RECOVERY_KEY && v.invented === false,
      'no recovery clarification on unique Call Mickey');
  }

  // Direct Text Mickey with body — opens immediately
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Mickey', message: "I'll be home at 8" },
      "Text Mickey I'll be home at 8.",
      makeSmsDeps({ session, openURLs, messages }),
    );
    assert('ARR-DIRECT-TEXT unique Mickey with body opens sms, no clarification',
      { openURLs, pending: session.hasPending(), body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5550100100')
        && v.body === "I'll be home at 8"
        && v.pending === false,
      'one sms with exact body');
  }

  // Missing text content — then continue with exact answer
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'Mickey', message: '' }, 'Text Mickey.', makeSmsDeps({ session, openURLs, messages }));
    assert('ARR-CONTENT-1 Text Mickey asks what to tell, retains recipient, no sms yet',
      { openURLs, pending: session.hasPending(), key: session.peekPendingKey(), messages },
      v => v.openURLs.length === 0
        && v.pending === true
        && v.key === CALL_TEXT_RECOVERY_KEY
        && v.messages.some(m => m === 'What would you like me to tell Mickey?'),
      'missing-content template; Mickey verbatim');
    const resumed = await session.resolvePending("I'll be home at 8.");
    assert('ARR-CONTENT-2 answer resumes same Text task with exact content',
      { resumed, openURLs, pending: session.hasPending(), body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.resumed.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5550100100')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'sms Mickey exact user answer; no restart');
  }

  // Missing person + retained content
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'him', message: "I'll be home at 8" },
      "Text him I'll be home at 8.",
      makeSmsDeps({ session, openURLs, messages }),
    );
    assert('ARR-PERSON-RETAIN-1 unresolved him asks who; no sms; no invented recipient',
      { openURLs, messages, pending: session.hasPending() },
      v => v.openURLs.length === 0
        && v.pending === true
        && v.messages.some(m => m === 'Who would you like me to text?')
        && !v.messages.some(m => /Mickey/i.test(m)),
      'who-question; Mickey not invented');
    const resumed = await session.resolvePending('Mickey.');
    assert('ARR-PERSON-RETAIN-2 Mickey merges into same task; original content retained',
      { resumed, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.resumed.status === 'committed'
        && v.openURLs.length === 1
        && v.body === "I'll be home at 8"
        && v.pending === false,
      'sms with original body after person fill');
  }

  // Two-gap continuation
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs, messages }));
    const step1 = await session.resolvePending('Mickey.');
    assert('ARR-TWO-1 person answer advances to missing-content clarification',
      { step1, openURLs, pending: session.hasPending() },
      v => v.step1.status === 'pending'
        && v.step1.status === 'pending'
        && /What would you like me to tell Mickey\?/.test(v.step1.prompt)
        && v.openURLs.length === 0
        && v.pending === true,
      'second question after advancement');
    const step2 = await session.resolvePending("I'll be home at 8.");
    assert('ARR-TWO-2 content answer resumes original Text task',
      { step2, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.step2.status === 'committed'
        && v.openURLs.length === 1
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'exactly two clarifications then send');
  }

  // Ambiguous person — existing always-ask with verbatim names
  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'Mickey', message: 'hi' }, 'Text Mickey hi', makeSmsDeps({ session, openURLs, messages }));
    assert('ARR-AMBIG-1 two Mickeys asks with verbatim names; no sms; no generated name',
      { openURLs, messages, pending: session.hasPending(), key: session.peekPendingKey() },
      v => v.openURLs.length === 0
        && v.pending === true
        && v.key === CALL_TEXT_RECOVERY_KEY
        && v.messages.some(m => /Mickey McCoy/.test(m) && /Mickey Smith/.test(m))
        && !v.messages.some(m => /Mickey Jones/.test(m)),
      'always-ask with stored names only; recovery owner');
    const resumed = await session.resolvePending('Mickey McCoy');
    assert('ARR-AMBIG-2 answer opens sms to the chosen Mickey only',
      { resumed, openURLs, pending: session.hasPending() },
      v => v.resumed.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5551111111')
        && !v.openURLs[0].includes('5552222222')
        && v.pending === false,
      'chosen candidate only');
  }

  // Progressive narrowing: MISSING_PERSON → four Mickeys → unique pick, payload kept
  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    insertContact(db, { id: 'c_c', name: 'Mickey Jones', phone: '555-333-3333' });
    insertContact(db, { id: 'c_d', name: 'Mickey Brown', phone: '555-444-4444' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'him', message: "I'll be home at 8." },
      "Text him I'll be home at 8.",
      makeSmsDeps({ session, openURLs, messages }),
    );
    const step1 = await session.resolvePending('Mickey.');
    assert('ARR-NARROW-1 Mickey after him narrows to four candidates; content not re-asked',
      { step1, openURLs, pending: session.hasPending() },
      v => v.step1.status === 'pending'
        && v.step1.prompt === 'I found four Mickeys. Which one do you mean?'
        && v.openURLs.length === 0
        && v.pending === true
        && !/What would you like me to tell/i.test(v.step1.prompt),
      'narrowed person question; original payload retained');
    const step2 = await session.resolvePending('Mickey McCoy');
    assert('ARR-NARROW-2 unique pick sends original body to chosen Mickey only',
      { step2, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.step2.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5551111111')
        && !v.openURLs.some((u: string) => /5552222222|5553333333|5554444444/.test(u))
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'recipient Mickey McCoy; content preserved; no restart');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    insertContact(db, { id: 'c_c', name: 'Mickey Jones', phone: '555-333-3333' });
    insertContact(db, { id: 'c_d', name: 'Mickey Brown', phone: '555-444-4444' });
    const r = advanceCallTextTask(
      {
        action: 'sms',
        contactName: '',
        message: "I'll be home at 8.",
        candidateNames: [],
        gap: 'missing_person',
        turnsAsked: 2,
      },
      'Mickey',
      resolvePersonIdentity,
    );
    assert('ARR-NARROW-ADVANCE person narrowing counts even after two asks; payload kept',
      r,
      v => v.kind === 'pending'
        && v.kind === 'pending'
        && v.task.message === "I'll be home at 8."
        && v.task.gap === 'ambiguous_person'
        && v.task.candidateNames.length === 4
        && v.prompt === 'I found four Mickeys. Which one do you mean?',
      'advancement not stop; message retained');
  }

  // Non-advancing answer → immediate graceful stop (no same-gap re-ask)
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs, messages }));
    const r1 = await session.resolvePending('that guy');
    assert('ARR-NONADV non-advance stops immediately; does not guess Mickey',
      { r1, openURLs, pending: session.hasPending() },
      v => v.r1.status === 'noop'
        && v.r1.ack === GRACEFUL_STOP_WHO
        && v.openURLs.length === 0
        && v.pending === false,
      'progress-or-stop; no sms');
  }

  // Same candidate set is not progress — do not continue
  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    insertContact(db, { id: 'c_c', name: 'Mickey Jones', phone: '555-333-3333' });
    insertContact(db, { id: 'c_d', name: 'Mickey Brown', phone: '555-444-4444' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    const r = await session.resolvePending('Mickey');
    assert('ARR-NO-PROGRESS repeating Mickey on a four-way set does not continue',
      { r, openURLs, pending: session.hasPending() },
      v => v.r.status === 'noop'
        && v.r.ack === GRACEFUL_STOP_WHO
        && v.openURLs.length === 0
        && v.pending === false,
      'no monotonic shrink; graceful stop; payload not sent to a guessed Mickey');
  }

  // Advancing 3-turn success: Text him → who → Mickey (four) → which → McCoy → content → SMS.
  // Third question is allowed only because each answer strictly narrowed the retained task.
  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    insertContact(db, { id: 'c_c', name: 'Mickey Jones', phone: '555-333-3333' });
    insertContact(db, { id: 'c_d', name: 'Mickey Brown', phone: '555-444-4444' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs, messages }));
    const step1 = await session.resolvePending('Mickey.');
    const step2 = await session.resolvePending('Mickey McCoy');
    assert('ARR-THREE-TURN-ADVANCE-1 Text him → Mickey (four) → McCoy asks content as third question',
      { step1, step2, openURLs, pending: session.hasPending() },
      v => v.step1.status === 'pending'
        && v.step1.prompt === 'I found four Mickeys. Which one do you mean?'
        && v.step2.status === 'pending'
        && v.step2.prompt === 'What would you like me to tell Mickey McCoy?'
        && v.openURLs.length === 0
        && v.pending === true,
      'exactly three clarifications: who, which, then what to tell resolved name');
    const step3 = await session.resolvePending("I'll be home at 8.");
    assert('ARR-THREE-TURN-ADVANCE-2 content answer SMS McCoy with exact body',
      { step3, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.step3.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5551111111')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'send after third question; no restart');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const r = advanceCallTextTask(
      {
        action: 'sms',
        contactName: '',
        message: '',
        candidateNames: [],
        gap: 'missing_person',
        turnsAsked: 2,
      },
      'Mickey',
      resolvePersonIdentity,
    );
    assert('ARR-THIRD unique person after two asks may ask missing_content',
      r,
      v => v.kind === 'pending'
        && v.kind === 'pending'
        && v.task.gap === 'missing_content'
        && v.task.contactName === 'Mickey'
        && v.prompt === 'What would you like me to tell Mickey?',
      'third question is simple remaining content field');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_ros', name: 'Mickey Red Oak Sr', phone: '555-101-0001', importance: 9 });
    insertContact(db, { id: 'c_roj', name: 'Mickey Red Oak Jr', phone: '555-101-0002', importance: 8 });
    insertContact(db, { id: 'c_rp', name: 'Mickey Red Pine', phone: '555-101-0003', importance: 7 });
    insertContact(db, { id: 'c_ra', name: 'Mickey Red Ash', phone: '555-101-0004', importance: 6 });
    insertContact(db, { id: 'c_bos', name: 'Mickey Blue Oak Sr', phone: '555-202-0001', importance: 5 });
    insertContact(db, { id: 'c_boj', name: 'Mickey Blue Oak Jr', phone: '555-202-0002', importance: 4 });
    insertContact(db, { id: 'c_bp', name: 'Mickey Blue Pine', phone: '555-202-0003', importance: 3 });
    insertContact(db, { id: 'c_ba', name: 'Mickey Blue Ash', phone: '555-202-0004', importance: 2 });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs }));
    const q2 = await session.resolvePending('Mickey.');
    const q3 = await session.resolvePending('Red');
    const q4 = await session.resolvePending('Oak');
    const q5 = await session.resolvePending('Sr');
    assert('ARR-FOUR-PLUS-1 4+ advancing narrows: eight→four→two→unique then content',
      { q2, q3, q4, q5, openURLs, pending: session.hasPending() },
      v => v.q2.status === 'pending'
        && v.q2.prompt === 'I found eight Mickeys. Which one do you mean?'
        && v.q3.status === 'pending'
        && v.q3.prompt === 'I found four Mickeys. Which one do you mean?'
        && v.q4.status === 'pending'
        && v.q4.prompt === 'Do you mean Mickey Red Oak Sr or Mickey Red Oak Jr?'
        && v.q5.status === 'pending'
        && v.q5.prompt === 'What would you like me to tell Mickey Red Oak Sr?'
        && v.openURLs.length === 0
        && v.pending === true,
      'five clarification turns, each a strict subset or unique bind');
    const done = await session.resolvePending("I'll be home at 8.");
    assert('ARR-FOUR-PLUS-2 after 4+ advancing turns the original Text task sends',
      { done, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.done.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5551010001')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'no count cap; payload retained; chosen Sr only');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Smith', phone: '555-222-2222' });
    insertContact(db, { id: 'c_c', name: 'Mickey Jones', phone: '555-333-3333' });
    insertContact(db, { id: 'c_d', name: 'Mickey Brown', phone: '555-444-4444' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    await session.resolvePending('Mickey McCoy');
    const r = await session.resolvePending('him');
    assert('ARR-THIRD-NONADVANCE non-advancing answer on the content question stops',
      { r, openURLs, pending: session.hasPending() },
      v => v.r.status === 'noop'
        && v.r.ack === GRACEFUL_STOP_WHO
        && v.openURLs.length === 0
        && v.pending === false,
      'graceful stop; no content re-ask loop');
  }

  // Topic change — recovery pending does not hijack timer
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session }));
    const outcome = await processUtterance('set a timer for 20 minutes', session, {
      classifyQuery,
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    });
    assert('ARR-TOPIC unrelated timer preempts stale recovery pending',
      { outcome, pending: session.hasPending() },
      v => v.pending === false
        && v.outcome.handled === false
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.kind === 'device_action'
        && v.outcome.routeDecision.actionIntent.type === 'timer',
      'pending cleared; timer proceeds');
  }

  // Trust — never infer recipient or author content
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs }));
    assert('ARR-TRUST unresolved person never opens a message',
      openURLs,
      v => v.length === 0,
      'zero sms URLs');
  }

  const routeDeps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    insertContact(db, { id: 'c_c', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    const outcome = await processUtterance('Show NFL', session, routeDeps);
    assert('ARR-SUPERSEDE-NFL Show NFL is not consumed as a Mickey answer',
      { outcome, pending: session.hasPending(), openURLs },
      v => v.pending === false
        && v.openURLs.length === 0
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.kind === 'backend'
        && v.outcome.routeDecision.reason === 'live:data'
        && !('responseText' in v.outcome && /lost who you mean|Which one|Mickey/i.test(String((v.outcome as { responseText?: string }).responseText ?? ''))),
      'live-data owns turn; no graceful-stop; no sms');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    const session = new ConversationSession();
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session }));
    await session.resolvePending('Mickey.');
    const outcome = await processUtterance('set an alarm for 7am', session, routeDeps);
    assert('ARR-SUPERSEDE-ALARM alarm still preempts identity pending',
      { outcome, pending: session.hasPending() },
      v => v.pending === false
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.kind === 'device_action'
        && v.outcome.routeDecision.actionIntent.type === 'alarm',
      'alarm owns turn');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'Mickey', message: '' }, 'Text Mickey.', makeSmsDeps({ session, openURLs }));
    const outcome = await processUtterance("What's the weather tomorrow?", session, routeDeps);
    assert('ARR-SUPERSEDE-WEATHER weather is not used as SMS body',
      { outcome, pending: session.hasPending(), openURLs },
      v => v.pending === false
        && v.openURLs.length === 0
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.kind === 'backend'
        && v.outcome.routeDecision.reason === 'live:data',
      'weather owns; composer not opened');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Paul.');
    const outcome = await processUtterance('Cioffre', session, routeDeps);
    assert('ARR-OWN-CIOFFRE exact surname stays pending-owned and resolves',
      { outcome, openURLs, pending: session.hasPending(), body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.outcome.handled === true
        && v.outcome.source === 'pending_resume'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5553010001')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'routing does not steal Cioffre; original body kept');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    insertContact(db, { id: 'c_c', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    const exact = await session.resolvePending('Schoenfeld');
    assert('ARR-SCHOEN-EXACT exact surname selects Schoenfeld; body kept; no extra confirm',
      { exact, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null },
      v => v.exact.status === 'committed'
        && v.openURLs[0].startsWith('sms:5555555555')
        && v.body === "I'll be home at 8.",
      'deterministic last-name match');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    insertContact(db, { id: 'c_c', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    const propose = await session.resolvePending('showing feld');
    assert('ARR-SCHOEN-STT proposes Schoenfeld; does not send yet',
      { propose, openURLs, pending: session.hasPending() },
      v => v.propose.status === 'pending'
        && v.propose.prompt === 'Did you mean Mickey Schoenfeld?'
        && v.openURLs.length === 0
        && v.pending === true,
      'fuzzy may propose only');
    const yes = await session.resolvePending('yes');
    assert('ARR-SCHOEN-YES confirmation sends original body to Schoenfeld only',
      { yes, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.yes.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5555555555')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'user yes is the authority; content unchanged');
  }

  {
    const names = ['Mickey McCoy', 'Mickey Schoenfeld', 'Mickey Smith'];
    const a = proposeConstrainedCandidate('show in field', names);
    const b = proposeConstrainedCandidate('schoenfeild', names);
    const c = proposeConstrainedCandidate('schoen feld', names);
    assert('ARR-SCHOEN-VARIANTS constrained proposer maps imperfect STT to Schoenfeld only',
      { a, b, c },
      v => v.a.kind === 'one' && v.a.kind === 'one' && v.a.name === 'Mickey Schoenfeld'
        && v.b.kind === 'one' && v.b.name === 'Mickey Schoenfeld'
        && v.c.kind === 'one' && v.c.name === 'Mickey Schoenfeld',
      'no invented names');
  }

  {
    const names = ['Paul Cioffre', 'Paul Smith', 'Paul Jones'];
    const a = proposeConstrainedCandidate('ciofre', names);
    const b = proposeConstrainedCandidate('choffray', names);
    const wrong = proposeConstrainedCandidate('McCoy', names);
    assert('ARR-CIOFFRE-VARIANTS propose Cioffre; McCoy does not force a Paul',
      { a, b, wrong },
      v => v.a.kind === 'one' && v.a.name === 'Paul Cioffre'
        && v.b.kind === 'one' && v.b.name === 'Paul Cioffre'
        && v.wrong.kind === 'none',
      'wrong surname is none');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: "I'll be home at 8." }, "Text him I'll be home at 8.", makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Paul.');
    const r = await session.resolvePending('McCoy');
    assert('ARR-WRONG-NAME McCoy against Pauls reasks; does not send or pick',
      { r, openURLs, pending: session.hasPending() },
      v => v.r.status === 'pending'
        && v.r.prompt === CAPTURE_FIRST_MISS
        && v.openURLs.length === 0
        && v.pending === true,
      'task preserved; no silent Paul');
  }

  {
    const two = proposeConstrainedCandidate('cioff', ['Paul Cioffre', 'Paul Cioffrey', 'Paul Smith']);
    assert('ARR-TWO-SIMILAR close surnames ask between the two, never pick',
      two,
      v => v.kind === 'two'
        && v.kind === 'two'
        && v.names.includes('Paul Cioffre')
        && v.names.includes('Paul Cioffrey')
        && !v.names.includes('Paul Smith'),
      'two active candidates only');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    insertContact(db, { id: 'c_c', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    const propose = await session.resolvePending('showing feld');
    const yes = await session.resolvePending('yes');
    assert('ARR-REPAIR-THEN-CONTENT person repair then asks what to tell; no sms yet',
      { propose, yes, openURLs, pending: session.hasPending() },
      v => v.propose.status === 'pending'
        && v.yes.status === 'pending'
        && v.yes.prompt === 'What would you like me to tell Mickey Schoenfeld?'
        && v.openURLs.length === 0
        && v.pending === true,
      'same task continues after confirm');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'him', message: "I'll be home at 8." },
      "Text him I'll be home at 8.",
      makeSmsDeps({ session, openURLs }),
    );
    await session.resolvePending('Paul.');
    const first = await processUtterance('Show Fray', session, routeDeps);
    const firstCommit = first.handled && first.source === 'pending_resume' ? first.commits[0] : null;
    assert('CR-FIRST-MISS Show Fray acknowledges capture difficulty',
      { first, firstCommit, openURLs, pending: session.hasPending() },
      v => v.first.handled === true
        && v.first.source === 'pending_resume'
        && v.first.responseText === CAPTURE_FIRST_MISS
        && v.firstCommit?.status === 'pending'
        && v.firstCommit.recoveryChoices == null
        && v.openURLs.length === 0
        && v.pending === true,
      'first miss keeps pending; no taps yet; no sms; not live-data');
    const second = await processUtterance('Show free', session, routeDeps);
    const secondCommit = second.handled && second.source === 'pending_resume' ? second.commits[0] : null;
    assert('CR-SECOND-MISS Show free exposes repair path; pending stays alive',
      { second, secondCommit, openURLs, pending: session.hasPending() },
      v => v.second.handled === true
        && v.second.source === 'pending_resume'
        && v.second.responseText === CAPTURE_SECOND_MISS
        && v.secondCommit?.status === 'pending'
        && Array.isArray(v.secondCommit.recoveryChoices)
        && v.secondCommit.recoveryChoices.join('|') === 'Paul Cioffre|Paul Smith|Paul Jones'
        && v.openURLs.length === 0
        && v.pending === true,
      'second miss: literal repair copy + current candidate taps');
    const guess = await session.resolvePending('yes');
    assert('CR-UNRESOLVED-NO-SEND yes after repair does not guess or send',
      { guess, openURLs, pending: session.hasPending() },
      v => v.guess.status === 'pending'
        && v.openURLs.length === 0
        && v.pending === true,
      'no silent recipient from yes without a proposal');
    const typed = await processUtterance('Cioffre', session, routeDeps);
    assert('CR-TYPED-CIOFFRE typed surname resolves retained task; body unchanged',
      { typed, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.typed.handled === true
        && v.typed.source === 'pending_resume'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5553010001')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'composer/voice/typed share processUtterance pending resume');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'him', message: "I'll be home at 8." },
      "Text him I'll be home at 8.",
      makeSmsDeps({ session, openURLs }),
    );
    await session.resolvePending('Paul.');
    await session.resolvePending('Show Fray');
    const armed = await session.resolvePending('Show free');
    assert('CR-TAP-NO-BYPASS choices are presentation; no sms until pending resume',
      { armed, openURLs, pending: session.hasPending() },
      v => v.armed.status === 'pending'
        && v.armed.recoveryChoices?.includes('Paul Cioffre') === true
        && v.openURLs.length === 0
        && v.pending === true,
      'exposing taps does not dispatch CALL/TEXT');
    const tapName = armed.status === 'pending' ? armed.recoveryChoices![0] : '';
    const tap = await session.resolvePending(tapName);
    assert('CR-TAP-CIOFFRE tap feeds selected candidate through pending resume',
      { tapName, tap, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.tapName === 'Paul Cioffre'
        && v.tap.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5553010001')
        && v.body === "I'll be home at 8."
        && v.pending === false,
      'same pending-resolution authority as typing the name');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_ros', name: 'Mickey Red Oak Sr', phone: '555-101-0001', importance: 9 });
    insertContact(db, { id: 'c_roj', name: 'Mickey Red Oak Jr', phone: '555-101-0002', importance: 8 });
    insertContact(db, { id: 'c_rp', name: 'Mickey Red Pine', phone: '555-101-0003', importance: 7 });
    insertContact(db, { id: 'c_ra', name: 'Mickey Red Ash', phone: '555-101-0004', importance: 6 });
    insertContact(db, { id: 'c_bos', name: 'Mickey Blue Oak Sr', phone: '555-202-0001', importance: 5 });
    insertContact(db, { id: 'c_boj', name: 'Mickey Blue Oak Jr', phone: '555-202-0002', importance: 4 });
    insertContact(db, { id: 'c_bp', name: 'Mickey Blue Pine', phone: '555-202-0003', importance: 3 });
    insertContact(db, { id: 'c_ba', name: 'Mickey Blue Ash', phone: '555-202-0004', importance: 2 });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction({ type: 'sms', contact: 'him', message: '' }, 'Text him.', makeSmsDeps({ session, openURLs }));
    await session.resolvePending('Mickey.');
    await session.resolvePending('Red');
    await session.resolvePending('Show Fray');
    const second = await session.resolvePending('Show free');
    assert('CR-NARROWED-SET taps are the current retained subset',
      { second, openURLs, pending: session.hasPending() },
      v => v.second.status === 'pending'
        && v.second.recoveryChoices?.join('|') === 'Mickey Red Oak Sr|Mickey Red Oak Jr|Mickey Red Pine|Mickey Red Ash'
        && !v.second.recoveryChoices?.some((n: string) => /Blue/.test(n))
        && v.openURLs.length === 0
        && v.pending === true,
      'four Reds only; no invented names');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'him', message: "I'll be home at 8." },
      "Text him I'll be home at 8.",
      makeSmsDeps({ session, openURLs }),
    );
    await session.resolvePending('Paul.');
    await session.resolvePending('Show Fray');
    await session.resolvePending('Show free');
    const cancel = await session.resolvePending('cancel');
    assert('CR-CANCEL cancel releases capture-repair pending',
      { cancel, openURLs, pending: session.hasPending() },
      v => v.cancel.status === 'noop'
        && /won't do that/i.test(v.cancel.ack)
        && v.openURLs.length === 0
        && v.pending === false,
      'cancel escape; original task not sent');
  }

  {
    const noneA = proposeConstrainedCandidate('Show Fray', ['Paul Cioffre', 'Paul Smith', 'Paul Jones']);
    const noneB = proposeConstrainedCandidate('Show free', ['Paul Cioffre', 'Paul Smith', 'Paul Jones']);
    assert('CR-MANGLE-NONE Show Fray / Show free do not force Cioffre',
      { noneA, noneB },
      v => v.noneA.kind === 'none' && v.noneB.kind === 'none',
      'thresholds unchanged; no open-world match');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, messages }),
    );
    assert('CR-NAMED-OWNER named Text Paul arms call_text_recovery',
      { key: session.peekPendingKey(), openURLs, messages },
      v => v.key === CALL_TEXT_RECOVERY_KEY
        && v.openURLs.length === 0
        && v.messages.some(m => /three Pauls/i.test(m)),
      'not sms_disambiguate; finite Paul set retained');
    const first = await processUtterance('Show Fray', session, routeDeps);
    const firstCommit = first.handled && first.source === 'pending_resume' ? first.commits[0] : null;
    assert('CR-NAMED-FIRST-MISS Show Fray is capture miss; task retained',
      { first, firstCommit, openURLs, pending: session.hasPending(), key: session.peekPendingKey() },
      v => v.first.handled === true
        && v.first.responseText === CAPTURE_FIRST_MISS
        && v.firstCommit?.status === 'pending'
        && v.openURLs.length === 0
        && v.pending === true
        && v.key === CALL_TEXT_RECOVERY_KEY,
      'device-shaped first miss on named path');
    const second = await processUtterance('Show free', session, routeDeps);
    const secondCommit = second.handled && second.source === 'pending_resume' ? second.commits[0] : null;
    assert('CR-NAMED-SECOND-MISS Show free emits recoveryChoices; pending alive',
      { second, secondCommit, openURLs, pending: session.hasPending() },
      v => v.second.handled === true
        && v.second.responseText === CAPTURE_SECOND_MISS
        && v.secondCommit?.status === 'pending'
        && v.secondCommit.recoveryChoices?.join('|') === 'Paul Cioffre|Paul Smith|Paul Jones'
        && v.openURLs.length === 0
        && v.pending === true,
      'chips are current named-Paul set');
    const guess = await session.resolvePending('yes');
    assert('CR-NAMED-YES-NOOP yes without proposal does not send',
      { guess, openURLs, pending: session.hasPending() },
      v => v.guess.status === 'pending' && v.openURLs.length === 0 && v.pending === true,
      'fuzzy/yes never authorizes');
    const typed = await processUtterance('Paul Cioffre', session, routeDeps);
    assert('CR-NAMED-TYPE type Paul Cioffre preserves original body',
      { typed, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.typed.handled === true
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:5553010001')
        && v.body === "I'll be there at 8"
        && v.pending === false,
      'named-path resume through recovery owner');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    insertContact(db, { id: 'c_c', name: 'Paul Jones', phone: '555-301-0003' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs }),
    );
    await session.resolvePending('Show Fray');
    const armed = await session.resolvePending('Show free');
    const tapName = armed.status === 'pending' ? armed.recoveryChoices![0] : '';
    const tap = await session.resolvePending(tapName);
    assert('CR-NAMED-TAP tap Paul Cioffre uses pending resume, not a parallel action',
      { tapName, tap, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.tapName === 'Paul Cioffre'
        && v.tap.status === 'committed'
        && v.openURLs.length === 1
        && v.body === "I'll be there at 8"
        && v.pending === false,
      'tap feeds the recovery owner');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_ros', name: 'Mickey Red Oak Sr', phone: '555-101-0001', importance: 9 });
    insertContact(db, { id: 'c_roj', name: 'Mickey Red Oak Jr', phone: '555-101-0002', importance: 8 });
    insertContact(db, { id: 'c_rp', name: 'Mickey Red Pine', phone: '555-101-0003', importance: 7 });
    insertContact(db, { id: 'c_ra', name: 'Mickey Red Ash', phone: '555-101-0004', importance: 6 });
    insertContact(db, { id: 'c_bos', name: 'Mickey Blue Oak Sr', phone: '555-202-0001', importance: 5 });
    insertContact(db, { id: 'c_boj', name: 'Mickey Blue Oak Jr', phone: '555-202-0002', importance: 4 });
    insertContact(db, { id: 'c_bp', name: 'Mickey Blue Pine', phone: '555-202-0003', importance: 3 });
    insertContact(db, { id: 'c_ba', name: 'Mickey Blue Ash', phone: '555-202-0004', importance: 2 });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Mickey', message: "I'll be home at 8." },
      "Text Mickey I'll be home at 8.",
      makeSmsDeps({ session, openURLs }),
    );
    assert('CR-NAMED-NARROW-1 named Mickey arms recovery with eight candidates',
      { key: session.peekPendingKey(), openURLs },
      v => v.key === CALL_TEXT_RECOVERY_KEY && v.openURLs.length === 0,
      'named ambiguous uses recovery owner');
    const red = await session.resolvePending('Red');
    assert('CR-NAMED-NARROW-2 Red narrows named Mickey set; body kept',
      { red, openURLs, pending: session.hasPending() },
      v => v.red.status === 'pending'
        && v.red.prompt === 'I found four Mickeys. Which one do you mean?'
        && v.openURLs.length === 0
        && v.pending === true,
      'strict subset; original SMS not sent');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs }),
    );
    const outcome = await processUtterance('Show NFL', session, routeDeps);
    assert('CR-NAMED-SUPERSEDE-NFL named recovery still yields to live-data',
      { outcome, pending: session.hasPending(), openURLs },
      v => v.pending === false
        && v.openURLs.length === 0
        && v.outcome.handled === false
        && 'routeDecision' in v.outcome
        && v.outcome.routeDecision.reason === 'live:data',
      'superseding intent unchanged');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Paul Cioffre', phone: '555-301-0001' });
    insertContact(db, { id: 'c_b', name: 'Paul Smith', phone: '555-301-0002' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs }),
    );
    const cancel = await session.resolvePending('cancel');
    assert('CR-NAMED-CANCEL named recovery cancel does not send',
      { cancel, openURLs, pending: session.hasPending() },
      v => v.cancel.status === 'noop'
        && v.openURLs.length === 0
        && v.pending === false,
      'cancel escape');
  }

  {
    const db = freshDB();
    insertContact(db, { id: 'c_a', name: 'Mickey McCoy', phone: '555-111-1111' });
    insertContact(db, { id: 'c_b', name: 'Mickey Schoenfeld', phone: '555-555-5555' });
    insertContact(db, { id: 'c_c', name: 'Mickey Smith', phone: '555-222-2222' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Mickey', message: "I'll be home at 8." },
      "Text Mickey I'll be home at 8.",
      makeSmsDeps({ session, openURLs }),
    );
    const propose = await session.resolvePending('showing feld');
    assert('CR-NAMED-FUZZY-NO-SEND named path proposes only; does not send',
      { propose, openURLs, pending: session.hasPending() },
      v => v.propose.status === 'pending'
        && v.propose.prompt === 'Did you mean Mickey Schoenfeld?'
        && v.openURLs.length === 0
        && v.pending === true,
      'fuzzy never authorizes on named owner');
  }

  const OS_S24_PAULS = [
    { name: 'Paul C Pennisi', phone: '6107554314' },
    { name: 'Paul Cioffre', phone: '18178468607' },
    { name: 'Paul Rowland', phone: '9042601365' },
    { name: 'Paul B Owens', phone: '9723753104' },
    { name: 'Paula Rivet Altium', phone: '6513032880' },
  ];
  const OS_S24_LABELS = OS_S24_PAULS.map(c => c.name);
  const osPaulPhone = () =>
    async () => ({
      phone: null as null,
      name: 'Paul',
      source: 'device' as const,
      candidateNames: OS_S24_LABELS,
      deviceCandidates: OS_S24_PAULS,
    });

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const messages: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, messages, resolveContactPhone: osPaulPhone() }),
    );
    assert('CR-OS-OWNER named Text Paul with empty Herald arms sms_disambiguate',
      { key: session.peekPendingKey(), openURLs, messages },
      v => v.key === SMS_OS_DISAMBIGUATE_KEY
        && v.openURLs.length === 0
        && v.messages.some(m => /more than one Paul/i.test(m))
        && v.messages.some(m => /Paul Cioffre/i.test(m) && /Paula Rivet Altium/i.test(m)),
      'OS-authoritative pending; not call_text_recovery');
    const first = await session.resolvePending('Show Fray');
    assert('CR-OS-FIRST-MISS Show Fray is capture miss; task retained',
      { first, openURLs, pending: session.hasPending(), key: session.peekPendingKey() },
      v => v.first.status === 'pending'
        && v.first.prompt === CAPTURE_FIRST_MISS
        && v.first.recoveryChoices == null
        && v.openURLs.length === 0
        && v.pending === true
        && v.key === SMS_OS_DISAMBIGUATE_KEY,
      'first OS capture miss');
    const second = await session.resolvePending('Show free');
    assert('CR-OS-SECOND-MISS Show free emits OS recoveryChoices; pending alive',
      { second, openURLs, pending: session.hasPending() },
      v => v.second.status === 'pending'
        && v.second.prompt === CAPTURE_SECOND_MISS
        && v.second.recoveryChoices?.join('|') === OS_S24_LABELS.join('|')
        && v.openURLs.length === 0
        && v.pending === true,
      'chips are current OS Paul set');
    const guess = await session.resolvePending('yes');
    assert('CR-OS-YES-NOOP yes without proposal does not send',
      { guess, openURLs, pending: session.hasPending() },
      v => v.guess.status === 'pending' && v.openURLs.length === 0 && v.pending === true,
      'yes never authorizes OS pick');
    const typed = await session.resolvePending('Cioffre');
    assert('CR-OS-TYPE typed Cioffre uses closure phone + original body',
      { typed, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.typed.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:18178468607')
        && v.body === "I'll be there at 8"
        && v.pending === false,
      'OS phone from closure; no Herald lookup');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone() }),
    );
    await session.resolvePending('Show Fray');
    const armed = await session.resolvePending('Show free');
    const tapName = armed.status === 'pending' ? armed.recoveryChoices!.find(n => n === 'Paul Cioffre') ?? '' : '';
    const tap = await session.resolvePending(tapName);
    assert('CR-OS-TAP tap Paul Cioffre uses OS snapshot phone',
      { tapName, tap, openURLs, body: openURLs[0] ? smsBody(openURLs[0]) : null, pending: session.hasPending() },
      v => v.tapName === 'Paul Cioffre'
        && v.tap.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:18178468607')
        && v.body === "I'll be there at 8"
        && v.pending === false,
      'tap authorizes listed OS row only');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone() }),
    );
    const propose = await session.resolvePending('pennsi');
    assert('CR-OS-FUZZY mangled surname proposes only; does not send',
      { propose, openURLs, pending: session.hasPending() },
      v => v.propose.status === 'pending'
        && /^Did you mean /.test(v.propose.prompt ?? '')
        && v.openURLs.length === 0
        && v.pending === true,
      'fuzzy never authorizes OS SMS');
    const guess = await session.resolvePending('yes');
    assert('CR-OS-FUZZY-YES confirmation after proposal uses proposed OS row',
      { guess, openURLs, pending: session.hasPending() },
      v => v.guess.status === 'committed'
        && v.openURLs.length === 1
        && v.openURLs[0].startsWith('sms:6107554314')
        && v.pending === false,
      'explicit yes after proposal only');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone() }),
    );
    await session.resolvePending('Show Fray');
    await session.resolvePending('Show free');
    const cancel = await session.resolvePending('cancel');
    assert('CR-OS-CANCEL cancel releases OS capture-repair pending',
      { cancel, openURLs, pending: session.hasPending() },
      v => v.cancel.status === 'noop'
        && /won't do that/i.test(v.cancel.ack)
        && v.openURLs.length === 0
        && v.pending === false,
      'cancel escape; original task not sent');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone() }),
    );
    const red = await session.resolvePending('Paul');
    assert('CR-OS-NARROW Paul token narrows to four Pauls; Paula dropped',
      { red, openURLs, pending: session.hasPending() },
      v => v.red.status === 'pending'
        && v.red.prompt === 'I found four Pauls. Which one do you mean?'
        && v.openURLs.length === 0
        && v.pending === true,
      'deterministic subset of OS labels');
    await session.resolvePending('Show Fray');
    const second = await session.resolvePending('Show free');
    assert('CR-OS-NARROW-CHIPS recoveryChoices are the narrowed OS set',
      { second, openURLs },
      v => v.second.status === 'pending'
        && v.second.recoveryChoices?.join('|') === 'Paul C Pennisi|Paul Cioffre|Paul Rowland|Paul B Owens'
        && !v.second.recoveryChoices?.some((n: string) => /Paula/.test(n))
        && v.openURLs.length === 0,
      'no open-world name; Paula not reintroduced');
  }

  {
    const db = freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    let osLookups = 0;
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({
        session,
        openURLs,
        resolveContactPhone: async () => {
          osLookups += 1;
          return {
            phone: null,
            name: 'Paul',
            source: 'device' as const,
            candidateNames: OS_S24_LABELS,
            deviceCandidates: OS_S24_PAULS,
          };
        },
      }),
    );
    insertContact(db, { id: 'c_secret', name: 'Paul Secret', phone: '555-999-0000' });
    const miss = await session.resolvePending('Secret');
    assert('CR-OS-NO-OPEN-WORLD Herald row added after arm is not selectable',
      { miss, openURLs, osLookups, pending: session.hasPending(), key: session.peekPendingKey() },
      v => v.miss.status === 'pending'
        && v.miss.prompt === CAPTURE_FIRST_MISS
        && v.openURLs.length === 0
        && v.osLookups === 1
        && v.pending === true
        && v.key === SMS_OS_DISAMBIGUATE_KEY,
      'finite OS set frozen; no completeReadySms');
  }

  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, resolveContactPhone: osPaulPhone() }),
    );
    await session.resolvePending('Show Fray');
    await session.resolvePending('Show free');
    const third = await session.resolvePending('zzzz-not-a-person');
    assert('CR-OS-THIRD-STOP third unresolved capture graceful-stops',
      { third, openURLs, pending: session.hasPending() },
      v => v.third.status === 'noop'
        && v.third.ack === GRACEFUL_STOP_WHO
        && v.openURLs.length === 0
        && v.pending === false,
      'not generic budget release; no guess');
  }

  // DD-2: leftover collect-ref must not co-own Call/Text recovery or CALL.
  {
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'running late' } };
    const session = new ConversationSession();
    releaseOverlappingContactCollect(leftover, session);
    assert('DD2-COLLECT-ALONE leftover number-collect stays when session has no contact pending',
      leftover.current,
      v => v?.action === 'text' && v?.name === 'Paul',
      'ref remains; missing-number collection is not migrated');
  }
  {
    freshDB();
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'stale' } };
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, openURLs, pendingRef: leftover, resolveContactPhone: osPaulPhone() }),
    );
    assert('DD2-SINGLE-OWNER OS recovery clears leftover collect-ref',
      { key: session.peekPendingKey(), leftover: leftover.current, openURLs },
      v => v.key === SMS_OS_DISAMBIGUATE_KEY && v.leftover === null && v.openURLs.length === 0,
      'session owns sms_disambiguate; collect-ref not co-armed');
    const guess = await session.resolvePending('yes');
    assert('DD2-YES leftover cannot authorize; ungrounded yes still no-ops',
      { guess, openURLs, pending: session.hasPending() },
      v => v.guess.status === 'pending' && v.openURLs.length === 0 && v.pending === true,
      'yes never selects from collect-ref or OS set');
    const cancel = await session.resolvePending('cancel');
    assert('DD2-CANCEL session cancel releases OS recovery',
      { cancel, openURLs, pending: session.hasPending(), leftover: leftover.current },
      v => v.cancel.status === 'noop'
        && /won't do that/i.test(v.cancel.ack)
        && v.openURLs.length === 0
        && v.pending === false
        && v.leftover === null,
      'cancel on ConversationSession; collect-ref already released');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'stale' } };
    await dispatchAction(
      { type: 'sms', contact: 'him', message: 'running late' },
      'Text him running late',
      makeSmsDeps({ session, pendingRef: leftover }),
    );
    assert('DD2-HERALD-RECOVERY leftover collect-ref yields to call_text_recovery',
      { key: session.peekPendingKey(), leftover: leftover.current },
      v => v.key === CALL_TEXT_RECOVERY_KEY && v.leftover === null,
      'Herald person recovery is session-owned');
  }
  {
    freshDB();
    const session = new ConversationSession();
    const leftover = { current: { action: 'confirm_call' as const, name: '911', phone: '911' } };
    await dispatchAction(
      { type: 'sms', contact: 'Paul', message: "I'll be there at 8" },
      "Text Paul and tell him I'll be there at 8",
      makeSmsDeps({ session, pendingRef: leftover, resolveContactPhone: osPaulPhone() }),
    );
    assert('DD2-911 911 confirm_call is not dropped when session also arms SMS recovery',
      leftover.current,
      v => v?.action === 'confirm_call' && v?.phone === '911',
      'emergency confirm stays on collect-ref');
  }
  {
    const db = freshDB();
    insertContact(db, { id: 'c_m', name: 'Mickey', phone: '555-010-0100' });
    const session = new ConversationSession();
    const openURLs: string[] = [];
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'stale' } };
    await dispatchAction(
      { type: 'call', contact: 'Mickey' },
      'Call Mickey.',
      makeSmsDeps({ session, openURLs, pendingRef: leftover }),
    );
    assert('DD2-CALL unique Call Mickey still dials; CALL not flattened into SMS collect',
      { urls: openURLs, leftover: leftover.current, pending: session.hasPending() },
      v => v.urls.some((u: string) => u.startsWith('tel:5550100100'))
        && v.pending === false
        && v.leftover?.action === 'text',
      'committed CALL; leftover SMS collect unchanged because session did not stay pending');
  }
  {
    freshDB();
    const session = new ConversationSession();
    const leftover = { current: { action: 'text' as const, name: 'Paul', body: 'stale' } };
    await dispatchAction(
      { type: 'call', contact: 'him' },
      'Call him.',
      makeSmsDeps({ session, pendingRef: leftover }),
    );
    assert('DD2-CALL-RECOVERY unresolved Call him session-owns; leftover SMS collect released',
      { key: session.peekPendingKey(), leftover: leftover.current },
      v => v.key === CALL_TEXT_RECOVERY_KEY && v.leftover === null,
      'CALL missing-person recovery is ConversationSession');
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1]?.endsWith('authorityReadinessRecovery.test.ts')) {
  runAuthorityReadinessRecoveryTests().catch(console.error);
}
