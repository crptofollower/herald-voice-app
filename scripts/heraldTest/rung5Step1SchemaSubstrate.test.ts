// Rung 5 Step 1 — schema substrate DDL contract.
// Paper: RUNG5_STEP1_PAPER_AMENDMENT_2026-09-22.md §4.
// D-1 Option (a): episodes keep category AND domain. No edge confidence.

import Database from 'better-sqlite3';
import { setDB, runMigrations, SCHEMA_VERSION } from '../../src/db/schema.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const EPISODES_COLUMNS = [
  'id',
  'raw_phrase',
  'occurred_at',
  'occurred_precision',
  'captured_at',
  'category',
  'domain',
  'salience',
  'sentiment',
  'source',
  'score',
  'embedding_ref',
  'removed_at',
];

const ENTITY_RELATIONSHIPS_ORIGINAL = [
  'id',
  'from_entity',
  'relation',
  'to_entity',
  'created_at',
];

const ENTITY_RELATIONSHIPS_V24 = [
  'stated_as',
  'raw_phrase',
  'source',
  'ended_at',
  'removed_at',
];

const UNTOUCHED_TABLES: Record<string, string[]> = {
  facts: [
    'id', 'fact', 'category', 'confidence', 'source_date', 'last_used', 'use_count',
    'entity_id', 'importance_score', 'valid_until', 'context_type',
  ],
  evidence: [
    'id', 'source_class', 'source_kind', 'source_id', 'raw_text', 'observed_at', 'event_at', 'removed_at',
  ],
  medical_records: [
    'id', 'visit_date', 'doctor_name', 'facility', 'reason', 'diagnosis', 'follow_up',
    'notes', 'created_at', 'removed_at', 'status', 'surfaced_at', 'visit_outcome', 'outcome_asked_at',
  ],
  appointments: [
    'id', 'title', 'category', 'appt_date', 'appt_date_precision', 'end_date', 'location',
    'notes', 'source', 'external_id', 'raw_phrase', 'status', 'created_at', 'updated_at', 'removed_at',
  ],
  contacts: [
    'id', 'name', 'relationship', 'phone', 'email', 'birthday', 'importance', 'entity_id',
    'os_contact_id', 'notes', 'last_contact', 'created_at', 'updated_at', 'address',
    'is_emergency', 'removed_at', 'location',
  ],
  entities: [
    'id', 'name', 'type', 'notes', 'created_at', 'updated_at',
  ],
};

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function tableInfo(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info(${table});`).all() as {
    cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }[];
}

function columnNames(db: Database.Database, table: string) {
  return tableInfo(db, table).map((r) => r.name);
}

export async function runRung5Step1SchemaSubstrateTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Rung 5 Step 1 schema substrate (v24 + v25 evidence.removed_at) --${RESET}\n`);

  assert('SCHEMA_VERSION export is 25', SCHEMA_VERSION, (v) => v === 25, '25');

  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();

  const meta = db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1;').get() as { version: number };
  assert('schema_meta top version is 25', meta?.version, (v) => v === 25, '25');

  const episodeInfo = tableInfo(db, 'episodes');
  assert('episodes column names are the ratified v19 shape plus domain',
    episodeInfo.map((c) => c.name), (v) => JSON.stringify(v) === JSON.stringify(EPISODES_COLUMNS), JSON.stringify(EPISODES_COLUMNS));
  const idCol = episodeInfo.find((c) => c.name === 'id');
  assert('episodes.id is PRIMARY KEY', idCol?.pk, (v) => v === 1, '1');
  assert('episodes.raw_phrase is NOT NULL',
    episodeInfo.find((c) => c.name === 'raw_phrase')?.notnull, (v) => v === 1, '1');
  assert('episodes.captured_at is NOT NULL',
    episodeInfo.find((c) => c.name === 'captured_at')?.notnull, (v) => v === 1, '1');
  assert('episodes keeps category (D-1 option a)',
    episodeInfo.some((c) => c.name === 'category'), (v) => v === true, 'true');
  assert('episodes has domain as memory_importance join key (D-1 option a)',
    episodeInfo.some((c) => c.name === 'domain'), (v) => v === true, 'true');
  assert('episodes.removed_at is present (soft delete day one)',
    episodeInfo.some((c) => c.name === 'removed_at'), (v) => v === true, 'true');
  assert('episodes.embedding_ref is present and nullable',
    episodeInfo.find((c) => c.name === 'embedding_ref')?.notnull, (v) => v === 0, '0');
  assert('episodes has no confidence column',
    episodeInfo.some((c) => c.name === 'confidence'), (v) => v === false, 'false');

  const edgeCols = columnNames(db, 'entity_relationships');
  assert('entity_relationships preserves original v3 columns',
    ENTITY_RELATIONSHIPS_ORIGINAL.every((c) => edgeCols.includes(c)), (v) => v === true, 'true');
  assert('entity_relationships has all five provenance/supersession columns',
    ENTITY_RELATIONSHIPS_V24.every((c) => edgeCols.includes(c)), (v) => v === true, 'true');
  assert('entity_relationships has no confidence column',
    edgeCols.includes('confidence'), (v) => v === false, 'false');

  for (const [table, expected] of Object.entries(UNTOUCHED_TABLES)) {
    const cols = columnNames(db, table);
    assert(`current schema does not alter ${table} columns beyond ratified additions`,
      cols, (v) => JSON.stringify(v) === JSON.stringify(expected), JSON.stringify(expected));
  }

  let threw = false;
  try { await runMigrations(); } catch { threw = true; }
  assert('v25 re-run is a no-op and does not throw', threw, (v) => v === false, 'false');
  const metaAfter = db.prepare('SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1;').get() as { version: number };
  assert('re-run leaves schema_meta at 25', metaAfter?.version, (v) => v === 25, '25');
  assert('re-run does not duplicate episodes columns',
    columnNames(db, 'episodes'), (v) => JSON.stringify(v) === JSON.stringify(EPISODES_COLUMNS), JSON.stringify(EPISODES_COLUMNS));

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Rung5Step1SchemaSubstrate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('rung5Step1SchemaSubstrate.test.ts')) {
  runRung5Step1SchemaSubstrateTests().catch(console.error);
}
