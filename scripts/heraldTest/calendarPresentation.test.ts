// Calendar Presentation Holder V1 — ordinal time follow-up after authoritative calendar read.
//
// Runner: npx tsx scripts/heraldTest/calendarPresentation.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import {
  CalendarPresentationHolder,
  parseCalendarTimeInquiry,
  CALENDAR_PRESENTATION_CONFUSION,
} from '../../src/routing/calendarPresentation.ts';
import { writeMedication } from '../../src/db/medicalDB.ts';
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

function msForDayOffset(offset: number, hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function insertCalendarEvent(
  db: Database.Database,
  id: string,
  title: string,
  startMs: number,
  allDay = 0,
) {
  const endMs = startMs + 3_600_000;
  db.prepare(
    `INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, cached_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, startMs, endMs, allDay, new Date().toISOString());
}

function freshHarness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run(
    'list_grocery', 'grocery', '2026-01-01T00:00:00.000Z',
  );
  insertCalendarEvent(db, 'ev_first', 'DENTIST_APPT', msForDayOffset(1, 9, 0));
  insertCalendarEvent(db, 'ev_second', 'LUNCH_MEETING', msForDayOffset(1, 12, 30));

  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendarPresentation = new CalendarPresentationHolder();
  const calendarContinuation = new CalendarContinuationHolder();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(
      text,
      session,
      deps,
      subject,
      medication,
      ordered,
      calendarPresentation,
      calendarContinuation,
    );
  return { db, session, calendarPresentation, calendarContinuation, say };
}

function formatExpectedTime(startMs: number): string {
  const timeStr = new Date(startMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `It's at ${timeStr}.`;
}

export async function runCalendarPresentationTests() {
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

  console.log(`\n${BOLD}-- Calendar Presentation Holder V1 ------------------------${RESET}\n`);

  assert(
    'CPH0 parse first thing',
    parseCalendarTimeInquiry('What time was the first thing?'),
    (v) => v === 1,
    '1',
  );
  assert(
    'CPH0 parse first one (is)',
    parseCalendarTimeInquiry('What time is the first one?'),
    (v) => v === 1,
    '1',
  );
  assert(
    'CPH0 parse second one (was)',
    parseCalendarTimeInquiry('What time was the second one?'),
    (v) => v === 2,
    '2',
  );
  assert(
    'CPH0 non-positional appointment → null',
    parseCalendarTimeInquiry('What time was the appointment?'),
    (v) => v === null,
    'null',
  );
  assert(
    'CPH0 unrelated ordinal sentence → null',
    parseCalendarTimeInquiry('The first thing I need to do is call Paul.'),
    (v) => v === null,
    'null',
  );

  {
    const { say, calendarPresentation } = freshHarness();
    const t1 = await say("What's on my calendar tomorrow?");
    assert(
      'CPH-A1 calendar read → device_read tomorrow',
      t1,
      (o) =>
        !o.handled &&
        o.routeDecision.kind === 'device_read' &&
        o.routeDecision.reason === 'calendar:tomorrow',
      'calendar:tomorrow',
    );
    assert(
      'CPH-A2 holder established with ordered IDs',
      calendarPresentation.peek()?.eventIds,
      (v) => Array.isArray(v) && v.length === 2 && v[0] === 'ev_first',
      "['ev_first', 'ev_second']",
    );
    const t2 = await say('What time was the first thing?');
    assert(
      'CPH-A3 first thing → authoritative time',
      t2,
      (o) =>
        o.handled &&
        o.source === 'referent_resume' &&
        o.responseText === formatExpectedTime(msForDayOffset(1, 9, 0)),
      'first event time',
    );
    assert(
      'CPH-A4 holder consumed after follow-up',
      calendarPresentation.hasLive(),
      (v) => v === false,
      'false',
    );
  }

  {
    const { say } = freshHarness();
    await say("What's on my calendar tomorrow?");
    const t2 = await say('What time is the second thing?');
    assert(
      'CPH-B second thing → second event time',
      t2,
      (o) =>
        o.handled &&
        o.responseText === formatExpectedTime(msForDayOffset(1, 12, 30)),
      'second event time',
    );
  }

  {
    const { say } = freshHarness();
    const t1 = await say('What time was the first thing?');
    assert(
      'CPH-C no prior presentation → not referent_resume',
      t1,
      (o) => !(o.handled && o.source === 'referent_resume'),
      'falls through without calendar ordinal authority',
    );
  }

  {
    const { db, say } = freshHarness();
    await say("What's on my calendar tomorrow?");
    const t2 = await say('What time was the third thing?');
    assert(
      'CPH-D out of range → confusion',
      t2,
      (o) => o.handled && o.responseText === CALENDAR_PRESENTATION_CONFUSION,
      CALENDAR_PRESENTATION_CONFUSION,
    );
    db.prepare(`DELETE FROM calendar_cache WHERE id = 'ev_first'`).run();
    await say("What's on my calendar tomorrow?");
    const t4 = await say('What time was the first thing?');
    assert(
      'CPH-E freshness — updated first event time after DB change',
      t4,
      (o) => {
        if (!o.handled || o.source !== 'referent_resume') return false;
        return o.responseText === formatExpectedTime(msForDayOffset(1, 12, 30));
      },
      'reread reflects ev_second time as new first',
    );
  }

  {
    const { db, say, calendarPresentation } = freshHarness();
    db.prepare(
      `INSERT INTO list_items (id, list_id, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run('li_a', 'list_grocery', 'apples', '2026-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO list_items (id, list_id, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run('li_b', 'list_grocery', 'bananas', '2026-01-02T00:00:00.000Z');
    await say("What's on my grocery list?");
    assert(
      'CPH-F grocery presentation does not block calendar time parse',
      calendarPresentation.hasLive(),
      (v) => v === false,
      'no calendar holder after grocery',
    );
    const t2 = await say('What time was the first thing?');
    assert(
      'CPH-F2 after grocery → no calendar ordinal authority',
      t2,
      (o) => !(o.handled && o.source === 'referent_resume' && o.responseText.includes("It's at")),
      'not calendar time answer',
    );
  }

  {
    const { db, say } = freshHarness();
    writeMedication({ name: 'Lisinopril', dosage: '10mg', frequency: 'daily', is_active: 1 });
    writeMedication({ name: 'Metformin', dosage: '500mg', frequency: 'daily', is_active: 1 });
    await say('What medications am I taking?');
    const t2 = await say('What time was the first thing?');
    assert(
      'CPH-G after medication presentation → no calendar hijack',
      t2,
      (o) => !(o.handled && o.source === 'referent_resume' && o.responseText.includes("It's at")),
      'not calendar time answer',
    );
  }

  {
    const { say, calendarContinuation } = freshHarness();
    await say("What's on my calendar tomorrow?");
    const t2 = await say('What about tomorrow?');
    assert(
      'CPH-H continuation regression — still fresh calendar read',
      t2,
      (o) =>
        o.handled &&
        o.source === 'referent_resume' &&
        typeof o.responseText === 'string' &&
        o.responseText.includes('DENTIST_APPT') &&
        !o.responseText.includes(CLARIFY),
      'temporal continuation unchanged',
    );
    assert(
      'CPH-H2 continuation consumes continuation holder',
      calendarContinuation.hasLive(),
      (v) => v === false,
      'false',
    );
  }

  {
    const { say } = freshHarness();
    const t1 = await say('What do I have going on tomorrow?');
    assert(
      'CPH-I entrance V1 regression',
      t1,
      (o) =>
        !o.handled &&
        o.routeDecision.kind === 'device_read' &&
        o.routeDecision.reason === 'calendar:tomorrow',
      'calendar entrance still routes',
    );
  }

  const total = passed + failures.length;
  return { passed, failed: failures.length, total, failures };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const r = await runCalendarPresentationTests();
  process.exit(r.failed > 0 ? 1 : 0);
}
