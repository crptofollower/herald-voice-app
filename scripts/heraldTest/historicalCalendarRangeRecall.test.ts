// Historical Calendar Range Recall V1 — bounded past calendar reads.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { ingestAuthorizedCalendarEvent, isAppointmentWorth } from '../../src/db/calendarEvidenceIngest.ts';
import { setCalendarEventFetcher, resetCalendarEventFetcher } from '../../src/db/calendarCacheDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import {
  projectScheduleRowsFromPresentedIds,
  scheduleScopeFromReason,
  scheduleScopeLabel,
} from '../../src/routing/scheduleSurfacePresentation.ts';
import {
  resolveHistoricalCalendarRange,
  thisWeekMonday,
} from '../../src/routing/historicalCalendarRange.ts';
import { setNow, resetNow } from '../../src/utils/heraldClock.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const OCCURRED = /\b(you saw|you visited|you attended|you had)\b/i;
const PIN = new Date(2026, 8, 21, 15, 0, 0); // Monday Sep 21 2026 local

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function rawEvent(id: string, title: string, start: Date) {
  return {
    id,
    title,
    startDate: start,
    endDate: new Date(start.getTime() + 3600_000),
    allDay: false,
  };
}

export async function runHistoricalCalendarRangeRecallTests() {
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

  console.log(`\n${BOLD}-- Historical Calendar Range Recall V1 --${RESET}\n`);

  {
    setNow(PIN);
    try {
      assertTrue('pin is Monday', PIN.getDay() === 1);
      const week = resolveHistoricalCalendarRange('What was on my calendar last week?', PIN);
      const monday = thisWeekMonday(PIN);
      const lastMonday = new Date(monday);
      lastMonday.setDate(monday.getDate() - 7);
      assertTrue('last week start is previous Monday', !!week && week.start.getTime() === lastMonday.getTime());
      assertTrue('last week end is this Monday', !!week && week.end.getTime() === monday.getTime());
      assertTrue('last week reason', week?.reason === 'calendar:last_week');

      const y = resolveHistoricalCalendarRange('What was on my calendar yesterday?', PIN);
      const yStart = new Date(2026, 8, 20);
      yStart.setHours(0, 0, 0, 0);
      const yEnd = new Date(2026, 8, 21);
      yEnd.setHours(0, 0, 0, 0);
      assertTrue('yesterday start', !!y && y.start.getTime() === yStart.getTime());
      assertTrue('yesterday end', !!y && y.end.getTime() === yEnd.getTime());

      const month = resolveHistoricalCalendarRange('What was on my calendar last month?', PIN);
      assertTrue('last month is August 1', !!month && month.start.getTime() === new Date(2026, 7, 1).getTime());
      assertTrue('last month ends Sep 1', !!month && month.end.getTime() === new Date(2026, 8, 1).getTime());

      const two = resolveHistoricalCalendarRange('What was on my calendar 2 months ago?', PIN);
      assertTrue('2 months ago is July 1', !!two && two.start.getTime() === new Date(2026, 6, 1).getTime());
      assertTrue('2 months ago ends Aug 1', !!two && two.end.getTime() === new Date(2026, 7, 1).getTime());

      assertTrue('last Thursday is not last-week range', resolveHistoricalCalendarRange("What's on my calendar last Thursday?", PIN) === null);
    } finally {
      resetNow();
    }
  }

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    setNow(PIN);
    const standup = new Date(2026, 8, 15, 10, 0, 0);
    const coffee = new Date(2026, 8, 16, 14, 30, 0);
    const oil = new Date(2026, 8, 18, 9, 0, 0);
    const yest = new Date(2026, 8, 20, 11, 0, 0);
    const beforeWeek = new Date(2026, 8, 13, 16, 0, 0);
    const august = new Date(2026, 7, 12, 15, 0, 0);
    const vance = new Date(2026, 8, 17, 15, 0, 0);
    setCalendarEventFetcher(async () => ({
      status: 'ok',
      events: [
        rawEvent('e-standup', 'Team standup', standup),
        rawEvent('e-coffee', 'Coffee with Sam', coffee),
        rawEvent('e-oil', 'Oil change', oil),
        rawEvent('e-yest', 'Book club', yest),
        rawEvent('e-before', 'Yard work', beforeWeek),
        rawEvent('e-aug', 'HOA meeting', august),
        rawEvent('e-vance', 'Appointment with Dr. Vance', vance),
      ],
    }));
    try {
      assertTrue('oil change is still worth-gated', isAppointmentWorth('Oil change'));
      assertTrue('team standup is still not worth-gated', !isAppointmentWorth('Team standup'));
      assertTrue('coffee is not worth-gated', !isAppointmentWorth('Coffee with Sam'));
      assertTrue('standup is not ingested as appointment/evidence', ingestAuthorizedCalendarEvent({
        title: 'Team standup',
        startISO: standup.toISOString(),
        externalId: 'e-standup',
        observedAt: PIN.toISOString(),
      }) === null);

      const lastWeek = await classifyQuery('What was on my calendar last week?');
      const ids = lastWeek.presentedCalendarEventIds ?? [];
      const snaps = lastWeek.presentedCalendarEvents ?? [];
      assertTrue('past-tense last week enrolls calendar:last_week', lastWeek.reason === 'calendar:last_week');
      assertTrue('canonical last-week set includes ordinary non-worth events', ids.includes('e-standup') && ids.includes('e-coffee'));
      assertTrue('canonical last-week set includes worth-gated titles too', ids.includes('e-oil'));
      assertTrue('canonical last-week set includes Dr Vance calendar row', ids.includes('e-vance'));
      assertTrue('canonical last-week set excludes prior Saturday and last month', !ids.includes('e-before') && !ids.includes('e-aug'));
      assertTrue('speech uses calendar provenance', typeof lastWeek.tier1Response === 'string' && lastWeek.tier1Response.startsWith('Your calendar shows'));
      assertTrue('speech names ordinary events', typeof lastWeek.tier1Response === 'string' && /Team standup/.test(lastWeek.tier1Response) && /Coffee with Sam/.test(lastWeek.tier1Response) && /Oil change/.test(lastWeek.tier1Response));
      assertTrue('speech never claims events occurred', typeof lastWeek.tier1Response === 'string' && !OCCURRED.test(lastWeek.tier1Response) && !/You have /.test(lastWeek.tier1Response));
      assertTrue('same IDs drive snapshots', snaps.map((e) => e.id).join(',') === ids.join(','));
      const rows = projectScheduleRowsFromPresentedIds(ids, snaps);
      assertTrue('Schedule rows are the same resolved set', rows.map((r) => r.id).sort().join(',') === [...ids].sort().join(','));
      const dayHeads = new Set(rows.map((r) => new Date(r.startMs).toLocaleDateString([], { weekday: 'short' }).toUpperCase()));
      assertTrue('historical rows group across multiple days', dayHeads.size >= 3);
      assertTrue('LAST WEEK heading', scheduleScopeLabel(scheduleScopeFromReason(lastWeek.reason!)) === 'LAST WEEK');

      const yesterday = await classifyQuery('What was on my calendar yesterday?');
      assertTrue('yesterday enrolls calendar:yesterday', yesterday.reason === 'calendar:yesterday');
      assertTrue('yesterday resolves Book club only', (yesterday.presentedCalendarEventIds ?? []).join(',') === 'e-yest');
      assertTrue('YESTERDAY heading', scheduleScopeLabel(scheduleScopeFromReason(yesterday.reason!)) === 'YESTERDAY');

      const lastMonth = await classifyQuery('What was on my calendar last month?');
      assertTrue('last month enrolls calendar:last_month', lastMonth.reason === 'calendar:last_month');
      assertTrue('last month includes August HOA', (lastMonth.presentedCalendarEventIds ?? []).includes('e-aug'));
      assertTrue('LAST MONTH heading', scheduleScopeLabel(scheduleScopeFromReason(lastMonth.reason!)) === 'LAST MONTH');

      const monthsAgo = await classifyQuery('What was on my calendar 2 months ago?');
      assertTrue('2 months ago enrolls month range', monthsAgo.reason === 'calendar:last_month');
      assertTrue('2 months ago is empty in this fixture', (monthsAgo.presentedCalendarEventIds ?? []).length === 0);
      assertTrue('empty historical range is honest', monthsAgo.tier1Response === 'Your calendar is clear 2 months ago.');

      setCalendarEventFetcher(async () => ({ status: 'ok', events: [] }));
      const emptyWeek = await classifyQuery('What was on my calendar last week?');
      assertTrue('empty last week is honest', emptyWeek.tier1Response === 'Your calendar is clear last week.');
      assertTrue('empty last week still presents a resolved set', Array.isArray(emptyWeek.presentedCalendarEventIds) && emptyWeek.presentedCalendarEventIds.length === 0 && Array.isArray(emptyWeek.presentedCalendarEvents));

      setCalendarEventFetcher(async () => ({
        status: 'ok',
        events: [rawEvent('e-vance', 'Appointment with Dr. Vance', vance)],
      }));
      const vanceRead = await classifyQuery('What was on my calendar last week?');
      assertTrue('past Dr Vance stays calendar-provenance', typeof vanceRead.tier1Response === 'string' && /Your calendar shows/.test(vanceRead.tier1Response) && /Dr\. Vance/.test(vanceRead.tier1Response));
      assertTrue('past Dr Vance is not an occurred-visit assertion', typeof vanceRead.tier1Response === 'string' && !OCCURRED.test(vanceRead.tier1Response) && !/You last saw/i.test(vanceRead.tier1Response));

      const today = await classifyQuery("What's on my calendar today?");
      const tomorrow = await classifyQuery("What's on my calendar tomorrow?");
      const thisWeek = await classifyQuery("What's on my calendar this week?");
      const nextWeek = await classifyQuery("What's on my calendar next week?");
      assertTrue('today does not regress', today.reason === 'calendar:today');
      assertTrue('tomorrow does not regress', tomorrow.reason === 'calendar:tomorrow');
      assertTrue('this week does not regress', thisWeek.reason === 'calendar:week');
      assertTrue('next week does not regress', nextWeek.reason === 'calendar:next_week');
    } finally {
      resetCalendarEventFetcher();
      resetNow();
    }
  }

  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files = fs.readdirSync(path.join(root, 'src/components'));
    assertTrue('no second historical Schedule component', !files.some((f) => /historical/i.test(f)));
    const surface = fs.readFileSync(path.join(root, 'src/components/ScheduleSurface.tsx'), 'utf8');
    const router = fs.readFileSync(path.join(root, 'src/routing/tierRouter.ts'), 'utf8');
    const ingest = fs.readFileSync(path.join(root, 'src/db/calendarEvidenceIngest.ts'), 'utf8');
    assertTrue('existing ScheduleSurface remains the card', /title="SCHEDULE"/.test(surface) && /From your calendar/.test(surface));
    assertTrue('historical reads use queryCalendarRange', /queryCalendarRange/.test(router) && /resolveHistoricalCalendarRange/.test(router));
    assertTrue('historical reads do not use appointments as complete source', !/getAppointmentsForLocalDate/.test(router));
    assertTrue('isAppointmentWorth is unchanged', /APPOINTMENT_KEYWORDS/.test(ingest) && ingest.includes('return APPOINTMENT_KEYWORDS.some((kw) => text.includes(kw));'));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}HistoricalCalendarRangeRecall: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('historicalCalendarRangeRecall.test.ts')) {
  runHistoricalCalendarRangeRecallTests().catch(console.error);
}
