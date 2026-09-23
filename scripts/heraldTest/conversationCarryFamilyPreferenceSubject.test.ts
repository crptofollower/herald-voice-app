// Conversation Carry V1 / Slice 2 — cross-turn family preference subject admission.
// Runner: from scripts/heraldTest, `npx tsx run.mjs`

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { writeContactRaw } from '../../src/db/contactsDB.ts';
import { ACTIVE_SUBJECT_GROUNDING_ACK } from '../../src/routing/activeSubjectReference.ts';
import {
  admitNaturalMultiFactProposal,
  proposeNaturalMultiFactFromUtterance,
} from '../../src/routing/naturalMultiFactInterpretation.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const DURABLE_RE = /\b(remember(?:ed)?|saved|stored|i remember|i have stored|your profile says)\b/i;

function prefs(candidates: AdmittedMultiFactCandidate[] | undefined) {
  return (candidates ?? []).filter((c) => c.kind === 'preference');
}

function medCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  const q = (sql: string) => {
    try { return db.prepare(sql).all().length; } catch { return 0; }
  };
  return {
    facts: q('SELECT id FROM facts'),
    contacts: q("SELECT id FROM contacts WHERE removed_at IS NULL"),
  };
}

function livePref(discourse: DiscourseContinuityHolder) {
  return prefs(discourse.peekInterpretationHold()?.candidates);
}

