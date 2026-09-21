// Recent Action Recall V1.
// Most recent successfully committed list-add, from ledger committed-item evidence.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { CalendarContinuationHolder } from '../../src/routing/calendarContinuation.ts';
import { CalendarPresentationHolder } from '../../src/routing/calendarPresentation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { classifyImmediateRecapDeterministic, answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import {
  classifyRecentCommittedAddRecall,
  findMostRecentCommittedAdd,
} from '../../src/routing/recentActionRecall.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  CLARIFY_LIST_ADD_ITEM_KEY,
  CLARIFY_OPERATIONAL_LIST_KEY,
} from '../../src/routing/operationalListContinuity.ts';
import { getPresentedOpenListItems, markOpenListItemRemovedById } from '../../src/db/listRead.ts';

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
  ).all() as { body: string }[]).map((r) => r.body);
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
  const ledger = createConversationTurnLedger();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }),
    llmReady: true,
    captureContext: { contacts: [] as string[], lists: ['grocery'] as string[] },
  };
  const say = (text: string) =>
    processUtterance(
      normalizeInput(text),
      session,
      deps,
      subject,
      medication,
      ordered,
      calendarPresentation,
      calendar,
      discourse,
      ledger,
    );
  return { db, session, ledger, say };
}

function groceryReadText(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  if (!outcome.handled && outcome.routeDecision.kind === 'device_read') {
    return outcome.routeDecision.response;
  }
  return '';
}

function clockKind(outcome: Awaited<ReturnType<typeof processUtterance>>) {
  if (outcome.handled) return null;
  if (outcome.routeDecision.kind !== 'device_action') return outcome.routeDecision.kind;
  return outcome.routeDecision.actionIntent.type;
}

function committedItems(ledger: ReturnType<typeof createConversationTurnLedger>) {
  const hit = findMostRecentCommittedAdd(ledger.peek(Date.now()));
  return hit ? hit.items.map((i) => i.toLowerCase()) : [];
}

