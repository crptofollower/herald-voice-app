// scripts/heraldTest/greeting.test.ts
// Greeting contract — 2026-07-30.
// Locks the deterministic greeting classifier (§4a): bare "hello/hi/hey" and
// a greeting addressed to whatever ai_name is CURRENTLY configured both route
// tier 1. A greeting addressed to any OTHER name stays unmatched (Graceful
// Confusion) — that is a deliberate scope boundary, not a bug. Unrelated text
// containing a name-shaped word never becomes a greeting.
//
// Runner: npx tsx scripts/heraldTest/greeting.test.ts
// Gate:   wired from run.mjs — must be green before this closes.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { setProfileField } from '../../src/db/profileDB.ts';
import { classifyQuery, isGreeting } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Hand-maintained replica of the tables classifyQuery's greeting path touches.
// Same caveat as doctorRead/medicalContract: if production DDL drifts, update
// this — device is the real migration proof.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

export async function runGreetingTests() {
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

  console.log(`\n${BOLD}-- Greeting Contract Tests -----------------------------${RESET}`);

  // ── G1: bare "Hello" — no ai_name configured
  {
    freshDB();
    const d = await classifyQuery('Hello');
    assert('G1 bare Hello routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G2: bare "Hi"
  {
    freshDB();
    const d = await classifyQuery('Hi');
    assert('G2 bare Hi routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G3: bare "Hey"
  {
    freshDB();
    const d = await classifyQuery('Hey');
    assert('G3 bare Hey routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G4: "Hello Kit" — ai_name = Kit
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('Hello Kit');
    assert('G4 Hello+Kit routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G5: "Hi Kit" — ai_name = Kit
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('Hi Kit');
    assert('G5 Hi+Kit routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G6: "Hey Kit" — ai_name = Kit
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('Hey Kit');
    assert('G6 Hey+Kit routes greeting', d.reason, (v) => v === 'greeting', 'greeting');
  }

  // ── G7: another configured name works with zero code changes — ai_name = Obi
  {
    freshDB();
    setProfileField('ai_name', 'Obi');
    const d = await classifyQuery('Hello Obi');
    assert('G7 Hello+Obi routes greeting (no code change needed)', d.reason,
      (v) => v === 'greeting', 'greeting');
  }

  // ── G8: response uses first name when profile name is set
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    setProfileField('name', 'Margaret Sullivan');
    const d = await classifyQuery('Hello Kit');
    assert('G8 response uses first name only', d.tier1Response,
      (v) => v === "Hi Margaret — I'm here.", "Hi Margaret — I'm here.");
  }

  // ── G9: response falls back gracefully with no profile name set
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('Hello Kit');
    assert('G9 response falls back without a name', d.tier1Response,
      (v) => v === "Hi — I'm here.", "Hi — I'm here.");
  }

  // ── G10 (negative): unrelated text containing a name-shaped word never becomes a greeting
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('I need a first aid kit');
    assert('G10 "kit" mid-sentence is not a greeting', d.reason,
      (v) => v !== 'greeting', 'not greeting');
  }

  // ── G11 (negative): greeting addressed to a name OTHER than the configured
  // ai_name stays unmatched — deliberate scope boundary, not a bug
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    const d = await classifyQuery('Hello Herald');
    assert('G11 Hello+wrong-name does not route greeting', d.reason,
      (v) => v !== 'greeting', 'not greeting (falls through unchanged)');
  }

  // ── G12 (negative): greeting never mutates ai_name — setProfileField is
  // never reachable from this path, confirmed by inspection; this asserts the
  // observable side effect (ai_name unchanged) rather than the code path
  {
    freshDB();
    setProfileField('ai_name', 'Kit');
    await classifyQuery('Hello Kit');
    const { getProfileField } = await import('../../src/db/profileDB.ts');
    assert('G12 ai_name unchanged after greeting', getProfileField('ai_name'),
      (v) => v === 'Kit', 'Kit');
  }

  // ── G13 (unit-level): isGreeting direct — bare greeting, no aiName
  {
    assert('G13 isGreeting("Hello", null) is true', isGreeting('Hello', null),
      (v) => v === true, 'true');
  }

  // ── G14 (unit-level): isGreeting direct — negative, unrelated text
  {
    assert('G14 isGreeting("I need a kit", "Kit") is false', isGreeting('I need a kit', 'Kit'),
      (v) => v === false, 'false');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Greeting: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('greeting.test.ts')) {
  runGreetingTests().catch(console.error);
}
