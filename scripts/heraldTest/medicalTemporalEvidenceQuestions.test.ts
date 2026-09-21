// Medical Temporal Evidence Questions V1.
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { ingestAuthorizedCalendarEvent } from '../../src/db/calendarEvidenceIngest.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { detectMedicalEvent } from '../../src/utils/detectMedicalEvent.ts';
import { setNow, resetNow } from '../../src/utils/heraldClock.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const OCCURRED = /\b(you saw|you visited|you attended|you had)\b/i;
const PIN = new Date(2026, 8, 21, 15, 0, 0);
const WAS_IT = 'Was it last month that I saw Dr. Vance?';
const DIDNT = "Didn't I see Dr. Vance last month?";
const WHEN_LAST = 'When did I last see Dr. Vance?';
const IN_AUGUST = 'Was Dr. Vance the doctor I saw in August?';
const CARDIO = "Didn't I see my cardiologist last month?";

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

async function fresh() {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  return db;
}

export async function runMedicalTemporalEvidenceQuestionsTests() {
  const failures: { label: string }[] = [];
  let passed = 0;
  function assertTrue(label: string, cond: boolean) {
    if (cond) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
      failures.push({ label });
    }
  }

  console.log(`\n${BOLD}-- Medical Temporal Evidence Questions V1 --${RESET}\n`);

  assertTrue('was-it cleft is not a medical capture', detectMedicalEvent(WAS_IT) === null);
  assertTrue("didn't-I polar is not a medical capture", detectMedicalEvent(DIDNT) === null);

  setNow(PIN);
  setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
  try {
    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      const d = await classifyQuery(WAS_IT);
      assertTrue('confirmed in-range is visit_history_read', d.reason === 'medical:visit_history_read');
      assertTrue('confirmed in-range uses occurrence voice', typeof d.tier1Response === 'string' && /^Yes, you saw Dr\. Vance on /i.test(d.tier1Response));
      assertTrue('confirmed in-range names the visit date', typeof d.tier1Response === 'string' && /August 12/i.test(d.tier1Response));
      assertTrue('was-it never becomes a write', d.reason !== 'action:medical_capture' && !d.actionIntent);
    }

    {
      await fresh();
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 12, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_month',
        observedAt: PIN.toISOString(),
      });
      const d = await classifyQuery(WAS_IT);
      assertTrue('calendar-only in-range is visit_history_read', d.reason === 'medical:visit_history_read');
      assertTrue('calendar-only uses calendar provenance', typeof d.tier1Response === 'string' && /Your calendar shows/i.test(d.tier1Response) && /Vance/i.test(d.tier1Response));
      assertTrue('calendar-only never claims occurred visit', typeof d.tier1Response === 'string' && !OCCURRED.test(d.tier1Response) && !/You last saw/i.test(d.tier1Response) && !/^Yes,/i.test(d.tier1Response));
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-07-03', status: 'noted' });
      const d = await classifyQuery(WAS_IT);
      assertTrue('out-of-range confirmed is not a yes', typeof d.tier1Response === 'string' && !/^Yes,/i.test(d.tier1Response) && !/You last saw/i.test(d.tier1Response));
      assertTrue('out-of-range confirmed is honest no-match', typeof d.tier1Response === 'string' && /I don't have a visit with Dr\. Vance last month/i.test(d.tier1Response));
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-05', status: 'noted' });
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 20, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_disagree',
        observedAt: PIN.toISOString(),
      });
      const d = await classifyQuery(WAS_IT);
      assertTrue('disagree keeps confirmed voice', typeof d.tier1Response === 'string' && /Yes, you saw Dr\. Vance/i.test(d.tier1Response) && /August 5/i.test(d.tier1Response));
      assertTrue('disagree keeps calendar provenance separately', typeof d.tier1Response === 'string' && /Your calendar shows/i.test(d.tier1Response) && /August 20/i.test(d.tier1Response));
      assertTrue('disagree does not merge into one occurrence claim', typeof d.tier1Response === 'string' && /Yes, you saw/i.test(d.tier1Response) && /Your calendar shows/i.test(d.tier1Response));
    }

    {
      await fresh();
      const d = await classifyQuery(WAS_IT);
      assertTrue('no evidence is honest', typeof d.tier1Response === 'string' && /I don't have a visit with Dr\. Vance last month/i.test(d.tier1Response));
      assertTrue('no evidence is not unconstrained history', typeof d.tier1Response === 'string' && !/You last saw/i.test(d.tier1Response) && !/I don't have any visits yet/i.test(d.tier1Response));
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      const d = await classifyQuery(DIDNT);
      assertTrue("didn't-I enrolls visit-history read", d.reason === 'medical:visit_history_read' && !d.actionIntent);
      assertTrue("didn't-I confirmed uses occurrence voice", typeof d.tier1Response === 'string' && /Yes, you saw Dr\. Vance/i.test(d.tier1Response));
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-07-03', status: 'noted' });
      const d = await classifyQuery(IN_AUGUST);
      assertTrue('in August is unresolved temporal', d.reason === 'medical:visit_history_unresolved_temporal');
      assertTrue('in August is not unconstrained history', typeof d.tier1Response === 'string' && !/You last saw/i.test(d.tier1Response) && !/^Yes,/i.test(d.tier1Response));
      assertTrue('in August is not a capture', !d.actionIntent && d.reason !== 'action:medical_capture');
    }

    {
      await fresh();
      const d = await classifyQuery(CARDIO);
      assertTrue('specialty-only preserves clarification fence', d.reason === 'medical:visit_history_unresolved_specialty');
      assertTrue('specialty-only does not invent a doctor', typeof d.tier1Response === 'string' && /cardiologist/i.test(d.tier1Response) && !/You last saw/i.test(d.tier1Response) && !/^Yes,/i.test(d.tier1Response));
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-07-03', status: 'noted' });
      const d = await classifyQuery(WHEN_LAST);
      assertTrue('unconstrained when-last remains visit_history_read', d.reason === 'medical:visit_history_read');
      assertTrue('unconstrained when-last still uses last-saw voice', typeof d.tier1Response === 'string' && /You last saw Dr\. Vance/i.test(d.tier1Response) && /July 3/i.test(d.tier1Response));
    }
  } finally {
    resetCalendarEventFetcher();
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicalTemporalEvidenceQuestions: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('medicalTemporalEvidenceQuestions.test.ts')) {
  runMedicalTemporalEvidenceQuestionsTests().catch(console.error);
}
