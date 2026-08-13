// scripts/heraldTest/phoneConfirm.test.ts
// D-phone-confirm, 2026-08-13 — regression coverage for the M1 mechanism
// fix: spoken phone numbers must not become authoritative memory solely
// because they contain 10 syntactically valid digits.
//
// Scope: phone_capture and emergency_contact writers only (the two proven,
// device-relevant call sites for this commit). service_capture and the
// dial-path collect stages are explicitly deferred — see state doc.
//
// These tests exercise DOMAIN_WRITERS directly (add -> resume), the same
// pattern contact_call.test.ts / matchCandidate.test.ts use, without going
// through ConversationSession — the writer's own pending/resume contract is
// what's under test here, not the session-level correction ladder (that is
// conversationalRepair.test.ts's job and is intentionally untouched by this
// commit).
//
// Runner: npx tsx --tsconfig ./tsconfig.json ./phoneConfirm.test.ts

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { findContactByName, getEmergencyContact } from '../../src/db/contactsDB.ts';
import { normalizePhone } from '../../src/utils/phone.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT, phone TEXT,
    email TEXT, birthday TEXT, importance INTEGER DEFAULT 5, entity_id TEXT,
    os_contact_id TEXT, notes TEXT, last_contact TEXT, created_at TEXT,
    updated_at TEXT, address TEXT, removed_at TEXT, location TEXT, is_emergency INTEGER DEFAULT 0
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

function contactCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE removed_at IS NULL`).get() as { n: number }).n;
}

export async function runPhoneConfirmTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }
  console.log(`\n${BOLD}-- Phone Confirm (D-phone-confirm, M1) -------------------${RESET}\n`);

  // ═══════════════════════════════════════════════════════════════════════
  // PC1–PC2: valid capture -> pending -> YES commits exactly once
  // ═══════════════════════════════════════════════════════════════════════
  {
    const db = freshDB();
    const intent = { type: 'phone_capture', name: 'Sarah', phone: '2145550100' } as IntentRecord;
    const armed = await DOMAIN_WRITERS.phone_capture!.add(intent, "Sarah's number is 214-555-0100");

    assert('PC1a valid capture returns pending, not committed', armed,
      v => (v as any).status === 'pending', 'pending');
    assert('PC1b pendingKey is phone_confirm', armed,
      v => (v as any).pendingKey === 'phone_confirm', 'phone_confirm');
    assert('PC1c read-back prompt names Sarah and the formatted number', armed,
      v => typeof (v as any).prompt === 'string'
        && /Sarah/.test((v as any).prompt) && /214.*555.*0100/.test((v as any).prompt),
      'prompt contains Sarah and 214-555-0100 formatted');
    assert('PC1d candidate not written before confirmation', contactCount(db), v => v === 0, '0 contacts');

    if (armed.status !== 'pending') throw new Error('expected pending');
    const committed = await armed.resume('yes');

    assert('PC2a YES commits', committed, v => (v as any).status === 'committed', 'committed');
    assert('PC2b commit ack contains formatted number', committed,
      v => /214.*555.*0100/.test((v as any).ack), 'ack contains 214-555-0100');
    assert('PC2c committed contact has correct digits', findContactByName('Sarah'),
      v => !!v && (v as any).phone === '2145550100', 'Sarah / 2145550100');
    assert('PC2d commits exactly once (no duplicate row)', contactCount(db), v => v === 1, '1 contact');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PC3: NO/cancel writes nothing
  // ═══════════════════════════════════════════════════════════════════════
  {
    const db = freshDB();
    const intent = { type: 'phone_capture', name: 'Marcus', phone: '9725550199' } as IntentRecord;
    const armed = await DOMAIN_WRITERS.phone_capture!.add(intent, 'raw');
    if (armed.status !== 'pending') throw new Error('expected pending');
    const rejected = await armed.resume('no');

    assert('PC3a NO returns noop, not committed', rejected,
      v => (v as any).status === 'noop', 'noop');
    assert('PC3b NO writes nothing', contactCount(db), v => v === 0, '0 contacts');
    assert('PC3c findContactByName confirms no row', findContactByName('Marcus'),
      v => v == null, 'null');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PC4: wrong-but-valid ("214-55-01000") — device-found regression.
  // detectPhoneCapture normalizes upstream, so the writer receives the
  // already-10-digit result of normalizePhone('214-55-01000').
  // ═══════════════════════════════════════════════════════════════════════
  {
    const db = freshDB();
    const wrongButValid = normalizePhone('214-55-01000');
    if (!wrongButValid.valid) throw new Error('fixture assumption broken — 214-55-01000 no longer normalizes to 10 digits');
    const intent = { type: 'phone_capture', name: 'Sarah', phone: wrongButValid.normalized } as IntentRecord;
    const armed = await DOMAIN_WRITERS.phone_capture!.add(intent, "Sarah's number is 214-55-01000");

    assert('PC4a wrong-but-valid 10-digit capture is accepted as a candidate (pending)', armed,
      v => (v as any).status === 'pending', 'pending');
    assert('PC4b wrong-but-valid candidate not written before confirmation', contactCount(db),
      v => v === 0, '0 contacts');

    if (armed.status !== 'pending') throw new Error('expected pending');
    const committed = await armed.resume('yes');
    assert('PC4c mechanism confirms exactly the read-back candidate, invents nothing',
      findContactByName('Sarah'),
      v => !!v && (v as any).phone === wrongButValid.normalized,
      `Sarah / ${wrongButValid.normalized}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PC5–PC6: emergency_contact WITH a phone uses the same confirm gate
  // ═══════════════════════════════════════════════════════════════════════
  {
    freshDB();
    const intent = { type: 'emergency_contact', name: 'Helen', phone: '2145550188' } as IntentRecord;
    const armed = await DOMAIN_WRITERS.emergency_contact!.add(intent, 'raw');

    assert('PC5a emergency contact with phone returns pending, not committed', armed,
      v => (v as any).status === 'pending', 'pending');
    assert('PC5b emergency candidate not persisted before confirmation', getEmergencyContact(),
      v => v == null, 'null');

    if (armed.status !== 'pending') throw new Error('expected pending');
    const committed = await armed.resume('yes');
    assert('PC5c YES commits emergency contact', committed,
      v => (v as any).status === 'committed', 'committed');
    assert('PC5d getEmergencyContact matches name/phone', getEmergencyContact(),
      v => !!v && (v as any).name === 'Helen' && (v as any).phone === '2145550188',
      'Helen / 2145550188');
  }
  {
    freshDB();
    const intent = { type: 'emergency_contact', name: 'Robert', phone: '9725550177' } as IntentRecord;
    const armed = await DOMAIN_WRITERS.emergency_contact!.add(intent, 'raw');
    if (armed.status !== 'pending') throw new Error('expected pending');
    const rejected = await armed.resume('no');

    assert('PC6a NO on emergency contact returns noop', rejected,
      v => (v as any).status === 'noop', 'noop');
    assert('PC6b wrong-but-valid emergency number never silently persists', getEmergencyContact(),
      v => v == null, 'null');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PC7: emergency_contact WITHOUT a phone — pre-existing direct-commit
  // behavior preserved unchanged (nothing high-entropy to confirm).
  // ═══════════════════════════════════════════════════════════════════════
  {
    freshDB();
    const intent = { type: 'emergency_contact', name: 'Uncle Ray' } as IntentRecord;
    const armed = await DOMAIN_WRITERS.emergency_contact!.add(intent, 'raw');

    assert('PC7a no-phone emergency contact commits immediately (unchanged)', armed,
      v => (v as any).status === 'committed', 'committed');
    assert('PC7b getEmergencyContact reflects direct commit', getEmergencyContact(),
      v => !!v && (v as any).name === 'Uncle Ray', 'Uncle Ray');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Phone Confirm: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('phoneConfirm.test.ts')) {
  runPhoneConfirmTests().catch(console.error);
}
