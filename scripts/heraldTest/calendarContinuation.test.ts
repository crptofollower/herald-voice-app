// Calendar Continuation V1 — bounded temporal follow-up after authoritative calendar read.
//
// Runner: npx tsx scripts/heraldTest/calendarContinuation.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import {
  CalendarContinuationHolder,
  parseCalendarTemporalFollowUp,
} from '../../src/routing/calendarContinuation.ts';
import { EPHEMERAL_CLARIFY_REPLY } from '../../src/utils/ephemeralSeam.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const CLARIFY = EPHEMERAL_CLARIFY_REPLY;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    start_ms  INTEGER NOT NULL,
    end_ms    INTEGER NOT NULL,
    all_day   INTEGER DEFAULT 0,
    notes     TEXT,
    cached_at TEXT NOT NULL
  );
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
    visit_date TEXT, doctor_name TEXT, facility TEXT, reason TEXT, diagnosis TEXT,
    follow_up TEXT, notes TEXT, status TEXT DEFAULT 'noted', surfaced_at TEXT,
    visit_outcome TEXT, outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY, name TEXT, specialty TEXT, phone TEXT, address TEXT,
    is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT, is_active INTEGER DEFAULT 1,
    notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS service_providers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS insurance_policies (
    id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT,
    is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL
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

function msForDayOffset(offset: number, hour = 10): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function insertCalendarEvent(
  db: Database.Database,
  id: string,
  title: string,
  startMs: number,
) {
  const endMs = startMs + 3_600_000;
  db.prepare(
    `INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, cached_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(id, title, startMs, endMs, new Date().toISOString());
}

function freshHarness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run(
    'list_grocery', 'grocery', '2026-01-01T00:00:00.000Z',
  );
  insertCalendarEvent(db, 'ev_week', 'WEEK_ONLY_MEETING', msForDayOffset(0));
  insertCalendarEvent(db, 'ev_tomorrow', 'TOMORROW_ONLY_MEETING', msForDayOffset(1));
  insertCalendarEvent(db, 'ev_today', 'TODAY_ONLY_MEETING', msForDayOffset(0, 14));

  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendar = new CalendarContinuationHolder();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered, calendar);
  return { db, session, calendar, say };
}

function isListAddOutcome(o: Awaited<ReturnType<typeof processUtterance>>): boolean {
  if (o.handled && o.source === 'capture') {
    return o.commits.some((c) => c.status === 'committed' || c.status === 'pending');
  }
  if (!o.handled && o.routeDecision.kind === 'capture') {
    return o.routeDecision.intents.some((i: { type: string }) => i.type === 'list_add');
  }
  return false;
}

export async function runCalendarContinuationTests() {
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

  console.log(`\n${BOLD}-- calendarContinuation V1 Tests --------------------------------${RESET}\n`);

  assert(
    'CCV0 parse tomorrow follow-up',
    parseCalendarTemporalFollowUp('What about tomorrow?'),
    (v) => v === 'tomorrow',
    'tomorrow',
  );
  assert(
    'CCV0 parse today follow-up',
    parseCalendarTemporalFollowUp('How about today'),
    (v) => v === 'today',
    'today',
  );
  assert(
    'CCV0 explicit calendar phrase is not a narrow follow-up',
    parseCalendarTemporalFollowUp("What's on my calendar tomorrow?"),
    (v) => v === null,
    'null',
  );

  {
    const { say, calendar } = freshHarness();
    const t1 = await say("What's on my calendar this week?");
    assert(
      'CCV-A1 turn 1 → device_read calendar week',
      t1,
      (o) =>
        !o.handled &&
        o.routeDecision.kind === 'device_read' &&
        o.routeDecision.reason === 'calendar:week',
      'calendar:week device_read',
    );
    assert(
      'CCV-A2 holder established after calendar read',
      calendar.peek()?.authorizedReason,
      (v) => v === 'calendar:week',
      'calendar:week',
    );
    const t2 = await say('What about tomorrow?');
    assert(
      'CCV-A3 turn 2 → referent_resume calendar (not clarify)',
      t2,
      (o) =>
        o.handled === true &&
        o.source === 'referent_resume' &&
        typeof o.responseText === 'string' &&
        o.responseText.includes('TOMORROW_ONLY_MEETING') &&
        !o.responseText.includes(CLARIFY),
      'fresh tomorrow read via continuation',
    );
    assert(
      'CCV-A4 holder consumed after follow-up',
      calendar.hasLive(),
      (v) => v === false,
      'false',
    );
  }

  {
    const { say } = freshHarness();
    await say("What's on my calendar this week?");
    const t2 = await say('What about today?');
    assert(
      'CCV-B today follow-up → TODAY_ONLY_MEETING',
      t2,
      (o) => o.handled && o.responseText.includes('TODAY_ONLY_MEETING'),
      'today calendar read',
    );
  }

  {
    const { calendar } = freshHarness();
    const d = await classifyQuery("What's on my calendar tomorrow?");
    assert(
      'CCV-C explicit tomorrow → tier 1 calendar:tomorrow',
      d,
      (v) => v.tier === 1 && v.reason === 'calendar:tomorrow',
      'calendar:tomorrow',
    );
    assert(
      'CCV-C holder not required',
      calendar.hasLive(),
      (v) => v === false,
      'false without prior read',
    );
  }

  {
    const { say } = freshHarness();
    const t = await say('What about tomorrow?');
    assert(
      'CCV-D fresh session → needs_clarification (not calendar hijack)',
      t,
      (o) =>
        !o.handled &&
        o.routeDecision.kind === 'needs_clarification',
      'needs_clarification',
    );
  }

  {
    const { say } = freshHarness();
    await say("What's on my calendar this week?");
    const grocery = await say('Add milk to my grocery list.');
    assert(
      'CCV-E2 unrelated grocery wins',
      grocery,
      (o) => isListAddOutcome(o),
      'list_add capture/commit',
    );
    const t3 = await say('What about tomorrow?');
    assert(
      'CCV-E3 stale holder must not hijack',
      t3,
      (o) => !o.handled && o.routeDecision.kind === 'needs_clarification',
      'needs_clarification after expiry',
    );
  }

  {
    const { say } = freshHarness();
    await say("What's on my calendar this week?");
    const list = await say('Add eggs to my grocery list.');
    assert(
      'CCV-F explicit list_add beats calendar holder',
      list,
      (o) => isListAddOutcome(o),
      'list_add',
    );
  }

  {
    const { say } = freshHarness();
    const t1 = await say("What's on my calendar this week?");
    const weekText =
      t1.handled === false && t1.routeDecision.kind === 'device_read'
        ? t1.routeDecision.response
        : '';
    const t2 = await say('What about tomorrow?');
    assert(
      'CCV-G second turn uses tomorrow event (fresh read)',
      t2,
      (o) =>
        o.handled &&
        o.responseText.includes('TOMORROW_ONLY_MEETING') &&
        !o.responseText.includes('WEEK_ONLY_MEETING'),
      'tomorrow-only content',
    );
    assert(
      'CCV-G turn-1 week text is not replayed verbatim as turn-2 answer',
      t2,
      (o) => o.handled && o.responseText !== weekText,
      'distinct from week response',
    );
  }

  {
    const { calendar, say } = freshHarness();
    await say("What's on my calendar this week?");
    assert('CCV-H1 holder continues on next turn', calendar.peek()?.authorizedReason, (v) => v === 'calendar:week', 'calendar:week');
    await say('Hello there.');
    assert('CCV-H2 unrelated turn clears holder', calendar.hasLive(), (v) => v === false, 'false');
    const t3 = await say('What about tomorrow?');
    assert(
      'CCV-H3 third turn → no calendar hijack',
      t3,
      (o) => !o.handled && o.routeDecision.kind === 'needs_clarification',
      'needs_clarification',
    );
  }

  console.log(`\n${BOLD}calendarContinuation:${RESET} ${passed} passed, ${failures.length} failed\n`);
  const total = passed + failures.length;
  return { passed, failed: failures.length, total, failures };
}
