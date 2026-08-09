// scripts/heraldTest/medicalVisitLifecycle.test.ts
// Locks the upcoming→noted→outcome-eligible lifecycle latch fix
// (medicalDB.ts supersedeStaleUpcomingAppointments) and the
// medical_visit_upcoming commit/verify/calendar-collect chain
// (routeIntent.ts). Root cause: surfaced_at was only ever set by the
// day-of proactive reminder, permanently excluding conversationally
// captured appointments from getVisitAwaitingOutcome() once their date
// passed (Hexagon case, 2026-08-08).
//
// Runner: npx tsx scripts/heraldTest/medicalVisitLifecycle.test.ts
// Gate:   wire from run.mjs (EXPECTED_TOTAL bump).

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import {
  writeMedicalRecord,
  getMedicalRecords,
  supersedeStaleUpcomingAppointments,
  getTodaysUpcomingAppointment,
  getVisitAwaitingOutcome,
} from '../../src/db/medicalDB.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { parseDatePhrase } from '../../src/utils/parseTime.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS medical_records (
    id TEXT PRIMARY KEY,
    visit_date TEXT,
    doctor_name TEXT,
    facility TEXT,
    reason TEXT,
    diagnosis TEXT,
    follow_up TEXT,
    notes TEXT,
    status TEXT DEFAULT 'noted',
    surfaced_at TEXT,
    visit_outcome TEXT,
    outcome_asked_at TEXT,
    removed_at TEXT,
    created_at TEXT
  );
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

// Direct row insert bypassing the writer, so tests can set an arbitrary
// past/today/future visit_date and status without depending on
// parseDatePhrase's "tomorrow"/"today" resolution.
function insertRow(db: Database.Database, overrides: Partial<{
  visit_date: string; doctor_name: string; status: string; surfaced_at: string | null;
  visit_outcome: string | null; outcome_asked_at: string | null;
}>) {
  const id = `mr_test_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, status, surfaced_at, visit_outcome, outcome_asked_at, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'test row', ?)`
  ).run(
    id,
    overrides.visit_date ?? '2026-08-07',
    overrides.doctor_name ?? 'Dr. Hexagon',
    overrides.status ?? 'upcoming',
    overrides.surfaced_at ?? null,
    overrides.visit_outcome ?? null,
    overrides.outcome_asked_at ?? null,
    new Date().toISOString()
  );
  return id;
}

const ROUTE_DEPS = { classifyQuery, classifyLLM: null as null, llmReady: false };

export async function runMedicalVisitLifecycleTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medical Visit Lifecycle: upcoming → noted → outcome-eligible --${RESET}\n`);

  // ── A: passed upcoming row, surfaced_at NULL → noted + latched ─────────────
  {
    const db = freshDB();
    const id = insertRow(db, { visit_date: '2026-08-01', status: 'upcoming', surfaced_at: null });
    supersedeStaleUpcomingAppointments();
    const row = getMedicalRecords().find(r => r.id === id)!;
    assert('A1 status transitions to noted', row.status, (v) => v === 'noted', 'noted');
    assert('A2 surfaced_at gets latched (non-null)', row.surfaced_at, (v) => v != null, 'non-null timestamp');
  }

  // ── B: passed upcoming row, surfaced_at already set → unchanged (COALESCE) ─
  {
    const db = freshDB();
    const original = '2026-08-01T09:00:00.000Z';
    const id = insertRow(db, { visit_date: '2026-08-01', status: 'upcoming', surfaced_at: original });
    supersedeStaleUpcomingAppointments();
    const row = getMedicalRecords().find(r => r.id === id)!;
    assert('B1 status transitions to noted', row.status, (v) => v === 'noted', 'noted');
    assert('B2 surfaced_at preserves original value', row.surfaced_at, (v) => v === original, original);
  }

  // ── C: retrospective medical_visit row (never status=upcoming) untouched ───
  {
    const db = freshDB();
    const id = insertRow(db, { visit_date: '2026-08-01', status: 'noted', surfaced_at: null });
    supersedeStaleUpcomingAppointments();
    const row = getMedicalRecords().find(r => r.id === id)!;
    assert('C1 status remains noted (was already noted, not upcoming)', row.status, (v) => v === 'noted', 'noted');
    assert('C2 surfaced_at remains null (sweep never touches non-upcoming rows)', row.surfaced_at, (v) => v == null, 'null');
  }

  // ── D: today's upcoming appointment still eligible for day-of reminder ─────
  // Regression guard: the fix must not make the day-of surfacing sweep
  // fire early / skip appointments that haven't happened yet.
  {
    const db = freshDB();
    const today = new Date().toISOString().slice(0, 10);
    const id = insertRow(db, { visit_date: today, status: 'upcoming', surfaced_at: null });
    supersedeStaleUpcomingAppointments();
    const row = getMedicalRecords().find(r => r.id === id)!;
    assert('D1 today\'s appointment NOT superseded (date is not < today)', row.status, (v) => v === 'upcoming', 'upcoming');
    const surfaced = getTodaysUpcomingAppointment();
    assert('D2 still returned by getTodaysUpcomingAppointment', surfaced?.id, (v) => v === id, id);
  }

  // ── E: commitUpcoming — verified write, single combined ack+time-question ──
  {
    freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const rd = await routeIntent(phrase, ROUTE_DEPS);
    // First turn: capture routes to medical_visit_upcoming confirm stage.
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('E1 confirm stage is pending', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        const commitResult = await confirmResult.resume('yes');
        assert('E2 combined result is pending (medical ack + time question)', commitResult.status,
          (v) => v === 'pending', 'pending');
        if (commitResult.status === 'pending') {
          assert('E3 prompt contains medical ack', commitResult.prompt,
            (v) => typeof v === 'string' && v.includes("I'll remind you"), 'contains "I\'ll remind you"');
          assert('E4 prompt contains time question', commitResult.prompt,
            (v) => typeof v === 'string' && /what time/i.test(v), 'contains "what time"');
          assert('E5 exactly one medical_records row written', getMedicalRecords().length,
            (v) => v === 1, '1');
        }
      }
    } else {
      assert('E0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── F: user declines the calendar-time question → medical row stays intact,
  //      no calendar event created. Safe to test headlessly: buildCalendarCollectSlot's
  //      own cancel check (COLLECT_CANCEL_RE) returns before ever calling the write
  //      function — same guarantee calendarCollect.test.ts CC2/CC6/CC8 already prove.
  //      NOTE: "user supplies a valid time → real Android Calendar event created" is
  //      intentionally NOT unit tested here. writeCalendarCore is never unit tested
  //      anywhere in this suite (only ever exercised via an injected mock) because it
  //      calls expo-calendar, a native module with no headless Node runtime. That
  //      branch is verified on-device only (S24+ acceptance script).
  {
    freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      if (confirmResult.status === 'pending') {
        const commitResult = await confirmResult.resume('yes');
        if (commitResult.status === 'pending') {
          const cancelResult = await commitResult.resume('never mind');
          assert('F1 declining the time question → noop, no calendar event', cancelResult.status,
            (v) => v === 'noop', 'noop');
          assert('F2 decline ack mentions not adding to calendar', (cancelResult as any).ack,
            (v) => typeof v === 'string' && /won't put anything/i.test(v), 'contains "won\'t put anything"');
          assert('F3 medical record still present after calendar decline', getMedicalRecords().length,
            (v) => v === 1, '1');
        } else {
          assert('F0 expected pending result after yes', commitResult.status, () => false, 'pending');
        }
      } else {
        assert('F0 expected pending confirm stage', confirmResult.status, () => false, 'pending');
      }
    } else {
      assert('F0 expected medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── G/H: existing-memory reconciliation gate — same doctor + same date ─────
  // fires the reconciliation prompt (commit e9be9814); YES leaves the
  // existing appointment untouched and writes nothing new.
  {
    const db = freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const tomorrow = parseDatePhrase(phrase)!;
    insertRow(db, { visit_date: tomorrow, doctor_name: 'Dr. Hexagon', status: 'upcoming' });

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('G1 reconciliation gate fires (pending)', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        assert('G2 pendingKey is the duplicate reconciliation key', confirmResult.pendingKey,
          (v) => v === 'medical_visit_upcoming_duplicate', 'medical_visit_upcoming_duplicate');
        assert('G3 prompt asks same-or-different', confirmResult.prompt,
          (v) => typeof v === 'string' && v.includes('already have you down'), 'contains "already have you down"');

        const yesResult = await confirmResult.resume('yes');
        assert('H1 YES → noop (no new write)', yesResult.status, (v) => v === 'noop', 'noop');
        assert('H2 YES ack leaves existing appointment as-is', (yesResult as any).ack,
          (v) => typeof v === 'string' && /leave that as is/i.test(v), 'contains "leave that as is"');
        assert('H3 exactly one medical_records row (seeded row only, no second write)',
          getMedicalRecords().length, (v) => v === 1, '1');
      }
    } else {
      assert('G0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── I: reconciliation gate — NO proceeds through the normal new-appointment
  //      commit path (same shape as test E's combined ack+time-question) ─────
  {
    const db = freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const tomorrow = parseDatePhrase(phrase)!;
    insertRow(db, { visit_date: tomorrow, doctor_name: 'Dr. Hexagon', status: 'upcoming' });

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('I1 reconciliation gate fires (pending)', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        assert('I2 pendingKey is the duplicate reconciliation key', confirmResult.pendingKey,
          (v) => v === 'medical_visit_upcoming_duplicate', 'medical_visit_upcoming_duplicate');
        const commitResult = await confirmResult.resume('no');
        assert('I3 NO → proceeds to normal commit (pending, ack+time question)', commitResult.status,
          (v) => v === 'pending', 'pending');
        if (commitResult.status === 'pending') {
          assert('I4 prompt contains medical ack', commitResult.prompt,
            (v) => typeof v === 'string' && v.includes("I'll remind you"), 'contains "I\'ll remind you"');
          assert('I5 prompt contains time question', commitResult.prompt,
            (v) => typeof v === 'string' && /what time/i.test(v), 'contains "what time"');
        }
        assert('I6 two medical_records rows now (seeded + new commit)', getMedicalRecords().length,
          (v) => v === 2, '2');
      }
    } else {
      assert('I0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── J: reconciliation gate — unresolved reply stays pending, commits nothing
  {
    const db = freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const tomorrow = parseDatePhrase(phrase)!;
    insertRow(db, { visit_date: tomorrow, doctor_name: 'Dr. Hexagon', status: 'upcoming' });

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('J1 reconciliation gate fires (pending)', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        assert('J2 pendingKey is the duplicate reconciliation key', confirmResult.pendingKey,
          (v) => v === 'medical_visit_upcoming_duplicate', 'medical_visit_upcoming_duplicate');
        const ambiguousResult = await confirmResult.resume('maybe');
        assert('J3 unresolved reply → noop (stays pending per Graceful Confusion convention)',
          ambiguousResult.status, (v) => v === 'noop', 'noop');
        assert('J4 unresolved reply → empty ack (no commit language spoken)', (ambiguousResult as any).ack,
          (v) => v === '', '""');
        assert('J5 no new write on unresolved reply', getMedicalRecords().length, (v) => v === 1, '1');
      }
    } else {
      assert('J0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── K: same doctor, different date → reconciliation gate does not fire ─────
  {
    const db = freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    // Fixed far-future date — cannot collide with "tomorrow"'s resolution.
    insertRow(db, { visit_date: '2026-12-25', doctor_name: 'Dr. Hexagon', status: 'upcoming' });

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('K1 different date → normal confirm pending', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        assert('K2 pendingKey is the normal confirm key, not the duplicate gate', confirmResult.pendingKey,
          (v) => v === 'medical_visit_upcoming', 'medical_visit_upcoming');
        assert('K3 prompt does not contain reconciliation language', confirmResult.prompt,
          (v) => typeof v === 'string' && !v.includes('already have you down'), 'does not contain "already have you down"');
      }
    } else {
      assert('K0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  // ── L: different doctor, same date → reconciliation gate does not fire ─────
  {
    const db = freshDB();
    const phrase = 'I have an appointment with Dr. Hexagon tomorrow.';
    const tomorrow = parseDatePhrase(phrase)!;
    insertRow(db, { visit_date: tomorrow, doctor_name: 'Dr. Patel', status: 'upcoming' });

    const rd = await routeIntent(phrase, ROUTE_DEPS);
    if (rd.kind === 'capture' && rd.intents[0]?.type === 'medical_visit_upcoming') {
      const { DOMAIN_WRITERS } = await import('../../src/routing/routeIntent.ts');
      const writer = DOMAIN_WRITERS['medical_visit_upcoming']!;
      const confirmResult = await writer.add(rd.intents[0], phrase);
      assert('L1 different doctor → normal confirm pending', confirmResult.status, (v) => v === 'pending', 'pending');
      if (confirmResult.status === 'pending') {
        assert('L2 pendingKey is the normal confirm key, not the duplicate gate', confirmResult.pendingKey,
          (v) => v === 'medical_visit_upcoming', 'medical_visit_upcoming');
        assert('L3 prompt does not contain reconciliation language', confirmResult.prompt,
          (v) => typeof v === 'string' && !v.includes('already have you down'), 'does not contain "already have you down"');
      }
    } else {
      assert('L0 routeIntent produced medical_visit_upcoming capture', rd.kind, () => false, 'capture / medical_visit_upcoming');
    }
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicalVisitLifecycle: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalVisitLifecycle.test.ts')) {
  runMedicalVisitLifecycleTests().catch(console.error);
}
