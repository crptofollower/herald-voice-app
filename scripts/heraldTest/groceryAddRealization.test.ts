// scripts/heraldTest/groceryAddRealization.test.ts
// Conversational Response Realization V1 — Grocery single-item add paths.
//
// Proves the mechanism solves grammatical number STRUCTURALLY: the same code
// path is correct for a plural noun (eggs), a singular mass noun (milk), and
// another plural (bananas) without inspecting the item, without a lookup table,
// and without any per-item special case. Also proves the non-enrolled
// multi-item wordings are untouched and cannot originate from this module.
//
// Runner: npx tsx scripts/heraldTest/groceryAddRealization.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  realizeGroceryAddAct,
  type GroceryAddResponseAct,
} from '../../src/conversation/groceryAddRealization.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const GENERIC_CLOSERS = [
  /anything else/i,
  /let me know/i,
  /if you need/i,
  /ask me if/i,
  /can i help/i,
];

export async function runGroceryAddRealizationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Grocery Add Realization (Response Realization V1) --------${RESET}`);

  // ── 1. Added one item — agreement-invariant across noun classes ───────────
  {
    const got = realizeGroceryAddAct({ kind: 'added_one', item: 'eggs', listName: 'grocery' });
    const want = 'Added eggs to your grocery list.';
    assert('GAR1 added eggs (plural noun — was "Eggs is on your grocery list.")', got, (v) => v === want, want);
  }
  {
    const got = realizeGroceryAddAct({ kind: 'added_one', item: 'milk', listName: 'grocery' });
    const want = 'Added milk to your grocery list.';
    assert('GAR2 added milk (singular mass noun)', got, (v) => v === want, want);
  }
  {
    const got = realizeGroceryAddAct({ kind: 'added_one', item: 'bananas', listName: 'grocery' });
    const want = 'Added bananas to your grocery list.';
    assert('GAR3 added bananas (plural noun)', got, (v) => v === want, want);
  }
  {
    // The point of the mechanism: one form, no plurality inference anywhere.
    const items = ['eggs', 'milk', 'bananas', 'asparagus', 'hummus', 'rice'];
    const all = items.map((item) => realizeGroceryAddAct({ kind: 'added_one', item, listName: 'grocery' }));
    assert('GAR4 every noun class uses the same agreement-free form',
      all.filter((s, i) => s === `Added ${items[i]} to your grocery list.`).length,
      (v) => v === items.length, String(items.length));
  }

  // ── 2. Item already present ───────────────────────────────────────────────
  {
    const got = realizeGroceryAddAct({ kind: 'already_had_one', item: 'eggs', listName: 'grocery' });
    const want = 'You already had eggs on your grocery list.';
    assert('GAR5 already had eggs (was "Eggs was already on your grocery list.")', got, (v) => v === want, want);
  }
  {
    const got = realizeGroceryAddAct({ kind: 'already_had_one', item: 'bananas', listName: 'grocery' });
    const want = 'You already had bananas on your grocery list.';
    assert('GAR6 already had bananas', got, (v) => v === want, want);
  }

  // ── 3. Trust-critical value preservation ──────────────────────────────────
  {
    // Item body is spoken exactly as captured: no casing change, no
    // pluralization, no trimming of a captured trailing period.
    const items = ['Greek yogurt', 'milk.', "Trader Joe's chili crisp", 'A1 sauce'];
    const all = items.map((item) => realizeGroceryAddAct({ kind: 'added_one', item, listName: 'grocery' }));
    assert('GAR7 item body is concatenated verbatim',
      all.filter((s, i) => s.includes(items[i])).length, (v) => v === items.length, String(items.length));
  }
  {
    const got = realizeGroceryAddAct({ kind: 'added_one', item: 'batteries', listName: 'hardware' });
    const want = 'Added batteries to your hardware list.';
    assert('GAR8 listName is passed through verbatim (not assumed to be grocery)', got, (v) => v === want, want);
  }

  // ── 4. Ending behavior ────────────────────────────────────────────────────
  {
    const acts: GroceryAddResponseAct[] = [
      { kind: 'added_one', item: 'eggs', listName: 'grocery' },
      { kind: 'already_had_one', item: 'eggs', listName: 'grocery' },
    ];
    const all = acts.map(realizeGroceryAddAct);
    assert('GAR9 no generic conversational closer',
      all.filter((s) => GENERIC_CLOSERS.some((re) => re.test(s))).length, (v) => v === 0, '0');
    assert('GAR10 an add confirmation asks nothing — silence is a valid ending',
      all.filter((s) => s.includes('?')).length, (v) => v === 0, '0');
  }

  // ── 5. Deterministic ──────────────────────────────────────────────────────
  {
    const act: GroceryAddResponseAct = { kind: 'added_one', item: 'eggs', listName: 'grocery' };
    const results = new Set(Array.from({ length: 10 }, () => realizeGroceryAddAct(act)));
    assert('GAR11 pure — identical input always yields identical output', results.size, (v) => v === 1, '1');
  }

  // ── 6. Non-enrolled multi-item paths are untouched ───────────────────────
  {
    const all = [
      realizeGroceryAddAct({ kind: 'added_one', item: 'eggs', listName: 'grocery' }),
      realizeGroceryAddAct({ kind: 'already_had_one', item: 'eggs', listName: 'grocery' }),
    ];
    assert('GAR12 this module can never emit the multi-item wordings',
      all.filter((s) => /items are on your|Those were already/.test(s)).length, (v) => v === 0, '0');
  }
  {
    // The multi-item acks stay literal in the writer — proven at the source, so
    // a later drive-by migration of those paths fails here rather than silently.
    // Grocery Integrity V1 re-pinned the count expression from `addedCount` to
    // `committed.length` (commit-truth); the user-facing wording is unchanged
    // and still lives literally in the writer, unenrolled from realization.
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const src = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8');
    assert('GAR13 multi-item committed ack still literal in list_add writer',
      src.includes('${committed.length} items are on your ${listName} list now.'),
      (v) => v === true, 'true');
    assert('GAR14 multi-item already-present ack still literal in list_add writer',
      src.includes('Those were already on your ${listName} list.'),
      (v) => v === true, 'true');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}groceryAddRealization: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('groceryAddRealization.test.ts')) {
  runGroceryAddRealizationTests().catch(console.error);
}
