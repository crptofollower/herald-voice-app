// scripts/heraldTest/conversationalSubject.test.ts
// Flow C — one-turn conversational subject + pronoun-phone re-read by id.
//
// Runner: npx tsx scripts/heraldTest/conversationalSubject.test.ts
// Gate:   wired from run.mjs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { setDB, getDB } from '../../src/db/schema.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeServiceProvider } from '../../src/utils/householdCapture.ts';
import { writeMedicalRecord, attachVisitOutcome, getMedicalRecords, normalizeDoctorNameForMatch } from '../../src/db/medicalDB.ts';
import { findUpcomingEventsMatchingTerm, setCalendarEventFetcher, resetCalendarEventFetcher, queryCalendarEvidence } from '../../src/db/calendarCacheDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  ConversationalSubjectHolder,
  isReferentPhoneQuestion,
  isReferentVisitDateQuestion,
  isReferentVisitOutcomeQuestion,
  isReferentUpcomingVisitQuestion,
  isReferentYearBoundedVisitQuestion,
  answerReferentVisitDate,
  answerReferentUpcomingVisit,
  answerReferentYearBoundedVisit,
} from '../../src/routing/conversationalSubject.ts';
import { formatSpokenDate } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS service_providers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS insurance_policies (
    id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT,
    is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS legal_documents (
    id TEXT PRIMARY KEY, type TEXT, location TEXT, created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT, start_ms INTEGER, end_ms INTEGER,
    all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT
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

function freshFlow() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text: string) => processUtterance(text, session, deps, subject);
  return { db, session, subject, say };
}

function seedTwoDoctorOutcomes() {
  const patelId = writeMedicalRecord({ doctor_name: 'Dr. Patel', notes: 'visit', visit_date: '2026-05-01' });
  attachVisitOutcome(patelId, 'Patel said the labs were unremarkable.');
  const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
  attachVisitOutcome(smithId, 'Smith said to continue the current dose.');
}

function seedUpcomingAppointment(doctorName: string, visitDate: string) {
  writeMedicalRecord({ doctor_name: doctorName, visit_date: visitDate, status: 'upcoming' });
}

