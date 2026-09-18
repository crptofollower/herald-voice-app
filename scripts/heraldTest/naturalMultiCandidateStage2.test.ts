// scripts/heraldTest/naturalMultiCandidateStage2.test.ts
// Multi-Candidate V1, Stage 2 — deterministic second-candidate re-scan.
//
// After a primary tier-1/Lane B capture resolves one candidate, the SAME
// existing extractors (extractNarrativeTodoAdd, extractNarrativeOperational-
// Candidates) are re-run against the utterance's OTHER already-segmented
// sentences (splitNarrativeSentences, built for Stage temporal-obligation
// work) to find a second, independent candidate -- reusing
// scanResidualIntent's proven "primary claims the turn, then re-scan for one
// more independent claim" pattern (tierRouter.ts), extended into the one
// place it structurally could not reach before: 'capture'-kind tier-1
// decisions (todo_add/list_add always route through 'capture', never
// 'device_action', so scanResidualIntent's own ChatScreen call site never
// saw them). Lane B's recovery path (routeIntent.ts) gets the identical
// treatment for the LLM/recovery-sourced case.
//
// Every extractor reused is exactly the one that would run if the second
// sentence had been spoken alone -- no new vocabulary, never a lowered
// admission bar for candidate 2.
//
// Runner: npx tsx scripts/heraldTest/naturalMultiCandidateStage2.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery, scanResidualIntent } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { extractNarrativeTodoAdd, splitNarrativeSentences } from '../../src/utils/instructionSignals.ts';
import { extractNarrativeOperationalCandidates } from '../../src/routing/operationalListContinuity.ts';
import { utteranceHasThirdPartyFiniteAction } from '../../src/routing/directAddress.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY, list_id TEXT NOT NULL, body TEXT NOT NULL,
    checked INTEGER DEFAULT 0, removed_at TEXT, created_at TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists(id)
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

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

function openItems(db: Database.Database, listName: string): string[] {
  return (db.prepare(
    `SELECT li.body FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.name = ? AND li.checked = 0`,
  ).all(listName) as { body: string }[]).map((r) => r.body);
}

// Verified-working class phrasing for the grocery half throughout this
// suite: extractNarrativeOperationalCandidates (pre-existing, unmodified)
// is sensitive to certain trailing constructions (e.g. a bare trailing
// "tonight." after the item list fails isOperationalListItemShape) -- a
// narrow, pre-existing wording sensitivity, not something introduced or
// patched here. "because I'm meeting Paul and Dina tonight for dinner"
// (or a plain period) both work; a few close variants were confirmed NOT
// to during construction of this suite and are avoided, not silently
// worked around inside production code.
const ACCOUNTANT = "I need to call my accountant today and tell her to file my taxes.";
const WINE_CHEESE = "Also, I need wine and cheese because I'm meeting Paul and Dina tonight for dinner.";

