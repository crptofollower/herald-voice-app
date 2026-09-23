// Explicit Domain Reference V1 — dormant observation. Not a route owner.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectExplicitDomainReference } from '../../src/routing/explicitDomainReference.ts';
import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function srcText() {
  return fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/explicitDomainReference.ts'),
    'utf8',
  );
}

export async function runExplicitDomainReferenceV1Tests() {
  let passed = 0;
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  function assert(label: string, cond: boolean, expected = 'true') {
    if (cond) {
      console.log(`${GREEN}PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${RESET}  ${label}`);
      failures.push({ label, got: false, expected });
    }
  }

  console.log(`\n${BOLD}-- Explicit Domain Reference V1 ------------------------------${RESET}\n`);

  function positive(input: string, family: 'calendar' | 'medications') {
    const hit = detectExplicitDomainReference(input);
    assert(`${input} → ${family}`, hit?.family === family);
    assert(
      `${input} groundedSpan is literal substring`,
      !!hit && input.includes(hit.groundedSpan) && hit.groundedSpan.length > 0,
    );
    assert(`${input} deterministic`, JSON.stringify(detectExplicitDomainReference(input)) === JSON.stringify(hit));
  }

  function negative(input: string, label?: string) {
    assert(`${label ?? input} → null`, detectExplicitDomainReference(input) === null);
  }

  positive('my calendar', 'calendar');
  positive('I was asking about my calendar', 'calendar');
  positive('I meant my calendar', 'calendar');
  positive('calendar', 'calendar');
  positive('my schedule', 'calendar');

  positive('my medications', 'medications');
  positive('I was asking about my medications', 'medications');
  positive('my meds', 'medications');
  positive('my medication', 'medications');
  positive('my medicine', 'medications');

  negative('Tell me more about that.', 'unrelated');
  negative('my calendar and my medications');
  negative('calendar or medications');
  negative("I wasn't asking about my calendar");
  negative('not my medications');
  negative('I meant my calendar, not my medications');
  negative('I was not asking about my medications');

  const src = srcText();
  assert('no DB import', !/\bgetDB\b/.test(src) && !/from ['"].*\/db\//.test(src));
  assert('no routeIntent/classifyQuery/model', !/routeIntent|classifyQuery|llama\.rn|LlamaContext/.test(src));
  assert('no mutable module state', !/\blet\b|\bvar\b/.test(src.split('export function')[0]));

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);

    const a = await say('my calendar');
    assert(
      'prod my calendar still needs_clarification/default',
      !a.handled && a.routeDecision.kind === 'needs_clarification' && a.routeDecision.reason === 'default',
    );
    const b = await say('I was asking about my calendar');
    assert(
      'prod I was asking about my calendar still default',
      !b.handled && b.routeDecision.kind === 'needs_clarification' && b.routeDecision.reason === 'default',
    );
    const cQ = await classifyQuery(normalizeInput("What's on my calendar tomorrow?"));
    assert('prod calendar tomorrow still calendar:tomorrow', cQ.reason === 'calendar:tomorrow' && cQ.tier === 1);
    const c = await say("What's on my calendar tomorrow?");
    assert(
      'prod calendar tomorrow still device_read',
      !c.handled && c.routeDecision.kind === 'device_read' && c.routeDecision.reason === 'calendar:tomorrow',
    );
    const dQ = await classifyQuery(normalizeInput('my medications'));
    assert('prod my medications still medical:summary', dQ.reason === 'medical:summary' && dQ.tier === 1);
    const eQ = await classifyQuery(normalizeInput('I was asking about my medications'));
    assert('prod asking medications still medical:summary', eQ.reason === 'medical:summary' && eQ.tier === 1);
    const calWrite = await classifyQuery(normalizeInput('Put this on my calendar.'));
    assert(
      'prod calendar write journey still calendar_write',
      calWrite.reason === 'action:calendar_write' && calWrite.actionIntent?.type === 'calendar_write',
    );
    const medWrite = await classifyQuery(normalizeInput('I take Metformin 500 mg twice a day.'));
    assert(
      'prod medication write journey still medical_capture',
      medWrite.reason === 'action:medical_capture' && medWrite.actionIntent?.type === 'medical_capture',
    );
    assert('EDR still calendar on asking-calendar', detectExplicitDomainReference('I was asking about my calendar')?.family === 'calendar');
    assert('EDR still medications on asking-meds', detectExplicitDomainReference('I was asking about my medications')?.family === 'medications');
    assert('session pending untouched by EDR-only calls', session.peekPendingKey() === null);
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('explicitDomainReference.test.ts')) {
  runExplicitDomainReferenceV1Tests().then((r) => {
    console.log(`\n${BOLD}ExplicitDomainReferenceV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
