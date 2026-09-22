// Everyday Capability Surfaces V1 — Stage 3 Schedule locks.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setDB, SCHEMA_VERSION } from '../../src/db/schema.ts';
import {
  classifyScheduleTitleIcon,
  projectScheduleRowsFromPresentedIds,
  scheduleOutcomeIdentifiesSurface,
} from '../../src/routing/scheduleSurfacePresentation.ts';
import type { UtteranceOutcome } from '../../src/routing/processUtterance.ts';
import { formatCachedEventsForSpeech, isCalendarAgendaSpeech } from '../../src/db/calendarCacheDB.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function fresh() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE calendar_cache (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      all_day INTEGER DEFAULT 0,
      notes TEXT,
      cached_at TEXT NOT NULL
    );
  `);
  setDB({
    getAllSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).all(...p); } catch { return []; } },
    getFirstSync: (s: string, p: unknown[] = []) => { try { return db.prepare(s).get(...p) ?? null; } catch { return null; } },
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  });
  return db;
}

export async function runEverydayScheduleCapabilitySurfaceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Everyday Capability Surfaces V1 (Stage 3 Schedule) --${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chatSrc = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const surfaceSrc = fs.readFileSync(path.join(root, 'src/components/ScheduleSurface.tsx'), 'utf8');
  const overlaySrc = fs.readFileSync(path.join(root, 'src/routing/scheduleSurfacePresentation.ts'), 'utf8');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
  const grocerySrc = fs.readFileSync(path.join(root, 'src/components/GrocerySurface.tsx'), 'utf8');
  const writerSrc = fs.readFileSync(path.join(root, 'src/routing/routeIntent.ts'), 'utf8');
  const schemaSrc = fs.readFileSync(path.join(root, 'src/db/schema.ts'), 'utf8');

  {
    const db = fresh();
    const t0 = Date.parse('2026-09-14T15:16:00.000Z');
    const t1 = Date.parse('2026-09-15T00:00:00.000Z');
    db.prepare(`INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at) VALUES (?,?,?,?,?,?,?)`)
      .run('e2', 'Later meeting', t1, t1 + 3600000, 0, 'do not show notes', '2026-09-12T00:00:00.000Z');
    db.prepare(`INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at) VALUES (?,?,?,?,?,?,?)`)
      .run('e1', 'Flight to Chicago', t0, t0 + 3600000, 0, 'AA 1251 secret', '2026-09-12T00:00:00.000Z');
    db.prepare(`INSERT INTO calendar_cache (id, title, start_ms, end_ms, all_day, notes, cached_at) VALUES (?,?,?,?,?,?,?)`)
      .run('e3', 'All-day conference', t1, t1 + 86400000, 1, null, '2026-09-12T00:00:00.000Z');
    const rows = projectScheduleRowsFromPresentedIds(['e2', 'missing', 'e1', 'e3']);
    assert('projection uses presentedCalendarEventIds and drops stale IDs',
      rows.map((r) => r.id).join(','),
      (v) => v === 'e1,e2,e3',
      'e1,e2,e3 chronological; missing dropped');
    assert('stored title is rendered faithfully without notes/airline synthesis',
      rows.every((r) => r.title === (r.id === 'e1' ? 'Flight to Chicago' : r.id === 'e2' ? 'Later meeting' : 'All-day conference'))
      && !('notes' in rows[0]),
      (v) => v === true, 'titles only');
    assert('all-day flag is preserved from cache',
      rows.find((r) => r.id === 'e3')?.allDay,
      (v) => v === true, 'true');
    assert('chronological ordering by start_ms',
      rows[0]?.id === 'e1' && rows[1]?.id === 'e2',
      (v) => v === true, 'true');
  }

  {
    assert('explicit flight title maps to flight icon',
      classifyScheduleTitleIcon('Flight to Chicago'), (v) => v === 'flight', 'flight');
    assert('explicit birthday title maps to birthday icon',
      classifyScheduleTitleIcon('Sam birthday'), (v) => v === 'birthday', 'birthday');
    assert('explicit dinner title maps to dining icon',
      classifyScheduleTitleIcon('Dinner at Weber Grill'), (v) => v === 'dining', 'dining');
    assert('explicit Dr. title maps to doctor icon',
      classifyScheduleTitleIcon('Dr. Smith'), (v) => v === 'doctor', 'doctor');
    assert('vague medical-ish title stays generic',
      classifyScheduleTitleIcon('Annual physical'), (v) => v === 'generic', 'generic');
    assert('uncertain titles use generic calendar icon',
      classifyScheduleTitleIcon('Team standup'), (v) => v === 'generic', 'generic');
  }

  {
    const calendarRead: UtteranceOutcome = {
      handled: false,
      routeDecision: {
        kind: 'device_read',
        tier: 1,
        response: 'You have Flight to Chicago today.',
        reason: 'calendar:today',
        presentedCalendarEventIds: ['e1'],
      },
      continuationRecoveryCandidates: [],
    };
    const chitChat: UtteranceOutcome = {
      handled: false,
      routeDecision: { kind: 'backend', tier: 3, reason: 'chit_chat' },
      continuationRecoveryCandidates: [],
    };
    assert('Schedule activates from structured calendar presented IDs',
      scheduleOutcomeIdentifiesSurface(calendarRead), (v) => v === true, 'true');
    assert('ordinary chit-chat does not identify Schedule',
      scheduleOutcomeIdentifiesSurface(chitChat), (v) => v === false, 'false');
    assert('no speech-text activation heuristic for Schedule',
      scheduleOutcomeIdentifiesSurface({
        handled: true,
        source: 'referent_resume',
        responseText: 'You have Flight to Chicago today.',
        commits: [],
      }),
      (v) => v === false, 'false');
    assert('unresolved weekday refusal does not identify Schedule',
      scheduleOutcomeIdentifiesSurface({
        handled: false,
        routeDecision: {
          kind: 'device_read',
          tier: 1,
          response: 'I can only tell you about today, tomorrow, this week, or next week right now.',
          reason: 'calendar:unresolved_weekday',
        },
        continuationRecoveryCandidates: [],
      }),
      (v) => v === false, 'false');
    assert('structured capabilitySurface schedule hint identifies the surface',
      scheduleOutcomeIdentifiesSurface({
        handled: true,
        source: 'referent_resume',
        responseText: 'Tomorrow you have: Lunch.',
        commits: [],
        capabilitySurface: 'schedule',
        presentedCalendarEventIds: ['e1'],
        calendarReadReason: 'calendar:tomorrow',
      }),
      (v) => v === true, 'true');
  }

  assert('schema version unchanged',
    SCHEMA_VERSION, (v) => v === 24, '24');
  assert('projection does not write or read appointments/medical tables',
    /appointments/.test(overlaySrc) || /medical_records/.test(overlaySrc) || /detectCategory/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('projection never inspects notes for icon or display',
    !/event\.notes/.test(overlaySrc) && /classifyScheduleTitleIcon\(event\.title\)/.test(overlaySrc),
    (v) => v === true, 'true');
  assert('activation does not parse spoken calendar answer text',
    /You have/.test(overlaySrc) || /Your calendar is clear/.test(overlaySrc) || /formatCachedEventsForSpeech/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('ChatScreen Schedule is a non-completing workspace on the one slot',
    /kind: 'schedule'/.test(chatSrc)
    && /kind: 'grocery'/.test(chatSrc)
    && /kind: 'todo'/.test(chatSrc)
    && /kind: 'weather'/.test(chatSrc)
    && /ScheduleSurface/.test(chatSrc)
    && /projectScheduleRowsFromPresentedIds/.test(chatSrc)
    && !/onCompleteOpenRow/.test(surfaceSrc)
    && !/Pressable/.test(surfaceSrc)
    && !/textDecorationLine/.test(surfaceSrc),
    (v) => v === true, 'true');
  assert('Schedule persists across ordinary chit-chat (sendMessage clears weather only)',
    /latLog\('sendMessage entry'[\s\S]*?setActiveSurface\(\(prev\) => \(prev\?\.kind === 'weather' \? null : prev\)\)/.test(chatSrc)
    && /scheduleOutcomeIdentifiesSurface/.test(chatSrc),
    (v) => v === true, 'true');
  assert('Grocery/To-do/Weather/Schedule are mutually exclusive visual workspaces',
    /activeSurface\?\.kind === 'weather'/.test(chatSrc)
    && /activeSurface\?\.kind === 'grocery' \?/.test(chatSrc)
    && /activeSurface\?\.kind === 'todo' \?/.test(chatSrc)
    && /activeSurface\?\.kind === 'schedule' \?/.test(chatSrc),
    (v) => v === true, 'true');
  assert('provenance is rendered as From your calendar',
    /From your calendar/.test(surfaceSrc),
    (v) => v === true, 'true');
  assert('unloaded state uses existing calendar-loaded copy, not a fake empty agenda',
    /I don't have your calendar loaded yet/.test(surfaceSrc)
    && !/Nothing on this window/.test(surfaceSrc),
    (v) => v === true, 'true');
  assert('continuation calendar reads carry presented IDs, not speech matching',
    /capabilitySurface: 'schedule'/.test(processSrc)
    && /presentedCalendarEventIds/.test(processSrc)
    && /readCalendarScope\(scope\)/.test(processSrc),
    (v) => v === true, 'true');
  assert('Grocery Stage 1 tap-to-complete behavior remains unchanged',
    /onCompleteOpenRow=\{handleGroceryCompleteOpenRow\}/.test(chatSrc)
    && /row\.status === 'open' && onCompleteOpenRow/.test(grocerySrc),
    (v) => v === true, 'true');
  assert('existing To-do confirmation mechanism remains unchanged',
    /pendingKey: 'todo_complete'/.test(writerSrc)
    && /Just to make sure — you're saying you've completed/.test(writerSrc),
    (v) => v === true, 'true');
  assert('no medical inference imported into Schedule presentation',
    /detectMedicalEvent/.test(overlaySrc) || /medicalDB/.test(overlaySrc) || /useCalendar/.test(overlaySrc),
    (v) => v === false, 'false');
  assert('schema still has calendar_cache as the event source',
    /CREATE TABLE calendar_cache/.test(schemaSrc),
    (v) => v === true, 'true');
  assert('Schedule hideProse uses calendar agenda speech helper while Schedule is active',
    /kind === 'schedule'/.test(chatSrc)
    && /isCalendarAgendaSpeech\(item\.content\)/.test(chatSrc)
    && /isGroceryListReadSummarySpeech\(item\.content\)/.test(chatSrc)
    && /isTodoOpenListSpeech\(item\.content\)/.test(chatSrc)
    && /speak\(outcome\.responseText\)/.test(chatSrc),
    (v) => v === true, 'true');
  {
    const week = 'This week you have: Flight to Chicago on Monday, and Dinner on Tuesday.';
    assert('week agenda speech is hideable',
      isCalendarAgendaSpeech(week), (v) => v === true, 'true');
    assert('chit-chat is not treated as agenda speech',
      isCalendarAgendaSpeech("You're welcome."), (v) => v === false, 'false');
    assert('formatCachedEventsForSpeech is unchanged by the hide helper',
      typeof formatCachedEventsForSpeech, (v) => v === 'function', 'function');
  }
  assert('bounded density: title 16/18, padding 6, minHeight 40, day/scope 5',
    /title: \{[\s\S]*?fontSize: 16,[\s\S]*?lineHeight: 18/.test(surfaceSrc)
    && /paddingVertical: 6/.test(surfaceSrc)
    && /minHeight: 40/.test(surfaceSrc)
    && /marginTop: 5/.test(surfaceSrc)
    && /marginBottom: 5/.test(surfaceSrc)
    && /fontSize: 12/.test(surfaceSrc)
    && /title: \{[\s\S]*?fontSize: 12/.test(fs.readFileSync(path.join(root, 'src/components/CapabilitySurfaceFrame.tsx'), 'utf8')),
    (v) => v === true, 'true');
  assert('hide helper does not live in projection/provenance modules',
    /isCalendarAgendaSpeech/.test(overlaySrc) || /formatCachedEventsForSpeech/.test(overlaySrc),
    (v) => v === false, 'false');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EverydayScheduleCapabilitySurface: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('everydayScheduleCapabilitySurface.test.ts')) {
  runEverydayScheduleCapabilitySurfaceTests().catch(console.error);
}
