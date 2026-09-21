// Everyday Capability Surfaces V1 — Stage 1 locks.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { getPresentedOpenListItems } from '../../src/db/listRead.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { completeOpenGroceryItemByExactId } from '../../src/routing/groceryAuthoritativeCompletion.ts';
import {
  groceryOutcomeIdentifiesSurface,
  mergeGrocerySurfaceRows,
  overlayAfterSuccessfulOpenDepartures,
  projectGroceryOpenRowsFromSqlite,
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
  db.prepare(`INSERT INTO lists (id, name, created_at) VALUES ('list_grocery', 'grocery', ?)`).run(new Date().toISOString());
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

export async function runEverydayCapabilitySurfacesV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Everyday Capability Surfaces V1 (Stage 1) --${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const grocerySurfaceSrc = fs.readFileSync(path.join(root, 'src/components/GrocerySurface.tsx'), 'utf8');
  const rowSrc = fs.readFileSync(path.join(root, 'src/components/CapabilityListRow.tsx'), 'utf8');
  const frameSrc = fs.readFileSync(path.join(root, 'src/components/CapabilitySurfaceFrame.tsx'), 'utf8');
  const completionSrc = fs.readFileSync(path.join(root, 'src/routing/groceryAuthoritativeCompletion.ts'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(root, 'src/routing/grocerySurfacePresentation.ts'), 'utf8');
  const listReadSrc = fs.readFileSync(path.join(root, 'src/db/listRead.ts'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g1','list_grocery','Bananas',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g2','list_grocery','milk, eggs mashed together',0,'2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g3','list_grocery','Checked milk',1,'2026-01-03T00:00:00.000Z')`).run();
    const open = projectGroceryOpenRowsFromSqlite();
    assert('open projection uses authoritative open rows only',
      open.map((r) => `${r.id}:${r.body}`).join('|'),
      (v) => v === 'g1:Bananas|g2:milk, eggs mashed together',
      'g1 Bananas, g2 malformed body; checked excluded');
    assert('getPresentedOpenListItems still excludes checked=1',
      getPresentedOpenListItems('grocery').map((i) => i.id).join(','),
      (v) => v === 'g1,g2', 'g1,g2');
    assert('malformed committed body is rendered faithfully',
      open[1]?.body,
      (v) => v === 'milk, eggs mashed together',
      'exact stored body');
  }

  {
    const merged = mergeGrocerySurfaceRows(
      [{ id: 'g1', body: 'Bananas' }, { id: 'g3', body: 'Milk' }],
      [{ id: 'g2', body: 'Dates' }],
      ['g1', 'g2', 'g3'],
    );
    assert('completed overlay stays in original visual position',
      merged.rows.map((r) => `${r.id}:${r.status}`).join('|'),
      (v) => v === 'g1:open|g2:completed|g3:open',
      'g2 completed between g1 and g3');
    assert('merged rows have no visual position/number field',
      merged.rows.every((r) => !('position' in r) && !('number' in r)),
      (v) => v === true, 'true');
  }

  {
    const overlay = overlayAfterSuccessfulOpenDepartures(
      [{ id: 'g1', body: 'Bananas' }, { id: 'g2', body: 'Dates' }],
      [{ id: 'g1', body: 'Bananas' }],
      [],
    );
    assert('overlay row appears only after open-set departure (post-write)',
      overlay,
      (v) => Array.isArray(v) && (v as { id: string }[]).length === 1 && (v as { id: string }[])[0].id === 'g2',
      'g2 overlayed');
    assert('no departure yields no overlay',
      overlayAfterSuccessfulOpenDepartures(
        [{ id: 'g1', body: 'Bananas' }],
        [{ id: 'g1', body: 'Bananas' }],
        [],
      ),
      (v) => Array.isArray(v) && (v as unknown[]).length === 0, '[]');
  }

  {
    const db = fresh();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g1','list_grocery','Bananas',0,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO list_items (id, list_id, body, checked, created_at) VALUES ('g2','list_grocery','Dates',0,'2026-01-02T00:00:00.000Z')`).run();
    const opr = new OrderedPresentationHolder();
    opr.establish('grocery', ['g1', 'g2']);
    const failed = completeOpenGroceryItemByExactId('missing', { orderedPresentation: opr });
    assert('failed exact-id write does not complete', failed.ok, (v) => v === false, 'false');
    assert('failed write leaves OPR on original open ids',
      opr.peek()?.presentedIds.join(','),
      (v) => v === 'g1,g2', 'g1,g2');
    const ok = completeOpenGroceryItemByExactId('g2', { orderedPresentation: opr });
    assert('tap path write succeeds via exact id', ok.ok && ok.ok && ok.removed.id === 'g2', (v) => v === true, 'true');
    assert('OPR re-established from remaining OPEN ids only',
      ok.ok ? ok.remaining.map((i) => i.id).join(',') : '',
      (v) => v === 'g1', 'g1');
    assert('OPR holder matches remaining open ids',
      opr.peek()?.presentedIds.join(','),
      (v) => v === 'g1', 'g1');
    assert('completed id is no longer in presented open items',
      getPresentedOpenListItems('grocery').map((i) => i.id).includes('g2'),
      (v) => v === false, 'false');
  }

  {
    const groceryRead: UtteranceOutcome = {
      handled: false,
      routeDecision: {
        kind: 'device_read',
        tier: 1,
        response: "You've got 2 things.",
        reason: 'action:list_read',
        presentedGroceryIds: ['g1', 'g2'],
      },
      continuationRecoveryCandidates: [],
    };
    const chitChat: UtteranceOutcome = {
      handled: false,
      routeDecision: { kind: 'backend', tier: 3, reason: 'chit_chat' },
      continuationRecoveryCandidates: [],
    };
    assert('authoritative grocery read identifies surface',
      groceryOutcomeIdentifiesSurface(groceryRead), (v) => v === true, 'true');
    assert('ordinary chit-chat does not identify grocery surface',
      groceryOutcomeIdentifiesSurface(chitChat), (v) => v === false, 'false');
    assert('spoken grocery ack text alone does not identify the surface',
      groceryOutcomeIdentifiesSurface({
        handled: true,
        source: 'referent_resume',
        responseText: 'Done — Dates is off.',
        commits: [],
      }),
      (v) => v === false, 'false');
    assert('structured grocery capabilitySurface hint identifies the surface',
      groceryOutcomeIdentifiesSurface({
        handled: true,
        source: 'referent_resume',
        responseText: 'Done — Dates is off.',
        commits: [],
        capabilitySurface: 'grocery',
      }),
      (v) => v === true, 'true');
  }

  assert('schema version unchanged (no grocery overlay table)',
    SCHEMA_VERSION, (v) => v === 23, '23');
  assert('schema has no Stage-1 list_items migration',
    /SCHEMA_VERSION = 23/.test(schemaSrc) && !/CREATE TABLE grocery_overlay/.test(schemaSrc),
    (v) => v === true, 'true');
  assert('getPresentedOpenListItems still filters checked = 0',
    /checked = 0/.test(listReadSrc), (v) => v === true, 'true');
  assert('completion helper is the exact-ID writer + remaining-open OPR',
    /markOpenListItemRemovedById\(id, 'grocery'\)/.test(completionSrc)
    && /getPresentedOpenListItems\('grocery'\)/.test(completionSrc)
    && /establish\(\s*'grocery'/.test(completionSrc),
    (v) => v === true, 'true');
  assert('processUtterance grocery mutation uses completion helper (no fourth writer)',
    /completeOpenGroceryItemByExactId\(row\.id/.test(processSrc)
    && !/markOpenListItemRemovedById\(row\.id, 'grocery'\)/.test(processSrc),
    (v) => v === true, 'true');
  assert('overlay module cannot write (no markOpen / runSync)',
    /markOpenListItemRemovedById/.test(overlaySrc) || /runSync/.test(overlaySrc) || /LIKE/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('activation does not parse spoken grocery ack text',
    /isGroceryListReadSummarySpeech/.test(overlaySrc) || /Done —/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('processUtterance grocery mutation sets structured capabilitySurface hint',
    /groceryHandled\(\s*'referent_resume',\s*\n\s*formatGroceryRemovalAck/.test(processSrc)
    || /capabilitySurface: 'grocery'/.test(processSrc) && /formatGroceryRemovalAck\(completed\.removed\.body/.test(processSrc),
    (v) => v === true, 'true');
  assert('ChatScreen grocery workspace owns remaining height; transcript is a strip',
    /groceryWorkspace/.test(chatSrc)
    && /groceryTranscriptStrip/.test(chatSrc)
    && /displayMessages\.slice\(-2\)/.test(chatSrc)
    && /groceryWorkspaceSurface/.test(chatSrc),
    (v) => v === true, 'true');
  assert('To-do leftover inset cannot compete with Grocery or Weather',
    !/todoVisualRows && todoVisualRows\.length > 0 && activeSurface == null/.test(chatSrc)
    && !/TodoListSurface/.test(chatSrc)
    && /kind: 'todo'/.test(chatSrc),
    (v) => v === true, 'true');
  assert('ChatScreen tap routes to existing ID completion helper',
    /onCompleteOpenRow=\{handleGroceryCompleteOpenRow\}/.test(chatSrc)
    && /completeOpenGroceryItemByExactId\(id/.test(chatSrc),
    (v) => v === true, 'true');
  assert('ChatScreen does not use dispatchLocalIntent for grocery tap',
    /handleGroceryCompleteOpenRow[\s\S]*dispatchLocalIntent/.test(chatSrc),
    (v) => v === false, 'false');
  assert('one activeSurface slot; weather and grocery are exclusive kinds',
    /kind: 'weather'/.test(chatSrc)
    && /kind: 'grocery'/.test(chatSrc)
    && /kind: 'todo'/.test(chatSrc)
    && /kind: 'schedule'/.test(chatSrc)
    && /activeSurface\?\.kind === 'weather'/.test(chatSrc)
    && /activeSurface\?\.kind === 'grocery'/.test(chatSrc)
    && !/weatherSurface \?/.test(chatSrc)
    && !/groceryVisualRows && groceryVisualRows\.length/.test(chatSrc)
    && !/todoVisualRows/.test(chatSrc),
    (v) => v === true, 'true');
  assert('sendMessage clears weather slot only, not grocery',
    /latLog\('sendMessage entry'[\s\S]*?setActiveSurface\(\(prev\) => \(prev\?\.kind === 'weather' \? null : prev\)\)/.test(chatSrc),
    (v) => v === true, 'true');
  assert('idle/session reset clears the slot',
    /followTranscriptRef\.current = true;\s*setActiveSurface\(null\)/.test(chatSrc),
    (v) => v === true, 'true');
  assert('grocery visual lifetime is not DiscourseContinuityHolder or OPR TTL',
    /refreshGroceryCapabilitySurface/.test(chatSrc)
    && !/discourseRef\.current\.peek[\s\S]{0,80}setActiveSurface/.test(chatSrc)
    && !/orderedPresentationRef\.current\.peek\(\)[\s\S]{0,120}kind: 'grocery'/.test(chatSrc),
    (v) => v === true, 'true');
  assert('shared frame + list row + grocery surface exist',
    /export function CapabilitySurfaceFrame/.test(frameSrc)
    && /export function CapabilityListRow/.test(rowSrc)
    && /export function GrocerySurface/.test(grocerySurfaceSrc)
    && /\\uD83D\\uDED2/.test(grocerySurfaceSrc),
    (v) => v === true, 'true');
  assert('Grocery surface has no visual row numbers',
    /row\.position/.test(grocerySurfaceSrc) || /\{index \+ 1\}/.test(grocerySurfaceSrc),
    (v) => v === false, 'false');
  assert('completed overlay rows are non-interactive',
    /if \(completed \|\| !onPressOpen\)/.test(rowSrc)
    && /accessibilityState=\{\{ disabled: true \}\}/.test(rowSrc)
    && /row\.status === 'open' && onCompleteOpenRow/.test(grocerySurfaceSrc),
    (v) => v === true, 'true');
  assert('open grocery row is the full-row press target (not a checkbox)',
    /Pressable/.test(rowSrc) && !/checkbox/i.test(rowSrc) && /minHeight:\s*48/.test(rowSrc),
    (v) => v === true, 'true');
  assert('grocery row density is compact 16sp text without device-specific dimensions',
    /fontSize:\s*16/.test(rowSrc)
    && /lineHeight:\s*20/.test(rowSrc)
    && /paddingVertical:\s*8/.test(rowSrc)
    && !/fontSize:\s*2[0-9]/.test(rowSrc)
    && !/Galaxy|S24|1080x|2340/.test(rowSrc + grocerySurfaceSrc + frameSrc),
    (v) => v === true, 'true');
  assert('Weather wraps shared frame without retuning personas.ts',
    fs.readFileSync(path.join(root, 'src/components/CapabilitySurface.tsx'), 'utf8').includes('CapabilitySurfaceFrame')
    && !fs.readFileSync(path.join(root, 'src/constants/personas.ts'), 'utf8').includes('deriveQuieterListSurfaceTint'),
    (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EverydayCapabilitySurfacesV1: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('everydayCapabilitySurfacesV1.test.ts')) {
  runEverydayCapabilitySurfacesV1Tests().catch(console.error);
}
