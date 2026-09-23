// Obligation Survival Under Interruption V1.
// Unfinished clarify:* survives completed read_only interruptions.
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
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  CLARIFY_LIST_ADD_ITEM_KEY,
  CLARIFY_OPERATIONAL_LIST_KEY,
} from '../../src/routing/operationalListContinuity.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

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

function fresh() {
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
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }),
    llmReady: true,
    captureContext: { contacts: [] as string[], lists: ['grocery'] as string[] },
  };
  const say = (text: string) =>
    processUtterance(normalizeInput(text), session, deps, subject, medication, ordered, calendarPresentation, calendar, discourse);
  return { db, session, say };
}

function clockKind(outcome: Awaited<ReturnType<typeof processUtterance>>) {
  if (outcome.handled) return null;
  if (outcome.routeDecision.kind !== 'device_action') return outcome.routeDecision.kind;
  return outcome.routeDecision.actionIntent.type;
}

export async function runObligationSurvivalV1Tests() {
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

  console.log(`\n${BOLD}-- Obligation Survival Under Interruption V1 ----------------${RESET}\n`);

  // 1 — operational-list + time + Grocery list.
  {
    const { db, session, say } = fresh();
    const arm = await say('grab milk and eggs');
    const key0 = session.peekPendingKey();
    const budget0 = session.peekPendingBudget();
    const time = await say('What time is it?');
    assert('1 arm clarify:operational_list', arm.handled === true && key0 === CLARIFY_OPERATIONAL_LIST_KEY);
    assert('1 time is unhandled device_action time', clockKind(time) === 'time');
    assert('1 pending key unchanged after time', session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY);
    assert('1 retry budget unchanged after time', session.peekPendingBudget() === budget0);
    assert('1 zero grocery rows after time', groceryBodies(db).length === 0);
    const resume = await say('Grocery list.');
    assert('1 resume commits grocery', resume.handled === true && resume.source === 'pending_resume');
    assert('1 milk and eggs write once', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('1 pending consumed', session.peekPendingKey() === null);
  }

  // 2 — item clarification + grocery read + The roses.
  {
    const { db, session, say } = fresh();
    const arm = await say('add those to my grocery list');
    const key0 = session.peekPendingKey();
    const budget0 = session.peekPendingBudget();
    assert('2 arms clarify:list_add_item', !arm.handled && key0 === CLARIFY_LIST_ADD_ITEM_KEY);
    assert('2 zero write on arm', groceryBodies(db).length === 0);
    const read = await say("What's on my grocery list?");
    assert(
      '2 grocery read answers normally',
      !read.handled && read.routeDecision.kind === 'device_read' && typeof read.routeDecision.response === 'string' && read.routeDecision.response.length > 0,
    );
    assert('2 item clarification remains', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY);
    assert('2 retry unchanged after read', session.peekPendingBudget() === budget0);
    assert('2 still zero grocery rows', groceryBodies(db).length === 0);
    const resume = await say('The roses.');
    assert('2 resume handled', resume.handled === true && resume.source === 'pending_resume');
    assert('2 exactly one roses row', JSON.stringify(groceryBodies(db)) === JSON.stringify(['roses']));
    assert('2 pending consumed', session.peekPendingKey() === null);
  }

  // 3 — two consecutive reads
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const budget0 = session.peekPendingBudget();
    const t = await say('What time is it?');
    const d = await say("What's the date?");
    assert('3 time answered', clockKind(t) === 'time');
    assert('3 date answered', clockKind(d) === 'date');
    assert('3 one pending survives', session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY);
    assert('3 neither read spent retry', session.peekPendingBudget() === budget0);
    const resume = await say('Grocery list.');
    assert('3 resume writes milk and eggs once', resume.handled && JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('3 pending consumed after answer', session.peekPendingKey() === null);
  }

  // 4 — invalid answer consumes retry; read does not
  {
    const { session, say } = fresh();
    await say('grab milk and eggs');
    const budget0 = session.peekPendingBudget();
    const invalid = await say('purple elephants');
    assert('4 invalid is pending re-ask', invalid.handled === true && invalid.source === 'pending_resume');
    assert('4 invalid consumed one retry', session.peekPendingBudget() === (budget0 ?? 2) - 1);
    const afterInvalid = session.peekPendingBudget();
    await say('What time is it?');
    assert('4 read consumed no retry', session.peekPendingBudget() === afterInvalid);
    const resume = await say('Grocery list.');
    assert('4 valid answer still resumes', resume.handled === true && session.peekPendingKey() === null);
  }

  // 5 — cancel after read
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    await say('What time is it?');
    const cancel = await say('Never mind.');
    assert('5 cancel handled', cancel.handled === true && cancel.source === 'pending_resume');
    assert('5 pending cleared', session.peekPendingKey() === null);
    assert('5 original objective never writes', groceryBodies(db).length === 0);
  }

  // 6 — competing / established lifecycle (do not redesign via effect enum)
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const compete = await say('Add bread to my grocery list.');
    assert(
      '6 grocery-marked add owns operational answer (established, not effect-redesign)',
      compete.handled === true && compete.source === 'pending_resume',
    );
    assert('6 original milk/eggs write; bread is not a second objective', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('6 pending consumed by established resume', session.peekPendingKey() === null);
  }
  {
    const { db, session, say } = fresh();
    await say('grab milk and eggs');
    const timer = await say('set a timer for 5 minutes');
    assert('6b timer still yields via actionIntent', clockKind(timer) === 'timer' || (!timer.handled && timer.routeDecision.kind === 'device_action'));
    assert('6b clarification released on competing device action', session.peekPendingKey() === null);
    assert('6b original items did not write', groceryBodies(db).length === 0);
  }

  // 7 — llm_confirm:* does not survive
  {
    const { session, say } = fresh();
    session.setPending({
      pendingKey: 'llm_confirm:list_add',
      resume: async (): Promise<CommitResult> => ({ status: 'noop', ack: '' }),
      budget: 2,
    });
    const budget0 = session.peekPendingBudget();
    const time = await say('What time is it?');
    assert('7 confirm list_add yields read_only clock (Carry Slice 1 representative)', clockKind(time) === 'time');
    assert('7 confirm still pending after clock', session.peekPendingKey() === 'llm_confirm:list_add');
    assert('7 confirm retry not consumed by read', session.peekPendingBudget() === budget0);
  }

  // 8 — non-actionIntent completed read (family)
  {
    const { session, say } = fresh();
    await say('grab milk and eggs');
    const budget0 = session.peekPendingBudget();
    const family = await say("what's my wife's name");
    assert(
      '8 family read routes as device_read',
      !family.handled && family.routeDecision.kind === 'device_read',
    );
    assert('8 family read preserves clarification', session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY);
    assert('8 family read consumes no retry', session.peekPendingBudget() === budget0);
  }

  // 9 — pending_arming does not preserve or stack
  {
    const { session, say } = fresh();
    await say('add those to my grocery list');
    const budget0 = session.peekPendingBudget();
    const those = await say('add those to my grocery list');
    assert('9 still one list_add_item pending', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY);
    assert('9 pending_arming swallowed as retry', those.handled === true && those.source === 'pending_resume');
    assert('9 retry consumed (not preserved)', session.peekPendingBudget() === (budget0 ?? 2) - 1);
  }

  // 10 — product composition
  {
    const { db, session, say } = fresh();
    const arm = await say('grab milk and eggs');
    assert('10 Kit asks which list', arm.handled && /grocery list, or as a to-do/i.test(arm.responseText));
    const time = await say('What time is it?');
    assert('10 time routes as clock action', clockKind(time) === 'time');
    const add = await say('Grocery list.');
    assert('10 adds original items', add.handled && JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('10 pending gone before list read', session.peekPendingKey() === null);
    const listed = await say("What's on my grocery list?");
    const speech = !listed.handled && listed.routeDecision.kind === 'device_read' ? listed.routeDecision.response : '';
    assert('10 names milk from SQLite', /milk/i.test(speech));
    assert('10 names eggs from SQLite', /eggs/i.test(speech));
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('obligationSurvival.test.ts')) {
  runObligationSurvivalV1Tests().then((r) => {
    console.log(`\n${BOLD}Obligation Survival V1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
