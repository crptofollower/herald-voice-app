// Ordered Presentation Reference V1 — parser, resolve-all, holder, grocery read-back.
//
// Runner: npx tsx scripts/heraldTest/orderedPresentation.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeMedication } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import {
  OrderedPresentationHolder,
  ordinalWordToNumber,
  cardinalWordToNumber,
  parseNumericOrdinal,
  parseCuedListPositions,
  parseGroceryReadPosition,
  isGroceryPositionNearMiss,
  resolvePositions,
  ORDERED_PRESENTATION_CONFUSION,
  GROCERY_POSITION_STALE,
} from '../../src/routing/orderedPresentation.ts';
import {
  composeOpenListSpeech,
  getPresentedOpenListItems,
  getOpenListItemById,
  formatGroceryItemReadback,
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

function presentGrocery(ordered: OrderedPresentationHolder, subject: ConversationalSubjectHolder, medication: MedicationPresentationHolder) {
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

export async function runOrderedPresentationTests() {
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

  console.log(`\n${BOLD}-- Ordered Presentation Reference V1 --------------------${RESET}\n`);

  // Parser — ordinal words
  assert('OP1 first', ordinalWordToNumber('first'), v => v === 1, '1');
  assert('OP2 third', ordinalWordToNumber('third'), v => v === 3, '3');
  assert('OP3 fifth', ordinalWordToNumber('fifth'), v => v === 5, '5');
  assert('OP4 tenth', ordinalWordToNumber('tenth'), v => v === 10, '10');
  assert('OP5 eleventh', ordinalWordToNumber('eleventh'), v => v === 11, '11');
  assert('OP6 twenty-first', ordinalWordToNumber('twenty-first'), v => v === 21, '21');
  assert('OP7 twenty-third', ordinalWordToNumber('twenty-third'), v => v === 23, '23');
  assert('OP8 one hundredth', ordinalWordToNumber('one hundredth'), v => v === 100, '100');
  assert('OP9 last rejected', ordinalWordToNumber('last'), v => v === null, 'null');

  // Parser — numeric ordinals
  assert('OP10 1st', parseNumericOrdinal('1st'), v => v === 1, '1');
  assert('OP11 2nd', parseNumericOrdinal('2nd'), v => v === 2, '2');
  assert('OP12 3rd', parseNumericOrdinal('3rd'), v => v === 3, '3');
  assert('OP13 4th', parseNumericOrdinal('4th'), v => v === 4, '4');
  assert('OP14 11th', parseNumericOrdinal('11th'), v => v === 11, '11');
  assert('OP15 23rd', parseNumericOrdinal('23rd'), v => v === 23, '23');
  assert('OP16 100th', parseNumericOrdinal('100th'), v => v === 100, '100');
  assert('OP17 23st rejected', parseNumericOrdinal('23st'), v => v === null, 'null');

  // Parser — cued forms
  assert('OP18 the third one', parseCuedListPositions('the third one'), v => Array.isArray(v) && v[0] === 3, '[3]');
  assert('OP19 that twenty-third one', parseCuedListPositions('that twenty-third one'), v => v?.[0] === 23, '[23]');
  assert('OP20 the one hundredth one', parseCuedListPositions('the one hundredth one'), v => v?.[0] === 100, '[100]');
  assert('OP21 number 5', parseCuedListPositions('number 5'), v => v?.[0] === 5, '[5]');
  assert('OP22 item 5', parseCuedListPositions('item 5'), v => v?.[0] === 5, '[5]');
  assert('OP23 #5', parseCuedListPositions('#5'), v => v?.[0] === 5, '[5]');
  assert('OP24 number 1', parseCuedListPositions('number 1'), v => v?.[0] === 1, '[1]');
  assert('OP25 3rd one', parseCuedListPositions('the 3rd one'), v => v?.[0] === 3, '[3]');
  assert('OP26 tell me the third one', parseGroceryReadPosition('Tell me the third one.'), v => v === 3, '3');
  assert('OP27 tell me about the third one', parseGroceryReadPosition('tell me about the third one'), v => v === 3, '3');
  assert('OP28 numbers 2, 4, and 5', parseCuedListPositions('numbers 2, 4, and 5'),
    v => Array.isArray(v) && v.join(',') === '2,4,5', '[2,4,5]');
  assert('OP90 What\'s the third one', parseGroceryReadPosition("What's the third one?"), v => v === 3, '3');
  assert('OP91 What was the third one', parseGroceryReadPosition('What was the third one?'), v => v === 3, '3');
  assert('OP92 What about the third one', parseGroceryReadPosition('What about the third one?'), v => v === 3, '3');
  assert('OP93 What was number two', parseGroceryReadPosition('What was number two?'), v => v === 2, '2');
  assert('OP94 What about number four', parseGroceryReadPosition('What about number four?'), v => v === 4, '4');
  assert('OP95 What was item six', parseGroceryReadPosition('What was item six?'), v => v === 6, '6');
  assert('OP96 number two', parseGroceryReadPosition('number two'), v => v === 2, '2');
  assert('OP97 number four', parseGroceryReadPosition('number four'), v => v === 4, '4');
  assert('OP98 item six', parseGroceryReadPosition('item six'), v => v === 6, '6');
  assert('OP99 Which one was number five', parseGroceryReadPosition('Which one was number five?'), v => v === 5, '5');
  assert('OP100 wrapped that third one', parseGroceryReadPosition("Let's go with that third one."), v => v === 3, '3');
  assert('OP101 This one', parseGroceryReadPosition('This one'), v => v === null, 'null');
  assert('OP102 It', parseGroceryReadPosition('It'), v => v === null, 'null');
  assert('OP103 grocery list ask', parseGroceryReadPosition("What's on my grocery list?"), v => v === null, 'null');
  assert('OP104 mutation unclaimed', parseGroceryReadPosition('I got number three you can remove it'), v => v === null, 'null');
  assert('OP105 competing operators not a single read', parseGroceryReadPosition('the first one and the third one'), v => v === null, 'null');
  assert('OP106 competing is near-miss', isGroceryPositionNearMiss('the first one and the third one'), v => v === true, 'true');
  assert('OP107 cardinal two', cardinalWordToNumber('two'), v => v === 2, '2');
  assert('OP108 cardinal four', cardinalWordToNumber('four'), v => v === 4, '4');
  assert('OP109 cardinal six', cardinalWordToNumber('six'), v => v === 6, '6');

  // Cue fences
  assert('OP29 bare the 23rd', parseCuedListPositions('the 23rd'), v => v === null, 'null');
  assert('OP30 last one', parseCuedListPositions('the last one'), v => v === null, 'null');
  assert('OP31 dose', parseCuedListPositions('take 25 mg'), v => v === null, 'null');
  assert('OP32 time', parseCuedListPositions('at 3:00'), v => v === null, 'null');
  assert('OP33 date-like third', parseCuedListPositions('I saw him on the third'), v => v === null, 'null');
  assert('OP34 garbage', parseCuedListPositions('asdf qwer'), v => v === null, 'null');
  assert('OP35 remove number 2 not a read', parseGroceryReadPosition('remove number 2'), v => v === null, 'null');
  assert('OP36 I completed number 2 not a read', parseGroceryReadPosition('I completed number 2'), v => v === null, 'null');

  // Resolver
  {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    assert('OP37 resolve 2,4,5', resolvePositions(ids, [2, 4, 5]),
      v => v.ok === true && v.ids.join(',') === 'b,d,e', 'b,d,e');
    assert('OP38 dedupe positions', resolvePositions(ids, [2, 2, 4]),
      v => v.ok === true && v.ids.join(',') === 'b,d', 'b,d');
    assert('OP39 OOR fails all', resolvePositions(ids, [2, 9, 4]),
      v => v.ok === false && v.reason === 'out_of_range', 'out_of_range');
    assert('OP40 zero invalid', resolvePositions(ids, [0]),
      v => v.ok === false && v.reason === 'invalid_position', 'invalid_position');
    assert('OP41 negative invalid', resolvePositions(ids, [-1, 2]),
      v => v.ok === false && v.reason === 'invalid_position', 'invalid_position');
    assert('OP42 empty invalid', resolvePositions(ids, []),
      v => v.ok === false && v.reason === 'invalid_position', 'invalid_position');
  }

  // Holder copies / replace / renew
  {
    const h = new OrderedPresentationHolder();
    const src = ['x', 'y'];
    h.establish('grocery', src);
    src.push('z');
    assert('OP43 establish copies IDs', h.peek()?.presentedIds.join(','), v => v === 'x,y', 'x,y');
    h.establish('grocery', ['p']);
    assert('OP44 replace', h.peek()?.presentedIds.join(','), v => v === 'p', 'p');
    h.consumeRepair();
    assert('OP45 repair consumed', h.peek()?.repairAvailable, v => v === false, 'false');
    h.renew();
    assert('OP46 renew restores repair', h.peek()?.repairAvailable, v => v === true, 'true');
    assert('OP47 renew keeps IDs', h.peek()?.presentedIds.join(','), v => v === 'p', 'p');
  }

  // Grocery same-read + proof
  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
    insertItem(db, 'g3dup', 'apples', '2026-01-04T00:00:00.000Z');
    const routed = await say("What's on my grocery list?");
    assert('OP48 list_read routes', routed,
      v => v.handled === false && v.routeDecision?.kind === 'device_read'
        && v.routeDecision.reason === 'action:list_read'
        && v.routeDecision.presentedGroceryIds?.join(',') === 'g1,g2,g3',
      'device_read action:list_read grocery IDs');
    assert('OP49 speech from post-dedupe', routed,
      v => v.handled === false && v.routeDecision?.kind === 'device_read'
        && /Milk/i.test(v.routeDecision.response)
        && /Eggs/i.test(v.routeDecision.response)
        && /Apples/i.test(v.routeDecision.response)
        && v.routeDecision.response.indexOf('Milk') < v.routeDecision.response.indexOf('Eggs')
        && v.routeDecision.response.indexOf('Eggs') < v.routeDecision.response.indexOf('Apples'),
      'names Milk, Eggs, Apples');
    assert('OP50 IDs skip duplicate body', ordered.peek()?.presentedIds.join(','),
      v => v === 'g1,g2,g3', 'g1,g2,g3');
    assert('OP51 holder matches speech IDs', ordered.peek()?.presentedIds.join(','),
      v => v === 'g1,g2,g3', 'g1,g2,g3');

    db.prepare(`UPDATE list_items SET created_at = ? WHERE id = ?`).run('2026-12-01T00:00:00.000Z', 'g1');
    const third = await say('the third one');
    assert('OP52 same-read third still Apples', third,
      v => v.handled === true && v.source === 'referent_resume' && v.responseText === "That's Apples.",
      "That's Apples.");
  }

  {
    const { db, say, ordered, subject, medication, getClassifyCalls } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const n2 = await say('number 2');
    assert('OP54 number 2 is Eggs', n2, v => v.responseText === "That's Eggs.", "That's Eggs.");
    const nth = await say('the 3rd one');
    assert('OP55 3rd one is Apples', nth, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('OP56 no classify on grocery position', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    for (let i = 1; i <= 27; i++) {
      insertItem(db, `n${i}`, `Item${i}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`);
    }
    presentGrocery(ordered, subject, medication);
    const t = await say('the 23rd one');
    assert('OP57 23rd of 27', t, v => v.responseText === "That's Item23.", "That's Item23.");
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const oor = await say('the fifth one');
    assert('OP58 OOR honest', oor, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('OP59 OOR retains', ordered.hasLive(), v => v === true, 'live');
    const still = await say('the first one');
    assert('OP60 retry after OOR', still, v => v.responseText === "That's Milk.", "That's Milk.");
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    db.prepare(`UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?`).run(
      '2026-08-29T00:00:00.000Z', 'g3',
    );
    const stale = await say('the third one');
    assert('OP61 stale honest', stale, v => v.responseText === GROCERY_POSITION_STALE, 'stale');
    assert('OP62 stale does not reshuffle', ordered.peek()?.presentedIds.join(','),
      v => v === 'g1,g2,g3', 'g1,g2,g3');
    const first = await say('number 1');
    assert('OP63 first still Milk after stale third', first, v => v.responseText === "That's Milk.", "That's Milk.");
    assert('OP64 reread misses deleted', getOpenListItemById('g3', 'grocery'), v => v === null, 'null');
  }

  {
    const { db, say, ordered, subject, medication, getClassifyCalls } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const unrelated = await say('what time is it');
    assert('OP65 unrelated clears', ordered.hasLive(), v => v === false, 'cleared');
    assert('OP66 unrelated reached routing', unrelated.handled, v => v === false, 'not handled');
    assert('OP67 classify ran after unused clear', getClassifyCalls() > 0, v => v === true, 'classified');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
    const again = presentGrocery(ordered, subject, medication);
    assert('OP68 new read replaces', ordered.peek()?.presentedIds.join(','),
      v => v === 'g1,g2,g3', 'g1,g2,g3');
    assert('OP69 replacement speech', again.speech, v => /Milk/i.test(v) && /Eggs/i.test(v) && /Apples/i.test(v), 'names Milk, Eggs, Apples');
    assert('OP69b replacement items include Apples', again.items.map((i) => i.body).join(','),
      v => v === 'Milk,Eggs,Apples', 'Milk,Eggs,Apples');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'Eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'Apples', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const go = await say("Let's go with that third one.");
    assert('OP70 wrapped third one resolves', go, v => v.responseText === "That's Apples.", "That's Apples.");
    assert('OP71 wrapped resolve renews', ordered.hasLive() && ordered.peek()?.repairAvailable === true,
      v => v === true, 'live, repair restored');
    const miss1 = await say('the first one and the third one');
    assert('OP72 competing operators confusion', miss1, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('OP73 first competing near-miss retains', ordered.hasLive(), v => v === true, 'live');
    const miss2 = await say('the first one and the third one');
    assert('OP73b second competing near-miss', miss2, v => v.responseText === ORDERED_PRESENTATION_CONFUSION, 'confusion');
    assert('OP73c second competing still retains', ordered.hasLive(), v => v === true, 'live');
  }

  {
    const { db, say, ordered, subject, medication, session } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    session.setPending({
      pendingKey: 'test_pending',
      resume: async () => ({ status: 'committed', ack: 'ok' }),
    });
    const p = await say('the first one');
    assert('OP74 pending owns over position', p, v => v.source === 'pending_resume', 'pending_resume');
    assert('OP75 pending clears presentation', ordered.hasLive(), v => v === false, 'cleared');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const em = await say('Can you help me?');
    assert('OP76 Law 0', em, v => v.source === 'emergency', 'emergency');
    assert('OP77 Law 0 clears', ordered.hasLive(), v => v === false, 'cleared');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    presentGrocery(ordered, subject, medication);
    await say('Who is my wife?');
    assert('OP78 Flow C clears grocery', { live: ordered.hasLive(), domain: subject.peek()?.domain },
      v => v.live === false && v.domain === 'family_contact', 'family, no grocery');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    writeMedication({ name: 'Lisinopril', dosage: '10mg', frequency: 'daily', is_active: 1 });
    presentGrocery(ordered, subject, medication);
    await say('What medications am I taking?');
    assert('OP79 medication summary clears grocery', ordered.hasLive(), v => v === false, 'cleared');
    assert('OP80 medication presentation established', medication.hasLive(), v => v === true, 'live');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'Milk', '2026-01-01T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const rm = await say('remove milk from my grocery list');
    assert('OP81 name-remove still routes', rm,
      v => v.handled === false && v.routeDecision?.kind === 'device_action'
        && v.routeDecision.actionIntent?.type === 'list_remove',
      'list_remove');
    assert('OP82 name-remove unused-clears presentation', ordered.hasLive(), v => v === false, 'cleared');
  }

  {
    const { say, ordered } = fresh();
    const empty = presentGrocery(ordered, new ConversationalSubjectHolder(), new MedicationPresentationHolder());
    assert('OP83 empty speech', empty.speech, v => v === 'Your grocery list is empty.', 'empty copy');
    assert('OP84 empty does not establish', ordered.hasLive(), v => v === false, 'cleared');
    const t = await say('the first one');
    assert('OP85 no presentation no grocery bind', t, v => v.handled === false, 'not referent');
  }

  {
    assert('OP86 formatGroceryItemReadback', formatGroceryItemReadback('Milk'), v => v === "That's Milk.", "That's Milk.");
    assert('OP87 wrapped third is not near-miss', isGroceryPositionNearMiss("Let's go with that third one."), v => v === false, 'false');
    assert('OP88 exact is not near-miss', isGroceryPositionNearMiss('the third one'), v => v === false, 'false');
    assert('OP89 the red one not near-miss', isGroceryPositionNearMiss('the red one'), v => v === false, 'false');
  }

  {
    const { db, say, ordered, subject, medication, getClassifyCalls } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
    insertItem(db, 'g4', 'applesauce', '2026-01-04T00:00:00.000Z');
    insertItem(db, 'g5', 'chocolate milk', '2026-01-05T00:00:00.000Z');
    insertItem(db, 'g6', 'avocados', '2026-01-06T00:00:00.000Z');
    insertItem(db, 'g7', 'dates', '2026-01-07T00:00:00.000Z');
    insertItem(db, 'g8', 'oranges', '2026-01-08T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const t1 = await say("What's the third one?");
    assert('OP110 device What\'s the third one', t1, v => v.responseText === "That's bananas.", "That's bananas.");
    const t2 = await say('The third one.');
    assert('OP111 device The third one', t2, v => v.responseText === "That's bananas.", "That's bananas.");
    const t3 = await say('What was the third one?');
    assert('OP112 device What was the third one', t3, v => v.responseText === "That's bananas.", "That's bananas.");
    const t4 = await say('What was number two?');
    assert('OP113 device What was number two', t4, v => v.responseText === "That's eggs.", "That's eggs.");
    const t5 = await say('What about number four?');
    assert('OP114 device What about number four', t5, v => v.responseText === "That's applesauce.", "That's applesauce.");
    const t6 = await say('What was item six?');
    assert('OP115 device What was item six', t6, v => v.responseText === "That's avocados.", "That's avocados.");
    const t7 = await say('number two');
    assert('OP116 device number two', t7, v => v.responseText === "That's eggs.", "That's eggs.");
    const t8 = await say('number four');
    assert('OP117 device number four', t8, v => v.responseText === "That's applesauce.", "That's applesauce.");
    const t9 = await say('item six');
    assert('OP118 device item six', t9, v => v.responseText === "That's avocados.", "That's avocados.");
    assert('OP119 device no classify', getClassifyCalls(), v => v === 0, '0');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const listAsk = await say("What's on my grocery list?");
    assert('OP120 live list ask not a position', listAsk,
      v => v.handled === false && v.routeDecision?.kind === 'device_read'
        && v.routeDecision.reason === 'action:list_read',
      'device_read list_read');
    assert('OP121 live list ask re-grants current presentation', ordered.peek()?.presentedIds.join(','),
      v => v === 'g1,g2,g3', 'g1,g2,g3');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const thisOne = await say('This one');
    assert('OP122 This one not a position', thisOne, v => v.handled === false, 'not referent');
    assert('OP123 This one unused-clears', ordered.hasLive(), v => v === false, 'cleared');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const it = await say('It');
    assert('OP124 It not a position', it, v => v.handled === false, 'not referent');
  }

  {
    const { db, say, ordered, subject, medication } = fresh();
    insertItem(db, 'g1', 'milk', '2026-01-01T00:00:00.000Z');
    insertItem(db, 'g2', 'eggs', '2026-01-02T00:00:00.000Z');
    insertItem(db, 'g3', 'bananas', '2026-01-03T00:00:00.000Z');
    presentGrocery(ordered, subject, medication);
    const mut = await say('I got number three you can remove it');
    assert('OP125 mutation not OPR read', mut,
      v => (v as { routeDecision?: { actionIntent?: { type?: string } } }).routeDecision?.actionIntent?.type !== 'list_remove',
      'not list_remove');
    assert('OP126 inferred got+number does not write bananas', getOpenListItemById('g3', 'grocery')?.body, v => v === 'bananas', 'bananas still open');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Ordered Presentation: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('orderedPresentation.test.ts')) {
  runOrderedPresentationTests().catch(console.error);
}
