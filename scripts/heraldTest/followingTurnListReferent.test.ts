// Following-turn List Referent Mutation V1.
// Historical committed-add evidence → referent resolution → existing list_update / list_remove.
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
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import { findMostRecentCommittedAdd } from '../../src/routing/recentActionRecall.ts';
import { bindFollowingTurnListReferent } from '../../src/routing/followingTurnListReferent.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { CLARIFY_LIST_ADD_ITEM_KEY, UNRESOLVED_LIST_REFERENT_REASON } from '../../src/routing/operationalListContinuity.ts';

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

function mutationIntent(outcome: Awaited<ReturnType<typeof processUtterance>>) {
  if (outcome.handled) return null;
  if (outcome.routeDecision.kind !== 'device_action') return null;
  return outcome.routeDecision.actionIntent;
}

/** Same current-open LIKE match + in-place body update as ChatScreen list_update. */
function applyExistingListUpdate(
  db: Database.Database,
  listName: string,
  oldItem: string,
  newItem: string,
): 'updated' | 'missing' | 'ambiguous' {
  const matches = db.prepare(
    `SELECT li.id, li.body FROM list_items li
     JOIN lists l ON l.id = li.list_id
     WHERE l.name = ? AND li.checked = 0
     AND lower(li.body) LIKE lower(?)`,
  ).all(listName, `%${oldItem}%`) as { id: string; body: string }[];
  if (matches.length === 0) return 'missing';
  if (matches.length > 1) return 'ambiguous';
  db.prepare(`UPDATE list_items SET body = ? WHERE id = ?`).run(newItem, matches[0]!.id);
  return 'updated';
}

