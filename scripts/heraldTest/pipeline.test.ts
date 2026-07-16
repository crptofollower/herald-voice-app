// scripts/heraldTest/pipeline.test.ts
// P-tests (S54 addendum Q4): the full capture→route→confirm→commit→read chain
// through the REAL processUtterance + ConversationSession against better-sqlite3.
// Multi-turn scripts; assertions on BOTH response text and SQL rows.
// These PIN CURRENT BEHAVIOR — including known Hazard E defects, marked DEFECT
// below. S-CONFIRM flips the DEFECT pins deliberately, RED-first. Do not "fix"
// anything here.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, fact TEXT NOT NULL, category TEXT,
    confidence TEXT, source_date TEXT, use_count INTEGER DEFAULT 0,
    last_used TEXT, context_type TEXT, valid_until TEXT, importance_score INTEGER
  );
`;

function makeShim(db) {
  // Reads are TOLERANT: classification touches tables this harness doesn't
  // create (calendar/profile/facts) — degrade to empty, same as run.mjs's
  // top-level shim. Writes are STRICT: a failed write must throw, never be
  // silently swallowed (Data Loss Priority #1).
  return {
    getAllSync: (s, p = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s, p = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}

function freshPipeline() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const deps = {
    classifyQuery,
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),   // Session W swaps this stub for the live classifier
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text) => processUtterance(text, session, deps);
  const rows = () => db.prepare(`SELECT name, relationship FROM contacts WHERE removed_at IS NULL`).all();
  return { db, session, say, rows };
}

export async function runPipelineTests() {
  const failures = [];
  let passed = 0;
  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}? PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}? FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Pipeline P-Tests (processUtterance, multi-turn) -------${RESET}\n`);

  // ── P1: the BUG B/C script, end to end (would have caught S53's BUG C) ──
  {
    const { say, rows } = freshPipeline();
    const t1 = await say('my wife is Shannon');
    assert('P1a wife capture asks confirm naming Shannon', t1, (v) => v.handled === true && v.responseText.includes('Shannon') && v.responseText.includes('wife'), 'handled, prompt names Shannon/wife');
    assert('P1b nothing written before confirm (ACK-matches-commit)', rows().length, (v) => v === 0, '0 rows');
    const t2 = await say('yes');
    assert('P1c yes commits with verified ack', t2, (v) => v.handled === true && v.responseText.includes('Shannon'), 'committed ack names Shannon');
    assert('P1d one contact row after commit', rows(), (v) => v.length === 1 && v[0].relationship === 'wife', '1 row, wife');
    const t3 = await say('my daughter is Shannon');
    assert('P1e daughter capture asks confirm', t3, (v) => v.handled === true && v.responseText.includes('daughter'), 'prompt names daughter');
    await say('yes');
    assert('P1f two rows — wife survived same-name daughter (BUG B)', rows().length, (v) => v === 2, '2 rows');
    const t4 = await say('tell me about my family');
    assert('P1g family read is a device_read', t4, (v) => v.handled === false && v.routeDecision.kind === 'device_read', 'device_read');
    assert('P1h overview shows both relationships (BUG C)', t4.handled === false && t4.routeDecision.kind === 'device_read' ? t4.routeDecision.response : '', (v) => v.includes('wife') && v.includes('daughter'), 'includes wife and daughter');
    assert('P1i overview lists Shannon twice (two people)', t4.handled === false && t4.routeDecision.kind === 'device_read' ? (t4.routeDecision.response.match(/Shannon/g) || []).length : 0, (v) => v === 2, 'count 2');
  }

  // ── P2: the BUG D script (have-form; would have caught S53's BUG D) ──
  {
    const { say, rows } = freshPipeline();
    const t1 = await say('I have a son named Hunter');
    assert('P2a have-form capture asks confirm naming Hunter', t1, (v) => v.handled === true && v.responseText.includes('Hunter'), 'prompt names Hunter');
    await say('yes');
    assert('P2b Hunter/son row written', rows(), (v) => v.some((r) => r.name === 'Hunter' && r.relationship === 'son'), 'Hunter/son present');
    const t2 = await say('I have another son named Grant');
    assert('P2c second confirm names GRANT, never Hunter (S53 device symptom)', t2, (v) => v.handled === true && v.responseText.includes('Grant') && !v.responseText.includes('Hunter'), 'prompt names Grant only');
    await say('yes');
    assert('P2d Grant/son row written', rows(), (v) => v.some((r) => r.name === 'Grant' && r.relationship === 'son'), 'Grant/son present');
    const t3 = await say('I have a son named Bob and another son named Tom');
    assert('P2e have-form compound defers, no half-capture (C19 at pipeline level)', t3.handled, (v) => v === false, 'handled false');
    assert('P2f compound wrote nothing', rows(), (v) => v.length === 2 && !v.some((r) => r.name === 'Bob' || r.name === 'Tom'), 'still 2 rows, no Bob/Tom');
  }

  // ── P3: Law 2 pins (S-DISCLOSE confirm-primitive, S60 build arc) ──
  {
    const { say, rows, session } = freshPipeline();
    const t1 = await say('my wife is Shannon');
    assert('P3a pending confirm live', t1, (v) => v.handled === true && v.responseText.includes('wife'), 'confirm prompt');
    const t2 = await say('ok my daughter is Shannon');
    assert('P3b Law 2: unresolvable reply re-asks — does NOT re-route as a fresh capture', t2, (v) => v.handled === true && v.source === 'pending_resume', 'pending_resume, not fresh capture');
    assert('P3b2 wife-pending stays pending — never leaks', session.hasPending(), (v) => v === true, 'true');
    assert('P3c nothing committed yet', rows().length, (v) => v === 0, '0 rows');
    const t3 = await say('yes');
    assert('P3d original wife pending still resolves on a real yes', t3, (v) => v.handled === true && v.responseText.includes('Shannon'), 'commits Shannon');
    assert('P3e one contact row after commit', rows(), (v) => v.length === 1 && v[0].relationship === 'wife', '1 row, wife');
  }
  {
    const { say, rows } = freshPipeline();
    await say('my wife is Shannon');
    const t1 = await say('no');
    assert('P3d NO branch asks for the correct name', t1, (v) => v.handled === true && v.responseText.toLowerCase().includes('correct name'), 'asks correct name');
    await say('Karen');
    assert('P3e E3 FIXED: bare-name correction commits Karen under the original relation', rows(), (v) => v.length === 1 && v[0].name === 'Karen' && v[0].relationship === 'wife', '1 row, Karen/wife');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Pipeline: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}
