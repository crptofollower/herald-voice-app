// Grocery conversational grant retention V1 — related-unresolved vs unused-clear.
//
// Runner: npx tsx scripts/heraldTest/groceryGrantRetention.test.ts
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
  ORDERED_PRESENTATION_CONFUSION,
} from '../../src/routing/orderedPresentation.ts';
import { interpretPositionReference } from '../../src/routing/positionReference.ts';
import {
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
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, medication, ordered);
  return { db, session, subject, medication, ordered, say };
}

function insertItem(db: Database.Database, id: string, body: string, createdAt: string) {
  db.prepare(
    `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'list_grocery', body, 0, createdAt);
}

function stockFour(db: Database.Database) {
  insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
  insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
  insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
  insertItem(db, 'g4', 'ham', '2026-01-04T00:00:00.000Z');
}

function presentGrocery(
  ordered: OrderedPresentationHolder,
  subject: ConversationalSubjectHolder,
  medication: MedicationPresentationHolder,
) {
  const items = getPresentedOpenListItems('grocery');
  if (items.length === 0) {
    ordered.clear();
    return;
  }
  subject.clear();
  medication.clear();
  ordered.establish('grocery', items.map((i) => i.id));
}

function rowChecked(db: Database.Database, id: string) {
  return (db.prepare(`SELECT checked FROM list_items WHERE id = ?`).get(id) as { checked: number }).checked;
}

export async function runGroceryGrantRetentionTests() {
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

  console.log(`\n${BOLD}-- Grocery grant retention V1 ---------------------------${RESET}\n`);

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const malformed = await say('Delete the third third item.');
    const bananasGone = rowChecked(db, 'g3') === 1;
    const collapseWrote = bananasGone
      && malformed.handled === true
      && String(malformed.responseText).startsWith('Done — bananas is off.');
    const retainedNoWrite = !bananasGone
      && [rowChecked(db, 'g1'), rowChecked(db, 'g2'), rowChecked(db, 'g3'), rowChecked(db, 'g4')].join(',') === '0,0,0,0';
    assert('CGR1 malformed related does not destroy grant', ordered.hasLive(), v => v === true, 'holder live');
    assert('CGR2 collapse-or-retain without grant loss', collapseWrote || retainedNoWrite, v => v === true, 'collapse or retain');
    if (!bananasGone) {
      const clean = await say('Delete the third item.');
      assert('CGR3 clean correction writes #3', clean,
        v => v.handled === true && String(v.responseText).startsWith('Done — bananas is off.'),
        'Done — bananas');
    } else {
      assert('CGR3 collapse already removed bananas', getOpenListItemById('g3', 'grocery'), v => v == null, 'gone');
    }
  }

  assert('CGR4 duplicate third is one position', interpretPositionReference('the third third item'),
    v => v.kind === 'position_reference' && v.positions[0] === 3, 'position 3');
  assert('CGR5 number number two', interpretPositionReference('number number two'),
    v => v.kind === 'position_reference' && v.positions[0] === 2, 'position 2');
  assert('CGR6 first and third still competing', interpretPositionReference('the first thing and the third thing'),
    v => v.kind === 'ambiguous' && v.reason === 'competing_positions', 'competing');
  assert('CGR7 mutation duplicate extracts N', interpretPositionReference('Delete the third third item.', { allowMutationLanguage: true }),
    v => v.kind === 'position_reference' && v.positions[0] === 3, 'position 3');

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    await say('Remove the next one.');
    await say('Remove the next one.');
    assert('CGR8 repeated relative retains', ordered.hasLive(), v => v === true, 'live');
    assert('CGR9 repeated relative no write', rowChecked(db, 'g1') + rowChecked(db, 'g2'), v => v === 0, '0');
    const third = await say('Remove the third thing.');
    assert('CGR10 clean after repeated relative', third,
      v => v.handled === true && String(v.responseText).startsWith('Done — bananas is off.'),
      'Done — bananas');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    await say('Remove the first and third things.');
    await say('Remove the first and third things.');
    assert('CGR11 repeated competing retains', ordered.hasLive(), v => v === true, 'live');
    assert('CGR12 competing no write', rowChecked(db, 'g1') + rowChecked(db, 'g3'), v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    await say("What's the second thing?");
    const time = await say('What time is it?');
    assert('CGR13 time query clears holder', ordered.hasLive(), v => v === false, 'cleared');
    const unnamed = await say('Remove the second thing.');
    assert('CGR14 unnamed after clear does not write', rowChecked(db, 'g2'), v => v === 0, '0');
    assert('CGR15 unnamed after clear no grocery mutation ack', unnamed,
      v => !(v.handled === true && String(v.responseText).startsWith('Done —')),
      'not Done');
    const named = await say('Remove the second thing from my grocery list.');
    assert('CGR16 named re-entry after clear', named,
      v => v.handled === true && String(v.responseText).startsWith('Done — eggs is off.'),
      'Done — eggs');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    await say('Remove the second medication.');
    assert('CGR17 medication collision does not grocery-write', rowChecked(db, 'g2'), v => v === 0, '0');
    assert('CGR18 medication collision not grocery Done', getOpenListItemById('g2', 'grocery')?.body, v => v === 'eggs', 'eggs');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('I got eggs.');
    assert('CGR19 I got eggs still list_remove', t,
      v => v.handled === false && v.routeDecision?.actionIntent?.type === 'list_remove',
      'list_remove');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Delete, can you delete the third item?');
    assert('CGR20 live wrapper writes #3', t,
      v => v.handled === true && String(v.responseText).startsWith('Done — bananas is off.'),
      'Done — bananas');
  }

  {
    const { say, ordered } = fresh();
    const t = await say('Delete the third item.');
    assert('CGR21 no grant does not invent grocery', t,
      v => v.handled === true && v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('CGR22 no grant no holder', ordered.hasLive(), v => v === false, 'empty');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Grocery grant retention: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('groceryGrantRetention.test.ts')) {
  runGroceryGrantRetentionTests().catch(console.error);
}
