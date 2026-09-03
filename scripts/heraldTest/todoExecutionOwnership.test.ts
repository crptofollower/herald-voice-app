// Shared-runtime todo capture → read → complete → confirm → reread.
// Also pins ChatScreen dispatch no longer owning todo_read / todo_complete.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
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

function rows(db: Database.Database) {
  return db.prepare(
    `SELECT li.id, li.body, li.checked, li.removed_at
     FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'todos' ORDER BY li.created_at`,
  ).all() as Array<{ id: string; body: string; checked: number; removed_at: string | null }>;
}

export async function runTodoExecutionOwnershipTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Todo execution ownership (shared runtime) --------------${RESET}\n`);

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dispatchSrc = fs.readFileSync(path.join(root, 'src/screens/chat/dispatch.ts'), 'utf8');
  assert(
    'dispatch.ts has no todo_read execution block',
    /actionIntent\.type === 'todo_read'/.test(dispatchSrc),
    (v) => v === false,
    'false',
  );
  assert(
    'dispatch.ts has no todo_complete matching/execution block',
    /actionIntent\.type === 'todo_complete'/.test(dispatchSrc) || /bestScore/.test(dispatchSrc),
    (v) => v === false,
    'false',
  );

  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [] as string[], lists: [] as string[] },
  };

  const capture = await processUtterance('I need to call the dentist.', session, deps);
  const afterCapture = rows(db);
  assert('capture handled', capture.handled === true && capture.source === 'capture', (v) => v === true, 'capture');
  assert('one open dentist item', afterCapture.length === 1 && /call the dentist/i.test(afterCapture[0].body) && afterCapture[0].checked === 0, (v) => v === true, 'one open');
  const captureId = afterCapture[0]?.id;

  const read1 = await processUtterance('What do I need to do?', session, deps);
  assert(
    'todo_read is device_read action:todo_read',
    !read1.handled && read1.routeDecision.kind === 'device_read'
      && read1.routeDecision.reason === 'action:todo_read'
      && /call the dentist/.test(read1.routeDecision.kind === 'device_read' ? read1.routeDecision.response : ''),
    (v) => v === true,
    'device_read action:todo_read with dentist',
  );

  const complete = await processUtterance('I called the dentist.', session, deps);
  const afterMatch = rows(db);
  assert(
    'complete pending todo_complete, no mutation',
    complete.handled === true && complete.source === 'capture'
      && session.peekPendingKey() === 'todo_complete'
      && afterMatch[0]?.checked === 0 && !afterMatch[0]?.removed_at,
    (v) => v === true,
    'pending, still open',
  );

  const yes = await processUtterance('Yes', session, deps);
  const afterYes = rows(db);
  assert(
    'Yes completes same durable id',
    yes.handled === true && yes.source === 'pending_resume'
      && afterYes.length === 1 && afterYes[0].id === captureId
      && afterYes[0].checked === 1 && !!afterYes[0].removed_at
      && !session.hasPending(),
    (v) => v === true,
    'same id checked+removed_at',
  );

  const read2 = await processUtterance('What do I need to do?', session, deps);
  assert(
    'reread excludes completed item',
    !read2.handled && read2.routeDecision.kind === 'device_read'
      && read2.routeDecision.reason === 'action:todo_read'
      && read2.routeDecision.kind === 'device_read'
      && read2.routeDecision.response === `You're all clear — nothing on your to-do list.`,
    (v) => v === true,
    'empty todo_read speech',
  );

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`${RED}❌ todoExecutionOwnership: ${failures.length} failed${RESET}`);
  } else {
    console.log(`${GREEN}✅ todoExecutionOwnership: ${passed}/${total} passed${RESET}`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('todoExecutionOwnership.test.ts')) {
  runTodoExecutionOwnershipTests().then((r) => process.exit(r.failed ? 1 : 0));
}