function seedCalendarEvent(title: string, startMs: number, opts?: { allDay?: boolean; endMs?: number }) {
  const db = getDB();
  db.runSync(
    `INSERT OR REPLACE INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    [
      `cal_${startMs}_${Math.random().toString(36).slice(2, 6)}`,
      title, startMs, opts?.endMs ?? startMs + 3600_000,
      opts?.allDay ? 1 : 0, null, new Date().toISOString(),
    ],
  );
}

// A fixed future instant well inside the forward window (never flaky vs "now").
function futureMs(daysAhead: number, hour = 11): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function futureYmd(daysAhead: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + daysAhead);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Android Calendar Range V1: expo-calendar has no native bridge inside the
// Node/tsx test runner, so queryCalendarEvidence's device fetch is swapped
// for a fake one via calendarCacheDB's setCalendarEventFetcher (mirrors this
// file's own setDB pattern). Returns {status:'ok', events} -- the fetcher's
// discriminated shape after the unavailable/ok distinction was added. The
// fake IGNORES the start/end bounds it's called with and returns the full
// seeded list every time -- the bound enforcement itself is the OS's
// contract (already evidenced safe from source, see session handoff), not
// something re-provable in this harness. What IS under test here is
// Herald's own matching/sorting/mapping/phrasing/range-filtering, which this
// fully exercises. Always reset in a finally so no test leaks its fake
// fetcher into a later block.
async function withFakeCalendarEvents<T>(
  events: { id: string; title: string; startDate: string | Date; endDate?: string | Date; notes?: string | null; allDay?: boolean }[],
  fn: () => Promise<T>,
): Promise<T> {
  setCalendarEventFetcher(async () => ({ status: 'ok' as const, events: events as any }));
  try {
    return await fn();
  } finally {
    resetCalendarEventFetcher();
  }
}

// Trust-boundary test helper: simulates the calendar source being
// unavailable (permission denied or a provider error) -- NOT the same as
// "zero events found". Proves the caller speaks the honest
// "I couldn't check your calendar right now." voice, never the confident
// "I don't have another visit..." miss string, when this fires.
async function withUnavailableCalendar<T>(
  reason: 'permission-denied' | 'error',
  fn: () => Promise<T>,
): Promise<T> {
  setCalendarEventFetcher(async () => ({ status: 'unavailable' as const, reason }));
  try {
    return await fn();
  } finally {
    resetCalendarEventFetcher();
  }
}

// Fixed instant N months from now, at a given hour -- for building fake
// wide-range/historical event fixtures without flakiness vs "now".
function monthsFromNowMs(monthsOffset: number, hour = 11): number {
  const d = new Date();
  d.setDate(1); // avoid month-length rollover surprises (e.g. Jan 31 + 1mo)
  d.setHours(hour, 0, 0, 0);
  d.setMonth(d.getMonth() + monthsOffset);
  return d.getTime();
}

const SMITH_OUTCOME = 'Smith said to continue the current dose.';
const PATEL_OUTCOME = 'Patel said the labs were unremarkable.';
const FOSTER_OUTCOME = 'Your blood pressure reading was elevated, follow up in a month.';
const VISIT_OUTCOME_MISS = "I don't have anything from your last visit yet.";

function spokenPhone(digits: string): string {
  const d = digits.replace(/\D/g, '');
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export async function runConversationalSubjectTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: any) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Flow C Conversational Subject Tests -------------------${RESET}\n`);

  // ── Speech-act parser (closed form; not entity-specific phrases) ──
  assert('P-her-phone', isReferentPhoneQuestion("What's her phone number?"), v => v === true, 'true');
  assert('P-her-number', isReferentPhoneQuestion("What's her number?"), v => v === true, 'true');
  assert('P-his-phone', isReferentPhoneQuestion("What's his phone number?"), v => v === true, 'true');
  assert('P-his-number', isReferentPhoneQuestion("What's his number?"), v => v === true, 'true');
  assert('P-what-is-her', isReferentPhoneQuestion('What is her number?'), v => v === true, 'true');
  assert('P-they-out', isReferentPhoneQuestion("What's their number?"), v => v === false, 'false');
  assert('P-who-is-she-out', isReferentPhoneQuestion('Who is she?'), v => v === false, 'false');
  assert('P-josh-explicit-out', isReferentPhoneQuestion("What's Josh's number?"), v => v === false, 'false');
  assert('P-what-about-her-out', isReferentPhoneQuestion('What about her?'), v => v === false, 'false');
  assert('P-address-out', isReferentPhoneQuestion("What's her address?"), v => v === false, 'false');
  assert('P-last-name-out', isReferentPhoneQuestion("What's her last name?"), v => v === false, 'false');

  // ── A. FAMILY POSITIVE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t1 = await say('Who is my wife?');
    assert('A1 wife identity read names Shannon', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read' && v.routeDecision.response.includes('Shannon'),
      'device_read Shannon');
    const established = subject.peek();
    assert('A2 exactly-one wife establishes family subject by id', established,
      v => v?.domain === 'family_contact' && v.displayName === 'Shannon' && typeof v.entityId === 'string' && v.entityId.length > 0 && !('gender' in v),
      'family_contact Shannon, stable id, no gender field');
    const t2 = await say("What's her phone number?");
    assert('A3 pronoun phone is Flow C current Shannon number', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon')
        && !/wife/i.test(v.responseText),
      "Shannon's number is 214-555-0100, no cached wife copy");
    assert('A4 subject clears after consume', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── B. FAMILY NO PHONE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say("What's her number?");
    assert('B1 honest miss, no fabricated phone', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && /don't have a number/i.test(v.responseText)
        && !/\d{3}/.test(v.responseText),
      'honest miss, no digits');
    assert('B2 subject clears after miss', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── C. EXPLICIT OVERRIDE ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    writeContactRaw({ name: 'Josh', relationship: 'son', phone: '9725550199', importance: 7 });
    await say('Who is my wife?');
    const t2 = await say("What's Josh's number?");
    assert('C1 Josh explicit reader, not Shannon hijack', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'contact:phone_lookup'
        && v.routeDecision.response.includes('Josh')
        && v.routeDecision.response.includes('972')
        && v.routeDecision.response.includes('555-0199')
        && !v.routeDecision.response.includes('214'),
      'Josh lookup, Shannon phone absent');
    assert('C2 unused next turn clears Shannon subject', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── D. NO CONTEXT ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t1 = await say("What's her phone number?");
    assert('D1 no subject → Flow C does not resolve', t1,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    const text = t1.handled && 'responseText' in t1 ? t1.responseText : (t1.handled === false ? t1.routeDecision.kind === 'device_read' ? t1.routeDecision.response : '' : '');
    assert('D2 no guessed person', { text, live: subject.hasLive() },
      v => !/Shannon/i.test(v.text) && v.live === false,
      'no Shannon, no subject');
  }

  // ── E. ONE-TURN EXPIRY ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say('Open YouTube');
    assert('E1 unused unrelated turn is not Flow C', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    assert('E2 subject gone after unused turn', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say("What's her number?");
    assert('E3 later pronoun fail-closed', t3,
      v => !(v.handled === true && v.source === 'referent_resume')
        && !(v.handled === true && 'responseText' in v && v.responseText.includes(spokenPhone('2145550100'))),
      'no old Shannon resolution');
  }

  // ── F. MULTI-ENTITY ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Hunter', relationship: 'son', phone: '2145550111', importance: 7 });
    writeContactRaw({ name: 'Grant', relationship: 'son', phone: '2145550222', importance: 7 });
    const t1 = await say('Who are my sons?');
    assert('F1 multi-son identity read does not establish', { t1, live: subject.hasLive(), peek: subject.peek() },
      v => v.t1.handled === false && v.live === false && v.peek === null,
      'no subject');
    const t2 = await say("What's his number?");
    assert('F2 pronoun does not pick a son', t2,
      v => !(v.handled === true && v.source === 'referent_resume')
        && !(v.handled === true && 'responseText' in v && (v.responseText.includes('214-555-0111') || v.responseText.includes('214-555-0222'))),
      'no pick');
  }

  // ── G. PENDING PRECEDENCE ──
  {
    const { say, session, subject } = freshFlow();
    const shannonId = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    seedTwoDoctorOutcomes();
    await say('Who is my wife?');
    const arm = await say('What did my doctor tell me?');
    assert('G1 medical pending arms', { arm, pending: session.hasPending() },
      v => v.arm.handled === true && v.arm.source === 'capture' && v.pending === true,
      'pending armed');
    subject.establishFamily({ entityId: shannonId, displayName: 'Shannon', relationship: 'wife' });
    assert('G2 holder prepared with live subject while pending', subject.hasLive(), v => v === true, 'live');
    const t3 = await say("What's her number?");
    assert('G3 PendingSlot owns the utterance', t3,
      v => v.handled === true && v.source === 'pending_resume'
        && !v.responseText.includes(spokenPhone('2145550100'))
        && !/Shannon/i.test(v.responseText),
      'pending_resume, no Shannon phone');
    assert('G4 Flow C resolver was not evaluated', subject.didEvaluateReferent(), v => v === false, 'not evaluated');
    assert('G5 subject cleared when pending owned the turn', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── H. HOUSEHOLD ──
  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    const t1 = await say('Who is my plumber?');
    assert('H1 plumber identity read names Bob', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_action'
        && v.routeDecision.actionIntent.type === 'household_read',
      'household_read');
    const established = subject.peek();
    assert('H2 exactly-one plumber establishes household subject', established,
      v => v?.domain === 'household_provider' && v.displayName === 'Bob' && typeof v.entityId === 'string' && v.entityId.length > 0,
      'household_provider Bob');
    const t2 = await say("What's his number?");
    assert('H3 pronoun phone is Flow C current Bob number', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550103'))
        && v.responseText.includes('Bob')
        && !/plumber/i.test(v.responseText),
      "Bob's number, no cached plumber copy");
    assert('H4 subject clears after consume', subject.hasLive(), v => v === false, 'cleared');
  }

  // Insurance/legal household reads do not establish
  {
    const { say, subject, db } = freshFlow();
    db.prepare(
      `INSERT INTO insurance_policies (id, type, carrier, is_active, created_at, updated_at)
       VALUES ('ins1', 'home', 'State Farm', 1, datetime('now'), datetime('now'))`
    ).run();
    await say("Who's my home insurance with?");
    assert('H5 insurance read does not establish subject', subject.hasLive(), v => v === false, 'no subject');
  }

  // ── I. RESTART ──
  {
    const a = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await a.say('Who is my wife?');
    assert('I1 holder A has subject', a.subject.hasLive(), v => v === true, 'live');
    const b = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    const t = await b.say("What's her number?");
    assert('I2 new holder/session does not resolve old subject', t,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'no resolution');
  }

  // ── J. STALE PHONE ──
  {
    const { say, subject, db } = freshFlow();
    const id = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE contacts SET phone = ? WHERE id = ?`).run('4695550999', entityId);
    const t2 = await say("What's her phone number?");
    assert('J1 re-read returns NEW phone', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550999'))
        && !v.responseText.includes(spokenPhone('2145550100')),
      'new phone, not old');
  }

  // ── K. SECOND PRONOUN AFTER CONSUME ──
  {
    const { say } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t2 = await say("What's her number?");
    assert('K1 first pronoun consumes', t2, v => v.handled === true && v.source === 'referent_resume', 'referent_resume');
    const t3 = await say("What's her number?");
    assert('K2 second pronoun has no old-subject resolution', t3,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'no old-subject resolution');
  }

  // ── L. RELATIONSHIP / CATEGORY STALENESS ──
  {
    const { say, subject, db } = freshFlow();
    const id = writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE contacts SET relationship = ? WHERE id = ?`).run('sister', entityId);
    const t2 = await say("What's her number?");
    assert('L1 phone from current row, not stale wife copy', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && !/wife/i.test(v.responseText)
        && !/sister/i.test(v.responseText),
      'current phone, no relationship spoken');
  }
  {
    const { say, subject, db } = freshFlow();
    const id = writeServiceProvider('plumber', 'Bob', '469-555-0103');
    await say('Who is my plumber?');
    const entityId = subject.peek()?.entityId ?? id;
    db.prepare(`UPDATE service_providers SET category = ? WHERE id = ?`).run('electrician', entityId);
    const t2 = await say("What's his number?");
    assert('L2 phone from current provider row, not stale plumber copy', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('4695550103'))
        && !/plumber/i.test(v.responseText)
        && !/electrician/i.test(v.responseText),
      'current phone, no category spoken');
  }

  // ── M. PRONOUN GENDER MISMATCH ──
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const id = subject.peek()?.entityId;
    assert('M1 no gender field on established subject', subject.peek(),
      v => v != null && !('gender' in v) && !('pronoun' in v),
      'no gender/pronoun field');
    const tHis = await say("What's his number?");
    assert('M2 opposite pronoun his binds the one subject', tHis,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon'),
      'same Shannon phone');
    void id;
  }
  {
    const { say } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const tHer = await say("What's her number?");
    assert('M3 matching pronoun her binds the same id authority', tHer,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(spokenPhone('2145550100'))
        && v.responseText.includes('Shannon'),
      'same Shannon phone');
  }

  // Nameless provider: no subject
  {
    const { say, subject, db } = freshFlow();
    db.prepare(
      `INSERT INTO service_providers (id, name, phone, category, created_at, updated_at)
       VALUES ('sp_bad', '', '4695550103', 'plumber', datetime('now'), datetime('now'))`
    ).run();
    await say('Who is my plumber?');
    assert('N-nameless provider does not establish', subject.hasLive(), v => v === false, 'no subject');
  }

  // Law 0 clears a live subject
  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('Who is my wife?');
    const t = await say('I need help');
    assert('L0a Law 0 owns the turn', t, v => v.handled === true && v.source === 'emergency', 'emergency');
    assert('L0b Law 0 clears subject', subject.hasLive(), v => v === false, 'cleared');
  }

  // ── Continuity Step 3 — doctor subject + visit-date referent ───────────────
  assert('V-him', isReferentVisitDateQuestion('When did I see him?'), v => v === true, 'true');
  assert('V-last-her', isReferentVisitDateQuestion('When did I last see her?'), v => v === true, 'true');
  assert('V-patel-out', isReferentVisitDateQuestion('When did I see Dr. Patel?'), v => v === false, 'false');
  assert('V-phone-out', isReferentVisitDateQuestion("What's his number?"), v => v === false, 'false');

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const before = getMedicalRecords().length;
    const t1 = await say('Who was the last doctor I saw?');
    assert('S3-1a Variant A still visit_history_read (no pronoun, unhinted global ok)', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_read'
        && v.routeDecision.response.includes('Dr. Smith'),
      'device_read / visit_history_read / Smith');
    const established = subject.peek();
    assert('S3-1 doctor read establishes medical_doctor with the latest name', established,
      v => v?.domain === 'medical_doctor' && v.entityId === 'Dr. Smith' && v.displayName === 'Dr. Smith',
      'medical_doctor Dr. Smith');
    assert('S3-10 establishment does not write medical_records', getMedicalRecords().length,
      v => v === before, String(before));
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Patel?');
    assert('S3-4 named Patel remains visit_history_read', subject.peek(),
      v => v?.domain === 'medical_doctor' && v.entityId === 'Dr. Patel',
      'established Patel');
    const tNamed = await (async () => {
      const { say: say2 } = freshFlow();
      seedTwoDoctorOutcomes();
      const t = await say2('When did I see Dr. Patel?');
      return t;
    })();
    assert('S3-4b reason unchanged for named doctor', tNamed,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_read',
      'medical:visit_history_read');
    const t2 = await say('When did I see him?');
    const patelSpoken = formatSpokenDate('2026-05-01');
    const smithSpoken = formatSpokenDate('2026-07-20');
    assert('S3-2 live doctor + when-did-I-see-him is referent_resume from storage', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes('Dr. Patel')
        && v.responseText.includes(patelSpoken)
        && !v.responseText.includes('Dr. Smith')
        && !v.responseText.includes(smithSpoken),
      `referent_resume Patel on ${patelSpoken}, not Smith`);
    assert('S3-2b subject RENEWED (still live) after visit-date consume', subject.hasLive(), v => v === true, 'live');
    assert('S3-2c renewed subject is still Patel, not cleared/switched', subject.peek()?.entityId, v => v === 'Dr. Patel', 'Dr. Patel');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const t1 = await say('When did I see him?');
    assert('S3-3a pronoun with no subject is unresolved_referent', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent'
        && v.routeDecision.response === "I'm not sure who you mean — which doctor?"
        && !/Smith|Patel|You last saw/i.test(v.routeDecision.response),
      'unresolved_referent clarification, no global visit data');
    assert('S3-3c no subject established', subject.hasLive(), v => v === false, 'no subject');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const t2 = await say('Open YouTube');
    assert('S3-5a unused turn is not Flow C', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
    assert('S3-5b subject gone after unused turn', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say('When did I see him?');
    assert('S3-5c later pronoun fail-closed', t3,
      v => v.handled === false
        && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent'
        && !/Smith|Patel|You last saw/i.test(v.routeDecision.response),
      'unresolved_referent, no global visit data');
  }

  {
    const { say, session, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const arm = await say('What did my doctor tell me?');
    assert('S3-6a medical pending arms', { arm, pending: session.hasPending() },
      v => v.arm.handled === true && v.arm.source === 'capture' && v.pending === true,
      'pending armed');
    assert('S3-6b pending clears subject before next turn', subject.hasLive(), v => v === false, 'cleared by pending arm');
    subject.establishMedical({ entityId: 'Dr. Smith', displayName: 'Dr. Smith' });
    const t3 = await say('When did I see him?');
    assert('S3-6c visit-date pronoun is a read_only escape, pending preserved', t3,
      v => !(v.handled === true && v.source === 'pending_resume')
        && session.peekPendingKey() === 'medical_visit_outcome_read_disambiguate',
      'not pending_resume; doctor pending preserved');
    assert('S3-6d Flow C may evaluate after pending yielded the read', subject.didEvaluateReferent(), v => v === true, 'evaluated');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('Who was the last doctor I saw?');
    const t = await say('I need help');
    assert('S3-7a Law 0 owns the turn', t, v => v.handled === true && v.source === 'emergency', 'emergency');
    assert('S3-7b Law 0 clears doctor subject', subject.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    seedTwoDoctorOutcomes();
    await say('Who is my plumber?');
    assert('S3-H live household subject', subject.peek()?.domain, v => v === 'household_provider', 'household_provider');
    const t2 = await say('When did I see him?');
    assert('S3-H no cross-domain visit answer', t2,
      v => !(v.handled === true && v.source === 'referent_resume' && typeof v.responseText === 'string' && /last saw/i.test(v.responseText)),
      'not a visit-date referent_resume');
    assert('S3-H falls through to unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_history_unresolved_referent',
      'medical:visit_history_unresolved_referent');
  }

  // ── Continuity Step 3b — doctor subject + visit-outcome referent ───────────
  console.log(`\n${BOLD}  Visit-outcome referent (Flow C + tierRouter guard)${RESET}\n`);

  assert('O-P-he', isReferentVisitOutcomeQuestion('What did he tell me?'), v => v === true, 'true');
  assert('O-P-she', isReferentVisitOutcomeQuestion('What did she tell me?'), v => v === true, 'true');
  assert('O-P-they', isReferentVisitOutcomeQuestion('What did they tell me?'), v => v === true, 'true');
  assert('O-P-patel-out', isReferentVisitOutcomeQuestion('What did Dr. Patel tell me?'), v => v === false, 'false');
  assert('O-P-him-out', isReferentVisitOutcomeQuestion('What did him tell me?'), v => v === false, 'false');

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    assert('O1a Smith established', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did he tell me?');
    assert('O1b referent_resume with Smith outcome', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(PATEL_OUTCOME),
      'referent_resume / Smith outcome');
    assert('O1c subject RENEWED (still live) after outcome consume', subject.hasLive(), v => v === true, 'live');
  }

  {
    const { say, subject } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const fosterId = writeMedicalRecord({ doctor_name: 'Dr. Foster', notes: 'visit', visit_date: '2026-07-20' });
    attachVisitOutcome(fosterId, FOSTER_OUTCOME);
    await say('When did I see Dr. Smith?');
    assert('O2a Smith subject locked', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did he tell me?');
    assert('O2b returns Smith outcome, not newer Foster', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes('elevated')
        && !v.responseText.includes(FOSTER_OUTCOME),
      'Smith only');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const t1 = await say('What did he tell me?');
    assert('O3a no-subject → visit_outcome_unresolved_referent', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
    assert('O3b clarify copy', t1,
      v => v.handled === false && v.routeDecision.response === "I'm not sure who you mean — which doctor?",
      "I'm not sure who you mean — which doctor?");
    assert('O3c never global latest outcome', t1,
      v => v.handled === false
        && !v.routeDecision.response.includes(SMITH_OUTCOME)
        && !v.routeDecision.response.includes(PATEL_OUTCOME)
        && v.routeDecision.tier === 1,
      'tier-1 clarify, no Smith/Patel leak');
    assert('O3d no subject established', subject.hasLive(), v => v === false, 'no subject');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    assert('O4a stale Smith subject live', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t2 = await say('What did Dr. Patel tell me?');
    assert('O4b explicit Patel wins over stale subject', t2,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_outcome_read'
        && v.routeDecision.response.includes(PATEL_OUTCOME)
        && !v.routeDecision.response.includes(SMITH_OUTCOME),
      'Patel outcome via named read');
    assert('O4c not referent_resume hijack', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'not referent_resume');
  }

  {
    const { say, subject } = freshFlow();
    writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20', status: 'noted' });
    await say('When did I see Dr. Smith?');
    const t2 = await say('What did he tell me?');
    assert('O5a no stored outcome → exact miss string', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText === VISIT_OUTCOME_MISS,
      VISIT_OUTCOME_MISS);
    assert('O5b subject RENEWED even on honest miss (identity still resolved)', subject.hasLive(), v => v === true, 'live');
  }

  {
    const { say, subject } = freshFlow();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    seedTwoDoctorOutcomes();
    await say('Who is my wife?');
    assert('O6a family subject live', subject.peek()?.domain, v => v === 'family_contact', 'family_contact');
    const t2 = await say('What did he tell me?');
    assert('O6b no medical cross-resolution from family subject', t2,
      v => !(v.handled === true && v.source === 'referent_resume'
        && typeof v.responseText === 'string'
        && (v.responseText.includes(SMITH_OUTCOME) || v.responseText.includes(PATEL_OUTCOME))),
      'no medical outcome via family subject');
    assert('O6c fail-closed to visit_outcome_unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
  }

  {
    const { say, subject } = freshFlow();
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    seedTwoDoctorOutcomes();
    await say('Who is my plumber?');
    assert('O6d household subject live', subject.peek()?.domain, v => v === 'household_provider', 'household_provider');
    const t2 = await say('What did he tell me?');
    assert('O6e no medical cross-resolution from household subject', t2,
      v => !(v.handled === true && v.source === 'referent_resume'
        && typeof v.responseText === 'string'
        && (v.responseText.includes(SMITH_OUTCOME) || v.responseText.includes(PATEL_OUTCOME))),
      'no medical outcome via household subject');
    assert('O6f fail-closed to visit_outcome_unresolved_referent', t2,
      v => v.handled === false && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent',
      'medical:visit_outcome_unresolved_referent');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    const tShe = await say('What did she tell me?');
    assert('O7a she pronoun referent_resume Smith outcome', tShe,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME),
      'she → Smith outcome');
    assert('O7b she consume RENEWS subject', subject.hasLive(), v => v === true, 'live');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    const tThey = await say('What did they tell me?');
    assert('O7c they pronoun referent_resume Smith outcome', tThey,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME),
      'they → Smith outcome');
    assert('O7d they consume RENEWS subject', subject.hasLive(), v => v === true, 'live');
  }

  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    await say('When did I see him?');
    assert('O8a visit-date consume RENEWS subject (was: cleared)', subject.hasLive(), v => v === true, 'live');
    const t3 = await say('What did he tell me?');
    assert('O8b chained outcome pronoun now RESOLVES via renewed subject (was: fail-closed)', t3,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(PATEL_OUTCOME),
      'referent_resume, Smith outcome');
  }

  {
    const procPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/processUtterance.ts');
    const src = fs.readFileSync(procPath, 'utf8');
    const liveStart = src.indexOf('if (subject?.hasLive())');
    const liveEnd = src.indexOf('// 2) The single routing authority');
    const liveBlock = src.slice(liveStart, liveEnd);
    const outcomeIdx = liveBlock.indexOf('isReferentVisitOutcomeQuestion(text)');
    const trailingClearIdx = liveBlock.lastIndexOf('subject.clear();');
    assert('O-SL outcome block precedes trailing unused-subject clear', { outcomeIdx, trailingClearIdx },
      v => (v as { outcomeIdx: number; trailingClearIdx: number }).outcomeIdx > 0
        && (v as { outcomeIdx: number; trailingClearIdx: number }).outcomeIdx
          < (v as { outcomeIdx: number; trailingClearIdx: number }).trailingClearIdx,
      'outcome before trailing clear');
    assert('O-SL outcome block follows visit-date block', liveBlock,
      v => (v as string).indexOf('isReferentVisitDateQuestion(text)')
        < (v as string).indexOf('isReferentVisitOutcomeQuestion(text)'),
      'visit-date before outcome');
  }

  // ── Continuity Step 4 — upcoming-visit referent (Flow C + tierRouter guard) ──
  console.log(`\n${BOLD}  Upcoming-visit referent + medical chaining (Continuity Step 4)${RESET}\n`);

  assert('U-P-am-i-seeing-him', isReferentUpcomingVisitQuestion('When am I seeing him again?'), v => v === true, 'true');
  assert('U-P-do-i-see-her', isReferentUpcomingVisitQuestion('When do I see her again?'), v => v === true, 'true');
  assert('U-P-next-appt-they', isReferentUpcomingVisitQuestion("When's my next appointment with them?"), v => v === true, 'true');
  assert('U-P-patel-out', isReferentUpcomingVisitQuestion('When am I seeing Dr. Patel again?'), v => v === false, 'false');
  assert('U-P-phone-out', isReferentUpcomingVisitQuestion("What's his number?"), v => v === false, 'false');

  // ── Test A (spec): three-turn chain, same doctor, no re-naming ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const t1 = await say('Who was the last doctor I saw?');
    assert('CHAIN-A1 turn 1 establishes Smith', t1.handled === false && t1.routeDecision.response.includes('Dr. Smith'), v => v === true, 'Dr. Smith named');
    const t2 = await say('When did I see him?');
    assert('CHAIN-A2 turn 2 resolves Smith visit date via referent_resume', t2,
      v => v.handled === true && v.source === 'referent_resume' && v.responseText.includes('Dr. Smith'),
      'referent_resume, Dr. Smith');
    assert('CHAIN-A3 subject still live after turn 2', subject.hasLive(), v => v === true, 'live');
    const t3 = await say('What did he tell me?');
    assert('CHAIN-A4 turn 3 resolves Smith outcome via referent_resume, same subject', t3,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(SMITH_OUTCOME)
        && !v.responseText.includes(PATEL_OUTCOME),
      'referent_resume, Smith outcome only');
  }

  // ── Test B (spec): four-turn chain including upcoming-visit ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    const smithUpcoming = futureYmd(14);
    seedUpcomingAppointment('Dr. Smith', smithUpcoming);
    await say('Who was the last doctor I saw?');
    await say('When did I see him?');
    await say('What did he tell me?');
    assert('CHAIN-B1 subject still live after three referent turns', subject.hasLive(), v => v === true, 'live');
    assert('CHAIN-B2 subject still Smith after three referent turns', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    const t4 = await say('When am I seeing him again?');
    assert('CHAIN-B3 turn 4 resolves Smith upcoming visit via referent_resume', t4,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes('Dr. Smith')
        && v.responseText.includes(formatSpokenDate(smithUpcoming)),
      'referent_resume, Smith upcoming visit');
  }

  // ── Test C (spec): explicit named subject replaces the stale live one ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    assert('CHAIN-C1 Smith established', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    await say('When did I see Dr. Patel?');
    assert('CHAIN-C2 explicit named Patel overrides stale Smith subject', subject.peek()?.entityId, v => v === 'Dr. Patel', 'Dr. Patel');
    const t3 = await say('What did he tell me?');
    assert('CHAIN-C3 subsequent "him" resolves to Patel, never Smith', t3,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.includes(PATEL_OUTCOME)
        && !v.responseText.includes(SMITH_OUTCOME),
      'Patel outcome only');
  }

  // ── Test D (spec): unrelated turn releases the subject, no resurrection ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    await say('When did I see Dr. Smith?');
    await say('When did I see him?'); // renews Smith
    assert('CHAIN-D1 subject live before unrelated turn', subject.hasLive(), v => v === true, 'live');
    await say('Open YouTube'); // unrelated -- must release
    assert('CHAIN-D2 subject released by unrelated turn', subject.hasLive(), v => v === false, 'cleared');
    const t3 = await say('What did he tell me?');
    assert('CHAIN-D3 pronoun after release fails closed, no resurrection of Smith', t3,
      v => v.handled === false
        && v.routeDecision.reason === 'medical:visit_outcome_unresolved_referent'
        && !v.routeDecision.response.includes(SMITH_OUTCOME),
      'unresolved_referent, no Smith leak');
  }

  // ── Test E (spec): missing subject, upcoming-visit leg specifically ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    seedUpcomingAppointment('Dr. Smith', '2026-09-10');
    seedUpcomingAppointment('Dr. Patel', '2026-09-15');
    const t1 = await say('When am I seeing him again?');
    assert('CHAIN-E1 no-subject upcoming referent fails closed', t1,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.reason === 'medical:visit_upcoming_unresolved_referent'
        && v.routeDecision.response === "I'm not sure who you mean — which doctor?",
      'unresolved referent clarification');
    assert('CHAIN-E2 no broad/lifetime fallback leaked either doctor', t1,
      v => v.handled === false
        && !t1.routeDecision.response.includes('Smith')
        && !t1.routeDecision.response.includes('Patel'),
      'no doctor named');
    assert('CHAIN-E3 no subject established by the miss', subject.hasLive(), v => v === false, 'no subject');
  }

  // ── Test F (spec): live subject, but no matching upcoming appointment ──
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes(); // Smith and Patel both have PAST visits only, no upcoming rows
    await withFakeCalendarEvents([], async () => {
      await say('When did I see Dr. Smith?');
      const t2 = await say('When am I seeing him again?');
      assert('CHAIN-F1 honest miss, no fabricated appointment', t2,
        v => v.handled === true && v.source === 'referent_resume'
          && v.responseText === "I don't see anything with Dr. Smith on your calendar in the next 6 months.",
        "I don't see anything with Dr. Smith on your calendar in the next 6 months.");
      assert('CHAIN-F2 subject preserved (not silently switched) after the miss', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
    });
  }

  // ── Test G (spec): near-name decoy does not get auto-selected ──
  {
    const { say, subject } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    seedUpcomingAppointment('Dr. Smithson', '2026-09-20'); // decoy: similar but NOT the same doctor
    await withFakeCalendarEvents([], async () => {
      await say('When did I see Dr. Smith?');
      assert('CHAIN-G1 Smith subject established, not Smithson', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
      const t2 = await say('When am I seeing him again?');
      assert('CHAIN-G2 decoy Smithson row never auto-selected for Smith\'s subject', t2,
        v => v.handled === true && v.source === 'referent_resume'
          && v.responseText === "I don't see anything with Dr. Smith on your calendar in the next 6 months."
          && !v.responseText.includes('Smithson'),
        "honest miss for Smith, no Smithson leak");
    });
  }

  // ── Forward Calendar Evidence V1 — doctor subject → calendar fallback ──
  console.log(`\n${BOLD}  Forward Calendar Evidence V1 (calendar-source fallback)${RESET}\n`);

  // Locale-independent helper: the expected weekday for a seeded event,
  // derived from the SAME formatter path the production code uses (build
  // CalendarEvidenceParts -> toLocaleDateString weekday), so tests never
  // hardcode a device's AM/PM punctuation or 12h/24h time rendering. We
  // assert on provenance prefix + name + weekday (the user-visible
  // requirement), not on a Samsung-specific time string. Seeded events are
  // spread across distinct days so weekday alone distinguishes the correct
  // event from decoys.
  const weekdayOf = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'long' });

  // A — calendar fallback when medical authority has no upcoming visit
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes(); // Smith + Patel PAST visits only, no upcoming medical rows
    const smithMs = futureMs(2, 11);
    seedCalendarEvent('Dr. Smith', smithMs);
    await say('When did I see Dr. Smith?'); // establish Smith subject
    const t2 = await say('When am I seeing him again?');
    assert('CAL-A1 calendar fallback: provenance prefix + name + correct weekday', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText.startsWith('Your calendar shows Dr. Smith on ')
        && v.responseText.includes(weekdayOf(smithMs)),
      `Your calendar shows Dr. Smith on ${weekdayOf(smithMs)} …`);
    assert('CAL-A2 subject remains Dr. Smith after calendar answer', subject.peek()?.entityId,
      v => v === 'Dr. Smith', 'Dr. Smith');
    assert('CAL-A3 answer does NOT use confirmed-medical voice', t2,
      v => v.handled === true && !/^You see /.test(v.responseText)
        && !/You have an appointment/i.test(v.responseText),
      'no confirmed-medical phrasing');
  }

  // B — medical authority precedence: confirmed upcoming visit wins, calendar ignored
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    seedUpcomingAppointment('Dr. Smith', '2026-12-01'); // confirmed MEDICAL upcoming
    seedCalendarEvent('Dr. Smith', futureMs(2, 9)); // calendar also has one, sooner
    await say('When did I see Dr. Smith?');
    const t2 = await say('When am I seeing him again?');
    assert('CAL-B1 medical authority wins, confirmed-memory voice used', t2,
      v => v.handled === true && v.source === 'referent_resume'
        && /^You see Dr\. Smith on /.test(v.responseText),
      'You see Dr. Smith … (medical voice)');
    assert('CAL-B2 calendar fallback did NOT override medical', t2,
      v => v.handled === true && !/Your calendar shows/.test(v.responseText),
      'no calendar-provenance phrasing');
  }

  // C — namesake fence, chronology-CANNOT-hide-a-break: both decoys
  //     (Smithson, Smithers) sit SOONER than the legitimate longer title, so
  //     a broken fence would surface a decoy, not the real event. Distinct
  //     days => weekday distinguishes them without a time string.
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const decoy1Ms = futureMs(1, 9);
    const decoy2Ms = futureMs(2, 10);
    const realMs = futureMs(4, 15);
    seedCalendarEvent('Dr. Smithson', decoy1Ms);            // namesake decoy, soonest
    seedCalendarEvent('Dr. Smithers', decoy2Ms);            // namesake decoy, 2nd
    seedCalendarEvent('Appointment with Dr. Smith', realMs); // legitimate longer title, latest
    await say('When did I see Dr. Smith?');
    const t2 = await say('When am I seeing him again?');
    assert('CAL-C1 longer legitimate title matches; correct (later) event, not a sooner namesake', t2,
      v => v.handled === true && v.responseText.startsWith('Your calendar shows Dr. Smith on ')
        && v.responseText.includes(weekdayOf(realMs))
        && !v.responseText.includes(weekdayOf(decoy1Ms)),
      `real event weekday ${weekdayOf(realMs)}, not a decoy`);
    assert('CAL-C2 Smithson never leaks', t2,
      v => v.handled === true && !/Smithson/.test(v.responseText), 'no Smithson');
    assert('CAL-C3 Smithers never leaks', t2,
      v => v.handled === true && !/Smithers/.test(v.responseText), 'no Smithers');
  }

  // C-unit — direct matcher proof, independent of chronology AND of speech
  //          formatting. Proves the token-sequence fence itself: two
  //          legitimate titles match, both namesakes excluded, regardless of
  //          ordering. This is the assertion that catches a broken fence even
  //          if a decoy were later.
  {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    setDB(makeShim(db));
    seedCalendarEvent('Dr. Smithson', futureMs(1, 9));
    seedCalendarEvent('Dr. Smithers', futureMs(1, 10));
    seedCalendarEvent('Dr. Smith - Follow Up', futureMs(2, 11));
    seedCalendarEvent('Appointment with Dr. Smith', futureMs(3, 12));
    // Pass the RAW term -- the reader tokenizes and normalizes internally.
    const hits = findUpcomingEventsMatchingTerm('Dr. Smith', normalizeDoctorNameForMatch);
    const titles = hits.map((h: { title: string }) => h.title).sort();
    assert('CAL-Cu1 matcher returns exactly the two legitimate Dr. Smith titles', titles,
      v => Array.isArray(v) && v.length === 2
        && v.includes('Appointment with Dr. Smith')
        && v.includes('Dr. Smith - Follow Up'),
      'two legitimate titles only');
    assert('CAL-Cu2 matcher excludes Smithson (partial-token namesake)', hits,
      (v: { title: string }[]) => !v.some(h => /Smithson/.test(h.title)), 'no Smithson row');
    assert('CAL-Cu3 matcher excludes Smithers (partial-token namesake)', hits,
      (v: { title: string }[]) => !v.some(h => /Smithers/.test(h.title)), 'no Smithers row');
  }

  // C-i18n — Unicode/accented name: the tokenizer must NOT shred an accented
  //          name on its accent char, must match it inside a longer title,
  //          and must still fence a partial-token namesake built on it. Proves
  //          the tokenizer is not ASCII-only. Uses a fresh DB like CAL-Cu.
  {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    setDB(makeShim(db));
    seedCalendarEvent('Dr. Muñoz', futureMs(1, 9));                 // exact accented match
    seedCalendarEvent('Appointment with Dr. Muñoz', futureMs(2, 10)); // accented inside longer title
    seedCalendarEvent('Dr. Muñozson', futureMs(3, 11));            // accented namesake decoy
    const hits = findUpcomingEventsMatchingTerm('Dr. Muñoz', normalizeDoctorNameForMatch);
    const titles = hits.map((h: { title: string }) => h.title).sort();
    assert('CAL-Ci1 accented name matches itself + longer title, not shredded on accent', titles,
      v => Array.isArray(v) && v.length === 2
        && v.includes('Dr. Muñoz')
        && v.includes('Appointment with Dr. Muñoz'),
      'both legitimate Muñoz titles');
    assert('CAL-Ci2 accented partial-token namesake (Muñozson) still fenced', hits,
      (v: { title: string }[]) => !v.some(h => /Muñozson/.test(h.title)), 'no Muñozson row');
  }

  // D — no medical result AND no calendar match anywhere within the checked
  //     bounds (14-day cache, then the 6-month wide-range search added by
  //     Android Calendar Range V1) → honest BOUNDED no-result, no
  //     substitution. Wraps the scenario in a fake wide-range fetcher
  //     returning {status:'ok', events:[]} -- this scenario now also
  //     reaches that tier (added after this test was originally written),
  //     and without the mock the real fetcher would fail in this Node test
  //     environment and produce "I couldn't check your calendar right now."
  //     instead, which is not what this test proves.
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes();
    seedCalendarEvent('Dentist cleaning', futureMs(2, 11)); // unrelated event present in the 14-day cache
    await withFakeCalendarEvents([], async () => {
      await say('When did I see Dr. Smith?');
      const t2 = await say('When am I seeing him again?');
      assert('CAL-D1 honest BOUNDED no-result when neither source matches (CTO trust correction)', t2,
        v => v.handled === true && v.source === 'referent_resume'
          && v.responseText === "I don't see anything with Dr. Smith on your calendar in the next 6 months.",
        "I don't see anything with Dr. Smith on your calendar in the next 6 months.");
      assert('CAL-D2 unrelated calendar event never substituted', t2,
        v => v.handled === true && !/Dentist/.test(v.responseText) && !/Your calendar shows/.test(v.responseText),
        'no substitution');
      assert('CAL-D3 subject preserved after honest miss', subject.peek()?.entityId,
        v => v === 'Dr. Smith', 'Dr. Smith');
    });
  }

  // E — multiple future Dr. Smith calendar events → nearest chosen
  //     deterministically. Distinct days => weekday of the nearest event must
  //     appear; the later event's (distinct) weekday must not.
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    const nearestMs = futureMs(2, 9);
    const laterMs = futureMs(5, 15);
    seedCalendarEvent('Dr. Smith', laterMs);   // later
    seedCalendarEvent('Dr. Smith', nearestMs); // nearest -- should win
    await say('When did I see Dr. Smith?');
    const t2 = await say('When am I seeing him again?');
    assert('CAL-E1 nearest future calendar event chosen (deterministic soonest-first)', t2,
      v => v.handled === true
        && v.responseText.includes(weekdayOf(nearestMs))
        && (weekdayOf(nearestMs) === weekdayOf(laterMs) || !v.responseText.includes(weekdayOf(laterMs))),
      `nearest weekday ${weekdayOf(nearestMs)}`);
  }

  // F — provenance: calendar answer always source-voiced, never medical-voiced
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    seedCalendarEvent('Dr. Smith', futureMs(2, 11));
    await say('When did I see Dr. Smith?');
    const t2 = await say('When am I seeing him again?');
    assert('CAL-F1 provenance prefix present and exact', t2,
      v => v.handled === true && v.responseText.startsWith('Your calendar shows '),
      'starts with "Your calendar shows "');
  }

  // G — no write side effect: reading calendar evidence writes nothing to medical_records
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    seedCalendarEvent('Dr. Smith', futureMs(2, 11));
    const before = getMedicalRecords().length;
    await say('When did I see Dr. Smith?');
    await say('When am I seeing him again?');
    assert('CAL-G1 calendar read creates no medical_records row', getMedicalRecords().length,
      v => v === before, String(before));
  }

  // ── Android Calendar Range V1 — wide-range / historical / year-bounded ──
  console.log(`\n${BOLD}  Android Calendar Range V1 (wide-range calendar evidence)${RESET}\n`);

  assert('RANGE-P1 year-bounded regex: "I thought I saw him in 2024"',
    isReferentYearBoundedVisitQuestion('I thought I saw him in 2024?'),
    v => v !== null && v.year === 2024, '{year: 2024}');
  assert('RANGE-P2 year-bounded regex: "did I see her in 2023"',
    isReferentYearBoundedVisitQuestion('Did I see her in 2023?'),
    v => v !== null && v.year === 2023, '{year: 2023}');
  assert('RANGE-P3 year-bounded regex rejects bare year with no subject shape',
    isReferentYearBoundedVisitQuestion('What happened in 2024?'),
    v => v === null, 'null');
  assert('RANGE-P4 year-bounded regex rejects named-doctor form (not a pronoun act)',
    isReferentYearBoundedVisitQuestion('Did I see Dr. Smith in 2024?'),
    v => v === null, 'null');

  // A — wider future lookup: 3-month-out event, beyond the 14-day cache,
  //     found via the direct wide-range query.
  {
    const { say, subject } = freshFlow();
    seedTwoDoctorOutcomes(); // no upcoming medical rows
    const threeMonthsMs = monthsFromNowMs(3, 14);
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Dr. Smith', startDate: new Date(threeMonthsMs).toISOString() }],
      async () => {
        await say('When did I see Dr. Smith?');
        const t2 = await say('When am I seeing him again?');
        assert('RANGE-A1 wide-range future match found beyond the 14-day cache', t2,
          v => v.handled === true && v.source === 'referent_resume'
            && v.responseText.startsWith('Your calendar shows Dr. Smith on ')
            && /\d{4}/.test(v.responseText), // date-mode phrasing includes a year
          'Your calendar shows Dr. Smith on [Month Day, Year] …');
        assert('RANGE-A2 subject remains Dr. Smith', subject.peek()?.entityId, v => v === 'Dr. Smith', 'Dr. Smith');
      },
    );
  }

  // B — medical authority still wins over a wide-range calendar match
  {
    const { say } = freshFlow();
    const smithId = writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-05-01' });
    attachVisitOutcome(smithId, SMITH_OUTCOME);
    seedUpcomingAppointment('Dr. Smith', '2026-12-01'); // confirmed MEDICAL upcoming
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Dr. Smith', startDate: new Date(monthsFromNowMs(3, 9)).toISOString() }],
      async () => {
        await say('When did I see Dr. Smith?');
        const t2 = await say('When am I seeing him again?');
        assert('RANGE-B1 medical authority wins over wide-range calendar match', t2,
          v => v.handled === true && /^You see Dr\. Smith on /.test(v.responseText),
          'You see Dr. Smith … (medical voice)');
      },
    );
  }

  // C — historical lookup via the referent path with an established subject
  {
    freshFlow(); // empty DB so getLastVisit misses and calendar fallback runs
    const pastMs = monthsFromNowMs(-8, 10);
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Appointment with Dr. Smith', startDate: new Date(pastMs).toISOString() }],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        const result = await answerReferentVisitDate(subj);
        assert('RANGE-C1 historical calendar fallback returns date-mode calendar answer', result,
          (v: string | null) => v !== null && v.startsWith('Your calendar shows Dr. Smith on ') && /\d{4}/.test(v),
          'Your calendar shows Dr. Smith on [Month Day, Year]');
      },
    );
  }

  // C3 — pronoun historical path reuses the upcoming doctor-title matcher
  {
    freshFlow();
    const pastMs = monthsFromNowMs(-4, 10);
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Dr. Estil Vance - on follow-up', startDate: new Date(pastMs).toISOString() }],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr Vance', displayName: 'Dr Vance', establishedAtTurn: 1 };
        const result = await answerReferentVisitDate(subj);
        assert('RANGE-C3 Flow C historical surname matches Dr. Estil Vance', result,
          (v: string | null) => v !== null && v.startsWith('Your calendar shows Dr Vance on ') && /\d{4}/.test(v) && !/which one did you mean/i.test(v),
          'Your calendar shows Dr Vance on [Month Day, Year]');
      },
    );
  }

  // C2 — historical: a SUCCESSFUL 12-month search with zero matches must
  //      speak a BOUNDED no-result (CTO trust correction), never the old
  //      unbounded "yet" claim, which read as a lifetime/complete-history
  //      search Herald never actually performed. withFakeCalendarEvents([])
  //      forces a genuine {status:'ok', events:[]} -- proving this is the
  //      real bounded-miss path, not an accidental unavailable.
  {
    freshFlow();
    await withFakeCalendarEvents([], async () => {
      const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
      const result = await answerReferentVisitDate(subj);
      assert('RANGE-C2 successful 12-month historical search, zero matches -> bounded no-result', result,
        (v: string | null) => v === "I don't see anything with Dr. Smith on your calendar in the past 12 months.",
        "I don't see anything with Dr. Smith on your calendar in the past 12 months.");
    });
  }

  // D — year-bounded: single match, only events IN the requested year used.
  {
    freshFlow();
    const inYearMs = new Date(2024, 5, 15, 10, 0, 0, 0).getTime();  // June 2024
    const outOfYearMs = new Date(2025, 5, 15, 10, 0, 0, 0).getTime(); // June 2025 -- must NOT be returned
    await withFakeCalendarEvents(
      [
        { id: 'e1', title: 'Dr. Smith', startDate: new Date(inYearMs).toISOString() },
        { id: 'e2', title: 'Dr. Smith', startDate: new Date(outOfYearMs).toISOString() },
      ],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        const result = await answerReferentYearBoundedVisit(subj, 2024);
        assert('RANGE-D1 year-bounded query returns only the 2024 match', result,
          (v: string | null) => v !== null && v.includes('June 15, 2024') && !v.includes('2025'),
          'June 15, 2024, not 2025');
      },
    );
  }

  // D2 — half-open year boundary proof: the exact edge instants. Dec 31
  //      23:59 of `year` must be INCLUDED; Jan 1 00:00:00.000 of `year + 1`
  //      must be EXCLUDED (queryCalendarEvidence's [start, end) contract,
  //      end = local Jan 1 of year+1). If the boundary were wrongly
  //      inclusive of the next year's first instant, both events would
  //      match and the multi-match clarification ("which one") would fire
  //      instead of a single calendar-voiced answer.
  {
    freshFlow();
    const lastInstantOfYear = new Date(2024, 11, 31, 23, 59, 0, 0).getTime();
    const firstInstantOfNextYear = new Date(2025, 0, 1, 0, 0, 0, 0).getTime();
    await withFakeCalendarEvents(
      [
        { id: 'e1', title: 'Dr. Smith', startDate: new Date(lastInstantOfYear).toISOString() },
        { id: 'e2', title: 'Dr. Smith', startDate: new Date(firstInstantOfNextYear).toISOString() },
      ],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        const result = await answerReferentYearBoundedVisit(subj, 2024);
        assert('RANGE-D2 half-open boundary: Dec 31 23:59 in, Jan 1 00:00:00.000 next year excluded', result,
          (v: string | null) => v !== null && v.startsWith('Your calendar shows Dr. Smith on ') && !/which one/i.test(v),
          'single match only (Dec 31 event) -- boundary correctly excludes Jan 1 next year');
      },
    );
  }

  // E — year-bounded: multiple matches never auto-selected, bounded clarification
  {
    freshFlow();
    const m1 = new Date(2024, 2, 3, 9, 0, 0, 0).getTime();  // March 3, 2024
    const m2 = new Date(2024, 8, 10, 11, 0, 0, 0).getTime(); // September 10, 2024
    await withFakeCalendarEvents(
      [
        { id: 'e1', title: 'Dr. Smith', startDate: new Date(m1).toISOString() },
        { id: 'e2', title: 'Dr. Smith', startDate: new Date(m2).toISOString() },
      ],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        const result = await answerReferentYearBoundedVisit(subj, 2024);
        assert('RANGE-E1 multiple matches never auto-selected; both dates named', result,
          (v: string | null) => v !== null
            && v.includes('March 3') && v.includes('September 10')
            && /which one/i.test(v),
          'clarification naming both dates, no auto-select');
        assert('RANGE-E2 multi-match clarification still carries calendar provenance', result,
          (v: string | null) => v !== null && v.startsWith('Your calendar shows '),
          'starts with "Your calendar shows " even on the clarification path');
      },
    );
  }

  // F — namesake fence still applies to wide-range/year queries
  {
    freshFlow();
    const decoyMs = new Date(2024, 2, 3, 9, 0, 0, 0).getTime();
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Dr. Smithson', startDate: new Date(decoyMs).toISOString() }],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        const result = await answerReferentYearBoundedVisit(subj, 2024);
        assert('RANGE-F1 namesake fence applies on the year-bounded path (Smithson excluded)', result,
          (v: string | null) => v === "I don't have anything with Dr. Smith on your calendar in 2024.",
          "honest no-result, no Smithson leak");
      },
    );
  }

  // G — Unicode still intact on the wide-range path
  {
    freshFlow();
    const munozMs = monthsFromNowMs(3, 14);
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Appointment with Dr. Muñoz', startDate: new Date(munozMs).toISOString() }],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Muñoz', displayName: 'Dr. Muñoz', establishedAtTurn: 1 };
        const result = await answerReferentUpcomingVisit(subj);
        assert('RANGE-G1 accented name intact on wide-range path', result,
          (v: string | null) => v !== null && v.includes('Dr. Muñoz'),
          'Dr. Muñoz, not shredded');
      },
    );
  }

  // ── Trust boundary: unavailable is NOT a no-result (CTO correction) ──
  console.log(`\n${BOLD}  Calendar unavailable ≠ calendar evidence absent${RESET}\n`);

  // U0 — direct unit proof: queryCalendarEvidence itself surfaces
  //      'unavailable', never collapses it into a bare empty-match result.
  {
    freshFlow();
    await withUnavailableCalendar('error', async () => {
      const now = new Date();
      const later = new Date(now);
      later.setMonth(later.getMonth() + 6);
      const result = await queryCalendarEvidence('Dr. Smith', normalizeDoctorNameForMatch, now, later);
      assert('RANGE-U0 queryCalendarEvidence itself reports unavailable, not {status:ok, events:[]}', result,
        (v: { status: string }) => v.status === 'unavailable',
        "{status: 'unavailable'}");
    });
  }

  // U1 — upcoming-visit consumer: unavailable speaks the honest
  //      "couldn't check" voice, never the confident absence claim.
  {
    freshFlow();
    await withUnavailableCalendar('permission-denied', async () => {
      const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
      const result = await answerReferentUpcomingVisit(subj);
      assert('RANGE-U1 upcoming-visit: unavailable never becomes any false absence claim (bounded or unbounded)', result,
        (v: string | null) => v === "I couldn't check your calendar right now."
          && v !== `I don't have another visit with Dr. Smith coming up.`
          && v !== `I don't see anything with Dr. Smith on your calendar in the next 6 months.`,
        "I couldn't check your calendar right now.");
    });
  }

  // U2 — historical (visit-date) consumer: same honest voice, same fence.
  {
    freshFlow();
    await withUnavailableCalendar('error', async () => {
      const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
      const result = await answerReferentVisitDate(subj);
      assert('RANGE-U2 historical: unavailable never becomes any false absence claim (bounded or unbounded)', result,
        (v: string | null) => v === "I couldn't check your calendar right now."
          && v !== `I don't have a visit with Dr. Smith yet — tell me and I'll remember.`
          && v !== `I don't see anything with Dr. Smith on your calendar in the past 12 months.`,
        "I couldn't check your calendar right now.");
    });
  }

  // U3 — year-bounded consumer: same honest voice, same fence.
  {
    freshFlow();
    await withUnavailableCalendar('permission-denied', async () => {
      const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
      const result = await answerReferentYearBoundedVisit(subj, 2024);
      assert('RANGE-U3 year-bounded: unavailable never becomes a false "I don\'t have anything" claim', result,
        (v: string | null) => v === "I couldn't check your calendar right now."
          && !/on your calendar in 2024/i.test(v ?? ''),
        "I couldn't check your calendar right now.");
    });
  }

  // H — no persistence: wide-range/year queries write nothing to medical_records
  {
    freshFlow();
    const before = getMedicalRecords().length;
    await withFakeCalendarEvents(
      [{ id: 'e1', title: 'Dr. Smith', startDate: new Date(monthsFromNowMs(3, 11)).toISOString() }],
      async () => {
        const subj = { domain: 'medical_doctor' as const, entityId: 'Dr. Smith', displayName: 'Dr. Smith', establishedAtTurn: 1 };
        await answerReferentUpcomingVisit(subj);
        await answerReferentYearBoundedVisit(subj, new Date().getFullYear());
      },
    );
    assert('RANGE-H1 no medical_records row created by wide-range/year reads', getMedicalRecords().length,
      v => v === before, String(before));
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('conversationalSubject.test')) {
  runConversationalSubjectTests().catch(console.error);
}