export async function runRecentActionRecallV1Tests() {
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

  console.log(`\n${BOLD}-- Recent Action Recall V1 --------------------------------${RESET}\n`);

  const addPhrasings = [
    'What did I just add?',
    'What did I add?',
    'What did I just put on the list?',
    'What was the last thing I added?',
  ];
  for (const p of addPhrasings) {
    assert(`classifier matches "${p}"`, classifyRecentCommittedAddRecall(p));
  }
  assert('classifier rejects recap', !classifyRecentCommittedAddRecall('What did I just tell you?'));
  assert('classifier rejects tell-you without add', !classifyRecentCommittedAddRecall('What did I tell you?'));
  assert('classifier rejects ask-you without add', !classifyRecentCommittedAddRecall('What did I ask you?'));
  assert('classifier matches ask-to-add commission', classifyRecentCommittedAddRecall('What did I ask you to add?'));
  assert('classifier matches tell-to-add commission', classifyRecentCommittedAddRecall('What did I tell you to add?'));
  assert('classifier matches commissioned want-you-to-add', classifyRecentCommittedAddRecall('What did I want you to add?'));
  assert('classifier rejects commissioned non-add', !classifyRecentCommittedAddRecall('What did I ask you to remind me?'));
  assert('classifier rejects third-person commission', !classifyRecentCommittedAddRecall('What did I tell Jane to add?'));
  assert('classifier rejects list read', !classifyRecentCommittedAddRecall("What's on my grocery list?"));
  assert('classifier rejects generic just-do', !classifyRecentCommittedAddRecall('What did I just do?'));
  assert('recap classifier still matches tell-you', classifyImmediateRecapDeterministic('What did I just tell you?'));

  {
    const { db, ledger, say } = fresh();
    const add = await say('add eggs to my grocery list');
    const recall = await say('What did I just add?');
    assert('single add commits', add.handled === true && add.source === 'capture');
    assert('single sqlite eggs', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs']));
    assert('single recall source', recall.handled === true && recall.source === 'recent_add_recall');
    assert('single recall speech', recall.handled && recall.responseText === 'You added eggs.');
    assert('single ledger items', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk and eggs to my grocery list');
    const recall = await say('What did I just add?');
    assert('multi sqlite milk+eggs', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('multi recall both from one operation', recall.handled === true && recall.responseText === 'You added milk and eggs.');
    assert('multi ledger both items', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk', 'eggs']));
    const recs = ledger.peek(Date.now()).filter((r) => r.outcome === 'committed');
    assert('multi is one committed operation', recs.length === 1 && recs[0]!.focus.filter((f) => f.kind === 'item').length === 2);
  }

  {
    const { db, ledger, say } = fresh();
    const add = await say('add buy stamps to my todo list');
    const recall = await say('What did I just add?');
    assert('todo add commits', add.handled === true && todoBodies(db).includes('buy stamps'));
    assert('todo recall names stamps', recall.handled === true && /buy stamps/i.test(recall.responseText));
    assert('todo ledger item', committedItems(ledger).includes('buy stamps'));
  }

  {
    const { db, session, ledger } = fresh();
    await applyIntents(
      [{ type: 'list_add', items: ['milk'], listName: 'grocery' }],
      'add milk',
      session, undefined, 'deterministic', undefined, ledger,
    );
    const mixed = await applyIntents(
      [{ type: 'list_add', items: ['milk', 'eggs'], listName: 'grocery' }],
      'add milk and eggs',
      session, undefined, 'deterministic', undefined, ledger,
    );
    const recall = await processUtterance(
      normalizeInput('What did I just add?'),
      session,
      {
        classifyQuery: async (t: string) => classifyQuery(t),
        classifyLLM: async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }),
        llmReady: true,
        captureContext: { contacts: [], lists: ['grocery'] },
      },
      null, null, null, null, null, new DiscourseContinuityHolder(), ledger,
    );
    const committed = mixed.commits[0]?.status === 'committed' ? mixed.commits[0].committed ?? [] : [];
    assert('dup+new sqlite milk+eggs', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('dup+new writer committed only eggs', JSON.stringify(committed.map((c) => c.toLowerCase())) === JSON.stringify(['eggs']));
    assert('dup+new recall eggs only', recall.handled === true && recall.responseText === 'You added eggs.');
    assert('dup+new ledger eggs only', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { db, session, ledger } = fresh();
    const failed = await applyIntents(
      [{ type: 'list_add', items: [], listName: 'grocery' }],
      'add',
      session, undefined, 'deterministic', undefined, ledger,
    );
    const recall = await processUtterance(
      normalizeInput('What did I just add?'),
      session,
      {
        classifyQuery: async (t: string) => classifyQuery(t),
        classifyLLM: async () => ({ status: 'ok' as const, intents: [{ type: 'pass' as const }] }),
        llmReady: true,
        captureContext: { contacts: [], lists: ['grocery'] },
      },
      null, null, null, null, null, new DiscourseContinuityHolder(), ledger,
    );
    assert('failed add not committed', failed.commits[0]?.status === 'failed');
    assert('failed add zero rows', groceryBodies(db).length === 0);
    assert('failed add is not recalled', !(recall.handled && recall.source === 'recent_add_recall'));
    assert('failed add ledger has no item evidence', committedItems(ledger).length === 0);
  }

  {
    const { db, session, say } = fresh();
    await say('add those to my grocery list');
    assert('fail-closed pending', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY);
    const cancel = await say('Never mind.');
    const recall = await say('What did I just add?');
    assert('fail-closed cancel clears pending', cancel.handled === true && session.peekPendingKey() === null);
    assert('fail-closed zero rows', groceryBodies(db).length === 0);
    assert('fail-closed never recalled', !(recall.handled && recall.source === 'recent_add_recall'));
  }

  {
    const { db, session, ledger, say } = fresh();
    await say('grab milk and eggs');
    assert('op-list pending', session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY);
    const resume = await say('Grocery list.');
    const recall = await say('What did I just add?');
    assert('op-list resume wrote', resume.handled === true && JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('op-list recall milk and eggs', recall.handled === true && recall.responseText === 'You added milk and eggs.');
    assert('op-list ledger both', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk', 'eggs']));
  }

  {
    const { db, session, ledger, say } = fresh();
    await say('add those to my grocery list');
    assert('item-clarify pending', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY);
    const resume = await say('The roses.');
    const recall = await say('What did I just add?');
    assert('item-clarify wrote roses', resume.handled === true && JSON.stringify(groceryBodies(db)) === JSON.stringify(['roses']));
    assert('item-clarify recall roses', recall.handled === true && recall.responseText === 'You added roses.');
    assert('item-clarify ledger roses', JSON.stringify(committedItems(ledger)) === JSON.stringify(['roses']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const time = await say('What time is it?');
    const recall = await say('What did I just add?');
    assert('time interruption is clock', clockKind(time) === 'time');
    assert('read-only still eggs in sqlite', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs']));
    assert('read-only recall still eggs', recall.handled === true && recall.responseText === 'You added eggs.');
    assert('read-only ledger still eggs', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const timer = await say('set a timer for 5 minutes');
    const recall = await say('What did I just add?');
    assert('unrelated timer not a list write', groceryBodies(db).length === 1);
    assert('unrelated action did not clear add evidence', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
    assert('unrelated action recall still eggs', recall.handled === true && recall.responseText === 'You added eggs.');
    assert('unrelated timer is not recent_add_recall', !(timer.handled && timer.source === 'recent_add_recall'));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const presented = getPresentedOpenListItems('grocery');
    const row = presented.find((i) => /^eggs$/i.test(i.body));
    const removed = row ? markOpenListItemRemovedById(row.id, 'grocery') : null;
    const recall = await say('What did I just add?');
    const listRead = await say("What's on my grocery list?");
    assert('remove applied', removed?.body.toLowerCase() === 'eggs' && groceryBodies(db).length === 0);
    assert('historical recall after remove', recall.handled === true && recall.responseText === 'You added eggs.');
    assert('list read after remove is empty', groceryReadText(listRead) === 'Your grocery list is empty.');
    assert('ledger still has eggs after remove', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { ledger, say } = fresh();
    await say('add eggs to my grocery list');
    await say('add bread to my grocery list');
    const recall = await say('What did I just add?');
    assert('newest add wins', recall.handled === true && recall.responseText === 'You added bread.');
    assert('newest ledger bread', JSON.stringify(committedItems(ledger)) === JSON.stringify(['bread']));
  }

  {
    const { say } = fresh();
    const recall = await say('What did I just add?');
    assert('no qualifying add does not fabricate', !(recall.handled && recall.source === 'recent_add_recall'));
  }

  {
    const { ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const recap = await answerImmediateSemanticRecap('What did I just tell you?', {
      ledgerEntries: ledger.peek(Date.now()),
    });
    const viaProcess = await say('What did I just tell you?');
    assert('recap still handled as recap', recap.handled === true);
    assert('recap does not go through recent_add_recall', !(viaProcess.handled && viaProcess.source === 'recent_add_recall'));
  }

  {
    const { db, say } = fresh();
    await say('add eggs to my grocery list');
    const read = await say("What's on my grocery list?");
    assert('list read remains sqlite device_read', groceryReadText(read).toLowerCase().includes('eggs') && groceryBodies(db).includes('eggs'));
  }

  {
    const { db, ledger, session, say } = fresh();
    await say('grab milk and eggs');
    assert('composition pending', session.peekPendingKey() === CLARIFY_OPERATIONAL_LIST_KEY);
    await say('Grocery list.');
    const recall = await say('What did I just add?');
    const read = await say("What's on my grocery list?");
    assert('composition recall milk and eggs', recall.handled === true && recall.responseText === 'You added milk and eggs.');
    assert('composition sqlite milk+eggs', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('composition list read names both', /milk/i.test(groceryReadText(read)) && /eggs/i.test(groceryReadText(read)));
    assert('composition ledger milk+eggs', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk', 'eggs']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const presented = getPresentedOpenListItems('grocery');
    const row = presented.find((i) => /^eggs$/i.test(i.body));
    if (row) markOpenListItemRemovedById(row.id, 'grocery');
    const recall = await say('What did I just add?');
    const read = await say("What's on my grocery list?");
    assert('composition-remove historical add', recall.handled === true && recall.responseText === 'You added eggs.');
    assert('composition-remove list empty', groceryReadText(read) === 'Your grocery list is empty.' && groceryBodies(db).length === 0);
    assert('composition-remove ledger unchanged', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add eggs to my grocery list');
    let allSame = true;
    for (const p of addPhrasings) {
      const out = await say(p);
      if (!(out.handled && out.source === 'recent_add_recall' && out.responseText === 'You added eggs.')) {
        allSame = false;
      }
    }
    assert('all natural phrasings share the same mechanism', allSame);
    assert('phrasings did not extra-write', groceryBodies(db).length === 1 && JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
  }

  {
    const { db, ledger, say } = fresh();
    const add = await say('add milk and eggs to my grocery list');
    const ask = await say('What did I ask you to add?');
    const tell = await say('What did I tell you to add?');
    const direct = await say('What did I just add?');
    assert('commission grocery committed two items', add.handled === true && JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
    assert('ask-to-add source is recent_add_recall', ask.handled === true && ask.source === 'recent_add_recall');
    assert('ask-to-add names only committed items', ask.handled === true && ask.responseText === 'You added milk and eggs.');
    assert('tell-to-add source is recent_add_recall', tell.handled === true && tell.source === 'recent_add_recall');
    assert('tell-to-add same operation', tell.handled === true && tell.responseText === ask.responseText);
    assert('direct add recall still works after commission forms', direct.handled === true && direct.source === 'recent_add_recall' && direct.responseText === ask.responseText);
    assert('commission grocery ledger both items', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk', 'eggs']));
  }

  {
    const { db, say } = fresh();
    await say('add buy stamps to my todo list');
    const ask = await say('What did I ask you to add?');
    const tell = await say('What did I tell you to add?');
    assert('todo ask-to-add is recent_add_recall', ask.handled === true && ask.source === 'recent_add_recall' && /buy stamps/i.test(ask.responseText));
    assert('todo tell-to-add shares RAR', tell.handled === true && tell.source === 'recent_add_recall' && tell.responseText === ask.responseText);
    assert('todo commission did not extra-write', todoBodies(db).filter((b) => b === 'buy stamps').length === 1);
  }

  {
    const { say } = fresh();
    const ask = await say('What did I ask you to add?');
    assert('commission with no qualifying add does not fabricate', !(ask.handled && ask.source === 'recent_add_recall'));
  }

  {
    const { ledger, say } = fresh();
    await say('add eggs to my grocery list');
    const unrelated = await say('What did I ask you to remind me?');
    const recap = await say('What did I just tell you?');
    const read = await say("What's on my grocery list?");
    const tellAdd = await say('What did I tell you to add?');
    assert('unrelated ask/tell is not recent_add_recall', !(unrelated.handled && unrelated.source === 'recent_add_recall'));
    assert('discourse recap is not recent_add_recall', !(recap.handled && recap.source === 'recent_add_recall'));
    assert('list read is not stolen by commission RAR', groceryReadText(read).toLowerCase().includes('eggs'));
    assert('recap classifier still owns tell-you', classifyImmediateRecapDeterministic('What did I just tell you?'));
    assert('tell-you-to-add is recent_add_recall not ISR', tellAdd.handled === true && tellAdd.source === 'recent_add_recall' && tellAdd.responseText === 'You added eggs.');
  }

  console.log('');
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('recentActionRecall.test');
if (isDirect) {
  runRecentActionRecallV1Tests().then((r) => {
    console.log(`\n${r.failed ? RED : GREEN}${r.passed}/${r.total}${RESET}`);
    process.exit(r.failed ? 1 : 0);
  });
}
