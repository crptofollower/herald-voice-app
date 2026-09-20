// Conversational Continuation V1 — grounded clarify:<objective> resume.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import {
  CLARIFY_OPERATIONAL_LIST_KEY,
  isAmbiguousOperationalListAcquisition,
} from '../../src/routing/operationalListContinuity.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT, is_active INTEGER DEFAULT 1,
    notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS calendar_cache (
    id TEXT PRIMARY KEY, title TEXT, start_ms INTEGER, end_ms INTEGER,
    all_day INTEGER DEFAULT 0, notes TEXT, cached_at TEXT
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

function groceryBodies(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0 AND li.removed_at IS NULL`,
  ).all() as { body: string }[]).map((r) => r.body).sort();
}

function todoBodies(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT lower(li.body) as body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'todos' AND li.checked = 0 AND li.removed_at IS NULL`,
  ).all() as { body: string }[]).map((r) => r.body).sort();
}

function itemCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as n FROM list_items').get() as { n: number }).n;
}

function fresh(opts?: {
  classifyLLM?: (t: string) => Promise<{ status: 'ok' | 'not_ready' | 'failed'; intents?: IntentRecord[]; reason?: string }>;
}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const calendarPresentation = new CalendarPresentationHolder();
  const calendar = new CalendarContinuationHolder();
  const discourse = new DiscourseContinuityHolder();
  const innerLlm = opts?.classifyLLM ?? (async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }));
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: innerLlm,
    llmReady: true,
    captureContext: { contacts: [] as string[], lists: ['grocery'] as string[] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered, calendarPresentation, calendar, discourse);
  return { db, session, discourse, say };
}

export async function runConversationalContinuationV1Tests() {
  let passed = 0;
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  function assert(label: string, cond: boolean, expected = 'true') {
    if (cond) {
      console.log(`${GREEN}PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${RESET}  ${label}`);
      failures.push({ label, got: false, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversational Continuation V1 ---------------------------${RESET}\n`);

  assert(
    'grab milk and eggs is unmarked operational-list acquisition',
    isAmbiguousOperationalListAcquisition('grab milk and eggs'),
  );

  {
    const { db, session, say } = fresh();
    const out = await say('grab milk and eggs');
    assert('grab milk and eggs arms clarify:operational_list', (
      out.handled === true
      && out.source === 'capture'
      && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY
      && /grocery list, or as a to-do/i.test(out.responseText)
      && itemCount(db) === 0
    ));
  }

  const GROCERY_ANSWERS = [
    'for groceries',
    'grocery',
    'on my grocery list',
    'the grocery list',
  ];
  for (const answer of GROCERY_ANSWERS) {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const out = await say(answer);
    const bodies = groceryBodies(db);
    assert(`"${answer}" resumes grocery write of milk and eggs`, (
      out.handled === true
      && out.source === 'pending_resume'
      && !session.hasPending()
      && bodies.includes('milk')
      && bodies.includes('eggs')
      && todoBodies(db).length === 0
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const out = await say('as a to-do');
    assert('as a to-do attaches items to todo, not grocery', (
      out.handled === true
      && out.source === 'pending_resume'
      && !session.hasPending()
      && groceryBodies(db).length === 0
      && todoBodies(db).some((b) => /milk/.test(b) && /eggs/.test(b))
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const yes = await say('yes');
    assert('bare yes does not fill which-list clarification or write', (
      yes.handled === true
      && yes.source === 'pending_resume'
      && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY
      && itemCount(db) === 0
    ));
  }
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const no = await say('no');
    assert('bare no does not fill which-list clarification or write', (
      no.handled === true
      && no.source === 'pending_resume'
      && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY
      && itemCount(db) === 0
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const weather = await say('the weather is nice');
    assert('unrelated answer does not write and keeps clarification', (
      weather.handled === true
      && weather.source === 'pending_resume'
      && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY
      && itemCount(db) === 0
    ));
  }
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const q = await say('what color is that');
    assert('another question does not authorize the list write', (
      q.source === 'pending_resume'
      && session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY
      && itemCount(db) === 0
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const out = await say('I need to call the dentist.');
    assert('independent todo objective supersedes clarification without grocery write', (
      out.handled === true
      && out.source === 'capture'
      && session.peekPendingKey() !== CLARIFY_OPERATIONAL_LIST_KEY
      && groceryBodies(db).length === 0
      && todoBodies(db).some((b) => /dentist/.test(b))
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    await say('maybe both');
    const released = await say('huh');
    assert('budget exhaustion releases clarification without a write', (
      released.handled === true
      && released.source === 'pending_resume'
      && !session.hasPending()
      && itemCount(db) === 0
    ));
  }

  {
    const { db, session, say } = fresh({
      classifyLLM: async () => ({
        status: 'ok',
        intents: [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
      }),
    });
    const ask = await say('I need to go pick up milk and eggs later.');
    assert('LLM grocery proposal still requires confirmation, not clarify-write', (
      ask.handled === true
      && session.peekPendingKey() === 'llm_confirm:list_add'
      && itemCount(db) === 0
    ));
    const answer = await say('for groceries');
    assert('clarification-shaped reply cannot confirm an llm_confirm write', (
      answer.source === 'pending_resume'
      && session.peekPendingKey() === 'llm_confirm:list_add'
      && itemCount(db) === 0
    ));
    const yes = await say('yes');
    assert('separate yes confirms the ordinary list_add pending', (
      yes.source === 'pending_resume'
      && !session.hasPending()
      && groceryBodies(db).includes('milk')
      && groceryBodies(db).includes('eggs')
    ));
  }

  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    await say('for groceries');
    const again = await say('for groceries');
    assert('no duplicate grocery write after clarification is consumed', (
      !session.hasPending()
      && groceryBodies(db).filter((b) => b === 'milk' || b === 'eggs').length === 2
      && again.source !== 'pending_resume'
    ));
  }

  console.log(`\n${BOLD}Conversational Continuation V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('conversationalContinuation');
if (isDirect) {
  runConversationalContinuationV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
