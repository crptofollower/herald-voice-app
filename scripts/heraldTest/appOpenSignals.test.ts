// scripts/heraldTest/appOpenSignals.test.ts
// Deterministic Tier-1 app-open extractor — discourse prefix, request-frame,
// stop-word boundary, and live ai_name wake-word (never hardcoded).
// Also owns the shared launch ACK seam (composeLaunchAck / launchAppAndCompose)
// and a ChatScreen executeIntent source-lock: false launch cannot reach "done".
//
// Runner: npx tsx scripts/heraldTest/appOpenSignals.test.ts
// Gate:   wired from run.mjs

import Database from 'better-sqlite3';
import { setDB } from '../../src/db/schema.ts';
import { setProfileField } from '../../src/db/profileDB.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { composeLaunchAck, launchAppAndCompose } from '../../src/screens/chat/dispatch.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SCHEMA_SQL = `
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
  setProfileField('ai_name', 'Kit');
  return db;
}

function actionType(d: { actionIntent?: { type?: string } }): string | undefined {
  return d.actionIntent?.type;
}

function appNameOf(d: { actionIntent?: { type?: string; appName?: string } }): string | undefined {
  return d.actionIntent?.type === 'app_open' ? d.actionIntent.appName : undefined;
}

export async function runAppOpenSignalsTests() {
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

  console.log(`\n${BOLD}-- App-Open Signals Tests -------------------------------${RESET}`);

  const positives: [string, string][] = [
    ['Open YouTube', 'YouTube'],
    ['Open my email', 'email'],
    ['Launch Maps', 'Maps'],
    ['Start Gmail', 'Gmail'],
    ['Pull up YouTube', 'YouTube'],
    ['Can you open YouTube for me', 'YouTube'],
    ['Could you open Maps please', 'Maps'],
    ['Like Kit can you open YouTube for me', 'YouTube'],
    ['Yeah Kit open my email', 'email'],
    ['Open the YouTube app', 'YouTube'],
    ['Open my email please', 'email'],
    ['Like Kit can you open YouTube for me I think I already showed this one to you', 'YouTube'],
  ];
  for (const [phrase, expectedName] of positives) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(
      `pos "${phrase}" → app_open/${expectedName}`,
      { type: actionType(d), appName: appNameOf(d) },
      (v) => {
        const o = v as { type?: string; appName?: string };
        return o.type === 'app_open' && o.appName === expectedName;
      },
      `app_open/${expectedName}`,
    );
  }

  const negatives = [
    'Chrome was left open overnight',
    'The store is open late',
    'Keep the window open tonight',
    'I like to keep YouTube open while cooking',
    'I have an open item on my to-do list',
    'What is open on my to-do list',
    'Show my open tasks',
    'Like Harold can you open YouTube for me',
    'Yeah Harold open my email',
  ];
  for (const phrase of negatives) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`neg "${phrase}" ≠ app_open`, actionType(d), (v) => v !== 'app_open', 'not app_open');
  }

  {
    freshDB();
    const d = await classifyQuery('Open Frobnicator');
    assert(
      'unsupported "Open Frobnicator" → app_open/Frobnicator',
      { type: actionType(d), appName: appNameOf(d) },
      (v) => {
        const o = v as { type?: string; appName?: string };
        return o.type === 'app_open' && o.appName === 'Frobnicator';
      },
      'app_open/Frobnicator',
    );
  }

  const cameraRegs = [
    'open camera',
    'open my camera',
    'take a selfie',
    'take a picture',
    'snap a picture',
    'open banking app',
  ];
  for (const phrase of cameraRegs) {
    freshDB();
    const d = await classifyQuery(phrase);
    assert(`cam "${phrase}" → app_open`, actionType(d), (v) => v === 'app_open', 'app_open');
  }

  // ── Shared launch ACK seam (2026-08-15 truthful ACK / status convergence) ──
  const FAIL_COPY = "I don't have YouTube set up to open yet — try it manually.";
  {
    assert(
      'composeLaunchAck(YouTube, true) → Opening YouTube.',
      composeLaunchAck('YouTube', true),
      (v) => v === 'Opening YouTube.',
      'Opening YouTube.',
    );
    assert(
      'composeLaunchAck(YouTube, false) → honest fail copy',
      composeLaunchAck('YouTube', false),
      (v) => v === FAIL_COPY,
      FAIL_COPY,
    );
  }
  {
    const ok = await launchAppAndCompose('YouTube', async () => true);
    assert(
      'launchAppAndCompose(...true) → opened true + success ACK',
      ok,
      (v) => (v as { opened: boolean; ack: string }).opened === true
        && (v as { opened: boolean; ack: string }).ack === 'Opening YouTube.',
      'opened true + Opening YouTube.',
    );
  }
  {
    const miss = await launchAppAndCompose('YouTube', async () => false);
    assert(
      'launchAppAndCompose(...false) → opened false + fail ACK',
      miss,
      (v) => (v as { opened: boolean; ack: string }).opened === false
        && (v as { opened: boolean; ack: string }).ack === FAIL_COPY,
      'opened false + honest fail copy',
    );
  }
  {
    const threw = await launchAppAndCompose('YouTube', async () => {
      throw new Error('blocked');
    });
    assert(
      'launchAppAndCompose(...throw) → opened false + fail ACK',
      threw,
      (v) => (v as { opened: boolean; ack: string }).opened === false
        && (v as { opened: boolean; ack: string }).ack === FAIL_COPY,
      'opened false + honest fail copy',
    );
  }
  {
    const miss = await launchAppAndCompose('YouTube', async () => false);
    const threw = await launchAppAndCompose('YouTube', async () => {
      throw new Error('blocked');
    });
    assert(
      'false/throw ACK cannot contain Opening',
      { miss: miss.ack, threw: threw.ack },
      (v) => {
        const o = v as { miss: string; threw: string };
        return !o.miss.includes('Opening') && !o.threw.includes('Opening');
      },
      'no Opening in fail ACKs',
    );
  }
  {
    const chatSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx'),
      'utf8',
    );
    const executeStart = chatSrc.indexOf('const executeIntent = async');
    const executeEnd = chatSrc.indexOf('const handleCalendarAction');
    const executeSrc = executeStart >= 0 && executeEnd > executeStart
      ? chatSrc.slice(executeStart, executeEnd)
      : '';
    const launchStart = executeSrc.indexOf('case "launch"');
    const launchEnd = executeSrc.indexOf('case "music"');
    const launchCase = launchStart >= 0 && launchEnd > launchStart
      ? executeSrc.slice(launchStart, launchEnd)
      : '';
    const doneIdx = executeSrc.indexOf('setActionStatus("done")');
    const catchIdx = executeSrc.indexOf('} catch (err)');
    const errorIdx = executeSrc.indexOf('setActionStatus("error")');
    assert(
      'executeIntent launch: !opened throws before done; catch sets error',
      {
        usesSeam: launchCase.includes('launchAppAndCompose'),
        throwsOnFalse: /if\s*\(\s*!opened\s*\)/.test(launchCase) && launchCase.includes('throw'),
        doneNotInLaunchCase: !launchCase.includes('setActionStatus("done")'),
        doneAfterLaunchCase: doneIdx > launchEnd,
        doneBeforeCatch: doneIdx >= 0 && catchIdx > doneIdx,
        catchSetsError: errorIdx > catchIdx && catchIdx >= 0,
      },
      (v) => {
        const o = v as Record<string, boolean>;
        return o.usesSeam && o.throwsOnFalse && o.doneNotInLaunchCase
          && o.doneAfterLaunchCase && o.doneBeforeCatch && o.catchSetsError;
      },
      'false launch throws into existing catch/error; cannot reach done',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}AppOpenSignals: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('appOpenSignals.test.ts')) {
  runAppOpenSignalsTests().catch(console.error);
}
