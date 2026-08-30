// Grocery positional mutation V1 — authority, lifecycle, collisions.
//
// Runner: npx tsx scripts/heraldTest/groceryPositionalMutation.test.ts
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
  parseGroceryPositionalMutation,
  hasGroceryNamedMutationCue,
} from '../../src/routing/groceryPositionalMutation.ts';
import { interpretPositionReference } from '../../src/routing/positionReference.ts';
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

function stockFour(db: Database.Database) {
  insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
  insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
  insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
  insertItem(db, 'g4', 'ham', '2026-01-04T00:00:00.000Z');
}

function rowState(db: Database.Database, id: string) {
  return db.prepare(`SELECT checked, removed_at FROM list_items WHERE id = ?`).get(id) as {
    checked: number;
    removed_at: string | null;
  };
}

export async function runGroceryPositionalMutationTests() {
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

  console.log(`\n${BOLD}-- Grocery positional mutation V1 -----------------------${RESET}\n`);

  assert('GPM1 remove second thing', parseGroceryPositionalMutation('Remove the second thing.'),
    v => v.kind === 'position' && v.n === 2, 'position 2');
  assert('GPM2 delete fourth item', parseGroceryPositionalMutation('Delete the fourth item.'),
    v => v.kind === 'position' && v.n === 4, 'position 4');
  assert('GPM3 take number two off', parseGroceryPositionalMutation('Take number two off.'),
    v => v.kind === 'position' && v.n === 2, 'position 2');
  assert('GPM4 remove first one', parseGroceryPositionalMutation('Remove the first one.'),
    v => v.kind === 'position' && v.n === 1, 'position 1');
  assert('GPM5 named from grocery', parseGroceryPositionalMutation('Take the third thing off my grocery list.'),
    v => v.kind === 'position' && v.n === 3, 'position 3');
  assert('GPM6 I got the third item', parseGroceryPositionalMutation('I got the third item.'),
    v => v.kind === 'position' && v.n === 3, 'position 3');
  assert('GPM7 named cue from', hasGroceryNamedMutationCue('Remove item three from my grocery list.'),
    v => v === true, 'true');
  assert('GPM8 named cue off', hasGroceryNamedMutationCue('Take the second thing off the grocery list.'),
    v => v === true, 'true');
  assert('GPM9 named cue on', hasGroceryNamedMutationCue('Delete number four on my grocery list.'),
    v => v === true, 'true');
  assert('GPM10 no named cue', hasGroceryNamedMutationCue('Remove the second thing.'),
    v => v === false, 'false');
  assert('GPM11 multi-position', parseGroceryPositionalMutation('Remove the first and third things.'),
    v => v.kind === 'ambiguous' && v.reason === 'competing_positions', 'ambiguous');
  assert('GPM12 next one', parseGroceryPositionalMutation('Remove the next one.'),
    v => v.kind === 'ambiguous' && v.reason === 'relative', 'relative');
  assert('GPM13 remove it', parseGroceryPositionalMutation('Remove it.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM14 red one', parseGroceryPositionalMutation('Delete the red one.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM15 medication', parseGroceryPositionalMutation('Remove the second medication.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM16 read request', parseGroceryPositionalMutation("What's the second thing?"),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM17 I got eggs', parseGroceryPositionalMutation('I got eggs.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM18 F2 read still refuses mutation', parseGroceryNamedCollectionRead('Remove the second thing on my grocery list.'),
    v => v.kind === 'not_this_act', 'not_this_act');
  assert('GPM19 grocery read parser refuses mutation', parseGroceryReadPosition('Remove the second thing.'),
    v => v === null, 'null');
  assert('GPM20 interpreter extracts without IDs', interpretPositionReference('Remove the second thing.', { allowMutationLanguage: true }),
    v => v.kind === 'position_reference' && v.positions[0] === 2 && !('id' in v) && !('body' in v),
    'position 2 no id');

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Remove the second thing.');
    const eggs = rowState(db, 'g2');
    assert('GPM21 live remove ACK', t,
      v => v.handled === true && typeof v.responseText === 'string' && v.responseText.startsWith('Done — eggs is off.'),
      'Done — eggs');
    assert('GPM22 eggs checked', eggs.checked, v => v === 1, '1');
    assert('GPM23 eggs removed_at', eggs.removed_at, v => typeof v === 'string' && v.length > 0, 'timestamp');
    assert('GPM24 milk still open', getOpenListItemById('g1', 'grocery')?.body, v => v === 'milk', 'milk');
    assert('GPM25 holder remaining order', ordered.peek()?.presentedIds.join(','), v => v === 'g1,g3,g4', 'g1,g3,g4');
    const next = await say("What's the second thing now?");
    assert('GPM26 post-mutation second is bananas', next, v => v.responseText === "That's bananas.", "That's bananas.");
  }

  {
    const { db, say, ordered } = fresh();
    stockFour(db);
    assert('GPM27 named starts with no holder', ordered.hasLive(), v => v === false, 'false');
    const t = await say('Remove item three from my grocery list.');
    assert('GPM28 named removes bananas', t,
      v => v.handled === true && v.responseText.startsWith('Done — bananas is off.'),
      'Done — bananas');
    assert('GPM29 g3 checked', rowState(db, 'g3').checked, v => v === 1, '1');
    assert('GPM30 g2 untouched', rowState(db, 'g2').checked, v => v === 0, '0');
  }

  {
    const { db, say } = fresh();
    stockFour(db);
    const t = await say('Remove the second thing.');
    assert('GPM31 no grant no write', t, v => v.handled === true && v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('GPM32 no grant eggs remain', rowState(db, 'g2').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    db.prepare(`UPDATE list_items SET created_at = ? WHERE id = ?`).run('2026-12-01T00:00:00.000Z', 'g1');
    const t = await say('Remove item three from my grocery list.');
    assert('GPM33 named-over-live removes current #3', t,
      v => v.handled === true && v.responseText.startsWith('Done — ham is off.'),
      'Done — ham');
    assert('GPM34 stale holder #3 bananas not mutated', rowState(db, 'g3').checked, v => v === 0, '0');
    assert('GPM35 milk (now last) not mutated', rowState(db, 'g1').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const next = await say('Remove the next one.');
    assert('GPM36 next confuses', next, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('GPM37 next does not write', rowState(db, 'g1').checked + rowState(db, 'g2').checked, v => v === 0, '0');
    assert('GPM38 next retains holder', ordered.hasLive(), v => v === true, 'live');
    const third = await say('Remove the third thing.');
    assert('GPM39 then third removes bananas', third,
      v => v.handled === true && v.responseText.startsWith('Done — bananas is off.'),
      'Done — bananas');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const multi = await say('Remove the first and third things.');
    assert('GPM40 multi no write', multi, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('GPM41 multi retains holder', ordered.hasLive(), v => v === true, 'live');
    assert('GPM42 multi none checked', [rowState(db, 'g1').checked, rowState(db, 'g3').checked].join(','),
      v => v === '0,0', '0,0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('I got the third item.');
    assert('GPM43 I got third removes bananas', t,
      v => v.handled === true && v.responseText.startsWith('Done — bananas is off.'),
      'Done — bananas');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('I got eggs.');
    assert('GPM44 I got eggs still list_remove', t,
      v => v.handled === false && v.routeDecision?.actionIntent?.type === 'list_remove'
        && String(v.routeDecision.actionIntent?.item ?? '').toLowerCase().startsWith('eggs'),
      'list_remove eggs');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('remove oranges from my grocery list');
    assert('GPM45 body remove still routes', t,
      v => v.handled === false && v.routeDecision?.actionIntent?.type === 'list_remove',
      'list_remove');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say("What's the second thing?");
    assert('GPM46 read not mutation', t, v => v.responseText === "That's eggs.", "That's eggs.");
    assert('GPM47 read did not check eggs', rowState(db, 'g2').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Call the second one.');
    assert('GPM48 call is not positional mutation', t,
      v => v.handled === true && v.responseText === "That's eggs.",
      'existing grocery read, not write');
    assert('GPM49 call did not check', rowState(db, 'g2').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Take 25 milligrams.');
    assert('GPM50 dose not grocery mutation', t,
      v => !(v.handled === true && typeof v.responseText === 'string' && v.responseText.startsWith('Done —')),
      'not grocery Done');
    assert('GPM51 dose no write', rowState(db, 'g1').checked, v => v === 0, '0');
  }

  {
    const { db, say } = fresh();
    stockFour(db);
    const t = await say('My appointment is on the third.');
    assert('GPM52 date not mutation', t, v => v.handled === false, 'not handled');
    assert('GPM53 date no write', rowState(db, 'g3').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Remove it.');
    assert('GPM54 it not mutation write', rowState(db, 'g1').checked + rowState(db, 'g2').checked, v => v === 0, '0');
    assert('GPM55 it not grocery positional handled-ack', t,
      v => !(v.handled === true && typeof v.responseText === 'string' && v.responseText.startsWith('Done —')),
      'not Done');
  }

  {
    const { db, say } = fresh();
    stockFour(db);
    const t = await say('What time is it?');
    assert('GPM56 time query no write', t, v => v.handled === false, 'not handled');
    assert('GPM57 time no grocery change', rowState(db, 'g1').checked, v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('I got number three you can remove it');
    assert('GPM58 OP125-shaped still list_remove', t,
      v => v.handled === false && v.routeDecision?.actionIntent?.type === 'list_remove',
      'list_remove');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const t = await say('Remove the first one.');
    assert('GPM59 last item clears list', t,
      v => v.handled === true && v.responseText === 'Done — milk is off your grocery list. That clears it.',
      'clears it');
    assert('GPM60 empty holder after last', ordered.hasLive(), v => v === false, 'cleared');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    stockFour(db);
    presentGrocery(ordered, subject, medication);
    const t = await say('Take number two off.');
    assert('GPM61 take number two off eggs', t,
      v => v.handled === true && v.responseText.startsWith('Done — eggs is off.'),
      'Done — eggs');
  }

  {
    const { say } = fresh();
    const t = await say('Delete number four on my grocery list.');
    assert('GPM62 named empty list', t, v => v.responseText === 'Your grocery list is empty.', 'empty');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Grocery positional mutation: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('groceryPositionalMutation.test.ts')) {
  runGroceryPositionalMutationTests().catch(console.error);
}
