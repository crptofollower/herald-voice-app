// scripts/heraldTest/calendarEvidenceRealization.test.ts
// Conversational Response Realization V1 — Calendar Evidence.
//
// Proves the mechanism, not a mood: provenance is carried structurally, the
// existing approved wording is preserved byte-for-byte, a disambiguation
// question appears only where the act requires one, and nothing here is
// generative (pure sync function, no model, no I/O, no clock).
//
// Runner: npx tsx scripts/heraldTest/calendarEvidenceRealization.test.ts

import {
  realizeCalendarEvidenceAct,
  type CalendarEvidenceResponseAct,
} from '../../src/conversation/calendarEvidenceRealization.ts';
import {
  buildCalendarEvidenceParts,
  formatCalendarEvidenceForSpeech,
  type CachedEvent,
} from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Generic chatbot closers this response family must never append. A question
// is legitimate ONLY when the act itself requires user input (multi-hit).
const GENERIC_CLOSERS = [
  /anything else/i,
  /let me know/i,
  /if you need/i,
  /ask me if/i,
  /can i help/i,
];

function ev(partial: Partial<CachedEvent> & Pick<CachedEvent, 'title'>): CachedEvent {
  const start = partial.start_ms ?? new Date(2026, 7, 12, 11, 0, 0).getTime(); // Wed Aug 12 2026 11:00 local
  return {
    id: partial.id ?? 'e1',
    title: partial.title,
    start_ms: start,
    end_ms: partial.end_ms ?? start + 3_600_000,
    all_day: partial.all_day ?? 0,
    cached_at: partial.cached_at ?? '2026-08-12T09:00:00.000Z',
  };
}

/** The pre-Realization template, recreated here independently, so "wording
 *  preserved" is proven against the old shape rather than against itself. */
function legacyHitSentence(displayName: string, event: CachedEvent, mode: 'weekday' | 'date'): string {
  const p = buildCalendarEvidenceParts(displayName, event);
  const when = mode === 'date' ? p.dateLabel : p.weekday;
  return p.timeStr === null
    ? `${p.prefix} ${p.displayName} on ${when}.`
    : `${p.prefix} ${p.displayName} on ${when} at ${p.timeStr}.`;
}

