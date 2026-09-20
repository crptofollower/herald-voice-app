// Hold Recall / Inspection V1 — read-only WCS interpretation-hold inspection.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder, DISCOURSE_TURN_TTL } from '../../src/routing/discourseContinuity.ts';
import type { InterpretationHoldSlot } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { detectEmergency } from '../../src/routing/emergencySignals.ts';
import {
  inspectHolds,
  formatHoldRecall,
  HOLD_RECALL_EMPTY_REPLY,
  HOLD_RECALL_NO_MATCH_REPLY,
} from '../../src/routing/holdRecall.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const GARDENIA =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const DERM =
  "I just saw my dermatologist, Dr. Cather. She said this rash looks like it might be lymphoma. She advised me to talk to my oncologist, Dr. Vance, but I think I already have something on my calendar to see him. She's going to send the medical records over. She called me in a prescription for XYZ. Boy, I hope it's not cancer.";

const ITALY_INCONSISTENT =
  "We're going to Italy this fall. Rome first, then Sorrento. We leave November 20th. Hunter and Grant, my sons, fly home Monday the 29th. Shannon my wife and I stay after they leave. We get back November 4th for our December 4th anniversary — wait, I mean we get back December 4th.";

const DURABLE_RE = /\b(remember(?:ed)?|saved|stored|scheduled|added|tracked|i'll remember)\b/i;

function medCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  const q = (sql: string) => {
    try { return db.prepare(sql).all().length; } catch { return 0; }
  };
  return {
    medications: q('SELECT id FROM medications'),
    medical_records: q('SELECT id FROM medical_records'),
    list_items: q('SELECT id FROM list_items'),
    facts: q('SELECT id FROM facts'),
    contacts: q("SELECT id FROM contacts WHERE removed_at IS NULL"),
    calendar_cache: q('SELECT id FROM calendar_cache'),
  };
}

function hold(over: Partial<AdmittedMultiFactCandidate> = {}): AdmittedMultiFactCandidate {
  return {
    kind: 'event',
    value: 'placeholder value',
    disposition: 'hold',
    episodeId: 'ep-test',
    ...over,
  };
}

