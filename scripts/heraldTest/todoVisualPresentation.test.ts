// scripts/heraldTest/todoVisualPresentation.test.ts
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { getPresentedOpenListItems, composeTodoOpenSpeech, isTodoOpenListSpeech } from '../../src/db/listRead.ts';
import {
  projectTodoVisualFromPresentedIds,
  TodoPresentationHolder,
} from '../../src/routing/todoVisualPresentation.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE list_items (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
      checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES ('list_todos', 'todos', ?)`).run(new Date().toISOString());
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

export async function runTodoVisualPresentationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Todo Visual Support V1 --${RESET}\n`);

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t1','list_todos','Call dentist',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t2','list_todos','Mail package',0,'2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t3','list_todos','Buy stamps',0,'2026-01-03T00:00:00.000Z')`).run();
    const presented = getPresentedOpenListItems('todos');
    const rows = projectTodoVisualFromPresentedIds(presented.map((i) => i.id));
    assert('visual rows follow authoritative presented ID order',
      rows.map((r) => `${r.id}:${r.body}`).join('|'),
      (v) => v === 't1:Call dentist|t2:Mail package|t3:Buy stamps',
      't1 Call dentist, t2 Mail package, t3 Buy stamps');
    assert('visual rows have no grocery-style position field',
      rows.every((r) => !('position' in r)),
      (v) => v === true, 'true');
  }

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t1','list_todos','Call dentist',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t2','list_todos','Mail package',0,'2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t3','list_todos','Buy stamps',0,'2026-01-03T00:00:00.000Z')`).run();
    const ids = getPresentedOpenListItems('todos').map((i) => i.id);
    db.prepare(`UPDATE list_items SET checked = 1, removed_at = ? WHERE id = 't2'`).run(new Date().toISOString());
    const rows = projectTodoVisualFromPresentedIds(ids);
    assert('completed/removed todo is dropped from refreshed open visual',
      rows.map((r) => r.id).join(','),
      (v) => v === 't1,t3', 't1,t3');
  }

  {
    fresh();
    const rows = projectTodoVisualFromPresentedIds(['missing']);
    assert('stale ID is skipped without inventing a row',
      rows, (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
  }

  {
    assert('empty presented IDs project empty visual',
      projectTodoVisualFromPresentedIds([]),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
  }

  {
    const holder = new TodoPresentationHolder();
    holder.establish(['t1', 't2']);
    assert('holder peeks established IDs',
      holder.peek()?.join(','), (v) => v === 't1,t2', 't1,t2');
    holder.clear();
    assert('holder clear drops live grant',
      holder.peek(), (v) => v === null, 'null');
  }

  {
    const items = [
      { id: 't1', body: 'Call dentist' },
      { id: 't2', body: 'Mail package' },
    ];
    const speech = composeTodoOpenSpeech(items);
    assert('open-list speech remains the concise authoritative summary',
      speech, (v) => v === "You've got 2 open: Call dentist, Mail package.",
      "You've got 2 open: Call dentist, Mail package.");
    assert('todo card hide helper matches that summary',
      isTodoOpenListSpeech(speech), (v) => v === true, 'true');
    assert('empty todo speech is not treated as a live-card dump',
      isTodoOpenListSpeech(composeTodoOpenSpeech([])), (v) => v === false, 'false');
  }

  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
    const surfaceSrc = fs.readFileSync(path.join(root, 'src/components/TodoSurface.tsx'), 'utf8');
    const modelSrc = fs.readFileSync(path.join(root, 'src/routing/todoVisualPresentation.ts'), 'utf8');
    const routeSrc = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8');
    assert('ChatScreen renders TodoSurface on the shared slot',
      /TodoSurface/.test(chatSrc) && /refreshTodoCapabilitySurface/.test(chatSrc),
      (v) => v === true, 'surface + refresh');
    assert('ChatScreen projects todo rows via presentation helper, not a second writer',
      /projectTodoOpenRowsFromSqlite/.test(chatSrc)
      && !/TodoListSurface/.test(chatSrc)
      && !/refreshTodoVisual/.test(chatSrc),
      (v) => v === true, 'open projection helper');
    assert('surface heading, clipboard cue, and item count',
      /TO-DO/.test(surfaceSrc)
      && (/\\uD83D\\uDCCB/.test(surfaceSrc) || /📋/.test(surfaceSrc))
      && /countLabel/.test(surfaceSrc),
      (v) => v === true, 'TO-DO + cue + count');
    assert('surface has no grocery ordinal badges',
      !/row\.position/.test(surfaceSrc) && !/minWidth:\s*28/.test(surfaceSrc),
      (v) => v === true, 'no ordinals');
    assert('todo visual model reads open todos by id only',
      /getOpenListItemById\(id, 'todos'\)/.test(modelSrc)
      && !/CREATE TABLE/.test(modelSrc)
      && !/INSERT INTO list_items/.test(modelSrc),
      (v) => v === true, 'reader only');
    assert('todo_read device_read carries presentedTodoIds from the same reader',
      /presentedTodoIds: items\.map\(\(i\) => i\.id\)/.test(routeSrc)
      && /getPresentedOpenListItems\('todos'\)/.test(routeSrc),
      (v) => v === true, 'same IDs as speech');
    assert('surface item text stays compact',
      !/fontSize:\s*24/.test(surfaceSrc) && !/fontSize:\s*28/.test(surfaceSrc),
      (v) => v === true, 'no 24/28 item type');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TodoVisualPresentation: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('todoVisualPresentation.test.ts')) {
  runTodoVisualPresentationTests().catch(console.error);
}
