// F2 grocery named-collection re-entry — grocery-owned, not OPR intake.
//
// Runner: npx tsx scripts/heraldTest/groceryNamedCollectionReentry.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import {
  OrderedPresentationHolder,
  parseGroceryReadPosition,
  ORDERED_PRESENTATION_CONFUSION,
} from '../../src/routing/orderedPresentation.ts';
import { parseGroceryNamedCollectionRead } from '../../src/routing/groceryNamedCollectionReentry.ts';
import {
  composeOpenListSpeech,
  getPresentedOpenListItems,
  getOpenListItemById,
} from '../../src/db/listRead.ts';

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

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run(
    'list_grocery', 'grocery', '2026-01-01T00:00:00.000Z',
  );
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  let classifyCalls = 0;
  const deps = {
    classifyQuery: async (t: string) => {
      classifyCalls++;
      return classifyQuery(t);
    },
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered);
  return { db, session, subject, medication, ordered, say, getClassifyCalls: () => classifyCalls };
}

function insertItem(
  db: Database.Database,
  id: string,
  body: string,
  createdAt: string,
  checked = 0,
) {
  db.prepare(
    `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'list_grocery', body, checked, createdAt);
}

function presentGrocery(
  ordered: OrderedPresentationHolder,
  subject: ConversationalSubjectHolder,
  medication: MedicationPresentationHolder,
) {
  const items = getPresentedOpenListItems('grocery');
  const speech = composeOpenListSpeech('grocery', items);
  if (items.length === 0) {
    ordered.clear();
  } else {
    subject.clear();
    medication.clear();
    ordered.establish('grocery', items.map((i) => i.id));
  }
  return { items, speech };
}

function stockThree(db: Database.Database) {
  insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
  insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
  insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
}

export async function runGroceryNamedCollectionReentryTests() {
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

  console.log(`\n${BOLD}-- Grocery named-collection re-entry (F2) ---------------${RESET}\n`);

  assert('F2P1 second thing', parseGroceryNamedCollectionRead('What was the second thing on my grocery list?'),
    v => v.kind === 'position' && v.n === 2, 'position 2');
  assert('F2P2 second item', parseGroceryNamedCollectionRead('What is the second item on my grocery list?'),
    v => v.kind === 'position' && v.n === 2, 'position 2');
  assert('F2P3 number two', parseGroceryNamedCollectionRead('What was number two on my grocery list?'),
    v => v.kind === 'position' && v.n === 2, 'position 2');
  assert('F2P4 item three', parseGroceryNamedCollectionRead("What's item three on my grocery list?"),
    v => v.kind === 'position' && v.n === 3, 'position 3');
  assert('F2P5 third on the grocery list', parseGroceryNamedCollectionRead('What was the third thing on the grocery list?'),
    v => v.kind === 'position' && v.n === 3, 'position 3');
  assert('F2P6 list_read inventory not F2', parseGroceryNamedCollectionRead("What's on my grocery list?"),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P7 my list not grocery-named F2', parseGroceryNamedCollectionRead("What's on my list?"),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P8 thing without grocery cue', parseGroceryNamedCollectionRead('the second thing'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P9 F1 third one is not F2', parseGroceryNamedCollectionRead("What's the third one?"),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P10 remove mutation', parseGroceryNamedCollectionRead('Remove the second thing on my grocery list.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P11 delete mutation', parseGroceryNamedCollectionRead('Delete item three on my grocery list.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P12 got remove mutation', parseGroceryNamedCollectionRead('I got number two, remove it.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P13 on the third', parseGroceryNamedCollectionRead('I saw him on the third.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P14 23rd', parseGroceryNamedCollectionRead('My appointment is on the 23rd.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P15 dose', parseGroceryNamedCollectionRead('Take 25 mg.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P16 time', parseGroceryNamedCollectionRead('At 3:00.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P17 the red one', parseGroceryNamedCollectionRead('The red one.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P18 two positions ambiguous', parseGroceryNamedCollectionRead('the first thing and the third thing on my grocery list'),
    v => v.kind === 'ambiguous', 'ambiguous');
  assert('F2P19 todo list not grocery', parseGroceryNamedCollectionRead('the second thing on my todo list'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('F2P20 named utterance extracts position', parseGroceryReadPosition('What was the second thing on my grocery list?'),
    v => v === 2, '2');
  assert('F2P20b named grant still owns named cue', parseGroceryNamedCollectionRead('What was the second thing on my grocery list?'),
    v => v.kind === 'position' && v.n === 2, 'F2 position 2');
  assert('F2P21 OPR intake still binds third one', parseGroceryReadPosition("What's the third one?"),
    v => v === 3, '3');

  {
    const { db, say, ordered, getClassifyCalls } = fresh();
    stockThree(db);
    assert('F2E1 no live OPR before', ordered.hasLive(), v => v === false, 'empty holder');
    const t = await say('What was the second thing on my grocery list?');
    assert('F2E2 second thing → Eggs', t,
      v => v.handled === true && v.source === 'referent_resume' && v.responseText === "That's Eggs.",
      "That's Eggs.");
    assert('F2E3 no classifier', getClassifyCalls(), v => v === 0, '0');
    assert('F2E4 selected row by ID', getOpenListItemById('g2', 'grocery')?.body, v => v === 'Eggs', 'Eggs');
    assert('F2E5 holder from same reread', ordered.peek()?.presentedIds.join(','), v => v === 'g1,g2,g3', 'g1,g2,g3');
  }

  {
    const { db, say, getClassifyCalls } = fresh();
    stockThree(db);
    const t = await say('What is the second item on my grocery list?');
    assert('F2E6 second item → Eggs', t, v => v.responseText === "That's Eggs.", "That's Eggs.");
    assert('F2E7 item path no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say('What was number two on my grocery list?');
    assert('F2E8 number two → Eggs', t, v => v.responseText === "That's Eggs.", "That's Eggs.");
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say("What's item three on my grocery list?");
    assert('F2E9 item three → Apples', t, v => v.responseText === "That's Apples.", "That's Apples.");
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say('What was the third thing on the grocery list?');
    assert('F2E10 the grocery list → Apples', t, v => v.responseText === "That's Apples.", "That's Apples.");
  }

  {
    const { say, getClassifyCalls } = fresh();
    const t = await say('What was the second thing on my grocery list?');
    assert('F2E11 empty list copy', t, v => v.responseText === 'Your grocery list is empty.', 'empty');
    assert('F2E12 empty no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered } = fresh();
    stockThree(db);
    const t = await say('What was the fifth thing on my grocery list?');
    assert('F2E13 OOR confusion', t, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('F2E14 OOR retains fresh presentation', ordered.hasLive() && ordered.peek()?.presentedIds.join(',') === 'g1,g2,g3',
      v => v === true, 'live g1,g2,g3');
  }

  {
    const { db, say, getClassifyCalls } = fresh();
    stockThree(db);
    const t = await say('the second one');
    assert('F2E15 no grocery cue no live OPR', t, v => v.handled === false, 'not handled');
    assert('F2E16 no-cue reached routing', getClassifyCalls() > 0, v => v === true, 'classified');
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say('Remove the second thing on my grocery list.');
    assert('F2E17 mutation not F2 read', t,
      v => !(v.handled === true && v.source === 'referent_resume' && String(v.responseText).startsWith("That's ")),
      'not grocery readback');
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say("What's on my grocery list?");
    assert('F2E18 LIST_READ intact', t,
      v => v.handled === false && v.routeDecision?.kind === 'device_action'
        && v.routeDecision.actionIntent?.type === 'list_read'
        && v.routeDecision.actionIntent?.listName === 'grocery',
      'list_read grocery');
  }

  {
    const { db, say } = fresh();
    stockThree(db);
    const t = await say("What's on my list?");
    assert('F2E19 my list still list_read', t,
      v => v.handled === false && v.routeDecision?.kind === 'device_action'
        && v.routeDecision.actionIntent?.type === 'list_read',
      'list_read');
  }

  {
    const { db, say, ordered, subject, medication, getClassifyCalls } = fresh();
    stockThree(db);
    presentGrocery(ordered, subject, medication);
    const t = await say("What's the third one?");
    assert('F2E20 live OPR third one', t, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E21 live OPR no classify', getClassifyCalls(), v => v === 0, '0');
    const thing = await say("What's the third thing?");
    assert('F2E20b live continuation thing', thing, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E20c thing retains holder', ordered.hasLive(), v => v === true, 'live');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockThree(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('what time is it');
    assert('F2E22 unused clear still', ordered.hasLive(), v => v === false, 'cleared');
    assert('F2E23 unused reached routing', t.handled, v => v === false, 'not handled');
  }

  {
    const { db, say, ordered, subject, medication, getClassifyCalls } = fresh();
    stockThree(db);
    presentGrocery(ordered, subject, medication);
    db.prepare(`UPDATE list_items SET created_at = ? WHERE id = ?`).run('2026-12-01T00:00:00.000Z', 'g1');
    const t = await say('What was the second thing on my grocery list?');
    assert('F2E24 live leftover unused then F2 fresh order', t, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E25 F2 fresh IDs Eggs,Apples,Milk', ordered.peek()?.presentedIds.join(','),
      v => v === 'g2,g3,g1', 'g2,g3,g1');
    assert('F2E26 F2 after unused no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered } = fresh();
    stockThree(db);
    await say('What was the second thing on my grocery list?');
    const t = await say("What's the third one?");
    assert('F2E27 F1 after F2 establish', t, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E28 F1 still live', ordered.hasLive(), v => v === true, 'live');
  }

  {
    const { db, say, getClassifyCalls } = fresh();
    stockThree(db);
    const t = await say('the first thing and the third thing on my grocery list');
    assert('F2E29 ambiguous confusion', t, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('F2E30 ambiguous no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered, getClassifyCalls } = fresh();
    stockThree(db);
    await say('What was the second thing on my grocery list?');
    const t = await say("What's the third thing?");
    assert('F2E31 F2 then thing continuation', t, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E32 holder usable after thing', ordered.hasLive(), v => v === true, 'live');
    const again = await say("What's the first one?");
    assert('F2E33 canonical after thing', again, v => v.responseText === "That's Milk.", "That's Milk.");
    assert('F2E34 continuation no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered, getClassifyCalls } = fresh();
    stockThree(db);
    await say('What was the second thing on my grocery list?');
    const ellipsis = await say('And the third?');
    assert('F2E35 ellipsis continuation', ellipsis, v => v.responseText === "That's Apples.", "That's Apples.");
    const invert = await say('Which thing was first?');
    assert('F2E36 inversion continuation', invert, v => v.responseText === "That's Milk.", "That's Milk.");
    assert('F2E37 ellipsis/inversion no classify', getClassifyCalls(), v => v === 0, '0');
    assert('F2E38 holder after ellipsis', ordered.hasLive(), v => v === true, 'live');
  }

  {
    const { db, say, ordered, getClassifyCalls } = fresh();
    stockThree(db);
    await say('What was the second thing on my grocery list?');
    const next = await say('the next one');
    assert('F2E39 next confusion', next, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('F2E40 next retains holder', ordered.hasLive(), v => v === true, 'live');
    const recover = await say("What's the third thing?");
    assert('F2E41 recover after next', recover, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('F2E42 next path no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered } = fresh();
    stockThree(db);
    presentGrocery(ordered, new ConversationalSubjectHolder(), new MedicationPresentationHolder());
    db.prepare(`UPDATE list_items SET created_at = ? WHERE id = ?`).run('2026-12-01T00:00:00.000Z', 'g1');
    const named = await say("What's item three on my grocery list?");
    assert('F2E43 named grant wins over live frozen IDs', named, v => v.responseText === "That's Milk.", "That's Milk.");
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Grocery named-collection re-entry: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('groceryNamedCollectionReentry.test.ts')) {
  runGroceryNamedCollectionReentryTests().catch(console.error);
}
