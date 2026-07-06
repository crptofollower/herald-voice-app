// scripts/heraldTest/todoComplete.test.ts
// Todo-complete contract tests (S-DISCLOSE build arc, step 4b).
// Confirms authority lives in todo_add.remove() — dispatch only arms the
// primitive-governed pending after fuzzy match resolution.
//
// Runner: npx tsx scripts/heraldTest/todoComplete.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    body TEXT NOT NULL,
    checked INTEGER DEFAULT 0,
    removed_at TEXT,
    created_at TEXT NOT NULL
  );
`;

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function freshDB(opts: { body?: string; checked?: number } = {}) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES (?, ?, ?)`).run('list_todos', 'todos', now);
  if (opts.body !== undefined) {
    db.prepare(
      `INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('todo_1', 'list_todos', opts.body, opts.checked ?? 0, now);
  }
  return db;
}

function isChecked(db: Database.Database, id = 'todo_1'): boolean {
  const row = db.prepare(`SELECT checked FROM list_items WHERE id = ?`).get(id) as { checked: number } | undefined;
  return row?.checked === 1;
}

async function armFromRemove(
  session: ConversationSession,
  itemId = 'todo_1',
): Promise<Extract<CommitResult, { status: 'pending' }>> {
  const result = await DOMAIN_WRITERS['todo_add']!.remove(itemId);
  if (result.status !== 'pending') throw new Error(`expected pending, got ${result.status}`);
  session.setPending({ pendingKey: result.pendingKey, resume: result.resume, kind: result.kind });
  return result;
}

export async function runTodoCompleteTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Todo-Complete Contract Tests ---------------------------${RESET}\n`);

  // ── T1: happy path YES commits ────────────────────────────────────────────
  {
    const db = freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    const result = await session.resolvePending('yes');
    assert('T1 arm → yes → committed; item checked off', { result, checked: isChecked(db) },
      v => v.result.status === 'committed' && /crossed off/i.test(v.result.ack) && v.checked === true,
      'committed, checked=1');
  }

  // ── T2: NO releases without commit ────────────────────────────────────────
  {
    const db = freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    const result = await session.resolvePending('no');
    assert('T2 arm → no → noop with leave-on-list ack; item still open',
      { ack: result.status === 'noop' ? result.ack : '', checked: isChecked(db), pending: session.hasPending() },
      v => /leaving/i.test(v.ack) && v.checked === false && v.pending === false,
      'leave-on-list, still open, released');
  }

  // ── T3: cancel vocabulary works ───────────────────────────────────────────
  {
    const db = freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    const result = await session.resolvePending('never mind');
    assert('T3 arm → never mind → CANCEL_RE; item still open',
      { pending: session.hasPending(), checked: isChecked(db), ack: result.status === 'noop' ? result.ack : '' },
      v => v.pending === false && v.checked === false && typeof v.ack === 'string' && v.ack.length > 0,
      'cancel ack, still open');
  }

  // ── T4: non-yes/no re-asks (Graceful Confusion), does not fall through ────
  {
    freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    const result = await session.resolvePending('what time is it');
    assert('T4 ambiguous reply stays pending with re-ask — never leaks to fresh routing',
      { pending: session.hasPending(), prompt: result.status === 'pending' ? result.prompt : '', status: result.status },
      v => v.pending === true && v.status === 'pending' && typeof v.prompt === 'string' && v.prompt.length > 0,
      'still pending, re-ask prompt');
  }

  // ── T5: budget exhausted releases gracefully ──────────────────────────────
  {
    freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    await session.resolvePending('purple');
    const result = await session.resolvePending('banana');
    assert('T5 budget exhausted → standard release, item still open',
      { pending: session.hasPending(), ack: result.status === 'noop' ? result.ack : '' },
      v => v.pending === false && /come back to that/i.test(v.ack),
      'released with honest-release copy');
  }

  // ── T6: item-not-found noop ───────────────────────────────────────────────
  {
    freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    const result = await DOMAIN_WRITERS['todo_add']!.remove('missing_id');
    assert('T6 unknown id → noop; nothing armed',
      { result, armed: session.hasPending() },
      v => v.result.status === 'noop' && /don't have that on your list/i.test(v.result.ack) && v.armed === false,
      'noop ack, not armed');
  }

  // ── T7: already-checked noop ──────────────────────────────────────────────
  {
    freshDB({ body: 'buy milk', checked: 1 });
    const session = new ConversationSession();
    const result = await DOMAIN_WRITERS['todo_add']!.remove('todo_1');
    assert('T7 already-checked item → noop; nothing armed',
      { result, armed: session.hasPending() },
      v => v.result.status === 'noop' && /don't have that on your list/i.test(v.result.ack) && v.armed === false,
      'noop ack, not armed');
  }

  // ── T8: narrow vocabulary — "ok"/"sure" do NOT commit ───────────────────
  {
    const db = freshDB({ body: 'buy milk' });
    const session = new ConversationSession();
    await armFromRemove(session);
    const result = await session.resolvePending('ok');
    assert('T8 "ok" does not commit — narrow CONFIRM_YES_RE; item stays open',
      { status: result.status, checked: isChecked(db), pending: session.hasPending() },
      v => v.status !== 'committed' && v.checked === false && v.pending === true,
      'not committed, still pending after ok');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Todo-Complete: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('todoComplete.test.ts')) {
  runTodoCompleteTests().catch(console.error);
}
