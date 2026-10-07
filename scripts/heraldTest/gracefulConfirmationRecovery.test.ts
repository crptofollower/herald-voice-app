// Graceful Confirmation Recovery V1 — family confirm release and residence authority.
// Runner: wired from run.mjs.

import { applyIntents, processUtterance } from '../../src/routing/processUtterance.ts';
import { DOMAIN_WRITERS } from '../../src/routing/routeIntent.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { detectFamilyCapture } from '../../src/utils/familyCapture.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { openJourneyDb } from './journeyHarness.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const DEFAULT_REASK = "I'm not sure I'm following — can you say that again?";
const RELEASE_ACK = "Let's come back to that — just tell me again anytime.";
const VISITING = 'My son Alex is visiting from New York.';
const WEEK = "He's here for the week.";
const WHO = 'Do you know who my son is?';
const ABOUT = 'Do you know what I was just talking about?';
const HUNTER = "My son Hunter came in from New York City, he's visiting us for a week.";
const AUSTIN = 'My son David lives in Austin.';

type ContactRow = { name: string; relationship: string | null; location: string | null };

function contacts(db: { prepare: (sql: string) => { all: () => ContactRow[] } }): ContactRow[] {
  return db.prepare(
    `SELECT name, relationship, location FROM contacts WHERE removed_at IS NULL ORDER BY name`,
  ).all();
}

