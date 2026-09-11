// scripts/heraldTest/groceryVisualPresentation.test.ts
import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { projectGroceryVisualFromPresentedIds } from '../../src/routing/groceryVisualPresentation.ts';
import { getPresentedOpenListItems } from '../../src/db/listRead.ts';
import { formatGroceryRemovalAck } from '../../src/routing/groceryPositionalMutation.ts';
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
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES ('list_grocery', 'grocery', ?)`).run(new Date().toISOString());
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

export async function runGroceryVisualPresentationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Grocery Visual Support V1 --${RESET}\n`);

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g1','list_grocery','Bananas',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g2','list_grocery','Dates',0,'2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g3','list_grocery','Milk',0,'2026-01-03T00:00:00.000Z')`).run();
    const presented = getPresentedOpenListItems('grocery');
    const rows = projectGroceryVisualFromPresentedIds(presented.map((i) => i.id));
    assert('visual rows follow presented ID order',
      rows?.map((r) => `${r.position}:${r.id}:${r.body}`).join('|'),
      (v) => v === '1:g1:Bananas|2:g2:Dates|3:g3:Milk',
      '1 Bananas, 2 Dates, 3 Milk');
    assert('visual numbering is 1-based contiguous',
      rows?.every((r, i) => r.position === i + 1),
      (v) => v === true, 'true');
  }

  {
    fresh();
    const rows = projectGroceryVisualFromPresentedIds(['missing']);
    assert('stale ID fails closed (no invented row)', rows, (v) => v === null, 'null');
  }

  {
    assert('empty presented IDs project empty visual',
      projectGroceryVisualFromPresentedIds([]),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
  }

  {
    assert('removal ack does not flatten remaining items',
      formatGroceryRemovalAck('Milk', [{ id: 'g1', body: 'Bananas' }]),
      (v) => v === 'Done — Milk is off.' && typeof v === 'string' && !/Bananas/.test(v),
      'Done — Milk is off.');
  }

  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
    assert('ChatScreen renders GroceryListSurface',
      /GroceryListSurface/.test(chatSrc) && /refreshGroceryVisual/.test(chatSrc),
      (v) => v === true, 'surface + refresh');
    const surfaceSrc = fs.readFileSync(path.join(root, 'src/components/GroceryListSurface.tsx'), 'utf8');
    assert('grocery surface file stays independent of TodoListSurface',
      /TodoListSurface/.test(surfaceSrc),
      (v) => v === false, 'false');
    assert('surface keeps GROCERY LIST heading and numbered rows',
      /GROCERY LIST/.test(surfaceSrc) && /row\.position/.test(surfaceSrc) && /countLabel/.test(surfaceSrc),
      (v) => v === true, 'heading + count + numbered rows');
    assert('surface keeps grocery cart cue',
      /\\uD83D\\uDED2/.test(surfaceSrc) || /🛒/.test(surfaceSrc),
      (v) => v === true, 'cart cue');
    assert('ordinal container is single-line and non-shrinking for multi-digit values',
      /numberOfLines=\{1\}/.test(surfaceSrc)
      && /minWidth:\s*28/.test(surfaceSrc)
      && /flexShrink:\s*0/.test(surfaceSrc),
      (v) => v === true, 'badge minWidth + no wrap');
    assert('surface item text stays compact relative to prior oversized rows',
      !/fontSize:\s*24/.test(surfaceSrc) && !/fontSize:\s*28/.test(surfaceSrc),
      (v) => v === true, 'no 24/28 item type');
    const bubbleSrc = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');
    assert('transcript MessageBubble remains',
      /export function MessageBubble/.test(bubbleSrc),
      (v) => v === true, 'present');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}GroceryVisualPresentation: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groceryVisualPresentation.test.ts')) {
  runGroceryVisualPresentationTests().catch(console.error);
}