export async function runConversationCarryFamilyPreferenceSubjectV1Tests() {
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

  console.log(`\n${BOLD}-- Conversation Carry V1 Slice 2 family preference subject --${RESET}\n`);

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    const arm = await say('My wife is Shannon.');
    assert('A1 family_capture still owns wife identity', arm.handled === true && arm.source === 'capture' && session.peekPendingKey() === 'family_capture');
    const yes = await say('Yes.');
    assert('A2 YES commits Shannon/wife', yes.handled === true && yes.source === 'pending_resume' && session.peekPendingKey() === null);
    const before = medCounts(db as never);
    const prefTurn = await say('Her favorite flowers are gardenias.');
    const after = medCounts(db as never);
    const held = livePref(discourse);
    assert(
      'A3 her-favorite is interpretation Okay',
      prefTurn.handled === true && prefTurn.source === 'interpretation' && prefTurn.responseText === ACTIVE_SUBJECT_GROUNDING_ACK,
    );
    assert('A3 live wife→gardenias hold', held.length === 1 && held[0].subject === 'wife' && /^gardenias$/i.test(held[0].value));
    assert('A3 no facts write, no extra contact, no pending', after.facts === before.facts && after.contacts === before.contacts && session.peekPendingKey() === null);
    assert('A3 no durable preference claim', !DURABLE_RE.test(prefTurn.responseText ?? ''));
    const q = await say('What flowers does my wife like?');
    assert(
      'A4 Hold Continuity answers gardenias',
      q.handled === true && q.source === 'hold_continuity' && /gardenias/i.test(q.responseText ?? '') && session.peekPendingKey() === null,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife is Shannon.');
    await say('Yes.');
    const prefTurn = await say('She likes gardenias.');
    const held = livePref(discourse);
    assert(
      'B she-likes establishes wife→gardenias hold',
      prefTurn.source === 'interpretation' && held.length === 1 && held[0].subject === 'wife' && /^gardenias$/i.test(held[0].value) && session.peekPendingKey() === null,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My son is Grant.');
    await say('Yes.');
    const prefTurn = await say('His favorite food is pizza.');
    const held = livePref(discourse);
    assert(
      'C his-favorite is son→pizza hold',
      prefTurn.source === 'interpretation' && held.length === 1 && held[0].subject === 'son' && /^pizza$/i.test(held[0].value),
    );
    const q = await say('What food does my son like?');
    assert(
      'C Hold Continuity answers pizza',
      q.handled === true && q.source === 'hold_continuity' && /pizza/i.test(q.responseText ?? '') && session.peekPendingKey() === null,
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    const bare = await say('My wife likes gardenias.');
    const held = livePref(discourse);
    assert(
      'D same-utterance My wife likes gardenias still holds',
      bare.source === 'interpretation' && held.length === 1 && held[0].subject === 'wife' && /^gardenias$/i.test(held[0].value),
    );
    const narrative =
      "I haven't told my wife yet. Her favorite flowers are gardenias.";
    const { session: s2, deps: d2 } = openJourneyDb();
    const discourse2 = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(narrative), s2, d2, null, null, null, null, null, discourse2);
    const held2 = livePref(discourse2);
    assert(
      'D same-utterance wife then her-favorite still holds',
      held2.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('She likes gardenias.'), session, deps, null, null, null, null, null, discourse);
    const held = livePref(discourse);
    assert('FC1 no established family does not invent wife', held.length === 0);
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    writeContactRaw({ name: 'Pat', relationship: 'sister', importance: 7 });
    await processUtterance(normalizeInput('She likes gardenias.'), session, deps, null, null, null, null, null, discourse);
    const held = livePref(discourse);
    assert('FC2 wife+sister does not pick either', !held.some((c) => /^gardenias$/i.test(c.value) && (c.subject === 'wife' || c.subject === 'sister')));
  }

  {
    const admitted = admitNaturalMultiFactProposal(
      "My wife and my sister are coming. She loves gardenias.",
      proposeNaturalMultiFactFromUtterance("My wife and my sister are coming. She loves gardenias."),
    );
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'FC3 same-utterance wife+sister she remains unsubjected',
      pref.length === 0 || pref.every((c) => c.subject === undefined),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife is Shannon.');
    await say('Yes.');
    await say('Shannon likes gardenias.');
    const held = livePref(discourse);
    assert('FC4 proper name does not become subject=wife', !held.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)));
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    writeContactRaw({ name: 'Dana', relationship: 'friend', importance: 5 });
    await processUtterance(normalizeInput('She likes gardenias.'), session, deps, null, null, null, null, null, discourse);
    const held = livePref(discourse);
    assert('FC5 friend Dana does not invent wife/gardenias', !held.some((c) => c.subject === 'wife') && !held.some((c) => /^gardenias$/i.test(c.value) && !!c.subject));
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    writeContactRaw({ name: 'Shannon', relationship: 'wife', importance: 8 });
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say("She doesn't like roses.");
    assert('FC6 negative does not hold', livePref(discourse).length === 0);
    await say('She might like roses.');
    assert('FC6 hedged does not hold', livePref(discourse).length === 0);
    await say('Does she like roses?');
    assert('FC6 interrogative does not hold', livePref(discourse).length === 0);
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const q = await processUtterance(normalizeInput('What flowers does my wife like?'), session, deps, null, null, null, null, null, discourse);
    assert(
      'FC7 cold preference Q still does not fabricate gardenias',
      !(q.handled && q.source === 'hold_continuity') && !/gardenias/i.test(q.handled ? (q.responseText ?? '') : ''),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const say = (t: string) => processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse);
    await say('My wife is Shannon.');
    await say('Yes.');
    const name = await say("What's my wife's name?");
    const spoken = name.handled ? name.responseText : (name.routeDecision?.kind === 'device_read' ? name.routeDecision.response : '');
    assert(
      'FC8 wife identity read still returns Shannon',
      /Shannon/i.test(spoken ?? '') && !(name.handled && name.source === 'hold_continuity'),
    );
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const disabled = { ...deps, naturalMultiFactInterpretationEnabled: false };
    const say = (t: string) => processUtterance(normalizeInput(t), session, disabled, null, null, null, null, null, discourse);
    await say('My wife is Shannon.');
    await say('Yes.');
    await say('Her favorite flowers are gardenias.');
    assert('FC10 NMF disabled creates no preference hold', livePref(discourse).length === 0);
  }

  {
    const noSubject = admitNaturalMultiFactProposal(
      'She loves roses',
      proposeNaturalMultiFactFromUtterance('She loves roses'),
    );
    assert('unit She loves roses still DEFER without established relation', noSubject.decision === 'DEFER');
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('conversationCarryFamilyPreferenceSubject.test.ts')) {
  runConversationCarryFamilyPreferenceSubjectV1Tests().then((r) => {
    console.log(`\n${BOLD}ConversationCarryFamilyPreferenceSubjectV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