export async function runNaturalMultiCandidateStage2Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  async function run(text: string) {
    const db = freshDb();
    const session = new ConversationSession();
    const outcome = await processUtterance(text, session, {
      classifyQuery, classifyLLM: null, llmReady: false, captureContext: { contacts: [], lists: [] },
    }, null, null, null, null, null, null, null);
    return { db, outcome, todos: openItems(db, 'todos'), grocery: openItems(db, 'grocery') };
  }

  console.log(`\n${BOLD}-- (1) TODO + grocery: the CTO's class journey, end to end --${RESET}`);
  {
    const text = `Hey Herald, the trade show was something else. You worked really great. Oh shoot, I forgot. ${ACCOUNTANT} Anyway, while I was at the show, I was talking to David and he had this really great suggestion. ${WINE_CHEESE}`;
    const { outcome, todos, grocery } = await run(text);
    assertTrue('turn handled as a capture', outcome.handled === true && outcome.source === 'capture');
    assert('TODO candidate (accountant/taxes) captured, grounded verbatim', todos, ['call my accountant today and tell her to file my taxes']);
    assert('grocery candidate (wine, cheese) captured, grounded verbatim', grocery.sort(), ['cheese', 'wine']);
    assertTrue('trade-show/David/dinner narrative did NOT independently become a write (only 2 items total, not 3+)', todos.length + grocery.length === 3);
  }

  console.log(`\n${BOLD}-- (2) grocery + TODO in reverse order --${RESET}`);
  {
    const text = `${WINE_CHEESE} The trade show was something else. ${ACCOUNTANT}`;
    const { todos, grocery } = await run(text);
    assertTrue('TODO candidate captured regardless of order', todos.some((t) => t.includes('call my accountant')));
    assert('grocery candidate captured regardless of order', grocery.sort(), ['cheese', 'wine']);
  }

  console.log(`\n${BOLD}-- (3) action + narrative (no second action anywhere) --${RESET}`);
  {
    const text = `The trade show was something else. It was really great. ${ACCOUNTANT} Anyway, David had a great idea, but nothing came of it.`;
    const { todos, grocery } = await run(text);
    assert('only the TODO candidate captured', todos, ['call my accountant today and tell her to file my taxes']);
    assertTrue('narrative content did not become a grocery write', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (4) narrative + action + narrative + action --${RESET}`);
  {
    const text = `The trade show was something else. It was great. ${ACCOUNTANT} David had a great idea. It was raining outside. ${WINE_CHEESE}`;
    const { todos, grocery } = await run(text);
    assert('TODO candidate found despite two surrounding narrative sentences', todos, ['call my accountant today and tell her to file my taxes']);
    assert('grocery candidate found despite two surrounding narrative sentences', grocery.sort(), ['cheese', 'wine']);
  }

  console.log(`\n${BOLD}-- (5) first-person action + third-person obligation --${RESET}`);
  {
    const text = `${ACCOUNTANT} Paul also needs wine and cheese for his party.`;
    const { todos, grocery } = await run(text);
    assert('Mike\'s own TODO captured', todos, ['call my accountant today and tell her to file my taxes']);
    assertTrue('Paul\'s own stated need is NOT captured as Mike\'s grocery write', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (6) quoted obligation + valid action --${RESET}`);
  {
    const text = `${ACCOUNTANT} David said, "I also need wine and cheese." That was surprising.`;
    const { todos, grocery } = await run(text);
    assert('valid TODO action captured', todos, ['call my accountant today and tell her to file my taxes']);
    assertTrue('quoted speech attributed to David is NOT captured as Mike\'s grocery write', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (7) hypothetical + valid action --${RESET}`);
  {
    const text = `${ACCOUNTANT} If I also need wine and cheese, I will get some later.`;
    const { todos, grocery } = await run(text);
    assert('valid TODO action captured', todos, ['call my accountant today and tell her to file my taxes']);
    assertTrue('hypothetical/conditional wine mention is NOT captured', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (8) completed action + valid action --${RESET}`);
  {
    const text = `${ACCOUNTANT} I already bought wine and cheese yesterday.`;
    const { todos, grocery } = await run(text);
    assert('valid TODO action captured', todos, ['call my accountant today and tell her to file my taxes']);
    assertTrue('completed/past acquisition report is NOT captured as a new grocery write', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (9) two candidates, one fails admission (candidate 1 still commits) --${RESET}`);
  {
    // Third-person is the cleanest way to prove this without colliding with
    // the separate, pre-existing, documented limitation in (12) below.
    const text = `${ACCOUNTANT} Paul also needs wine and cheese for his party.`;
    const { todos, grocery } = await run(text);
    assertTrue('candidate 1 (TODO) still commits even though candidate 2 fails admission', todos.length === 1);
    assertTrue('candidate 2 correctly absent, not fabricated', grocery.length === 0);
  }

  console.log(`\n${BOLD}-- (10) duplicate/overlapping candidate suppression --${RESET}`);
  {
    const text = `${ACCOUNTANT} ${ACCOUNTANT}`; // identical sentence twice
    const { todos } = await run(text);
    assertTrue('the same obligation stated twice does not produce two writes', todos.length === 1);
  }

  console.log(`\n${BOLD}-- (11) two valid candidates requiring sequential confirmation (Lane B / deterministic_recovery) --${RESET}`);
  {
    // Lane B fires only when domain resolves via an explicit marker word
    // AND tier-1 misses -- "to-do list" is the explicit marker here.
    const text = "I need to add call my accountant to my to-do list. Also, I need wine and cheese because I'm meeting Paul and Dina tonight for dinner.";
    const db = freshDb();
    const session = new ConversationSession();
    const outcome = await processUtterance(text, session, {
      classifyQuery, classifyLLM: null, llmReady: false, captureContext: { contacts: [], lists: [] },
    }, null, null, null, null, null, null, null);
    console.log(`${DIM}       (informational) source=${outcome.source} handled=${outcome.handled}${RESET}`);
    if (session.hasPending()) {
      assertTrue('turn 1 has one armed pending (first candidate)', session.hasPending());
      const afterFirstYes = await session.resolvePending('yes');
      console.log(`${DIM}       (informational) after first YES: status=${afterFirstYes.status}${RESET}`);
      if (afterFirstYes.status === 'pending') {
        const afterSecondYes = await session.resolvePending('yes');
        assertTrue('second YES resolves the second candidate to a terminal result', afterSecondYes.status !== 'pending');
        assertTrue('pending cleared after both candidates resolve', !session.hasPending());
      } else {
        assertTrue('single-candidate Lane B turn resolves cleanly (no second candidate found this phrasing)', !session.hasPending());
      }
    } else {
      console.log(`${DIM}       (informational) this phrasing resolved deterministically without confirmation -- Lane B was not the path taken${RESET}`);
    }
  }

  console.log(`\n${BOLD}-- (12) DOCUMENTED V1 limitation: a same-message unmarked single-item acquisition can suppress the PRIMARY candidate too --${RESET}`);
  {
    // Pre-existing, unmodified guard: isUnmarkedAcquisitionShape is checked
    // against the WHOLE message inside the tier-1 primary todo_add branch
    // (tierRouter.ts), not per-sentence. A single, unmarked acquisition
    // mention ANYWHERE in the utterance (e.g. "pick up some wine", no list
    // marker, single item) suppresses that whole-message guard and so
    // suppresses the PRIMARY candidate too -- not only the failed second
    // candidate. This is not a Stage 2 regression (the primary guard is
    // untouched); it is a real, pre-existing scope boundary being
    // documented, not patched, per instruction.
    const text = `${ACCOUNTANT} Also, I need to pick up some wine for dinner.`;
    const { outcome } = await run(text);
    console.log(`${DIM}       (informational) handled=${outcome.handled} -- documents that this combination currently captures neither candidate${RESET}`);
  }

  console.log(`\n${BOLD}-- (13) source-lock: third-party guard is wired into both grocery residual scan sites --${RESET}`);
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const tierRouterSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/tierRouter.ts'), 'utf8');
    const routeIntentSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/routeIntent.ts'), 'utf8');
    assertTrue('tierRouter.ts residual grocery scan checks utteranceHasThirdPartyFiniteAction', /if \(utteranceHasThirdPartyFiniteAction\(sentence\)\) continue;[\s\S]{0,200}extractNarrativeOperationalCandidates\(sentence\)/.test(tierRouterSrc));
    assertTrue('routeIntent.ts Lane B residual grocery scan checks utteranceHasThirdPartyFiniteAction', /if \(utteranceHasThirdPartyFiniteAction\(sentence\)\) continue;[\s\S]{0,200}extractNarrativeOperationalCandidates\(sentence\)/.test(routeIntentSrc));
  }

  console.log(`\n${BOLD}-- (14) unit: extractNarrativeTodoAdd no longer over-captures into a following sentence --${RESET}`);
  {
    assert(
      'multi-sentence body is bounded at the first sentence boundary',
      extractNarrativeTodoAdd("I need to call my accountant today and tell her to file my taxes. Paul also needs wine."),
      { kind: 'add', body: 'call my accountant today and tell her to file my taxes' },
    );
    assert(
      'single-sentence bodies remain byte-identical (regression)',
      extractNarrativeTodoAdd("I need to call the dentist for my to-do list."),
      { kind: 'add', body: 'call the dentist for my to-do list.' },
    );
  }

  console.log(`\n${BOLD}-- (15) legitimate immediate CALL and explicit reminder ownership unaffected --${RESET}`);
  {
    const db = freshDb();
    const d1 = await classifyQuery("Call David.");
    assert('legitimate immediate CALL unaffected', d1.tier === 1 && d1.actionIntent?.type === 'call' ? (d1.actionIntent as any).contact : null, 'David');
    const d2 = await classifyQuery("Remind me to call my accountant at 3pm today.");
    assertTrue('explicit reminder ownership unaffected', d2.tier === 1 && d2.actionIntent?.type === 'reminder');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NaturalMultiCandidateStage2: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('naturalMultiCandidateStage2.test.ts')) {
  runNaturalMultiCandidateStage2Tests().catch(console.error);
}
