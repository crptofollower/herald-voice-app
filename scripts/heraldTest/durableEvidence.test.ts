// scripts/heraldTest/durableEvidence.test.ts
// Durable Evidence Substrate V1 — SQLite storage contract only.
// Proves unconfirmed evidence persists without mutating domain truth.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import {
  persistEvidence,
  getEvidenceById,
  listActiveEvidence,
} from '../../src/db/evidenceDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const REMEMBER_FRANK =
  'Remember the guy I had dinner with that Mickey set up. His name was Frank.';

function makeShim(db) {
  return {
    getAllSync: (s, p = []) => db.prepare(s).all(...p),
    getFirstSync: (s, p = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get().n;
}

export async function runDurableEvidenceTests() {
  const failures = [];
  let passed = 0;

  function assertTrue(label, cond) {
    if (cond) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
      failures.push({ label });
    }
  }

  console.log(`\n${BOLD}-- Durable Evidence Substrate V1 -----------------------${RESET}\n`);

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();

    const payload = JSON.stringify({ title: 'Dentist', start: '2026-09-22T14:00:00.000Z' });
    const first = persistEvidence({
      sourceClass: 'external_source',
      sourceKind: 'calendar',
      sourceId: 'cal_evt_abc',
      rawText: payload,
      observedAt: '2026-09-21T20:00:00.000Z',
    });
    assertTrue('external: persists as external_source', first.sourceClass === 'external_source');
    assertTrue('external: source kind is calendar', first.sourceKind === 'calendar');
    assertTrue('external: source id provenance survives persist', first.sourceId === 'cal_evt_abc');
    const roundTrip = getEvidenceById(first.id);
    assertTrue('external: getById returns the same stable id', roundTrip?.id === first.id);
    assertTrue('external: provenance survives round trip', roundTrip?.sourceClass === 'external_source' && roundTrip?.sourceKind === 'calendar' && roundTrip?.sourceId === 'cal_evt_abc');
    assertTrue('external: raw payload survives without fabrication', roundTrip?.rawText === payload);
    assertTrue('external: observed_at survives', roundTrip?.observedAt === '2026-09-21T20:00:00.000Z');

    const second = persistEvidence({
      sourceClass: 'external_source',
      sourceKind: 'calendar',
      sourceId: 'cal_evt_abc',
      rawText: JSON.stringify({ title: 'Should not mint a second row' }),
    });
    assertTrue('external: same source observation reinsert returns the same id', second.id === first.id);
    assertTrue('external: reinsert does not duplicate', count(db, 'evidence') === 1);
    assertTrue('external: reinsert does not overwrite original payload', getEvidenceById(first.id)?.rawText === payload);

    const unnamedA = persistEvidence({
      sourceClass: 'external_source',
      sourceKind: 'calendar',
      rawText: payload,
    });
    const unnamedB = persistEvidence({
      sourceClass: 'external_source',
      sourceKind: 'calendar',
      rawText: payload,
    });
    assertTrue('external: missing source id is not invented, so two observations stay distinct', unnamedA.id !== unnamedB.id && count(db, 'evidence') === 3);

    const listed = listActiveEvidence({ sourceClass: 'external_source', sourceKind: 'calendar', sourceId: 'cal_evt_abc' });
    assertTrue('external: selector by source id returns the one identified observation', listed.length === 1 && listed[0].id === first.id);

    assertTrue('external: writes no medical_records', count(db, 'medical_records') === 0);
    assertTrue('external: writes no facts', count(db, 'facts') === 0);
    assertTrue('external: writes no contacts', count(db, 'contacts') === 0);
    assertTrue('external: writes no entities', count(db, 'entities') === 0);
    assertTrue('external: writes no people', count(db, 'people') === 0);
    assertTrue('external: writes no notes', count(db, 'notes') === 0);
    assertTrue('external: writes no observations', count(db, 'observations') === 0);
    assertTrue('external: writes no appointments', count(db, 'appointments') === 0);
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();

    const stored = persistEvidence({
      sourceClass: 'user_explicit',
      sourceKind: 'remember',
      rawText: REMEMBER_FRANK,
    });
    assertTrue('user-explicit: source class is user_explicit', stored.sourceClass === 'user_explicit');
    assertTrue('user-explicit: SQLite round trip keeps raw text intact', getEvidenceById(stored.id)?.rawText === REMEMBER_FRANK);
    assertTrue('user-explicit: no source id invented', stored.sourceId === null);

    const again = persistEvidence({
      sourceClass: 'user_explicit',
      sourceKind: 'remember',
      rawText: REMEMBER_FRANK,
    });
    assertTrue('user-explicit: two authorized identical remember acts remain distinct', again.id !== stored.id && count(db, 'evidence') === 2);

    const sameCapture = persistEvidence({
      sourceClass: 'user_explicit',
      sourceKind: 'remember',
      rawText: REMEMBER_FRANK,
      captureId: stored.id,
    });
    assertTrue('user-explicit: same capture identity does not mint a third row', sameCapture.id === stored.id && count(db, 'evidence') === 2);

    const byClass = listActiveEvidence({ sourceClass: 'user_explicit' });
    assertTrue('user-explicit: class selector returns both distinct acts', byClass.length === 2);

    const contacts = db.prepare('SELECT name FROM contacts').all();
    const facts = db.prepare('SELECT fact FROM facts').all();
    const people = db.prepare('SELECT name FROM people').all();
    const entities = db.prepare('SELECT name FROM entities').all();
    const notes = db.prepare('SELECT body FROM notes').all();
    const blob = JSON.stringify({ contacts, facts, people, entities, notes });
    assertTrue('user-explicit: does not mint Frank or Mickey contacts', contacts.length === 0 && !/frank|mickey/i.test(blob));
    assertTrue('user-explicit: does not mint facts or relationships', facts.length === 0 && count(db, 'entity_relationships') === 0);
    assertTrue('user-explicit: does not mint people/entities', people.length === 0 && entities.length === 0);
    assertTrue('user-explicit: does not become a notes row', notes.length === 0);
    assertTrue('user-explicit: writes no medical_records', count(db, 'medical_records') === 0);
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    db.prepare(`INSERT INTO medical_records (id, doctor_name, created_at, status) VALUES ('mr_seed', 'Dr. Smith', datetime('now'), 'noted');`).run();
    db.prepare(`INSERT INTO facts (id, fact, category, confidence, source_date) VALUES ('f_seed', 'coffee in the morning', 'preference', 'stated', datetime('now'));`).run();
    db.prepare(`INSERT INTO contacts (id, name, created_at, updated_at) VALUES ('c_seed', 'Pat', datetime('now'), datetime('now'));`).run();
    db.prepare(`INSERT INTO notes (id, body, created_at, updated_at) VALUES ('n_seed', 'buy milk', datetime('now'), datetime('now'));`).run();
    db.prepare(`INSERT INTO observations (id, observation, created_at) VALUES ('o_seed', 'seems tired', datetime('now'));`).run();

    persistEvidence({
      sourceClass: 'user_explicit',
      sourceKind: 'remember',
      rawText: REMEMBER_FRANK,
    });
    persistEvidence({
      sourceClass: 'external_source',
      sourceKind: 'calendar',
      sourceId: 'cal_evt_iso',
      rawText: '{"title":"Lunch"}',
    });

    assertTrue('isolation: medical_records seed unchanged', count(db, 'medical_records') === 1);
    assertTrue('isolation: facts seed unchanged', count(db, 'facts') === 1);
    assertTrue('isolation: contacts seed unchanged', count(db, 'contacts') === 1);
    assertTrue('isolation: notes seed unchanged', count(db, 'notes') === 1);
    assertTrue('isolation: observations seed unchanged', count(db, 'observations') === 1);
    assertTrue('isolation: evidence holds two authorized rows only', count(db, 'evidence') === 2);
    const missing = getEvidenceById('ev_does_not_exist');
    assertTrue('getById: unknown id is null', missing === null);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}DurableEvidence: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('durableEvidence.test.ts')) {
  runDurableEvidenceTests().catch(console.error);
}