export async function runCalendarEvidenceRealizationTests() {
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

  console.log(`\n${BOLD}-- Calendar Evidence Realization (Response Realization V1) --${RESET}`);

  // ── 1. HIT: exact sentences, all four shape combinations ──────────────────
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: 'Dr. Estil Vance',
      weekday: 'Wednesday', dateLabel: 'August 12, 2026', timeStr: '11:00 AM', mode: 'weekday',
    });
    const want = 'Your calendar shows Dr. Estil Vance on Wednesday at 11:00 AM.';
    assert('CER1 hit weekday+time', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: 'Dr. Estil Vance',
      weekday: 'Wednesday', dateLabel: 'August 12, 2026', timeStr: null, mode: 'weekday',
    });
    const want = 'Your calendar shows Dr. Estil Vance on Wednesday.';
    assert('CER2 hit weekday all-day (no time clause)', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: 'Dr. Estil Vance',
      weekday: 'Wednesday', dateLabel: 'August 12, 2026', timeStr: '11:00 AM', mode: 'date',
    });
    const want = 'Your calendar shows Dr. Estil Vance on August 12, 2026 at 11:00 AM.';
    assert('CER3 hit date+time (year-bearing, historical safe)', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: 'Dr. Estil Vance',
      weekday: 'Wednesday', dateLabel: 'August 12, 2026', timeStr: null, mode: 'date',
    });
    const want = 'Your calendar shows Dr. Estil Vance on August 12, 2026.';
    assert('CER4 hit date all-day', got, (v) => v === want, want);
  }

  // ── 2. HIT provenance is structural, not incidental ───────────────────────
  {
    const combos: CalendarEvidenceResponseAct[] = [
      { kind: 'hit', displayName: 'Dr. Smith', weekday: 'Monday', dateLabel: 'May 4, 2026', timeStr: '3:00 PM', mode: 'weekday' },
      { kind: 'hit', displayName: 'Dr. Smith', weekday: 'Monday', dateLabel: 'May 4, 2026', timeStr: null, mode: 'weekday' },
      { kind: 'hit', displayName: 'Dentist', weekday: 'Friday', dateLabel: 'June 1, 2026', timeStr: '9:15 AM', mode: 'date' },
      { kind: 'hit', displayName: 'Dr. Muñoz', weekday: 'Tuesday', dateLabel: 'July 7, 2026', timeStr: null, mode: 'date' },
    ];
    const all = combos.map(realizeCalendarEvidenceAct);
    assert('CER5 every hit shape carries the calendar-evidence prefix',
      all.filter((s) => s.startsWith('Your calendar shows ')).length,
      (v) => v === combos.length, String(combos.length));
  }

  // ── 3. Existing approved wording preserved byte-for-byte ──────────────────
  {
    const e = ev({ title: 'Dr. Estil Vance follow-up' });
    const got = formatCalendarEvidenceForSpeech('Dr. Estil Vance', e, 'weekday');
    const want = legacyHitSentence('Dr. Estil Vance', e, 'weekday');
    assert('CER6 formatCalendarEvidenceForSpeech unchanged (weekday mode)', got, (v) => v === want, want);
  }
  {
    const e = ev({ title: 'Dr. Estil Vance follow-up' });
    const got = formatCalendarEvidenceForSpeech('Dr. Estil Vance', e, 'date');
    const want = legacyHitSentence('Dr. Estil Vance', e, 'date');
    assert('CER7 formatCalendarEvidenceForSpeech unchanged (date mode)', got, (v) => v === want, want);
  }
  {
    const e = ev({ title: 'Dr. Vance', all_day: 1 });
    const got = formatCalendarEvidenceForSpeech('Dr. Vance', e, 'weekday');
    const want = legacyHitSentence('Dr. Vance', e, 'weekday');
    assert('CER8 formatCalendarEvidenceForSpeech unchanged (all-day)', got, (v) => v === want, want);
  }
  {
    // Pins the fact-builder's prefix to realization's own constant, so a future
    // edit to either one alone fails here instead of silently diverging.
    const partsPrefix = buildCalendarEvidenceParts('Dr. X', ev({ title: 'Dr. X' })).prefix;
    const realized = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: 'Dr. X', weekday: 'Monday', dateLabel: 'May 4, 2026', timeStr: null, mode: 'weekday',
    });
    assert('CER9 parts prefix and realized prefix stay identical', realized,
      (v) => typeof v === 'string' && v.startsWith(`${partsPrefix} `), `startsWith("${partsPrefix} ")`);
  }

  // ── 4. MISS: exact sentences, both directions ─────────────────────────────
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'miss', displayName: 'Dr. Smith',
      scope: { kind: 'relative_months', direction: 'past', months: 12 },
    });
    const want = "I don't see anything with Dr. Smith on your calendar in the past 12 months.";
    assert('CER10 miss past (historical evidence window)', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'miss', displayName: 'Dr. Smith',
      scope: { kind: 'relative_months', direction: 'next', months: 6 },
    });
    const want = "I don't see anything with Dr. Smith on your calendar in the next 6 months.";
    assert('CER11 miss next (forward evidence window)', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'miss', displayName: 'Dr. Smith',
      scope: { kind: 'relative_months', direction: 'past', months: 12 },
    });
    assert('CER12 miss never asserts a calendar finding', got,
      (v) => typeof v === 'string' && !/Your calendar shows/.test(v), 'no "Your calendar shows"');
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'miss', displayName: 'Dr. Smith',
      scope: { kind: 'relative_months', direction: 'next', months: 6 },
    });
    assert('CER13 miss stays explicitly calendar-scoped', got,
      (v) => typeof v === 'string' && v.includes('on your calendar'), 'contains "on your calendar"');
  }

  // ── 5. MULTI: exact sentences + required disambiguation question ──────────
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'multi', displayName: 'Dr. Vance',
      scope: { kind: 'relative_months', direction: 'past', months: 12 },
      dates: ['Dr. Estil Vance on May 4, 2026', 'Dr. Robert Vance on June 2, 2026'],
    });
    const want = 'Your calendar shows 2 things with Dr. Vance in the past 12 months — '
      + 'Dr. Estil Vance on May 4, 2026, Dr. Robert Vance on June 2, 2026. Which one did you mean?';
    assert('CER14 multi past (namesake fence, never auto-picks)', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'multi', displayName: 'Dr. Vance',
      scope: { kind: 'relative_months', direction: 'next', months: 6 },
      dates: ['Dr. Estil Vance on May 4, 2026', 'Dr. Robert Vance on June 2, 2026'],
    });
    const want = 'Your calendar shows 2 things with Dr. Vance in the next 6 months — '
      + 'Dr. Estil Vance on May 4, 2026, Dr. Robert Vance on June 2, 2026. Which one did you mean?';
    assert('CER15 multi next', got, (v) => v === want, want);
  }
  {
    const got = realizeCalendarEvidenceAct({
      kind: 'multi', displayName: 'Dr. Smith',
      scope: { kind: 'year', year: 2025 },
      dates: ['May 4', 'June 2', 'October 9'],
    });
    const want = 'Your calendar shows 3 things with Dr. Smith in 2025 — May 4, June 2, October 9. Which one did you mean?';
    assert('CER16 multi year-bounded', got, (v) => v === want, want);
  }
  {
    const acts: CalendarEvidenceResponseAct[] = [
      { kind: 'multi', displayName: 'Dr. Vance', scope: { kind: 'relative_months', direction: 'past', months: 12 }, dates: ['a', 'b'] },
      { kind: 'multi', displayName: 'Dr. Vance', scope: { kind: 'year', year: 2025 }, dates: ['a', 'b', 'c'] },
    ];
    const all = acts.map(realizeCalendarEvidenceAct);
    assert('CER17 multi keeps provenance even while asking a question',
      all.filter((s) => s.startsWith('Your calendar shows ')).length, (v) => v === 2, '2');
    assert('CER18 multi always ends with the required disambiguation question',
      all.filter((s) => s.endsWith('Which one did you mean?')).length, (v) => v === 2, '2');
  }

  // ── 6. Ending behavior: no generic closers, no unrequired questions ───────
  {
    const acts: CalendarEvidenceResponseAct[] = [
      { kind: 'hit', displayName: 'Dr. Smith', weekday: 'Monday', dateLabel: 'May 4, 2026', timeStr: '3:00 PM', mode: 'weekday' },
      { kind: 'hit', displayName: 'Dr. Smith', weekday: 'Monday', dateLabel: 'May 4, 2026', timeStr: null, mode: 'date' },
      { kind: 'miss', displayName: 'Dr. Smith', scope: { kind: 'relative_months', direction: 'past', months: 12 } },
      { kind: 'miss', displayName: 'Dr. Smith', scope: { kind: 'relative_months', direction: 'next', months: 6 } },
      { kind: 'multi', displayName: 'Dr. Smith', scope: { kind: 'year', year: 2025 }, dates: ['May 4', 'June 2'] },
    ];
    const all = acts.map(realizeCalendarEvidenceAct);
    assert('CER19 no generic conversational closer in any kind',
      all.filter((s) => GENERIC_CLOSERS.some((re) => re.test(s))).length, (v) => v === 0, '0');
    const nonMulti = all.slice(0, 4);
    assert('CER20 only the disambiguation act ends in a question',
      nonMulti.filter((s) => s.includes('?')).length, (v) => v === 0, '0');
  }

  // ── 7. Deterministic and value-preserving ────────────────────────────────
  {
    const act: CalendarEvidenceResponseAct = {
      kind: 'multi', displayName: 'Dr. Estil Vance',
      scope: { kind: 'relative_months', direction: 'past', months: 12 }, dates: ['May 4', 'June 2'],
    };
    const results = new Set(Array.from({ length: 10 }, () => realizeCalendarEvidenceAct(act)));
    assert('CER21 pure — identical input always yields identical output', results.size, (v) => v === 1, '1');
  }
  {
    // Trust-critical identity value is concatenated verbatim: no casing change,
    // no punctuation normalization, no re-spelling.
    const name = 'Dr. Estil Vance-O’Neill, M.D.';
    const hit = realizeCalendarEvidenceAct({
      kind: 'hit', displayName: name, weekday: 'Wednesday', dateLabel: 'August 12, 2026', timeStr: '11:00 AM', mode: 'weekday',
    });
    const miss = realizeCalendarEvidenceAct({
      kind: 'miss', displayName: name, scope: { kind: 'relative_months', direction: 'past', months: 12 },
    });
    assert('CER22 displayName is spoken verbatim in every kind',
      hit.includes(name) && miss.includes(name), (v) => v === true, 'true');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}calendarEvidenceRealization: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('calendarEvidenceRealization.test.ts')) {
  runCalendarEvidenceRealizationTests().catch(console.error);
}
