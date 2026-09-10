// scripts/heraldTest/groceryIntegrityV1.test.ts
// Grocery Integrity V1 — segmentation + commit-truth acknowledgement.
//
// Drives the REAL production path (normalizeInput → processUtterance →
// DOMAIN_WRITERS.list_add via applyIntents; classifier-shaped intents via
// applyIntents directly at the same convergence point). Persisted rows are read
// from the in-memory DB; acknowledgement is the actual responseText. Removal
// addressability is proven through the existing listRead production readers/
// mutator — the removal implementation itself is NOT modified or re-tested here.
//
// Runner: npx tsx scripts/heraldTest/groceryIntegrityV1.test.ts

import Database from 'better-sqlite3';
import { openJourneyDb, runJourneyTurn } from './journeyHarness.ts';
import { applyIntents } from '../../src/routing/processUtterance.ts';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import {
  getPresentedOpenListItems,
  getOpenListItemById,
  markOpenListItemRemovedById,
} from '../../src/db/listRead.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

/** Open grocery bodies as a normalized set (order is created_at/id dependent,
 *  never asserted). */
function grocerySet(db: Database.Database): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id
     WHERE l.name = 'grocery' AND li.checked = 0`,
  ).all() as { body: string }[])
    .map((r) => r.body.trim().toLowerCase())
    .sort();
}

export async function runGroceryIntegrityV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  const setEq = (want: string[]) => (v: unknown) =>
    Array.isArray(v) && JSON.stringify(v) === JSON.stringify([...want].sort());

  console.log(`\n${BOLD}-- Grocery Integrity V1 (segmentation + commit-truth) -------${RESET}`);

  // ── 1. Oxford-comma add persists three independent, uncorrupted bodies ─────
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    const r = await runJourneyTurn(db, session, deps, 1, 'add milk, bread, and bananas to my grocery list', orderedPresentation);
    const set = grocerySet(db);
    assert('GI1 oxford add → {milk,bread,bananas}', set, setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
    assert('GI1 no "and bananas" corrupted body', set, (v) => Array.isArray(v) && !v.includes('and bananas'), 'no "and bananas"');
    assert('GI1 no combined single item', set, (v) => Array.isArray(v) && !v.some((b) => (b as string).includes(',')), 'no comma-bearing body');
    assert('GI1 commit acknowledged', r.response, (v) => typeof v === 'string' && /grocery list/.test(v), 'mentions grocery list');
  }

  // ── 2. "milk and bread" → two items ────────────────────────────────────────
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk and bread to my grocery list', orderedPresentation);
    assert('GI2 "milk and bread" → {milk,bread}', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
  }

  // ── 3. "milk, bread, bananas" (no conjunction) → three items ───────────────
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk, bread, bananas to my grocery list', orderedPresentation);
    assert('GI3 "milk, bread, bananas" → {milk,bread,bananas}', grocerySet(db), setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
  }

  // ── 4. Classifier-shaped compound single element normalized before commit ──
  {
    const { db, session } = openJourneyDb();
    const { commits } = await applyIntents(
      [{ type: 'list_add', items: ['milk, bread, and bananas'], listName: 'grocery' }],
      'add milk, bread, and bananas',
      session, undefined, 'deterministic',
    );
    assert('GI4 classifier combined string commits', commits[0]?.status, (v) => v === 'committed', 'committed');
    assert('GI4 combined string re-split into three rows', grocerySet(db), setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
    assert('GI4 no combined row persisted', grocerySet(db), (v) => Array.isArray(v) && !v.some((b) => (b as string).includes(',')), 'no comma-bearing body');
  }

  // ── 5. Mixed dup/new: milk present, add "milk and bread" → ACK names bread ─
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk to my grocery list', orderedPresentation);
    const r = await runJourneyTurn(db, session, deps, 2, 'add milk and bread to my grocery list', orderedPresentation);
    assert('GI5 ACK names the committed item (bread), not requested milk', r.response, (v) => v === 'Added bread to your grocery list.', 'Added bread to your grocery list.');
    assert('GI5 both items now present', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
  }

  // ── 6. Mixed dup/new, oxford: milk+bread present, add trio → ACK bananas ───
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk and bread to my grocery list', orderedPresentation);
    const r = await runJourneyTurn(db, session, deps, 2, 'add milk, bread, and bananas to my grocery list', orderedPresentation);
    assert('GI6 ACK names the sole committed item (bananas)', r.response, (v) => v === 'Added bananas to your grocery list.', 'Added bananas to your grocery list.');
    assert('GI6 list now has all three', grocerySet(db), setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
  }

  // ── 7. No-duplicate multi-item add: truthful count ─────────────────────────
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    const r = await runJourneyTurn(db, session, deps, 1, 'add milk, bread, and bananas to my grocery list', orderedPresentation);
    assert('GI7 three-new ACK is count-based', r.response, (v) => v === '3 items are on your grocery list now.', '3 items are on your grocery list now.');
    assert('GI7 three rows', grocerySet(db).length, (v) => v === 3, '3');
  }

  // ── 8. All-duplicate adds remain truthful, claim no new commit ─────────────
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk and bread to my grocery list', orderedPresentation);
    const r = await runJourneyTurn(db, session, deps, 2, 'add milk and bread to my grocery list', orderedPresentation);
    assert('GI8a all-dup multi → "Those were already…" (no false single-out)', r.response, (v) => v === 'Those were already on your grocery list.', 'Those were already on your grocery list.');
    assert('GI8a no extra rows', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
  }
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk to my grocery list', orderedPresentation);
    const r = await runJourneyTurn(db, session, deps, 2, 'add milk to my grocery list', orderedPresentation);
    assert('GI8b single dup → "You already had milk…"', r.response, (v) => v === 'You already had milk on your grocery list.', 'You already had milk on your grocery list.');
    assert('GI8b still exactly one row', grocerySet(db).length, (v) => v === 1, '1');
  }

  // ── 9. Collection focus stays ONE entry despite three committed rows ───────
  {
    const { session } = openJourneyDb();
    const ledger = createConversationTurnLedger();
    const { commits } = await applyIntents(
      [{ type: 'list_add', items: ['milk, bread, and bananas'], listName: 'grocery' }],
      'add milk, bread, and bananas',
      session, undefined, 'deterministic', undefined, ledger,
    );
    assert('GI9 commit succeeded', commits[0]?.status, (v) => v === 'committed', 'committed');
    const r = ledger.peek(Date.now());
    assert('GI9 exactly ONE focus entry despite 3 rows', r[0]?.focus.length, (v) => v === 1, '1');
    assert('GI9 focus kind is collection', r[0]?.focus[0]?.kind, (v) => v === 'collection', 'collection');
  }

  // ── 10. Removal regression: bananas is independently addressable/removable ─
  //     via the EXISTING listRead readers/mutator (implementation unchanged).
  {
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk, bread, and bananas to my grocery list', orderedPresentation);
    const presented = getPresentedOpenListItems('grocery');
    const bananas = presented.find((i) => /^bananas$/i.test(i.body.trim()));
    assert('GI10 an independent "bananas" row exists', bananas, (v) => v != null, 'a bananas row');
    if (bananas) {
      const resolved = getOpenListItemById(bananas.id, 'grocery');
      assert('GI10 bananas row resolves by its own stable id', resolved?.id, (v) => v === bananas.id, bananas.id);
      const removed = markOpenListItemRemovedById(bananas.id, 'grocery');
      assert('GI10 existing removal helper removes exactly bananas', removed?.body, (v) => typeof v === 'string' && /^bananas$/i.test((v as string).trim()), 'bananas');
      assert('GI10 milk and bread remain after removing bananas', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
    }
  }

  // ── TRUST GUARDS (tightening): a BARE embedded "and" must NOT split at the
  //     writer boundary; only comma structure re-segments an incoming element. ─
  // A classifier-produced single item is passed via applyIntents (the exact
  // convergence path), NOT a deterministic utterance — the deterministic
  // tierRouter path is intentionally left unchanged (see TG-F).
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['peanut butter and jelly'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-A "peanut butter and jelly" stays ONE item', grocerySet(db), setEq(['peanut butter and jelly']), '["peanut butter and jelly"]');
  }
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['macaroni and cheese'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-B "macaroni and cheese" stays ONE item', grocerySet(db), setEq(['macaroni and cheese']), '["macaroni and cheese"]');
  }
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['ham and cheese'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-B2 "ham and cheese" stays ONE item', grocerySet(db), setEq(['ham and cheese']), '["ham and cheese"]');
  }
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['milk', 'bread'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-C ["milk","bread"] stays two independent items', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
  }
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['milk', 'bread', 'and bananas'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-D pre-corrupted ["…","and bananas"] → milk/bread/bananas', grocerySet(db), setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
  }
  {
    const { db, session } = openJourneyDb();
    await applyIntents([{ type: 'list_add', items: ['milk, bread, and bananas'], listName: 'grocery' }], 'x', session, undefined, 'deterministic');
    assert('TG-E comma compound → milk/bread/bananas', grocerySet(db), setEq(['milk', 'bread', 'bananas']), '["bananas","bread","milk"]');
  }
  {
    // Deterministic production utterance: tierRouter (unchanged) segments before
    // the writer; the writer accepts the two independent items. NOT altered here.
    const { db, session, deps, orderedPresentation } = openJourneyDb();
    await runJourneyTurn(db, session, deps, 1, 'add milk and bread to my grocery list', orderedPresentation);
    assert('TG-F deterministic "add milk and bread…" → two items (upstream unchanged)', grocerySet(db), setEq(['milk', 'bread']), '["bread","milk"]');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}groceryIntegrityV1: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groceryIntegrityV1.test.ts')) {
  runGroceryIntegrityV1Tests().catch(console.error);
}
