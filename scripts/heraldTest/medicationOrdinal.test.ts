// Medication ordinal continuation V1 — RAM presentation + deterministic first/second.
//
// Runner: npx tsx scripts/heraldTest/medicationOrdinal.test.ts
// Gate:   wired from run.mjs.

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { writeServiceProvider } from '../../src/utils/householdCapture.ts';
import { writeMedicalRecord, writeMedication, writeMedicalContact, getActiveMedications, getMedicalSummary } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import {
  MedicationPresentationHolder,
  MEDICATION_ORDINAL_CONFUSION,
  MEDICATION_ORDINAL_STALE,
} from '../../src/routing/medicationPresentation.ts';

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
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT, doctor_name TEXT, facility TEXT, reason TEXT, diagnosis TEXT,
    follow_up TEXT, notes TEXT, status TEXT DEFAULT 'noted', surfaced_at TEXT,
    visit_outcome TEXT, outcome_asked_at TEXT, removed_at TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medical_contacts (
    id TEXT PRIMARY KEY, name TEXT, specialty TEXT, phone TEXT, address TEXT,
    is_primary INTEGER DEFAULT 0, notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS medications (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dosage TEXT, frequency TEXT,
    prescribing_doctor TEXT, start_date TEXT, end_date TEXT, is_active INTEGER DEFAULT 1,
    notes TEXT, created_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS service_providers (
    id TEXT PRIMARY KEY, name TEXT, phone TEXT, category TEXT NOT NULL,
    created_at TEXT, updated_at TEXT, removed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS insurance_policies (
    id TEXT PRIMARY KEY, type TEXT, carrier TEXT, agent_name TEXT, agent_phone TEXT,
    is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
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

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  setDB(makeShim(db));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const presentation = new MedicationPresentationHolder();
  let classifyCalls = 0;
  const deps = {
    classifyQuery: async (t: string) => {
      classifyCalls++;
      return classifyQuery(t);
    },
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    captureContext: { contacts: [], lists: [] },
  };
  const say = (text: string) => processUtterance(text, session, deps, subject, presentation);
  const resetClassify = () => { classifyCalls = 0; };
  const getClassifyCalls = () => classifyCalls;
  return { db, session, subject, presentation, say, resetClassify, getClassifyCalls };
}

function seedOrderedPair(db: Database.Database) {
  const older = writeMedication({ name: 'Lisinopril', dosage: '10mg', frequency: 'daily', is_active: 1 });
  const newer = writeMedication({ name: 'Metformin', dosage: '500mg', frequency: 'twice a day', is_active: 1 });
  db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', older);
  db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-06-01T00:00:00.000Z', newer);
  return { older, newer };
}

export async function runMedicationOrdinalTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: any) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medication Ordinal Continuation V1 --------------------${RESET}\n`);

  // 1–3. Two meds, presentation order, second then first, chain survives
  {
    const { db, say, presentation, subject, resetClassify, getClassifyCalls } = fresh();
    const { older, newer } = seedOrderedPair(db);
    const ordered = getActiveMedications().map((m) => m.id);
    assert('MO1 list order is created_at DESC (Metformin then Lisinopril)', ordered,
      v => v[0] === newer && v[1] === older, 'newer, older');

    const summary = await say('What medications am I taking?');
    assert('MO2 summary is medical:summary device_read', summary,
      v => v.handled === false && v.routeDecision.kind === 'device_read' && v.routeDecision.reason === 'medical:summary',
      'medical:summary');
    assert('MO3 summary phrasing unchanged (two-med list)', getMedicalSummary(),
      v => v === "You're currently on 2 medications: Metformin 500mg, twice a day; Lisinopril 10mg, daily.",
      'verbatim two-med summary');
    assert('MO4 presentation captures that order', presentation.peek()?.medicationIds,
      v => Array.isArray(v) && v[0] === newer && v[1] === older, 'ids in spoken order');
    assert('MO5 transient state is IDs only', presentation.peek(),
      v => v != null && Object.keys(v).sort().join(',') === 'establishedAtTurn,medicationIds'
        && !JSON.stringify(v).includes('Metformin')
        && !JSON.stringify(v).includes('10mg')
        && !JSON.stringify(v).includes('daily'),
      'medicationIds + establishedAtTurn');
    assert('MO6 person subject cleared on medication presentation', subject.hasLive(), v => v === false, 'no subject');

    resetClassify();
    const second = await say('Tell me about the second one.');
    assert('MO7 second one is fresh Lisinopril readback', second,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText === "You're currently on Lisinopril 10mg, daily.",
      'Lisinopril readback');
    assert('MO8 LLM/classifier not consulted for ordinal target', getClassifyCalls(), v => v === 0, '0 classifyQuery calls');
    assert('MO9 presentation survives successful ordinal', presentation.hasLive(), v => v === true, 'live');

    resetClassify();
    const first = await say('What was the first one again?');
    assert('MO10 first one is fresh Metformin readback', first,
      v => v.handled === true && v.source === 'referent_resume'
        && v.responseText === "You're currently on Metformin 500mg, twice a day.",
      'Metformin readback');
    assert('MO11 classifier still unused on chained ordinal', getClassifyCalls(), v => v === 0, '0');
    assert('MO12 presentation survives chained ordinal', presentation.peek()?.medicationIds,
      v => Array.isArray(v) && v[0] === newer && v[1] === older, 'same ids');
  }

  // 4. New summary replaces ordering
  {
    const { db, say, presentation } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    const third = writeMedication({ name: 'Atorvastatin', dosage: '20mg', frequency: 'nightly', is_active: 1 });
    db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-08-01T00:00:00.000Z', third);
    await say('What medications am I taking?');
    assert('MO13 new summary replaces presentation with Atorvastatin first', presentation.peek()?.medicationIds,
      v => Array.isArray(v) && v[0] === third && v.length === 3, 'atorvastatin, metformin, lisinopril');
    const second = await say('Tell me about the second one.');
    assert('MO14 second after replace is Metformin not Lisinopril', second,
      v => v.handled === true && v.responseText === "You're currently on Metformin 500mg, twice a day.",
      'Metformin');
  }

  // 5. No prior presentation
  {
    const { say, presentation, getClassifyCalls, resetClassify } = fresh();
    writeMedication({ name: 'Metformin', dosage: '500mg', is_active: 1 });
    resetClassify();
    const t = await say('Tell me about the second one.');
    assert('MO15 no presentation → ordinal does not resolve a medication', t,
      v => !(v.handled === true && v.source === 'referent_resume' && /Metformin/i.test(v.responseText)),
      'no Metformin referent_resume');
    assert('MO16 no presentation stored', presentation.hasLive(), v => v === false, 'empty');
    assert('MO17 no presentation falls through to routing (not silent med pick)', t,
      v => v.handled === false, 'unhandled');
  }

  // 6–7. Out of range + retry first; doctor coda is not selected
  {
    const { db, say, presentation } = fresh();
    const only = writeMedication({ name: 'Metformin', dosage: '500mg', frequency: 'daily', is_active: 1 });
    writeMedicalContact({ name: 'Dr. Patel', specialty: 'cardiology', is_primary: 1 });
    await say('What medications am I taking?');
    assert('MO18 one-med presentation length 1', presentation.peek()?.medicationIds, v => Array.isArray(v) && v.length === 1 && v[0] === only, '1 id');
    const oor = await say('Tell me about the second one.');
    assert('MO19 out-of-range is graceful confusion', oor,
      v => v.handled === true && v.source === 'referent_resume' && v.responseText === MEDICATION_ORDINAL_CONFUSION,
      MEDICATION_ORDINAL_CONFUSION);
    assert('MO20 out-of-range does not speak doctor or Metformin as the pick', oor.responseText,
      v => !/Patel/i.test(v) && !/Metformin/i.test(v) && !/cardiology/i.test(v),
      'no doctor/med value');
    assert('MO21 presentation retained after out-of-range', presentation.hasLive(), v => v === true, 'live');
    const retry = await say('Tell me about the first one.');
    assert('MO22 retry first one after out-of-range', retry,
      v => v.handled === true && v.responseText === "You're currently on Metformin 500mg, daily.",
      'Metformin');
  }

  // 8. Inactive between turns
  {
    const { db, say } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    db.prepare(`UPDATE medications SET is_active = 0 WHERE name = 'Lisinopril'`).run();
    const stale = await say('Tell me about the second one.');
    assert('MO23 inactive row is honest miss, not prior spoken value', stale,
      v => v.handled === true && v.responseText === MEDICATION_ORDINAL_STALE
        && !/Lisinopril/i.test(v.responseText) && !/10mg/i.test(v.responseText),
      MEDICATION_ORDINAL_STALE);
  }

  // 9. removed_at between turns (still is_active=1)
  {
    const { db, say } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    db.prepare(`UPDATE medications SET removed_at = ? WHERE name = 'Lisinopril'`).run('2026-08-29T00:00:00.000Z');
    const stale = await say('Tell me about the second one.');
    assert('MO24 removed_at is honest miss, not prior spoken value', stale,
      v => v.handled === true && v.responseText === MEDICATION_ORDINAL_STALE
        && !/Lisinopril/i.test(v.responseText),
      MEDICATION_ORDINAL_STALE);
  }

  // 10. Row missing
  {
    const { db, say } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    db.prepare(`DELETE FROM medications WHERE name = 'Lisinopril'`).run();
    const stale = await say('Tell me about the second one.');
    assert('MO25 missing row is honest miss, not prior spoken value', stale,
      v => v.handled === true && v.responseText === MEDICATION_ORDINAL_STALE
        && !/Lisinopril/i.test(v.responseText),
      MEDICATION_ORDINAL_STALE);
  }

  // 11. Values change between turns → reread
  {
    const { db, say } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    db.prepare(`UPDATE medications SET dosage = ?, frequency = ? WHERE name = 'Lisinopril'`).run('20mg', 'twice daily');
    const freshRead = await say('Tell me about the second one.');
    assert('MO26 ordinal reflects current authority not prior speech', freshRead,
      v => v.handled === true && v.responseText === "You're currently on Lisinopril 20mg, twice daily.",
      '20mg twice daily');
  }

  // 12. Live doctor subject does not satisfy medication ordinal
  {
    const { say, subject, presentation } = fresh();
    writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    await say('When did I see Dr. Smith?');
    assert('MO27 doctor subject live', subject.peek()?.domain, v => v === 'medical_doctor', 'medical_doctor');
    assert('MO28 no medication presentation', presentation.hasLive(), v => v === false, 'empty');
    const t = await say('Tell me about the second one.');
    assert('MO29 doctor subject does not resolve a medication ordinal', t,
      v => !(v.handled === true && v.source === 'referent_resume' && /You're currently on/.test(v.responseText)),
      'no med readback');
  }

  // 13. New person subject invalidates stale medication presentation
  {
    const { db, say, presentation, subject } = fresh();
    seedOrderedPair(db);
    writeMedicalRecord({ doctor_name: 'Dr. Smith', notes: 'visit', visit_date: '2026-07-20' });
    await say('What medications am I taking?');
    assert('MO30 presentation live before doctor read', presentation.hasLive(), v => v === true, 'live');
    await say('When did I see Dr. Smith?');
    assert('MO31 doctor establish clears medication presentation', presentation.hasLive(), v => v === false, 'cleared');
    assert('MO32 doctor subject live', subject.peek()?.domain, v => v === 'medical_doctor', 'medical_doctor');
    const t = await say('Tell me about the first one.');
    assert('MO33 stale presentation cannot satisfy ordinal after doctor subject', t,
      v => !(v.handled === true && /Metformin/i.test(v.responseText)),
      'no Metformin');
  }

  // 13b family / household also invalidate
  {
    const { db, say, presentation, subject } = fresh();
    seedOrderedPair(db);
    writeContactRaw({ name: 'Shannon', relationship: 'wife', phone: '2145550100', importance: 8 });
    await say('What medications am I taking?');
    await say('Who is my wife?');
    assert('MO34 family subject clears medication presentation', { live: presentation.hasLive(), domain: subject.peek()?.domain },
      v => v.live === false && v.domain === 'family_contact', 'family, no presentation');
  }
  {
    const { db, say, presentation, subject } = fresh();
    seedOrderedPair(db);
    writeServiceProvider('plumber', 'Bob', '469-555-0103');
    await say('What medications am I taking?');
    await say('Who is my plumber?');
    assert('MO35 household subject clears medication presentation', { live: presentation.hasLive(), domain: subject.peek()?.domain },
      v => v.live === false && v.domain === 'household_provider', 'household, no presentation');
  }

  // 14. Med presentation cannot feed his/her/them person acts
  {
    const { db, say, subject } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    const t = await say("What's his number?");
    assert('MO36 pronoun phone does not bind medication IDs', t,
      v => !(v.handled === true && v.source === 'referent_resume' && /Metformin|Lisinopril/i.test(v.responseText)),
      'no med in phone resume');
    assert('MO37 no live person subject to consume', subject.hasLive(), v => v === false, 'no subject');
  }

  // 15. Multi-person Flow C rejection unchanged with holder wired
  {
    const { say, subject, presentation } = fresh();
    writeContactRaw({ name: 'Hunter', relationship: 'son', phone: '2145550111', importance: 7 });
    writeContactRaw({ name: 'Grant', relationship: 'son', phone: '2145550222', importance: 7 });
    const t1 = await say('Who are my sons?');
    assert('MO38 multi-son still does not establish person subject', { t1, live: subject.hasLive(), peek: subject.peek() },
      v => v.t1.handled === false && v.live === false && v.peek === null, 'no subject');
    const t2 = await say("What's his number?");
    assert('MO39 pronoun still does not pick a son', t2,
      v => !(v.handled === true && v.source === 'referent_resume'),
      'no pick');
    assert('MO40 multi-son does not arm medication presentation', presentation.hasLive(), v => v === false, 'empty');
  }

  // Unused next turn clears presentation
  {
    const { db, say, presentation } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    await say("What's the weather tomorrow?");
    assert('MO41 unrelated turn clears medication presentation', presentation.hasLive(), v => v === false, 'cleared');
  }

  // Pending owns the turn over ordinal
  {
    const { db, say, session, presentation } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    session.setPending({
      pendingKey: 'test_pending',
      kind: 'standard',
      budget: 1,
      resume: async () => ({ status: 'ok', ack: 'pending owned the turn' }),
    });
    const t = await say('Tell me about the second one.');
    assert('MO42 pending owns ordinal utterance', t,
      v => v.handled === true && v.source === 'pending_resume' && v.responseText.includes('pending owned the turn')
        && !/Lisinopril/i.test(v.responseText),
      'pending_resume');
    assert('MO43 pending clears medication presentation', presentation.hasLive(), v => v === false, 'cleared');
  }

  // Law 0
  {
    const { db, say, presentation } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    const t = await say('I need help');
    assert('MO44 Law 0 owns the turn', t, v => v.handled === true && v.source === 'emergency', 'emergency');
    assert('MO45 Law 0 clears medication presentation', presentation.hasLive(), v => v === false, 'cleared');
  }

  // Same-read grounding: spoken sequence and holder IDs come from ONE
  // getActiveMedications() array. If establish re-read independently, swapping
  // created_at after speech would invert the ordinal.
  {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    setDB(makeShim(db));
    const session = new ConversationSession();
    const subject = new ConversationalSubjectHolder();
    const presentation = new MedicationPresentationHolder();
    const older = writeMedication({ name: 'Lisinopril', dosage: '10mg', frequency: 'daily', is_active: 1 });
    const newer = writeMedication({ name: 'Metformin', dosage: '500mg', frequency: 'twice a day', is_active: 1 });
    db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', older);
    db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-06-01T00:00:00.000Z', newer);
    const deps = {
      classifyQuery: async (t: string) => {
        const decision = await classifyQuery(t);
        if (decision.reason === 'medical:summary') {
          db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-08-01T00:00:00.000Z', older);
          db.prepare(`UPDATE medications SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00.000Z', newer);
        }
        return decision;
      },
      classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    };
    const summary = await processUtterance('What medications am I taking?', session, deps, subject, presentation);
    assert('MO47a speech still names Metformin then Lisinopril', summary,
      v => v.handled === false && v.routeDecision.kind === 'device_read'
        && v.routeDecision.response.includes('Metformin 500mg, twice a day; Lisinopril 10mg, daily'),
      'spoken order A');
    assert('MO47b holder IDs match spoken order, not the post-speech DB order', presentation.peek()?.medicationIds,
      v => Array.isArray(v) && v[0] === newer && v[1] === older, 'spoken IDs, not swapped live order');
    const second = await processUtterance('Tell me about the second one.', session, deps, subject, presentation);
    assert('MO47c second one is Lisinopril from presented sequence', second,
      v => v.handled === true && v.responseText === "You're currently on Lisinopril 10mg, daily.",
      'Lisinopril — would be Metformin if holder re-read after swap');
  }

  {
    const { db, say } = fresh();
    seedOrderedPair(db);
    await say('What medications am I taking?');
    const t = await say('tell me about the first one!');
    assert('MO46 case/punctuation variant of first one', t,
      v => v.handled === true && v.responseText === "You're currently on Metformin 500mg, twice a day.",
      'Metformin');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Contract: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.includes('medicationOrdinal.test')) {
  runMedicationOrdinalTests().catch(console.error);
}