/** Same current-open LIKE match + soft-delete as ChatScreen list_remove. */
function applyExistingListRemove(
  db: Database.Database,
  listName: string,
  item: string,
): { removed: string[]; missing: string[]; ambiguous: boolean } {
  const pieces = item
    .split(/\s*,\s*|\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const targets = pieces.length > 0 ? pieces : [item];
  const removed: string[] = [];
  const missing: string[] = [];
  for (const piece of targets) {
    const matches = db.prepare(
      `SELECT li.id, li.body FROM list_items li
       JOIN lists l ON l.id = li.list_id
       WHERE l.name = ? AND li.checked = 0
       AND lower(li.body) LIKE lower(?)`,
    ).all(listName, `%${piece}%`) as { id: string; body: string }[];
    if (matches.length === 0) missing.push(piece);
    else if (matches.length > 1) return { removed, missing, ambiguous: true };
    else {
      db.prepare(`UPDATE list_items SET checked = 1, removed_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        matches[0]!.id,
      );
      removed.push(matches[0]!.body);
    }
  }
  return { removed, missing, ambiguous: false };
}

function committedItems(ledger: ReturnType<typeof createConversationTurnLedger>) {
  const hit = findMostRecentCommittedAdd(ledger.peek(Date.now()));
  return hit ? hit.items.map((i) => i.toLowerCase()) : [];
}

export async function runFollowingTurnListReferentV1Tests() {
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

  console.log(`\n${BOLD}-- Following-turn List Referent Mutation V1 --------------${RESET}\n`);

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    const bound = bindFollowingTurnListReferent(
      normalizeInput('Actually, make that oat milk.'),
      ledger.peek(Date.now()),
    );
    const out = await say('Actually, make that oat milk.');
    const intent = mutationIntent(out);
    const applied = intent?.type === 'list_update'
      ? applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem)
      : 'missing';
    assert('actually-make binder milk→oat milk', bound.kind === 'replace' && bound.oldItem.toLowerCase() === 'milk' && bound.newItem.toLowerCase() === 'oat milk');
    assert('actually-make hands list_update', intent?.type === 'list_update' && intent.oldItem.toLowerCase() === 'milk' && intent.newItem.toLowerCase() === 'oat milk' && intent.listName === 'grocery');
    assert('actually-make current-state update', applied === 'updated' && JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const out = await say('Change that to oat milk.');
    const intent = mutationIntent(out);
    const applied = intent?.type === 'list_update'
      ? applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem)
      : 'missing';
    assert('change-that list_update milk', intent?.type === 'list_update' && intent.oldItem.toLowerCase() === 'milk' && intent.newItem.toLowerCase() === 'oat milk');
    assert('change-that sqlite oat milk', applied === 'updated' && JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const out = await say('Take that off.');
    const intent = mutationIntent(out);
    const applied = intent?.type === 'list_remove'
      ? applyExistingListRemove(db, intent.listName, intent.item)
      : null;
    assert('take-that-off list_remove milk', intent?.type === 'list_remove' && intent.item.toLowerCase() === 'milk' && intent.listName === 'grocery');
    assert('take-that-off soft-delete', !!applied && applied.removed.length === 1 && groceryBodies(db).length === 0);
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const recall = await say('What did I just add?');
    const out = await say('Change that to oat milk.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    assert('rar then replace still recall', recall.handled === true && recall.source === 'recent_add_recall' && recall.responseText === 'You added milk.');
    assert('rar then replace oat milk', intent?.type === 'list_update' && intent.oldItem.toLowerCase() === 'milk' && JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const recall = await say('What did I just add?');
    const out = await say('Take that off.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_remove') applyExistingListRemove(db, intent.listName, intent.item);
    assert('rar then remove still recall', recall.handled === true && recall.responseText === 'You added milk.');
    assert('rar then remove milk gone', intent?.type === 'list_remove' && intent.item.toLowerCase() === 'milk' && groceryBodies(db).length === 0);
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    const time = await say('What time is it?');
    const out = await say('Change that to oat milk.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    assert('readonly interruption is clock', !time.handled && time.routeDecision.kind === 'device_action' && time.routeDecision.actionIntent.type === 'time');
    assert('readonly interruption preserves add evidence', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk']));
    assert('readonly then replace oat milk', intent?.oldItem.toLowerCase() === 'milk' && JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    const timer = await say('set a timer for 5 minutes');
    assert('unrelated timer is not a list write', JSON.stringify(groceryBodies(db)) === JSON.stringify(['milk']));
    assert('unrelated action did not fabricate list referent', !(timer.handled === false && timer.routeDecision.kind === 'device_action' && (timer.routeDecision.actionIntent.type === 'list_update' || timer.routeDecision.actionIntent.type === 'list_remove')));
    assert('unrelated action preserves add evidence', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk']));
    const out = await say('Take that off.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_remove') applyExistingListRemove(db, intent.listName, intent.item);
    assert('unrelated then remove milk', intent?.type === 'list_remove' && intent.item.toLowerCase() === 'milk' && groceryBodies(db).length === 0);
  }

  {
    const { db, say } = fresh();
    await say('add milk and eggs to my grocery list');
    const out = await say('Change that to oat milk.');
    assert('multi-item singular that fail-closed', out.handled === true && mutationIntent(out) === null);
    assert('multi-item singular did not guess', JSON.stringify(groceryBodies(db)) === JSON.stringify(['eggs', 'milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk and eggs to my grocery list');
    const pluralReplace = await say('Change those to oat milk.');
    const pluralRemove = await say('Take those off.');
    const intent = mutationIntent(pluralRemove);
    const applied = intent?.type === 'list_remove'
      ? applyExistingListRemove(db, intent.listName, intent.item)
      : null;
    assert('plural replace fail-closed', pluralReplace.handled === true && mutationIntent(pluralReplace) === null);
    assert('plural remove maps full committed set', intent?.type === 'list_remove' && /milk/i.test(intent.item) && /eggs/i.test(intent.item));
    assert('plural remove existing authority both gone', !!applied && applied.missing.length === 0 && !applied.ambiguous && groceryBodies(db).length === 0);
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    await say('add milk and eggs to my grocery list');
    const out = await say('Change that to oat milk.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    assert('dup+new committed evidence is eggs', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
    assert('dup+new that resolves eggs not milk', intent?.type === 'list_update' && intent.oldItem.toLowerCase() === 'eggs');
    assert('dup+new sqlite milk + oat milk', JSON.stringify(groceryBodies(db)) === JSON.stringify(['milk', 'oat milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const firstRemove = await say('Take that off.');
    const firstIntent = mutationIntent(firstRemove);
    if (firstIntent?.type === 'list_remove') applyExistingListRemove(db, firstIntent.listName, firstIntent.item);
    const replace = await say('Change that to oat milk.');
    const replaceIntent = mutationIntent(replace);
    const applied = replaceIntent?.type === 'list_update'
      ? applyExistingListUpdate(db, replaceIntent.listName, replaceIntent.oldItem, replaceIntent.newItem)
      : 'missing';
    assert('stale replace still hands historical milk', replaceIntent?.type === 'list_update' && replaceIntent.oldItem.toLowerCase() === 'milk');
    assert('stale replace does not resurrect', applied === 'missing' && groceryBodies(db).length === 0 && !groceryBodies(db).includes('oat milk'));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const first = await say('Take that off.');
    const firstIntent = mutationIntent(first);
    if (firstIntent?.type === 'list_remove') applyExistingListRemove(db, firstIntent.listName, firstIntent.item);
    const second = await say('Take that off.');
    const secondIntent = mutationIntent(second);
    const applied = secondIntent?.type === 'list_remove'
      ? applyExistingListRemove(db, secondIntent.listName, secondIntent.item)
      : null;
    assert('second remove still hands milk', secondIntent?.type === 'list_remove' && secondIntent.item.toLowerCase() === 'milk');
    assert('second remove existing absence', !!applied && applied.removed.length === 0 && applied.missing.includes('milk') && groceryBodies(db).length === 0);
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    await say('add eggs to my grocery list');
    const out = await say('Change that to oat milk.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    assert('newest qualifying add is eggs', JSON.stringify(committedItems(ledger)) === JSON.stringify(['eggs']));
    assert('newest add replace eggs', intent?.oldItem.toLowerCase() === 'eggs' && JSON.stringify(groceryBodies(db)) === JSON.stringify(['milk', 'oat milk']));
  }

  {
    const { db, say } = fresh();
    const out = await say('Change that to oat milk.');
    assert('no qualifying add fail-closed', out.handled === true && mutationIntent(out) === null);
    assert('no qualifying add no fabricated row', groceryBodies(db).length === 0);
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const out = await say('Change milk to oat milk');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    assert('explicit named update unchanged', intent?.type === 'list_update' && intent.oldItem.toLowerCase() === 'milk' && intent.newItem.toLowerCase() === 'oat milk');
    assert('explicit named update sqlite', JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const out = await say('Remove milk from my grocery list.');
    const intent = mutationIntent(out);
    if (intent?.type === 'list_remove') applyExistingListRemove(db, intent.listName, intent.item);
    assert('explicit named remove unchanged', intent?.type === 'list_remove' && intent.item.toLowerCase() === 'milk');
    assert('explicit named remove sqlite', groceryBodies(db).length === 0);
  }

  {
    const { db, session, say } = fresh();
    await say('add milk to my grocery list');
    const rwi = await say('add those to my grocery list');
    const those = await classifyQuery(normalizeInput('Add those to my grocery list'));
    const them = await classifyQuery(normalizeInput('Add them to my grocery list'));
    const it = await classifyQuery(normalizeInput('Add it to my grocery list'));
    const that = await classifyQuery(normalizeInput('Add that to my grocery list'));
    assert('rwi add those still pending', session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY);
    assert('rwi add those not a mutation', mutationIntent(rwi) === null);
    assert(
      'rwi add those/them/it/that still unresolved class',
      those.reason === UNRESOLVED_LIST_REFERENT_REASON
        && them.reason === UNRESOLVED_LIST_REFERENT_REASON
        && it.reason === UNRESOLVED_LIST_REFERENT_REASON
        && that.reason === UNRESOLVED_LIST_REFERENT_REASON,
    );
    assert('rwi add those zero extra write', JSON.stringify(groceryBodies(db)) === JSON.stringify(['milk']));
  }

  {
    const { db, session, say } = fresh();
    await say('add milk to my grocery list');
    const headless = await say('Actually, make that some.');
    const quantity = await say('add some to my grocery list');
    assert('headless make that some fail-closed', headless.handled === true && mutationIntent(headless) === null);
    assert(
      'indefinite quantity still unresolved add',
      quantity.handled === false
        && quantity.routeDecision.kind === 'device_read'
        && quantity.routeDecision.reason === UNRESOLVED_LIST_REFERENT_REASON
        && session.peekPendingKey() === CLARIFY_LIST_ADD_ITEM_KEY,
    );
    assert('quantity/RWI replacement did not write some', JSON.stringify(groceryBodies(db)) === JSON.stringify(['milk']));
  }

  {
    const d = await classifyQuery('add milk to my grocery list actually make that oat milk');
    assert(
      'susr same-utterance still resolved add',
      d.actionIntent?.type === 'list_add' && JSON.stringify((d.actionIntent as { items?: string[] }).items?.map((i) => i.toLowerCase())) === JSON.stringify(['oat milk']),
    );
    assert(
      'susr unresolved replacement reason unchanged',
      (await classifyQuery('add milk to my grocery list actually that')).reason === UNRESOLVED_LIST_REFERENT_REASON,
    );
  }

  {
    const { db, ledger, say } = fresh();
    await say('add milk to my grocery list');
    const recall = await say('What did I just add?');
    const replace = await say('Actually, make that oat milk.');
    const intent = mutationIntent(replace);
    if (intent?.type === 'list_update') applyExistingListUpdate(db, intent.listName, intent.oldItem, intent.newItem);
    const read = await say("What's on my grocery list?");
    assert('product rar then replace recall milk', recall.handled === true && recall.responseText === 'You added milk.');
    assert('product replace oat milk sqlite', JSON.stringify(groceryBodies(db)) === JSON.stringify(['oat milk']));
    assert('product final read oat milk not milk', /oat milk/i.test(groceryReadText(read)) && !/\bmilk\b/i.test(groceryReadText(read).replace(/oat milk/ig, '')));
    assert('product ledger still historical milk', JSON.stringify(committedItems(ledger)) === JSON.stringify(['milk']));
  }

  {
    const { db, say } = fresh();
    await say('add milk to my grocery list');
    const remove = await say('Take that off.');
    const intent = mutationIntent(remove);
    if (intent?.type === 'list_remove') applyExistingListRemove(db, intent.listName, intent.item);
    const read = await say("What's on my grocery list?");
    assert('product remove milk absent sqlite', groceryBodies(db).length === 0);
    assert('product final read empty', groceryReadText(read) === 'Your grocery list is empty.');
  }

  console.log('');
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = typeof process !== 'undefined' && process.argv[1] && process.argv[1].includes('followingTurnListReferent.test');
if (isDirect) {
  runFollowingTurnListReferentV1Tests().then((r) => {
    console.log(`\n${r.failed ? RED : GREEN}${r.passed}/${r.total}${RESET}`);
    if (r.failed) process.exit(1);
  });
}