export async function runHoldRecallV1Tests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
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

  console.log(`\n${BOLD}-- Hold Recall / Inspection V1 --------------------------------${RESET}\n`);

  {
    const classified = inspectHolds('Call Hunter', null);
    assert('unrelated is not_recall', classified.kind === 'not_recall', (v) => v === true, 'not_recall');
    assert('not_recall formats to null', formatHoldRecall(classified), (v) => v === null, 'null');
    const filteredEmpty = inspectHolds('What did I tell you about Eliquis?', null);
    assert('filtered with no hold does not steal named store', filteredEmpty.kind === 'not_recall', (v) => v === true, 'not_recall');
  }

  {
    const empty = inspectHolds('What did I say?', null);
    assert('no live hold is empty', empty.kind === 'empty', (v) => v === true, 'empty');
    assert('empty wording is ephemeral', formatHoldRecall(empty) === HOLD_RECALL_EMPTY_REPLY && !DURABLE_RE.test(HOLD_RECALL_EMPTY_REPLY), (v) => v === true, 'empty reply');
  }

  {
    const wcs = new DiscourseContinuityHolder();
    wcs.beginUserTurn();
    wcs.establishInterpretationHold('ep1', [
      hold({ value: 'alpha first', kind: 'event' }),
      hold({ value: 'beta second', kind: 'preference' }),
      hold({ value: 'gamma third', kind: 'obligation' }),
    ]);
    const whole = inspectHolds('What did I just tell you?', wcs.peekInterpretationHold());
    assert('whole_set kind', whole.kind === 'whole_set', (v) => v === true, 'whole_set');
    if (whole.kind === 'whole_set') {
      assert('several holds preserve order', whole.candidates.map((c) => c.value).join('|') === 'alpha first|beta second|gamma third', (v) => v === true, 'alpha|beta|gamma');
    }
    const spoken = formatHoldRecall(whole) ?? '';
    assert('whole-set uses ephemeral framing', /^You just mentioned /.test(spoken) && !DURABLE_RE.test(spoken), (v) => v === true, 'You just mentioned');
  }

  {
    const wcs = new DiscourseContinuityHolder();
    wcs.beginUserTurn();
    wcs.establishInterpretationHold('ep1', [hold({ value: 'only one thing', kind: 'event' })]);
    assert('WCS establish still no-ops a singleton', wcs.peekInterpretationHold(), (v) => v === null, 'null');
    const synthetic: InterpretationHoldSlot = {
      episodeId: 'ep-synthetic',
      sourceTurn: 1,
      refreshedAtTurn: 1,
      candidates: [hold({ value: 'only one thing', kind: 'event' })],
    };
    const one = inspectHolds('What did I say?', synthetic);
    assert('one hold is whole_set', one.kind === 'whole_set' && one.candidates.length === 1, (v) => v === true, '1');
    assert('one hold wording', formatHoldRecall(one) === 'A moment ago you said only one thing.', (v) => v === true, 'A moment ago…');
  }

  {
    const wcs = new DiscourseContinuityHolder();
    wcs.beginUserTurn();
    wcs.establishInterpretationHold('ep1', [
      hold({ value: 'Going to Italy this fall', kind: 'event' }),
      hold({ value: 'Need airline tickets', kind: 'obligation' }),
      hold({ value: 'Need airline tickets again', kind: 'obligation' }),
      hold({ value: 'Favorite flowers are gardenias', kind: 'preference' }),
    ]);
    const italy = inspectHolds('What did I say about Italy?', wcs.peekInterpretationHold());
    assert('one filtered match', italy.kind === 'filtered' && italy.kind === 'filtered' && italy.candidates.length === 1 && italy.candidates[0].value === 'Going to Italy this fall', (v) => v === true, 'Italy only');
    const tickets = inspectHolds('What did I say about the tickets?', wcs.peekInterpretationHold());
    assert('multiple filtered matches', tickets.kind === 'filtered' && tickets.kind === 'filtered' && tickets.candidates.length === 2, (v) => v === true, '2 ticket holds');
    const miss = inspectHolds('What did I say about Mars?', wcs.peekInterpretationHold());
    assert('filtered no-match', miss.kind === 'no_match', (v) => v === true, 'no_match');
    assert('no-match does not substitute another store', formatHoldRecall(miss) === HOLD_RECALL_NO_MATCH_REPLY, (v) => v === true, HOLD_RECALL_NO_MATCH_REPLY);
  }

  {
    const wcs = new DiscourseContinuityHolder();
    wcs.beginUserTurn();
    wcs.establishInterpretationHold('ep1', [
      hold({ value: 'We get back November 4th', kind: 'temporal', temporal: 'November 4th', contradictGroupId: 'g1' }),
      hold({ value: 'December 4th', kind: 'temporal', temporal: 'December 4th', contradictGroupId: 'g1' }),
    ]);
    const dates = inspectHolds('What did I say?', wcs.peekInterpretationHold());
    const spoken = formatHoldRecall(dates) ?? '';
    assert('contradictory holds both returned', /November 4th/.test(spoken) && /December 4th/.test(spoken), (v) => v === true, 'both dates');
    assert('contradictions unreconciled', spoken.indexOf('November 4th') < spoken.indexOf('December 4th'), (v) => v === true, 'order preserved');
  }

  {
    const wcs = new DiscourseContinuityHolder();
    wcs.beginUserTurn();
    const sneaks = [
      hold({ value: 'visible event', kind: 'event' }),
      { kind: 'emotion_drop', value: 'I hope it is not cancer', disposition: 'hold', episodeId: 'ep1' } as unknown as AdmittedMultiFactCandidate,
    ];
    wcs.establishInterpretationHold('ep1', sneaks);
    const rec = inspectHolds('What did I say?', wcs.peekInterpretationHold());
    assert('emotion_drop cannot surface', rec.kind === 'whole_set' && rec.kind === 'whole_set' && rec.candidates.length === 1 && !/cancer/i.test(formatHoldRecall(rec) ?? ''), (v) => v === true, 'no cancer');
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('What did I just tell you?'), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    assert('journey whole-set handled hold_recall', outcome.handled && outcome.source === 'hold_recall', (v) => v === true, 'hold_recall');
    assert('journey whole-set mentions gardenias in grounded value', outcome.handled && /gardenias/i.test(outcome.responseText), (v) => v === true, 'gardenias');
    assert('journey no durable wording', outcome.handled && !DURABLE_RE.test(outcome.responseText), (v) => v === true, 'no durable');
    assert('journey zero sqlite writes', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('journey no pending created', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('journey no commits', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(DERM), session, deps, null, null, null, null, null, discourse);
    const dermHold = discourse.peekInterpretationHold();
    const lymphoma = dermHold?.candidates.find((c) => /lymphoma/i.test(c.value));
    const dermAbout = await processUtterance(normalizeInput('What did I say about my dermatologist?'), session, deps, null, null, null, null, null, discourse);
    assert('filtered dermatologist handled', dermAbout.handled && dermAbout.source === 'hold_recall', (v) => v === true, 'hold_recall');
    const lymphomaAbout = await processUtterance(normalizeInput('What did I say about lymphoma?'), session, deps, null, null, null, null, null, discourse);
    assert(
      'medical grounded value unchanged',
      lymphomaAbout.handled
        && lymphoma != null
        && lymphomaAbout.responseText.includes(lymphoma.value)
        && /might|looks like/i.test(`${lymphoma.hedge ?? ''} ${lymphoma.value}`),
      (v) => v === true,
      'hold value echoed unchanged',
    );
    assert('medical not strengthened', lymphomaAbout.handled && !/\bhas lymphoma\b|\byou have lymphoma\b/i.test(lymphomaAbout.responseText), (v) => v === true, 'not diagnosis');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(ITALY_INCONSISTENT), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('What did I say about Italy?'), session, deps, null, null, null, null, null, discourse);
    assert('filtered Italy can match', outcome.handled && outcome.source === 'hold_recall' && /italy/i.test(outcome.responseText), (v) => v === true, 'Italy');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('What did I say about Mars?'), session, deps, null, null, null, null, null, discourse);
    assert('filtered no-match is honest empty-of-that', outcome.handled && outcome.responseText === HOLD_RECALL_NO_MATCH_REPLY, (v) => v === true, HOLD_RECALL_NO_MATCH_REPLY);
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(normalizeInput('What were the things I just mentioned?'), session, deps, null, null, null, null, null, discourse);
    assert('no hold journey empty', outcome.handled && outcome.source === 'hold_recall' && outcome.responseText === HOLD_RECALL_EMPTY_REPLY, (v) => v === true, 'empty');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    for (let i = 0; i < DISCOURSE_TURN_TTL + 1; i++) discourse.beginUserTurn();
    const outcome = await processUtterance(normalizeInput('What did I say?'), session, deps, null, null, null, null, null, discourse);
    assert('expired hold behaves as no live hold', outcome.handled && outcome.responseText === HOLD_RECALL_EMPTY_REPLY, (v) => v === true, 'empty');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    session.setPending({
      pendingKey: 'medical_visit',
      kind: 'standard',
      budget: 2,
      resume: async (): Promise<CommitResult> => ({ status: 'pending', prompt: 'Want me to remember you saw Dr. Cather?', pendingKey: 'medical_visit', resume: async () => ({ status: 'noop', ack: '' }) }),
    });
    const outcome = await processUtterance(normalizeInput('What did I say?'), session, deps, null, null, null, null, null, discourse);
    assert('pending wins over hold recall', outcome.handled && outcome.source === 'pending_resume', (v) => v === true, 'pending_resume');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('I need help'), session, deps, null, null, null, null, null, discourse);
    assert('Law 0 still emergency', outcome.handled && outcome.source === 'emergency' && detectEmergency('I need help'), (v) => v === true, 'emergency');
    assert('Law 0 cleared hold', discourse.peekInterpretationHold(), (v) => v === null, 'null');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('Call Hunter'), session, deps, null, null, null, null, null, discourse);
    const diverted = outcome.handled && outcome.source === 'hold_recall';
    assert('non-recall falls through', diverted === false, (v) => v === true, 'not hold_recall');
    assert('non-recall is device_action or capture', !outcome.handled && outcome.routeDecision.kind === 'device_action' || (outcome.handled && outcome.source !== 'hold_recall'), (v) => v === true, 'existing routing');
  }

  console.log(`\n${BOLD}Hold Recall V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('holdRecall.test');
if (isDirect) {
  runHoldRecallV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
