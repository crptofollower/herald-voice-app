// Everyday Capability Surfaces V1 — Stage 2 To-do locks.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { getPresentedOpenListItems } from '../../src/db/listRead.ts';
import { completeOpenTodoItemByExactId } from '../../src/routing/todoAuthoritativeCompletion.ts';
import {
  mergeTodoSurfaceRows,
  overlayTodoAfterSuccessfulOpenDepartures,
  projectTodoOpenRowsFromSqlite,
  todoOutcomeIdentifiesSurface,
} from '../../src/routing/todoSurfacePresentation.ts';
import {
  overlayAfterSuccessfulOpenDepartures,
} from '../../src/routing/grocerySurfacePresentation.ts';
import type { UtteranceOutcome } from '../../src/routing/processUtterance.ts';

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

export async function runEverydayTodoCapabilitySurfaceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Everyday Capability Surfaces V1 (Stage 2 To-do) --${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const todoSurfaceSrc = fs.readFileSync(path.join(root, 'src/components/TodoSurface.tsx'), 'utf8');
  const grocerySurfaceSrc = fs.readFileSync(path.join(root, 'src/components/GrocerySurface.tsx'), 'utf8');
  const rowSrc = fs.readFileSync(path.join(root, 'src/components/CapabilityListRow.tsx'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(root, 'src/routing/todoSurfacePresentation.ts'), 'utf8');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
  const writerSrc = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');
  const listReadSrc = fs.readFileSync(path.join(root, 'src/db/listRead.ts'), 'utf8');
  const completionSrc = fs.readFileSync(path.join(root, 'src/routing/todoAuthoritativeCompletion.ts'), 'utf8');
  const groceryCompletionSrc = fs.readFileSync(path.join(root, 'src/routing/groceryAuthoritativeCompletion.ts'), 'utf8');

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t1','list_todos','Call dentist',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t2','list_todos','mail package, stamps mashed together',0,'2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t3','list_todos','Already done',1,'2026-01-03T00:00:00.000Z')`).run();
    const open = projectTodoOpenRowsFromSqlite();
    assert('todo projection uses list identity todos and open rows only',
      open.map((r) => `${r.id}:${r.body}`).join('|'),
      (v) => v === 't1:Call dentist|t2:mail package, stamps mashed together',
      't1,t2; checked excluded');
    assert('stored task body is rendered faithfully',
      open[1]?.body,
      (v) => v === 'mail package, stamps mashed together',
      'exact stored body');
    assert('completed IDs are not treated as open items',
      getPresentedOpenListItems('todos').map((i) => i.id).includes('t3'),
      (v) => v === false, 'false');
  }

  {
    const todoRead: UtteranceOutcome = {
      handled: false,
      routeDecision: {
        kind: 'device_read',
        tier: 1,
        response: "You've got 2 open: Call dentist, Mail package.",
        reason: 'action:todo_read',
        presentedTodoIds: ['t1', 't2'],
      },
      continuationRecoveryCandidates: [],
    };
    const chitChat: UtteranceOutcome = {
      handled: false,
      routeDecision: { kind: 'backend', tier: 3, reason: 'chit_chat' },
      continuationRecoveryCandidates: [],
    };
    assert('To-do surface activates from structured todo read outcome',
      todoOutcomeIdentifiesSurface(todoRead), (v) => v === true, 'true');
    assert('ordinary chit-chat does not identify To-do surface',
      todoOutcomeIdentifiesSurface(chitChat), (v) => v === false, 'false');
    assert('no speech-text activation heuristic for To-do',
      todoOutcomeIdentifiesSurface({
        handled: true,
        source: 'referent_resume',
        responseText: "You've got 2 open: Call dentist, Mail package.",
        commits: [],
      }),
      (v) => v === false, 'false');
    assert('structured capabilitySurface todo hint identifies the surface',
      todoOutcomeIdentifiesSurface({
        handled: true,
        source: 'pending_resume',
        responseText: "Done — crossed off 'Call dentist'.",
        commits: [],
        capabilitySurface: 'todo',
      }),
      (v) => v === true, 'true');
    assert('pending confirmation commit identifies surface without striking via overlay helper',
      todoOutcomeIdentifiesSurface({
        handled: true,
        source: 'capture',
        responseText: "Just to make sure — you're saying you've completed 'Call dentist'?",
        commits: [{
          status: 'pending',
          kind: 'standard',
          prompt: "Just to make sure",
          pendingKey: 'todo_complete',
          resume: async () => ({ status: 'noop', ack: '' }),
        }],
        capabilitySurface: 'todo',
      }),
      (v) => v === true, 'true');
  }

  {
    const previousOpen = [{ id: 't1', body: 'Call dentist' }, { id: 't2', body: 'Mail package' }];
    assert('pending confirmation does not strike (no open-set departure)',
      overlayTodoAfterSuccessfulOpenDepartures(previousOpen, previousOpen, []),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
    assert('rejected confirmation does not strike (open set unchanged)',
      overlayTodoAfterSuccessfulOpenDepartures(previousOpen, previousOpen, []),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
    const afterYes = overlayTodoAfterSuccessfulOpenDepartures(
      previousOpen,
      [{ id: 't2', body: 'Mail package' }],
      [],
    );
    assert('successful confirmed completion does strike via overlay',
      afterYes,
      (v) => Array.isArray(v) && (v as { id: string }[]).length === 1 && (v as { id: string }[])[0].id === 't1',
      't1 overlayed');
    const merged = mergeTodoSurfaceRows(
      [{ id: 't2', body: 'Mail package' }],
      afterYes,
      ['t1', 't2'],
    );
    assert('completed overlay is presentation-only and not an open row',
      merged.rows.map((r) => `${r.id}:${r.status}`).join('|'),
      (v) => v === 't1:completed|t2:open',
      't1 completed, t2 open');
    assert('overlay helper is the same Stage 1 departure function',
      overlayTodoAfterSuccessfulOpenDepartures === overlayAfterSuccessfulOpenDepartures,
      (v) => v === true, 'true');
  }

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t1','list_todos','Call dentist',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('t2','list_todos','mail package',0,'2026-01-02T00:00:00.000Z')`).run();
    const openBefore = projectTodoOpenRowsFromSqlite();
    const failed = completeOpenTodoItemByExactId('missing');
    assert('failed exact-id tap does not write', failed.ok, (v) => v === false, 'false');
    assert('failed write does not strike or leave the open set',
      projectTodoOpenRowsFromSqlite().map((r) => r.id).join(','),
      (v) => v === 't1,t2', 't1,t2');
    const overlayUnchanged = overlayTodoAfterSuccessfulOpenDepartures(openBefore, projectTodoOpenRowsFromSqlite(), []);
    assert('failed write produces no completed overlay',
      overlayUnchanged.length, (v) => v === 0, '0');
    const ok = completeOpenTodoItemByExactId('t1');
    assert('exact-id tap commits via markOpenListItemRemovedById todos',
      ok.ok && ok.ok && ok.removed.id === 't1', (v) => v === true, 'true');
    assert('successful tap removes id from open reader',
      getPresentedOpenListItems('todos').map((i) => i.id).join(','),
      (v) => v === 't2', 't2');
    const overlay = overlayTodoAfterSuccessfulOpenDepartures(
      openBefore,
      projectTodoOpenRowsFromSqlite(),
      [],
    );
    const mergedTap = mergeTodoSurfaceRows(projectTodoOpenRowsFromSqlite(), overlay, openBefore.map((r) => r.id));
    assert('successful tap overlay strikes the completed row',
      mergedTap.rows.map((r) => `${r.id}:${r.status}`).join('|'),
      (v) => v === 't1:completed|t2:open',
      't1 completed, t2 open');
    const dbRow = db.prepare(`SELECT checked, removed_at FROM list_items WHERE id = 't1'`).get() as { checked: number; removed_at: string | null };
    assert('successful tap sets checked and removed_at',
      dbRow.checked === 1 && !!dbRow.removed_at, (v) => v === true, 'true');
  }

  assert('schema version unchanged (no todo overlay table)',
    SCHEMA_VERSION, (v) => v === 24, '24');
  assert('schema has no Stage-2 list_items migration',
    /SCHEMA_VERSION = 24/.test(schemaSrc) && !/CREATE TABLE todo_overlay/.test(schemaSrc),
    (v) => v === true, 'true');
  assert('open-item reader still excludes checked rows',
    /checked = 0/.test(listReadSrc) && /getPresentedOpenListItems\('todos'\)/.test(overlaySrc),
    (v) => v === true, 'true');
  assert('activation does not parse spoken todo ack text',
    /isTodoOpenListSpeech/.test(overlaySrc) || /Done —/.test(overlaySrc) || /You've got/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('processUtterance sets structured todo capabilitySurface hint',
    /capabilitySurface: 'todo'/.test(processSrc)
    && /todoHandled/.test(processSrc)
    && /pendingKey === 'todo_complete'/.test(processSrc),
    (v) => v === true, 'true');
  assert('existing To-do confirmation mechanism remains unchanged',
    /pendingKey: 'todo_complete'/.test(writerSrc)
    && /Just to make sure — you're saying you've completed/.test(writerSrc)
    && /UPDATE list_items SET checked = 1, removed_at = \? WHERE id = \?/.test(writerSrc)
    && /Got it — leaving '\$\{body\}' on your list/.test(writerSrc)
    && /DOMAIN_WRITERS\.todo_add!\.remove\(bestMatch\.id\)/.test(writerSrc),
    (v) => v === true, 'true');
  assert('ChatScreen exact-ID tap uses todos helper, not the voice confirm writer',
    /completeOpenTodoItemByExactId\(id/.test(chatSrc)
    && /onCompleteOpenRow=\{handleTodoCompleteOpenRow\}/.test(chatSrc)
    && /markOpenListItemRemovedById\(id, 'todos'\)/.test(completionSrc)
    && !/setPending/.test(completionSrc),
    (v) => v === true, 'true');
  assert('open To-do rows are tappable; completed rows are not',
    /onPressOpen=/.test(todoSurfaceSrc)
    && /row\.status === 'open' && onCompleteOpenRow/.test(todoSurfaceSrc)
    && /if \(completed \|\| !onPressOpen\)/.test(rowSrc),
    (v) => v === true, 'true');
  assert('tap helper does not arm confirmation',
    !/setPending/.test(completionSrc) && !/pendingKey/.test(completionSrc),
    (v) => v === true, 'true');
  assert('Grocery exact-ID helper remains grocery-only',
    /markOpenListItemRemovedById\(id, 'grocery'\)/.test(groceryCompletionSrc)
    && !/markOpenListItemRemovedById\(id, 'todos'\)/.test(groceryCompletionSrc),
    (v) => v === true, 'true');
  assert('To-do reuses one activeSurface slot with grocery workspace chrome',
    /kind: 'todo'/.test(chatSrc)
    && /kind: 'grocery'/.test(chatSrc)
    && /kind: 'weather'/.test(chatSrc)
    && /activeSurface\?\.kind === 'grocery'[\s\S]*kind === 'todo'[\s\S]*kind === 'schedule'/.test(chatSrc)
    && /groceryWorkspaceSurface/.test(chatSrc)
    && /refreshTodoCapabilitySurface/.test(chatSrc)
    && /refreshGroceryCapabilitySurface/.test(chatSrc),
    (v) => v === true, 'true');
  assert('To-do persists across ordinary chit-chat (sendMessage clears weather only)',
    /latLog\('sendMessage entry'[\s\S]*?setActiveSurface\(\(prev\) => \(prev\?\.kind === 'weather' \? null : prev\)\)/.test(chatSrc)
    && /todoOutcomeIdentifiesSurface/.test(chatSrc),
    (v) => v === true, 'true');
  assert('Grocery/Weather/To-do are mutually exclusive visual workspaces',
    /activeSurface\?\.kind === 'weather'/.test(chatSrc)
    && /activeSurface\?\.kind === 'grocery' \?/.test(chatSrc)
    && /activeSurface\?\.kind === 'todo' \?/.test(chatSrc)
    && /activeSurface\?\.kind === 'schedule' \?/.test(chatSrc)
    && !/todoVisualRows/.test(chatSrc)
    && !/TodoListSurface/.test(chatSrc),
    (v) => v === true, 'true');
  assert('To-do surface has no visual row numbers',
    /row\.position/.test(todoSurfaceSrc) || /\{index \+ 1\}/.test(todoSurfaceSrc),
    (v) => v === false, 'false');
  assert('overlay module cannot write (presentation only)',
    /markOpenListItemRemovedById/.test(overlaySrc) || /runSync/.test(overlaySrc) || /UPDATE list_items/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('Grocery Stage 1 tap-to-complete behavior remains unchanged',
    /onCompleteOpenRow=\{handleGroceryCompleteOpenRow\}/.test(chatSrc)
    && /completeOpenGroceryItemByExactId\(id/.test(chatSrc)
    && /row\.status === 'open' && onCompleteOpenRow/.test(grocerySurfaceSrc),
    (v) => v === true, 'true');
  assert('To-do visual lifetime is not DiscourseContinuityHolder or OPR TTL',
    /refreshTodoCapabilitySurface/.test(chatSrc)
    && !/discourseRef\.current\.peek[\s\S]{0,80}kind: 'todo'/.test(chatSrc)
    && !/todoPresentationRef\.current\.peek\(\)[\s\S]{0,120}kind: 'todo'/.test(chatSrc),
    (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EverydayTodoCapabilitySurface: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('everydayTodoCapabilitySurface.test.ts')) {
  runEverydayTodoCapabilitySurfaceTests().catch(console.error);
}
