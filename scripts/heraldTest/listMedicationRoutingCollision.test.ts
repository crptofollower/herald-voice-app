// List / Medication routing collision V1 — list-removal language must not
// become medication capture (especially structural "off" as drug name).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  detectMedicalEvent,
  extractDrugName,
  isListRemovalOperatorShape,
} from '../../src/utils/detectMedicalEvent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    text TEXT NOT NULL,
    done INTEGER DEFAULT 0,
    created_at TEXT
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

function freshDB() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  return db;
}

export async function runListMedicationRoutingCollisionTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- List / Medication Routing Collision V1 ----------------${RESET}\n`);

  freshDB();

  // A — existing guarded list remove
  {
    const phrase = 'take chocolate milk off my grocery list';
    const ev = detectMedicalEvent(phrase);
    const route = await classifyQuery(phrase);
    assert('LMRC-A1 guarded list phrase is not medical event',
      ev,
      v => v == null,
      'null');
    assert('LMRC-A2 guarded list phrase routes list_remove',
      route.actionIntent?.type,
      v => v === 'list_remove',
      'list_remove');
  }

  // B — colloquial take-X-off (no explicit list token)
  for (const phrase of ['take chocolate milk off', 'take eggs off']) {
    assert(`LMRC-B detectMedicalEvent null for "${phrase}"`,
      detectMedicalEvent(phrase),
      v => v == null,
      'not medical');
    assert(`LMRC-B isListRemovalOperatorShape true for "${phrase}"`,
      isListRemovalOperatorShape(phrase),
      v => v === true,
      'list-removal shape');
    const route = await classifyQuery(phrase);
    assert(`LMRC-B classifyQuery not medical_capture for "${phrase}"`,
      route.actionIntent?.type,
      v => v !== 'medical_capture',
      'never medical_capture');
  }

  // C — take-off-X shape
  for (const phrase of ['take off eggs', 'take off the milk']) {
    assert(`LMRC-C detectMedicalEvent null for "${phrase}"`,
      detectMedicalEvent(phrase),
      v => v == null,
      'not medical');
    assert(`LMRC-C extractDrugName never "off" for "${phrase}"`,
      extractDrugName(phrase),
      v => v !== 'off',
      'not structural off');
  }

  // D — legitimate medication capture unchanged (Tier-H evidenced only —
  // Tier-2 closure, 2026-09-07). LMRC-D1/D2 previously relied solely on
  // candidate capitalization/lenient-trigger membership — those proxies are
  // removed; bare "I take Eliquis"/"I'm taking metformin" now abstain and
  // are eligible for the Semantic Interpretation V1 seam instead. Updated
  // to a Tier-H-evidenced pair so this file keeps proving a real, currently
  // capturable case, not a preserved-but-now-unsafe one.
  {
    assert('LMRC-D1 I take Eliquis 5 mg (dosage evidence, Tier-H)',
      detectMedicalEvent('I take Eliquis 5 mg'),
      v => (v as { type?: string; drug_name?: string } | null)?.type === 'medication'
        && (v as { drug_name?: string }).drug_name === 'Eliquis',
      'medication Eliquis');
    assert('LMRC-D1b bare "I take Eliquis" now abstains (Tier-2 closure)',
      detectMedicalEvent('I take Eliquis'),
      v => v === null,
      'null');
    assert('LMRC-D2 my doctor prescribed metformin (specialty+terminology evidence, Tier-H)',
      detectMedicalEvent('My doctor prescribed metformin'),
      v => (v as { type?: string; drug_name?: string } | null)?.type === 'medication'
        && (v as { drug_name?: string }).drug_name === 'metformin',
      'medication metformin');
    assert('LMRC-D2b bare "I\'m taking metformin" now abstains (Tier-2 closure)',
      detectMedicalEvent("I'm taking metformin"),
      v => v === null,
      'null');
    assert('LMRC-D3 doctor start taking Eliquis',
      detectMedicalEvent('My doctor told me to start taking Eliquis'),
      v => (v as { type?: string; drug_name?: string } | null)?.type === 'medication'
        && (v as { drug_name?: string }).drug_name === 'Eliquis',
      'medication Eliquis');
  }

  // E — real medication with off-language
  {
    assert('LMRC-E1 take me off Eliquis',
      detectMedicalEvent('My doctor told me to take me off Eliquis'),
      v => (v as { type?: string; drug_name?: string } | null)?.type === 'medication'
        && (v as { drug_name?: string }).drug_name === 'Eliquis',
      'medication Eliquis not off');
    // LMRC-E2 (Tier-2 closure): bare "I stopped taking Eliquis" carries no
    // Tier-H evidence either — now abstains, same disclosed consequence as
    // LMRC-D1/D2 above. The narrow discontinuation SHAPE ("take me off X",
    // LMRC-E1 above) is a distinct, unaffected Tier-H path; "stopped
    // taking X" is not that shape.
    assert('LMRC-E2 bare "I stopped taking Eliquis" now abstains (Tier-2 closure)',
      detectMedicalEvent('I stopped taking Eliquis'),
      v => v === null,
      'null');
    assert('LMRC-E3 I\'m off Eliquis now',
      detectMedicalEvent("I'm off Eliquis now"),
      v => v == null,
      'no false capture');
  }

  // F — shortened removal without list authority may fail closed, never medical
  {
    const route = await classifyQuery('take eggs off');
    assert('LMRC-F colloquial remove without list token is not medical_capture',
      route.actionIntent?.type,
      v => v !== 'medical_capture',
      'not medical_capture');
  }

  // G — structural operators never become drug name
  {
    assert('LMRC-G1 extractDrugName(take off) undefined',
      extractDrugName('take off'),
      v => v == null,
      'undefined');
    assert('LMRC-G2 extractDrugName never returns off alone',
      ['take off', 'take off eggs', 'take off the milk'].map(extractDrugName),
      v => Array.isArray(v) && v.every(d => d !== 'off'),
      'never off');
    assert('LMRC-G3 isListRemovalOperatorShape blocks take off eggs',
      isListRemovalOperatorShape('take off eggs'),
      v => v === true,
      'list-removal shape');
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1]?.endsWith('listMedicationRoutingCollision.test.ts')) {
  runListMedicationRoutingCollisionTests().catch(console.error);
}
