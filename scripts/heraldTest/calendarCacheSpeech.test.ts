// scripts/heraldTest/calendarCacheSpeech.test.ts
// formatCachedEventsForSpeech — TITLE_HAS_WEEKDAY (no doubled day labels).
//
// Runner: npx tsx scripts/heraldTest/calendarCacheSpeech.test.ts

import {
  formatCachedEventsForSpeech,
  type CachedEvent,
} from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function ev(partial: Partial<CachedEvent> & Pick<CachedEvent, 'title'>): CachedEvent {
  const start = partial.start_ms ?? new Date(2026, 6, 10).getTime(); // Fri Jul 10 2026 local
  return {
    id: partial.id ?? 'e1',
    title: partial.title,
    start_ms: start,
    end_ms: partial.end_ms ?? start + 3_600_000,
    all_day: partial.all_day ?? 1,
    cached_at: partial.cached_at ?? '2026-07-10T12:00:00.000Z',
  };
}

export async function runCalendarCacheSpeechTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- calendarCacheSpeech Contract Tests (TITLE_HAS_WEEKDAY) --${RESET}\n`);

  // CCS1: title already has weekday → no trailing dayLabel on single-event tomorrow
  {
    const got = formatCachedEventsForSpeech(
      [ev({ title: "pick up cake for Val's family Saturday" })],
      'tomorrow',
    );
    assert(
      'CCS1 title with Saturday + tomorrow → ends "...Saturday." (no trailing dayLabel)',
      got,
      (v) =>
        typeof v === 'string' &&
        !/Saturday tomorrow/i.test(v) &&
        v === "You have pick up cake for Val's family Saturday.",
      `You have pick up cake for Val's family Saturday.`,
    );
  }

  // CCS2: no weekday in title → trailing dayLabel still present
  {
    const got = formatCachedEventsForSpeech(
      [ev({ title: 'Dentist appointment' })],
      'tomorrow',
    );
    assert(
      'CCS2 "Dentist appointment" + tomorrow → still "...Dentist appointment tomorrow."',
      got,
      (v) => v === 'You have Dentist appointment tomorrow.',
      'You have Dentist appointment tomorrow.',
    );
  }

  // CCS3: this-week + title has Friday → skip per-event "on ${weekday}"
  {
    const fridayMs = new Date(2026, 6, 10).getTime(); // Friday
    const got = formatCachedEventsForSpeech(
      [ev({ title: 'Team meeting Friday', start_ms: fridayMs })],
      'this week',
    );
    assert(
      'CCS3 "Team meeting Friday" + this week → no "Friday on Friday" / no on-weekday append',
      got,
      (v) =>
        typeof v === 'string' &&
        !/Friday on Friday/i.test(v) &&
        !/\bon\s+Friday\b/i.test(v) &&
        v === 'You have Team meeting Friday.',
      'You have Team meeting Friday.',
    );
  }

  // CCS4: this-week + no day in title → still appends "on {weekday}"
  {
    const fridayMs = new Date(2026, 6, 10).getTime();
    const weekday = new Date(fridayMs).toLocaleDateString([], { weekday: 'long' });
    const got = formatCachedEventsForSpeech(
      [ev({ title: 'Team meeting', start_ms: fridayMs })],
      'this week',
    );
    assert(
      `CCS4 "Team meeting" + this week → still contains "on ${weekday}"`,
      got,
      (v) =>
        typeof v === 'string' &&
        v.includes(`on ${weekday}`) &&
        v === `You have Team meeting on ${weekday} this week.`,
      `You have Team meeting on ${weekday} this week.`,
    );
  }

  // CCS5: multi-event tomorrow — opener unchanged once
  {
    const got = formatCachedEventsForSpeech(
      [
        ev({ id: 'a', title: "pick up cake for Val's family Saturday" }),
        ev({ id: 'b', title: 'Dentist appointment' }),
      ],
      'tomorrow',
    );
    assert(
      'CCS5 multi-event tomorrow → opener "Tomorrow you have:" once, unchanged',
      got,
      (v) => {
        if (typeof v !== 'string') return false;
        const openerCount = (v.match(/Tomorrow you have:/g) ?? []).length;
        return (
          openerCount === 1 &&
          v.startsWith('Tomorrow you have:') &&
          v === "Tomorrow you have: pick up cake for Val's family Saturday, and Dentist appointment."
        );
      },
      "Tomorrow you have: pick up cake for Val's family Saturday, and Dentist appointment.",
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}calendarCacheSpeech: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('calendarCacheSpeech.test.ts')) {
  runCalendarCacheSpeechTests().catch(console.error);
}
