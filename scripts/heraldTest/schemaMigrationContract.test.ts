// scripts/heraldTest/schemaMigrationContract.test.ts
// Schema v19 migration contract — MEDICAL_SURFACING_DESIGN_SPEC §2.1, Commit B.
//
// Two scenarios, both must land at v19 with the same shape:
//   1. Fresh install — runs the REAL migration chain (v1→v19) via the actual
//      exported runMigrations(). Strongest proof: no hand-replica DDL involved.
//   2. Upgrade from v18 — a hand-maintained replica of the v18 end-state
//      schema (same caveat as medicalContract/diagnosisContract: only the
//      DEVICE test proves the real upgrade path) with schema_meta pre-stamped
//      at 18, then runMigrations() applies only v19.
//
// Both paths must be idempotent (re-running never throws — CLAUDE.md
// "Schema migrations are high-risk events" / re-run safety).

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function makeShim(db) {
  return {
    getAllSync: (s, p = []) => db.prepare(s).all(...p),
    getFirstSync: (s, p = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s, p = []) => db.prepare(s).run(...p),
    execSync: (s) => db.exec(s),
  };
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table});`).all().map(r => r.name);
}

// Hand-maintained replica of the v1-through-v18 end state for medical_records
// and medical_contacts ONLY (the two tables v19 touches). Caveat: if production
// schema.ts changes these tables' pre-v19 shape, update this replica —
// otherwise this test passes while production drifts. Only the DEVICE test
// (spec §2.5) proves the real upgrade path.
const V18_REPLICA_SQL = `
  CREATE TABLE medical_records (
    id TEXT PRIMARY KEY, visit_date TEXT, doctor_name TEXT, facility TEXT,
    reason TEXT, diagnosis TEXT, follow_up TEXT, notes TEXT, created_at TEXT,
    removed_at TEXT
  );
  CREATE TABLE medical_contacts (
    id TEXT PRIMARY KEY, name TEXT, specialty TEXT, phone TEXT, address TEXT,
    is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT
  );
`;

export async function runSchemaMigrationContractTests() {
  const failures = [];
  let passed = 0;

  function assert(label, got, check, expected) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Schema Migration Contract (v19) -----------------------${RESET}\n`);

  // ── SM1-4: Fresh install runs the REAL migration chain to v19 ──────────────
  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();

    const meta = db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1;').get();
    assert('SM1 fresh install lands at schema_meta v19', meta?.version, v => v === 19, 19);

    const mrCols = columnNames(db, 'medical_records');
    assert('SM2 fresh install: medical_records has status', mrCols.includes('status'), v => v === true, true);
    assert('SM3 fresh install: medical_records has surfaced_at', mrCols.includes('surfaced_at'), v => v === true, true);

    const mcCols = columnNames(db, 'medical_contacts');
    assert('SM4 fresh install: medical_contacts has removed_at', mcCols.includes('removed_at'), v => v === true, true);
  }

  // ── SM5: Fresh install is idempotent (re-run never throws) ─────────────────
  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    let threw = false;
    try { await runMigrations(); } catch { threw = true; }
    assert('SM5 fresh install re-run is idempotent (no throw)', threw, v => v === false, false);
  }

  // ── SM6-9: Upgrade from v18 applies ONLY v19, existing rows survive ────────
  {
    const db = new Database(':memory:');
    db.exec(V18_REPLICA_SQL);
    db.exec(`CREATE TABLE schema_meta (version INTEGER NOT NULL, migrated_at TEXT NOT NULL);`);
    db.prepare(`INSERT INTO schema_meta (version, migrated_at) VALUES (18, datetime('now'));`).run();
    // Seed a pre-existing visit — must survive migration untouched except the
    // new status column defaulting per spec §2.1 ("existing rows: status
    // defaults to 'noted' — correct, they are all past visits").
    db.prepare(`INSERT INTO medical_records (id, doctor_name, diagnosis, created_at) VALUES ('mr_1', 'Dr. Sarver', 'flu', datetime('now'));`).run();

    setDB(makeShim(db));
    await runMigrations();

    const meta = db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1;').get();
    assert('SM6 upgrade from v18 lands at v19', meta?.version, v => v === 19, 19);

    const mrCols = columnNames(db, 'medical_records');
    assert('SM7 upgrade: medical_records gains status + surfaced_at', 
      mrCols.includes('status') && mrCols.includes('surfaced_at'), v => v === true, true);

    const existingRow = db.prepare(`SELECT status, diagnosis FROM medical_records WHERE id = 'mr_1';`).get();
    assert('SM8 upgrade: existing row untouched, status defaults to noted', existingRow?.status,
      v => v === 'noted', '"noted"');
    assert('SM9 upgrade: existing row diagnosis unchanged (no data loss)', existingRow?.diagnosis,
      v => v === 'flu', '"flu"');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Schema Migration Contract: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('schemaMigrationContract.test.ts')) {
  runSchemaMigrationContractTests().catch(console.error);
}
