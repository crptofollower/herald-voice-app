// scripts/heraldTest/naturalObligationCallGuard.test.ts
// Conversation Reliability V1 — natural-speech obligation-prefix guard.
//
// Proves: TODO_ADD_PREFIX's own `^` anchor only ever protected an isolated,
// sentence-initial "I need to call X and do Y" from tier-1 CALL. The
// identical obligation phrasing, embedded after ANY narrative preamble (a
// normal conversational shape, not an edge case), previously fell through
// that anchor and got tier-1-hijacked as a literal dial-now command —
// discarding the real intent and any content after it in the same turn.
// hasObligationPrefixSentence (instructionSignals.ts) closes this by
// checking the SAME phrase set against every sentence in the utterance, not
// only its first word. No new vocabulary, no capability, no architecture
// change — a scope generalization of one existing guard.
//
// Runner: npx tsx scripts/heraldTest/naturalObligationCallGuard.test.ts
// Not wired into run.mjs (that file is unrelated in-flight work tonight —
// run standalone, same as groceryTodoCapabilityOwnershipRecovery.test.ts).

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { hasObligationPrefixSentence } from '../../src/utils/instructionSignals.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';

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
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
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

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

const tierRouterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/tierRouter.ts');

export async function runNaturalObligationCallGuardTests() {
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

  console.log(`\n${BOLD}-- (1) hasObligationPrefixSentence: unit behavior --${RESET}`);
  {
    assertTrue('empty string: false', hasObligationPrefixSentence('') === false);
    assertTrue('single isolated obligation sentence: true', hasObligationPrefixSentence('I need to call my accountant.'));
    assertTrue('obligation sentence NOT first: true', hasObligationPrefixSentence('I went to a trade show. I need to call my accountant today.'));
    assertTrue('obligation sentence after multiple prior sentences: true', hasObligationPrefixSentence('I went to a trade show. It was great. Oh shoot. I have to call the vet about the appointment.'));
    assertTrue('no obligation phrasing anywhere: false', hasObligationPrefixSentence('I went to a trade show. Call David when you get a chance.') === false);
    assertTrue('obligation phrase present but NOT sentence-initial: false', hasObligationPrefixSentence('By the way, you should know I need to call David eventually.') === false);
  }

  console.log(`\n${BOLD}-- (2) Full acceptance-example-class narrative does NOT hijack to tier-1 CALL --${RESET}`);
  {
    freshDb();
    const text = "Hey Herald, I went to a trade show. You worked really great. Oh shoot, I forgot. I need to call my accountant today and tell her to file my taxes. Anyway, while I was at the show, I was talking to David and he had this really great suggestion. Oh darn it, I also need to pick up some wine because I'm meeting Paul and Dina tonight for dinner at six o'clock.";
    const d = await classifyQuery(text);
    assertTrue('NOT tier-1 call (was: tier1/action:call/contact:accountant)', !(d.tier === 1 && d.actionIntent?.type === 'call'));
  }

  console.log(`\n${BOLD}-- (3) Different-phrased narrative, same shape (proves this is not a phrase-specific patch) --${RESET}`);
  {
    freshDb();
    const text = "So work was a mess today, total chaos honestly. I have to call the vet about Buddy's checkup before Friday. Anyway David asked about the lake house again.";
    const d = await classifyQuery(text);
    assertTrue('NOT tier-1 call for a differently-worded narrative+obligation shape', !(d.tier === 1 && d.actionIntent?.type === 'call'));
  }

  console.log(`\n${BOLD}-- (4) Isolated obligation clause: still correctly NOT tier-1 call (pre-existing protection, unregressed) --${RESET}`);
  {
    freshDb();
    const d = await classifyQuery("I need to call my accountant today and tell her to file my taxes.");
    assertTrue('isolated obligation clause remains protected', !(d.tier === 1 && d.actionIntent?.type === 'call'));
  }

  console.log(`\n${BOLD}-- (5) Legitimate direct/mid-narrative CALL commands still correctly route tier-1 (regression safety) --${RESET}`);
  {
    freshDb();
    const d1 = await classifyQuery("Call David.");
    assert('bare "Call David." still tier-1 call', d1.tier === 1 && d1.actionIntent?.type === 'call' ? (d1.actionIntent as any).contact : null, 'David');

    freshDb();
    const d2 = await classifyQuery("Can you please call my mom");
    assert('polite "call my mom" still tier-1 call', d2.tier === 1 && d2.actionIntent?.type === 'call' ? (d2.actionIntent as any).contact : null, 'mom');

    freshDb();
    const d3 = await classifyQuery("So I was at the trade show and it was great. By the way, can you call David?");
    assertTrue('mid-narrative command with NO obligation-prefix sentence still tier-1 calls', d3.tier === 1 && d3.actionIntent?.type === 'call');
  }

  console.log(`\n${BOLD}-- (6) routeIntent-level: the acceptance-example narrative no longer decides to call anyone --${RESET}`);
  {
    freshDb();
    const text = "Hey Herald, I went to a trade show. You worked really great. Oh shoot, I forgot. I need to call my accountant today and tell her to file my taxes. Anyway, while I was at the show, I was talking to David and he had this really great suggestion. Oh darn it, I also need to pick up some wine because I'm meeting Paul and Dina tonight for dinner at six o'clock.";
    const decision = await routeIntent(text, {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    });
    const isCallAction =
      (decision.kind === 'device_action' && (decision as any).actionIntent?.type === 'call') ||
      (decision as any).actionIntent?.type === 'call';
    assertTrue('routeIntent decision is not a call action', !isCallAction);
    console.log(`${DIM}       (informational) decision.kind=${decision.kind} reason=${(decision as any).reason}${RESET}`);
  }

  console.log(`\n${BOLD}-- (7) source-lock: guard is actually wired into the CALL branch condition --${RESET}`);
  {
    const src = fs.readFileSync(tierRouterPath, 'utf8');
    assertTrue(
      'CALL branch condition calls hasObligationPrefixSentence(msg), not the old TODO_ADD_PREFIX.test(msg)',
      /CALL_SIGNALS\.some[\s\S]{0,220}!hasObligationPrefixSentence\(msg\)/.test(src),
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}NaturalObligationCallGuard: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('naturalObligationCallGuard.test.ts')) {
  runNaturalObligationCallGuardTests().catch(console.error);
}
