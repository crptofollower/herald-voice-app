// Temporal Clarification Continuity V1.
// Specialty clarification supplies doctor identity only; original temporal
// constraint and visit-history authority composition are preserved on resume.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { ingestAuthorizedCalendarEvent } from '../../src/db/calendarEvidenceIngest.ts';
import { writeMedicalRecord } from '../../src/db/medicalDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { setNow, resetNow } from '../../src/utils/heraldClock.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const OCCURRED = /\b(you saw|you visited|you attended|you had)\b/i;
const PIN = new Date(2026, 8, 21, 15, 0, 0);
const CARDIO = "Didn't I see my cardiologist last month?";
const DIRECT = "Didn't I see Dr. Vance last month?";
const IN_AUGUST_SPECIALTY = "Didn't I see my cardiologist in August?";

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
  const session = new ConversationSession();
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
  };
  const say = (text: string) => processUtterance(text, session, deps);
  return { db, session, say };
}

function speechOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  return 'responseText' in outcome && typeof outcome.responseText === 'string' ? outcome.responseText : '';
}

export async function runTemporalClarificationContinuityTests() {
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

  console.log(`\n${BOLD}-- Temporal Clarification Continuity V1 --${RESET}\n`);

  setNow(PIN);
  setCalendarEventFetcher(async () => ({ status: 'unavailable', reason: 'permission-denied' }));
  try {
    {
      const { session, say } = await fresh();
      const first = await say(CARDIO);
      assertTrue('cardiologist question is handled', first.handled === true);
      assertTrue('cardiologist question arms a pending, not a one-shot read', session.hasPending());
      assertTrue(
        'pending is the visit-history specialty slot',
        session.peekPendingKey() === 'medical_visit_history_specialty',
      );
      assertTrue(
        'clarification prompt is preserved',
        /cardiologist/i.test(speechOf(first)) && /who do you mean/i.test(speechOf(first)),
      );
      assertTrue('clarification does not claim a visit occurred', !OCCURRED.test(speechOf(first)) && !/^Yes,/i.test(speechOf(first)));
    }

    {
      const { session, say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      await say(CARDIO);
      const resume = await say('Dr. Vance.');
      assertTrue('named resume settles the pending', !session.hasPending());
      assertTrue(
        'confirmed in-range resume uses occurrence voice',
        /^Yes, you saw Dr\. Vance on /i.test(speechOf(resume)) && /August 12/i.test(speechOf(resume)),
      );
    }

    {
      const { session, say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-07-03', status: 'noted' });
      await say(CARDIO);
      const resume = await say('Dr. Vance.');
      const text = speechOf(resume);
      assertTrue('out-of-range resume is not a yes', !/^Yes,/i.test(text) && !/You last saw/i.test(text) && !OCCURRED.test(text));
      assertTrue(
        'out-of-range resume keeps last-month constraint',
        /I don't have a visit with Dr\. Vance last month/i.test(text),
      );
      assertTrue('out-of-range resume is not unconstrained history', !/I don't have any visits yet/i.test(text));
      assertTrue('out-of-range named resume still settles', !session.hasPending());
    }

    {
      const { say } = await fresh();
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 12, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_clarification',
        observedAt: PIN.toISOString(),
      });
      await say(CARDIO);
      const resume = await say('Dr. Vance.');
      const text = speechOf(resume);
      assertTrue('calendar-only resume uses calendar provenance', /Your calendar shows/i.test(text) && /Vance/i.test(text));
      assertTrue(
        'calendar-only resume never claims occurrence',
        !OCCURRED.test(text) && !/You last saw/i.test(text) && !/^Yes,/i.test(text),
      );
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      const direct = await classifyQuery(DIRECT);
      const { say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      await say(CARDIO);
      const resumed = await say('Dr. Vance.');
      assertTrue(
        'direct confirmed in-range uses occurrence voice',
        typeof direct.tier1Response === 'string' && /^Yes, you saw Dr\. Vance on /i.test(direct.tier1Response),
      );
      assertTrue(
        'direct and resumed confirmed occurrence speech match',
        typeof direct.tier1Response === 'string' && direct.tier1Response === speechOf(resumed),
      );
    }

    {
      await fresh();
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 12, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_direct',
        observedAt: PIN.toISOString(),
      });
      const direct = await classifyQuery(DIRECT);
      const { say } = await fresh();
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 12, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_resume',
        observedAt: PIN.toISOString(),
      });
      await say(CARDIO);
      const resumed = await say('Dr. Vance.');
      assertTrue(
        'direct calendar-only uses calendar provenance',
        typeof direct.tier1Response === 'string' && /Your calendar shows/i.test(direct.tier1Response) && !OCCURRED.test(direct.tier1Response),
      );
      assertTrue(
        'direct and resumed calendar-only speech match',
        typeof direct.tier1Response === 'string' && direct.tier1Response === speechOf(resumed),
      );
    }

    {
      await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-05', status: 'noted' });
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 20, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_disagree_direct',
        observedAt: PIN.toISOString(),
      });
      const direct = await classifyQuery(DIRECT);
      const { say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-05', status: 'noted' });
      ingestAuthorizedCalendarEvent({
        title: 'Appointment with Dr. Vance',
        startISO: new Date(2026, 7, 20, 15, 0, 0).toISOString(),
        externalId: 'cal_vance_disagree_resume',
        observedAt: PIN.toISOString(),
      });
      await say(CARDIO);
      const resumed = await say('Dr. Vance.');
      assertTrue(
        'disagree keeps separate provenance on the direct path',
        typeof direct.tier1Response === 'string'
          && /Yes, you saw Dr\. Vance/i.test(direct.tier1Response)
          && /Your calendar shows/i.test(direct.tier1Response),
      );
      assertTrue(
        'direct and resumed disagree speech match',
        typeof direct.tier1Response === 'string' && direct.tier1Response === speechOf(resumed),
      );
    }

    {
      const { session, say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      const first = await say(CARDIO);
      const miss = await say('the one downtown');
      assertTrue('non-name reply keeps the original obligation armed', session.hasPending());
      assertTrue(
        'non-name reply re-asks rather than answering',
        /who do you mean/i.test(speechOf(miss)) && speechOf(miss) === speechOf(first),
      );
      const resume = await say('Dr. Vance.');
      assertTrue(
        'name after re-ask still uses original last-month confirmed visit',
        /^Yes, you saw Dr\. Vance on /i.test(speechOf(resume)) && /August 12/i.test(speechOf(resume)),
      );
    }

    {
      const { session, say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-07-03', status: 'noted' });
      await say(CARDIO);
      const miss = await say('last week');
      assertTrue('temporal-looking non-name reply does not settle', session.hasPending());
      assertTrue('temporal-looking non-name reply re-asks', /who do you mean/i.test(speechOf(miss)));
      const resume = await say('Dr. Vance.');
      const text = speechOf(resume);
      assertTrue(
        'second unresolved reply did not replace last-month with last-week',
        /I don't have a visit with Dr\. Vance last month/i.test(text) && !/last week/i.test(text),
      );
      assertTrue('resume after second miss is not a false yes', !/^Yes,/i.test(text) && !OCCURRED.test(text));
    }

    {
      const { say } = await fresh();
      writeMedicalRecord({ doctor_name: 'Dr. Vance', visit_date: '2026-08-12', status: 'noted' });
      await say(IN_AUGUST_SPECIALTY);
      const resume = await say('Dr. Vance.');
      const text = speechOf(resume);
      assertTrue(
        'unsupported original temporal stays fail-closed after identity fill',
        /I can check yesterday, last week, last month/i.test(text),
      );
      assertTrue(
        'unsupported original temporal is not unconstrained confirmed history',
        !/^Yes,/i.test(text) && !/You last saw/i.test(text),
      );
    }
  } finally {
    resetCalendarEventFetcher();
    resetNow();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}TemporalClarificationContinuity: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('temporalClarificationContinuity.test.ts')) {
  runTemporalClarificationContinuityTests().catch(console.error);
}