export async function runGracefulConfirmationRecoveryV1Tests() {
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

  console.log(`\n${BOLD}-- Graceful Confirmation Recovery V1 ----------------------${RESET}\n`);

  function routedDeps(base: ReturnType<typeof openJourneyDb>['deps']) {
    let queries = 0;
    let models = 0;
    const deps = {
      ...base,
      classifyQuery: async (msg: string) => {
        queries += 1;
        return classifyQuery(msg);
      },
      classifyLLM: async () => {
        models += 1;
        return { status: 'ok' as const, intents: [] as IntentRecord[] };
      },
    };
    return {
      deps,
      counts: () => ({ queries, models }),
      reset: () => { queries = 0; models = 0; },
    };
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps);
    const captured = detectFamilyCapture(VISITING);
    assert('GCR-1a visiting capture has no residence', captured.length === 1 && captured[0].location === undefined);
    const arm = await say(VISITING);
    const prompt = arm.handled && arm.source === 'capture' ? arm.responseText : '';
    assert('GCR-1b confirmation is family_capture', arm.handled === true && arm.source === 'capture' && session.peekPendingKey() === 'family_capture');
    assert('GCR-1c prompt names Alex and son', prompt === 'Alex, your son — that right?');
    assert('GCR-1d prompt contains no city', !/new york/i.test(prompt));
    const yes = await say('yes');
    const rows = contacts(db as never);
    assert('GCR-5 yes commits through the existing path', yes.handled === true && yes.source === 'pending_resume' && yes.commits[0]?.status === 'committed');
    assert('GCR-1e Alex/son stored with no location', rows.length === 1 && rows[0].name === 'Alex' && rows[0].relationship === 'son' && (rows[0].location == null || rows[0].location === ''));
    assert('GCR-5b confirm pending is gone after yes', session.peekPendingKey() === null);
  }

  {
    const { db, session, deps: base } = openJourneyDb();
    const routed = routedDeps(base);
    const say = (t: string) => processUtterance(normalizeInput(t), session, routed.deps);
    await say(VISITING);
    routed.reset();
    const next = await say(WEEK);
    const speech = next.handled ? next.responseText : '';
    assert('GCR-2a week elaboration writes nothing', contacts(db as never).length === 0);
    assert('GCR-2b family pending is cleared', session.peekPendingKey() === null);
    assert('GCR-2c old pending does not speak DEFAULT_REASK', speech !== DEFAULT_REASK);
    assert('GCR-2d elaboration is not consumed as pending_resume', !(next.handled && next.source === 'pending_resume'));
    assert('GCR-2e same utterance is routed once', routed.counts().queries === 1);
    assert('GCR-10a recovery does not call a model', routed.counts().models === 0);
    const who = await say(WHO);
    const read = !who.handled && who.routeDecision.kind === 'device_read' && who.routeDecision.reason === 'family:read'
      ? who.routeDecision.response
      : '';
    assert('GCR-3a who-is-my-son reaches family read', !who.handled && who.routeDecision.kind === 'device_read' && who.routeDecision.reason === 'family:read');
    assert('GCR-3b family read is not the old re-ask', read.length > 0 && read !== DEFAULT_REASK && /son/i.test(read));
  }

  {
    const { session, deps: base } = openJourneyDb();
    const routed = routedDeps(base);
    const say = (t: string) => processUtterance(normalizeInput(t), session, routed.deps);
    await say(VISITING);
    routed.reset();
    const about = await say(ABOUT);
    const speech = about.handled ? about.responseText : '';
    assert('GCR-4a talking-about is not DEFAULT_REASK', speech !== DEFAULT_REASK);
    assert('GCR-4b talking-about is not pending_resume', !(about.handled && about.source === 'pending_resume'));
    assert('GCR-4c talking-about is routed once', routed.counts().queries === 1 && session.peekPendingKey() !== 'family_capture');
    assert('GCR-10b no model call on that release', routed.counts().models === 0);
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps);
    await say('My wife is Shannon.');
    const no = await say('No');
    assert('GCR-6a plain No enters the name correction', no.handled === true && no.source === 'pending_resume' && session.peekPendingKey() === 'family_capture_correction');
    assert('GCR-6b plain No writes nothing', contacts(db as never).length === 0);
    const second = openJourneyDb();
    const say2 = (t: string) => processUtterance(normalizeInput(t), second.session, second.deps);
    await say2('My wife Shannon lives in Austin.');
    const corrected = await say2("No, it's Jennifer");
    const prompt = corrected.handled ? corrected.responseText : '';
    assert('GCR-6c correction re-confirms Jennifer', corrected.handled === true && second.session.peekPendingKey() === 'family_capture_correction_confirm' && prompt === 'Jennifer, your wife, in Austin — that right?');
    assert('GCR-6d correction writes nothing yet', contacts(second.db as never).length === 0);
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps);
    await say(VISITING);
    const cancel = await say('never mind');
    assert('GCR-7a cancel clears the family confirm', cancel.handled === true && cancel.source === 'pending_resume' && session.peekPendingKey() === null);
    assert('GCR-7b cancel writes nothing', contacts(db as never).length === 0 && /won'?t do that/i.test(cancel.handled ? cancel.responseText : ''));
  }

  {
    const { db, session } = openJourneyDb();
    const phrase = HUNTER;
    const intent: IntentRecord = {
      type: 'family_capture',
      relation: 'son',
      name: 'Hunter',
      location: 'New York City',
    };
    const armed = await applyIntents([intent], phrase, session, undefined, 'llm');
    assert('GCR-8a model proposal arms llm_confirm:family_capture', session.peekPendingKey() === 'llm_confirm:family_capture' && !/new york/i.test(armed.responseText));
    const firstYes = await session.resolvePending('yes');
    const confirm = firstYes.status === 'pending' ? firstYes.prompt : '';
    assert('GCR-8b residence confirm does not present New York City', confirm === 'Hunter, your son — that right?' && !/new york/i.test(confirm));
    const secondYes = await session.resolvePending('yes');
    const rows = contacts(db as never);
    assert('GCR-8c yes does not persist New York City', secondYes.status === 'committed' && rows.length === 1 && rows[0].name === 'Hunter' && rows[0].relationship === 'son' && (rows[0].location == null || rows[0].location === ''));
  }

  {
    const { db, session, deps: base } = openJourneyDb();
    const routed = routedDeps(base);
    const phrase = HUNTER;
    await applyIntents([{
      type: 'family_capture',
      relation: 'son',
      name: 'Hunter',
      location: 'New York City',
    }], phrase, session, undefined, 'llm');
    routed.reset();
    const next = await processUtterance(normalizeInput(WEEK), session, routed.deps);
    const speech = next.handled ? next.responseText : '';
    assert('GCR-8d unrecognized llm family confirm writes nothing', contacts(db as never).length === 0);
    assert('GCR-8e llm family confirm is cleared', session.peekPendingKey() === null);
    assert('GCR-8f that reply is not DEFAULT_REASK', speech !== DEFAULT_REASK && !(next.handled && next.source === 'pending_resume'));
    assert('GCR-8g that reply is routed once with no model call', routed.counts().queries === 1 && routed.counts().models === 0);
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps);
    const arm = await say(AUSTIN);
    const prompt = arm.handled ? arm.responseText : '';
    assert('GCR-9a lives-in Austin is still proposed', prompt === 'David, your son, in Austin — that right?');
    const yes = await say('yes');
    const rows = contacts(db as never);
    assert('GCR-9b confirmed write stores Austin', yes.handled === true && yes.commits[0]?.status === 'committed' && rows.length === 1 && rows[0].name === 'David' && rows[0].relationship === 'son' && rows[0].location === 'Austin');
  }

  {
    const { db, session, deps: base } = openJourneyDb();
    const routed = routedDeps(base);
    const say = (t: string) => processUtterance(t, session, routed.deps);
    await say(VISITING);
    routed.reset();
    const silent = await say('');
    assert(
      'GCR-S1 empty input re-asks and keeps the family pending',
      silent.handled === true
        && silent.source === 'pending_resume'
        && silent.responseText === DEFAULT_REASK
        && session.peekPendingKey() === 'family_capture',
    );
    assert('GCR-S2 silence does not route or call a model', routed.counts().queries === 0 && routed.counts().models === 0);
    const second = await say('');
    assert(
      'GCR-S3 second silence uses the baseline release, not a reroute',
      second.handled === true
        && second.source === 'pending_resume'
        && second.responseText === RELEASE_ACK
        && session.peekPendingKey() === null,
    );
    assert('GCR-S4 the release still does not route or call a model', routed.counts().queries === 0 && routed.counts().models === 0);
    assert('GCR-S5 silence writes nothing', contacts(db as never).length === 0);
  }

  {
    const blank = openJourneyDb();
    const blankRouted = routedDeps(blank.deps);
    await processUtterance(VISITING, blank.session, blankRouted.deps);
    blankRouted.reset();
    const spaces = await processUtterance('   ', blank.session, blankRouted.deps);
    assert(
      'GCR-S6 whitespace keeps the re-ask ladder',
      spaces.handled === true
        && spaces.source === 'pending_resume'
        && spaces.responseText === DEFAULT_REASK
        && blank.session.peekPendingKey() === 'family_capture'
        && blankRouted.counts().queries === 0
        && blankRouted.counts().models === 0,
    );
    const marks = openJourneyDb();
    const markRouted = routedDeps(marks.deps);
    await processUtterance(VISITING, marks.session, markRouted.deps);
    markRouted.reset();
    const punct = await processUtterance('???', marks.session, markRouted.deps);
    assert(
      'GCR-S7 punctuation with no letters or digits keeps the re-ask ladder',
      punct.handled === true
        && punct.source === 'pending_resume'
        && punct.responseText === DEFAULT_REASK
        && marks.session.peekPendingKey() === 'family_capture'
        && markRouted.counts().queries === 0
        && markRouted.counts().models === 0,
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(t, session, deps);
    const arm = await say('My son Alex is visiting; my brother lives in Austin.');
    const prompt = arm.handled ? arm.responseText : '';
    assert('R1a Alex visiting does not confirm Austin', prompt === 'Alex, your son — that right?' && !/austin/i.test(prompt));
    const yes = await say('yes');
    const rows = contacts(db as never);
    assert('R1b yes stores Alex/son with no Austin', yes.handled === true && rows.length === 1 && rows[0].name === 'Alex' && rows[0].relationship === 'son' && (rows[0].location == null || rows[0].location === ''));
  }

  {
    const { db, session } = openJourneyDb();
    const phrase = 'My wife Shannon lives in Austin and my daughter Sarah lives in Dallas.';
    const armed = await DOMAIN_WRITERS.family_capture.add(
      { type: 'family_capture', relation: 'daughter', name: 'Sarah', location: 'Austin' },
      phrase,
    );
    const prompt = armed.status === 'pending' ? armed.prompt : '';
    assert('R2a Sarah is not confirmed in Shannon\'s Austin', prompt === 'Sarah, your daughter — that right?' && !/austin/i.test(prompt));
    session.setPending({ pendingKey: armed.status === 'pending' ? armed.pendingKey : 'family_capture', resume: armed.status === 'pending' ? armed.resume : async () => ({ status: 'noop', ack: '' }) });
    const yes = await session.resolvePending('yes');
    const rows = contacts(db as never);
    assert('R2b yes cannot write Austin onto Sarah', yes.status === 'committed' && rows.length === 1 && rows[0].name === 'Sarah' && rows[0].relationship === 'daughter' && (rows[0].location == null || rows[0].location === ''));
  }

  {
    const { db, session, deps } = openJourneyDb();
    const say = (t: string) => processUtterance(t, session, deps);
    const arm = await say(AUSTIN);
    const prompt = arm.handled ? arm.responseText : '';
    assert('R3a David lives in Austin still confirms Austin', prompt === 'David, your son, in Austin — that right?');
    const yes = await say('yes');
    const rows = contacts(db as never);
    assert('R3b confirmed write still stores Austin', yes.handled === true && rows.length === 1 && rows[0].name === 'David' && rows[0].relationship === 'son' && rows[0].location === 'Austin');
  }

  async function confirmedPlace(phrase: string) {
    const opened = openJourneyDb();
    const say = (t: string) => processUtterance(t, opened.session, opened.deps);
    const arm = await say(phrase);
    const prompt = arm.handled ? arm.responseText : '';
    await say('yes');
    const row = contacts(opened.db as never)[0];
    return { prompt, location: row?.location ?? null, name: row?.name ?? null, relationship: row?.relationship ?? null };
  }

  {
    const la = await confirmedPlace('My son David lives in L.A.');
    assert('ABBR-1 L.A. is kept whole', la.prompt.includes('L.A.') && la.location === 'L.A.' && la.location !== 'L');
    const dc = await confirmedPlace('My son David lives in Washington D.C.');
    assert('ABBR-2 Washington D.C. is kept whole', dc.prompt.includes('Washington D.C.') && dc.location === 'Washington D.C.' && dc.location !== 'Washington D');
    const ft = await confirmedPlace('My son David lives in Ft. Worth.');
    assert('ABBR-3 Ft. Worth is kept whole', ft.prompt.includes('Ft. Worth') && ft.location === 'Ft. Worth' && ft.location !== 'Ft');
    const usa = await confirmedPlace('My son David lives in U.S.A.');
    assert('ABBR-4 U.S.A. is kept whole', usa.location === 'U.S.A.' && usa.location !== 'U');
    const bound = await confirmedPlace('My son David lives in Austin. He is 12.');
    assert('BOUNDARY-1 Austin stops before the next sentence', bound.prompt === 'David, your son, in Austin — that right?' && bound.location === 'Austin' && !bound.prompt.includes('He'));
  }

  {
    const { session, deps } = openJourneyDb();
    session.setPending({
      pendingKey: 'phone_capture',
      resume: async () => ({ status: 'noop', ack: '' }),
    });
    const kept = await processUtterance(normalizeInput(WEEK), session, deps);
    assert(
      'GCR-10c a non-family confirm still re-asks and stays pending',
      kept.handled === true
        && kept.source === 'pending_resume'
        && kept.responseText === DEFAULT_REASK
        && session.peekPendingKey() === 'phone_capture',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}Graceful Confirmation Recovery: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('gracefulConfirmationRecovery.test.ts')) {
  runGracefulConfirmationRecoveryV1Tests().then((result) => {
    if (result.failed > 0) process.exit(1);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
