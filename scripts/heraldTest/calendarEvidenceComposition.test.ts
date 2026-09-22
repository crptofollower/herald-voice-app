// scripts/heraldTest/calendarEvidenceComposition.test.ts
// Calendar Evidence → Doctor Read Composition V1.

import Database from 'better-sqlite3';
import { setDB, runMigrations, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { ingestAuthorizedCalendarEvent, isAppointmentWorth } from '../../src/db/calendarEvidenceIngest.ts';
import { getEvidenceById, listActiveEvidence } from '../../src/db/evidenceDB.ts';
import { getMedicalRecords } from '../../src/db/medicalDB.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const OCCURRED_CLAIM = /\b(you saw|you visited|you attended|you had your appointment)\b/i;
const VANCE_TITLE = 'Appointment with Dr. Vance';
const EVENT_AT = '2026-09-20T15:00:00.000Z';
const OBSERVED_AT = '2026-09-21T20:00:00.000Z';

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

export async function runCalendarEvidenceCompositionTests() {
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

  console.log(`\n${BOLD}-- Calendar Evidence → Doctor Read Composition V1 --${RESET}\n`);

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    assertTrue('fresh v25 schema version', SCHEMA_VERSION === 25);
    const cols = db.prepare('PRAGMA table_info(evidence);').all().map((r) => r.name);
    assertTrue('fresh schema has event_at', cols.includes('event_at'));
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    const ingested = ingestAuthorizedCalendarEvent({
      title: VANCE_TITLE,
      startISO: EVENT_AT,
      externalId: 'cal_vance_1',
      observedAt: OBSERVED_AT,
    });
    assertTrue('doctor event persists through production ingest seam', !!ingested);
    const ev = ingested!.evidence;
    assertTrue('source_class is external_source', ev.sourceClass === 'external_source');
    assertTrue('source_kind is calendar', ev.sourceKind === 'calendar');
    assertTrue('source_id is calendar external_id', ev.sourceId === 'cal_vance_1');
    assertTrue('raw_text is verbatim title', ev.rawText === VANCE_TITLE);
    assertTrue('event_at is calendar event time', ev.eventAt === EVENT_AT);
    assertTrue('observed_at is observation/sync time', ev.observedAt === OBSERVED_AT);
    assertTrue('event_at is not overloaded onto observed_at', ev.eventAt !== ev.observedAt);

    const again = ingestAuthorizedCalendarEvent({
      title: VANCE_TITLE,
      startISO: EVENT_AT,
      externalId: 'cal_vance_1',
      observedAt: '2026-09-22T00:00:00.000Z',
    });
    assertTrue('repeated sync is idempotent (same evidence id)', again?.evidence.id === ev.id);
    assertTrue('repeated sync does not duplicate evidence', count(db, 'evidence') === 1);

    const changed = ingestAuthorizedCalendarEvent({
      title: 'Follow-up with Dr. Vance',
      startISO: '2026-09-21T16:00:00.000Z',
      externalId: 'cal_vance_1',
      observedAt: '2026-09-22T01:00:00.000Z',
    });
    assertTrue('changed title/time keeps the same source identity', changed?.evidence.id === ev.id);
    assertTrue('changed title is represented', getEvidenceById(ev.id)?.rawText === 'Follow-up with Dr. Vance');
    assertTrue('changed event_at is represented', getEvidenceById(ev.id)?.eventAt === '2026-09-21T16:00:00.000Z');
    assertTrue('update does not mutate medical_records', count(db, 'medical_records') === 0);
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    assertTrue('oil change is worth-gated', isAppointmentWorth('Oil change'));
    assertTrue('team standup is not worth-gated', !isAppointmentWorth('Team standup'));
    const oil = ingestAuthorizedCalendarEvent({
      title: 'Oil change',
      startISO: EVENT_AT,
      externalId: 'cal_oil',
      observedAt: OBSERVED_AT,
    });
    const standup = ingestAuthorizedCalendarEvent({
      title: 'Team standup',
      startISO: EVENT_AT,
      externalId: 'cal_standup',
      observedAt: OBSERVED_AT,
    });
    assertTrue('nonmedical worth-gated event persists as evidence', oil?.evidence.sourceKind === 'calendar' && oil.evidence.rawText === 'Oil change');
    assertTrue('non-authorized event is not ingested', standup === null);
    assertTrue('nonmedical evidence is not medical truth', count(db, 'medical_records') === 0);
    const cal = listActiveEvidence({ sourceClass: 'external_source', sourceKind: 'calendar', sourceId: 'cal_oil' });
    assertTrue('nonmedical evidence remains domain-neutral calendar', cal.length === 1 && cal[0].sourceClass === 'external_source');
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    ingestAuthorizedCalendarEvent({
      title: 'Pharmacy refill',
      startISO: EVENT_AT,
      externalId: 'cal_rx',
      observedAt: OBSERVED_AT,
    });
    assertTrue('medication-looking calendar does not write medications', count(db, 'medications') === 0);
    assertTrue('medication-looking calendar does not write medical_records', count(db, 'medical_records') === 0);
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    ingestAuthorizedCalendarEvent({
      title: VANCE_TITLE,
      startISO: EVENT_AT,
      externalId: 'cal_vance_restart',
      observedAt: OBSERVED_AT,
    });
    const beforeRecords = getMedicalRecords().length;
    setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
    try {
      const named = await classifyQuery('When did I last see Dr Vance?');
      assertTrue('named doctor history is visit_history_read', named.reason === 'medical:visit_history_read');
      assertTrue('named history uses calendar-shows semantics', typeof named.tier1Response === 'string' && /Your calendar shows/i.test(named.tier1Response) && /Vance/i.test(named.tier1Response));
      assertTrue('named history never claims occurred visit', typeof named.tier1Response === 'string' && !OCCURRED_CLAIM.test(named.tier1Response) && !/You last saw/i.test(named.tier1Response));
      assertTrue('post-restart works without live calendar', typeof named.tier1Response === 'string' && /Your calendar shows/i.test(named.tier1Response));

      const unhinted = await classifyQuery('Who was my last doctor?');
      assertTrue('unhinted doctor history is visit_history_read', unhinted.reason === 'medical:visit_history_read');
      assertTrue('unhinted history discovers persisted doctor evidence', typeof unhinted.tier1Response === 'string' && /Your calendar shows/i.test(unhinted.tier1Response) && /Vance/i.test(unhinted.tier1Response));
    } finally {
      resetCalendarEventFetcher();
    }
    assertTrue('calendar ingest leaves medical_records unchanged', getMedicalRecords().length === beforeRecords);
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    ingestAuthorizedCalendarEvent({
      title: 'Dr. Estil Vance - on follow-up',
      startISO: '2026-08-12T16:00:00.000Z',
      externalId: 'cal_estil',
      observedAt: OBSERVED_AT,
    });
    setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
    try {
      const surname = await classifyQuery('When did I last see Dr Vance?');
      assertTrue('surname-in-middle remains matched', typeof surname.tier1Response === 'string' && /Your calendar shows/i.test(surname.tier1Response) && /Vance/i.test(surname.tier1Response) && !/Which one did you mean/i.test(surname.tier1Response));
    } finally {
      resetCalendarEventFetcher();
    }
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    writeMedicalRecord({ doctor_name: 'Dr Smith', visit_date: '2026-08-01', status: 'noted' });
    ingestAuthorizedCalendarEvent({
      title: 'Appointment with Dr Smith',
      startISO: EVENT_AT,
      externalId: 'cal_smith_ev',
      observedAt: OBSERVED_AT,
    });
    setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
    try {
      const both = await classifyQuery('When did I last see Dr Smith?');
      assertTrue('confirmed medical memory remains authoritative', typeof both.tier1Response === 'string' && /You last saw/i.test(both.tier1Response) && /Smith/i.test(both.tier1Response));
      assertTrue('related calendar evidence is preserved as a second authority voice', typeof both.tier1Response === 'string' && /Your calendar shows/i.test(both.tier1Response));
      assertTrue('authorities are not probabilistically merged into one occurrence claim', typeof both.tier1Response === 'string' && /You last saw/i.test(both.tier1Response) && /Your calendar shows/i.test(both.tier1Response));
    } finally {
      resetCalendarEventFetcher();
    }
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    ingestAuthorizedCalendarEvent({
      title: VANCE_TITLE,
      startISO: EVENT_AT,
      externalId: 'cal_vance_neg',
      observedAt: OBSERVED_AT,
    });
    const recordsBefore = count(db, 'medical_records');
    setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
    try {
      const d = await classifyQuery('When did I last see Dr Vance?');
      assertTrue('NEG: calendar Dr Vance → evidence exists', listActiveEvidence({ sourceClass: 'external_source', sourceKind: 'calendar', sourceId: 'cal_vance_neg' }).length === 1);
      assertTrue('NEG: medical_records unchanged', count(db, 'medical_records') === recordsBefore);
      assertTrue('NEG: Herald may describe only what the calendar shows', typeof d.tier1Response === 'string' && /Your calendar shows/i.test(d.tier1Response) && !OCCURRED_CLAIM.test(d.tier1Response) && !/You last saw/i.test(d.tier1Response));
    } finally {
      resetCalendarEventFetcher();
    }
  }

  {
    const host = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/dev/androidJourneyHost.ts'), 'utf8');
    const cal = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/hooks/useCalendar.ts'), 'utf8');
    const snapStart = host.indexOf('function snapshotAuthoritative');
    const snapEnd = host.indexOf('function diffSnapshots');
    const snapshotFn = snapStart >= 0 && snapEnd > snapStart ? host.slice(snapStart, snapEnd) : '';
    assertTrue('AuthoritativeSnapshot observes evidence including event_at', /FROM evidence/.test(snapshotFn) && /event_at/.test(snapshotFn));
    assertTrue('AuthoritativeSnapshot does not write evidence', snapshotFn.length > 0 && !/persistEvidence|ingestAuthorizedCalendarEvent/.test(snapshotFn));
    assertTrue('production sync seam persists evidence alongside appointments', /ingestAuthorizedCalendarEvent/.test(cal) && /isAppointmentWorth/.test(cal));
    assertTrue('production sync is not a second calendar sweep', (cal.match(/getEventsAsync/g) || []).length === 1);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}CalendarEvidenceComposition: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('calendarEvidenceComposition.test.ts')) {
  runCalendarEvidenceCompositionTests().catch(console.error);
}
