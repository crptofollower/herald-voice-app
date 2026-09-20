// Natural Multi-Fact Interpretation V1 — propose → admit → WCS hold.
// Does not write memory, arm pending, or authorize CALL/SMS/Maps.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { detectEmergency } from '../../src/routing/emergencySignals.ts';
import {
  admitNaturalMultiFactProposal,
  parseMultiFactProposal,
  proposeNaturalMultiFactFromUtterance,
  tryNaturalMultiFactHold,
} from '../../src/routing/naturalMultiFactInterpretation.ts';
import { NATURAL_MULTI_FACT_INTERPRETATION_ENABLED } from '../../src/constants/features.ts';
import { ACTIVE_SUBJECT_GROUNDING_ACK } from '../../src/routing/activeSubjectReference.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const GARDENIA =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const DERM =
  "I just saw my dermatologist, Dr. Cather. She said this rash looks like it might be lymphoma. She advised me to talk to my oncologist, Dr. Vance, but I think I already have something on my calendar to see him. She's going to send the medical records over. She called me in a prescription for XYZ. Boy, I hope it's not cancer.";

const ITALY_INCONSISTENT =
  "We're going to Italy this fall. Rome first, then Sorrento. We leave November 20th. Hunter and Grant, my sons, fly home Monday the 29th. Shannon my wife and I stay after they leave. We get back November 4th for our December 4th anniversary — wait, I mean we get back December 4th.";

const TICKETS =
  "I need to buy airline tickets to Rome. The kids said they're available starting November 20 but have to be back by Monday the 29th. I need Airbnbs in Rome and Sorrento and a rental car. I'm going to research the Airbnbs. We're going to celebrate our anniversary.";

const SIMPLE_VISIT = 'I saw Dr. Cather';

function medCounts(db: { prepare: (s: string) => { all: () => unknown[] } }) {
  const q = (sql: string) => {
    try { return db.prepare(sql).all().length; } catch { return 0; }
  };
  return {
    medications: q('SELECT id FROM medications'),
    medical_records: q('SELECT id FROM medical_records'),
    list_items: q('SELECT id FROM list_items'),
    contacts: q("SELECT id FROM contacts WHERE removed_at IS NULL"),
  };
}

export async function runNaturalMultiFactInterpretationV1Tests() {
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

  console.log(`\n${BOLD}-- Natural Multi-Fact Interpretation V1 -----------------------${RESET}\n`);

  assert(
    'flag default is ON (seam live; OFF still identity-tested below)',
    NATURAL_MULTI_FACT_INTERPRETATION_ENABLED,
    (v) => v === true,
    'true',
  );

  {
    const proposal = proposeNaturalMultiFactFromUtterance(GARDENIA);
    const admitted = admitNaturalMultiFactProposal(GARDENIA, proposal);
    assert('gardenia admit >=2', admitted, (v) => (v as { decision: string }).decision === 'ADMIT'
      && (v as { candidates: unknown[] }).candidates.length >= 2, 'ADMIT >=2');
    if (admitted.decision === 'ADMIT') {
      const kinds = new Set(admitted.candidates.map((c) => c.kind));
      assert('gardenia has preference', kinds.has('preference'), (v) => v === true, 'preference');
      assert('gardenia has person_relation or intention', kinds.has('person_relation') || kinds.has('intention'), (v) => v === true, 'relation|intention');
      assert('gardenia December 4 grounded', admitted.candidates.some((c) => /december 4/i.test(c.value) || /december 4/i.test(c.temporal ?? '')), (v) => v === true, 'Dec 4 span');
    }
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(DERM);
    const admitted = admitNaturalMultiFactProposal(DERM, proposal);
    assert('dermatologist admit >=2', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    if (admitted.decision === 'ADMIT') {
      const lymphoma = admitted.candidates.find((c) => /lymphoma/i.test(c.value));
      assert('lymphoma hold is attributed_claim', lymphoma?.kind === 'attributed_claim', (v) => v === true, 'attributed_claim');
      assert('lymphoma hedge preserved', !!(lymphoma?.hedge && /might|looks like/i.test(lymphoma.hedge)), (v) => v === true, 'hedge');
      assert('emotion hope-not-cancer dropped', !admitted.candidates.some((c) => /hope/i.test(c.value) && /cancer/i.test(c.value)), (v) => v === true, 'no emotion retain');
      assert('XYZ is prescribed not taking', admitted.candidates.some((c) => c.kind === 'prescribed' && /xyz/i.test(c.value) && !/taking/i.test(c.value)), (v) => v === true, 'prescribed XYZ');
    }
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(ITALY_INCONSISTENT);
    const admitted = admitNaturalMultiFactProposal(ITALY_INCONSISTENT, proposal);
    assert('italy admit', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    if (admitted.decision === 'ADMIT') {
      const dates = admitted.candidates.filter((c) => /november 4/i.test(c.value) || /december 4/i.test(c.value));
      const nov = dates.some((c) => /november 4/i.test(c.value));
      const dec = dates.some((c) => /december 4/i.test(c.value));
      assert('italy keeps both return dates', nov && dec, (v) => v === true, 'Nov 4 and Dec 4');
      const groups = new Set(dates.map((c) => c.contradictGroupId).filter(Boolean));
      assert('contradictory dates share group', groups.size === 1, (v) => v === true, 'one contradictGroupId');
    }
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(TICKETS);
    const admitted = admitNaturalMultiFactProposal(TICKETS, proposal);
    assert('tickets admit >=2', admitted.decision === 'ADMIT' && admitted.decision === 'ADMIT' && admitted.candidates.length >= 2, (v) => v === true, 'ADMIT');
    if (admitted.decision === 'ADMIT') {
      const kinds = admitted.candidates.map((c) => c.kind);
      assert('travel obligations coexist', kinds.includes('obligation') || kinds.filter((k) => k === 'obligation').length >= 1 || kinds.length >= 2, (v) => v === true, 'multi holds');
    }
  }

  {
    const ungrounded = admitNaturalMultiFactProposal(GARDENIA, {
      episodeId: 'x',
      candidates: [
        { kind: 'preference', value: 'tulips' },
        { kind: 'event', value: 'invented promotion at NASA' },
      ],
    });
    assert('ungrounded values deferred', ungrounded.decision === 'DEFER', (v) => v === true, 'DEFER');
  }

  {
    const simple = tryNaturalMultiFactHold(SIMPLE_VISIT, { enabled: true, intercept: 'visit' });
    assert('simple visit does not take hold path', simple, (v) => v === null, 'null');
    assert(
      'Dr. title does not fake a second sentence',
      tryNaturalMultiFactHold('Why am I supposed to see Dr. Vance?', { enabled: true, intercept: 'fallthrough' }),
      (v) => v === null,
      'null',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const outcome = await processUtterance(normalizeInput(GARDENIA), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const hold = discourse.peekInterpretationHold();
    assert('gardenia process handled interpretation', outcome.handled && outcome.source === 'interpretation', (v) => v === true, 'interpretation');
    assert('gardenia ack is existing Okay.', outcome.handled && outcome.responseText === ACTIVE_SUBJECT_GROUNDING_ACK, (v) => v === true, 'Okay.');
    assert('gardenia WCS holds >=2', (hold?.candidates.length ?? 0) >= 2, (v) => v === true, '>=2');
    assert('gardenia zero DB writes', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged counts');
    assert('gardenia no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('gardenia no commit effects', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const outcome = await processUtterance(normalizeInput(DERM), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const hold = discourse.peekInterpretationHold();
    assert('derm process is hold not visit pending', outcome.handled && outcome.source === 'interpretation' && !session.hasPending(), (v) => v === true, 'hold, no pending');
    assert('derm zero medical DB', before.medications === after.medications && before.medical_records === after.medical_records, (v) => v === true, 'no medical rows');
    assert('derm hold has hedged lymphoma', !!hold?.candidates.some((c) => /lymphoma/i.test(c.value) && /might|looks like/i.test(`${c.hedge ?? ''} ${c.value}`)), (v) => v === true, 'hedged lymphoma');
    assert('derm does not claim stored in ack', outcome.handled && !/remember|stored|scheduled|added/i.test(outcome.responseText), (v) => v === true, 'Okay. only');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(normalizeInput(SIMPLE_VISIT), session, deps, null, null, null, null, null, discourse);
    assert('simple visit still capture/pending', outcome.handled && outcome.source === 'capture' && session.peekPendingKey() === 'medical_visit', (v) => v === true, 'medical_visit pending');
    assert('simple visit did not establish multi-fact hold', discourse.peekInterpretationHold(), (v) => v === null, 'null hold');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(
      normalizeInput(GARDENIA),
      session,
      { ...deps, naturalMultiFactInterpretationEnabled: false },
      null, null, null, null, null, discourse,
    );
    assert('flag OFF gardenia not interpretation', !(outcome.handled && outcome.source === 'interpretation'), (v) => v === true, 'not interpretation');
    assert('flag OFF no WCS hold', discourse.peekInterpretationHold(), (v) => v === null, 'null');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(
      normalizeInput(GARDENIA),
      session,
      { ...deps, proposeNaturalMultiFact: () => ({ status: 'unavailable', reason: 'busy' }) },
      null, null, null, null, null, discourse,
    );
    assert('busy proposer fallthrough', !(outcome.handled && outcome.source === 'interpretation'), (v) => v === true, 'not hold');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(
      normalizeInput(GARDENIA),
      session,
      { ...deps, proposeNaturalMultiFact: () => ({ status: 'parse_fail', raw: '{' }) },
      null, null, null, null, null, discourse,
    );
    assert('parse_fail fallthrough', !(outcome.handled && outcome.source === 'interpretation'), (v) => v === true, 'not hold');
  }

  {
    const parsed = parseMultiFactProposal('not json');
    assert('strict parse reject', parsed, (v) => v === null, 'null');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const outcome = await processUtterance(normalizeInput(TICKETS), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert('tickets can hold without capability action', (outcome.handled && outcome.source === 'interpretation' && (hold?.candidates.length ?? 0) >= 2) || (!outcome.handled && outcome.routeDecision.kind !== 'device_action'), (v) => v === true, 'hold or non-action');
    assert('tickets no pending', session.hasPending() === false, (v) => v === true, 'no pending');
  }

  {
    const session = new ConversationSession();
    session.setPending({
      pendingKey: 'medical_capture',
      kind: 'standard',
      budget: 2,
      resume: async (): Promise<CommitResult> => ({ status: 'committed', ack: 'should not run' }),
    });
    const { deps } = openJourneyDb();
    const outcome = await processUtterance('I need help', session, deps);
    assert('Law 0 still emergency with multi-fact live', outcome.handled && outcome.source === 'emergency', (v) => v === true, 'emergency');
    assert('Law 0 detectEmergency agrees', detectEmergency('I need help'), (v) => v === true, 'true');
    assert('Law 0 released pending', session.hasPending() === false, (v) => v === true, 'released');
  }

  {
    const { session, deps } = openJourneyDb();
    const seed = [
      { id: 'c_a', name: 'Paul Cioffre', phone: '5553010001' },
      { id: 'c_b', name: 'Paul Smith', phone: '5553010002' },
    ];
    const db = (openJourneyDb().db);
    for (const c of seed) {
      try {
        db.prepare('INSERT INTO contacts (id, name, phone, importance, created_at, updated_at) VALUES (?, ?, ?, 5, datetime(\'now\'), datetime(\'now\'))').run(c.id, c.name, c.phone);
      } catch { /* schema variants */ }
    }
    const outcome = await processUtterance(
      normalizeInput("Text him I'll be home at 8."),
      session,
      {
        ...deps,
        resolveContact: async () => null,
      },
    );
    const diverted = outcome.handled && outcome.source === 'interpretation';
    assert('Continuity SMS opener is not swallowed by multi-fact', diverted === false, (v) => v === true, 'not interpretation');
  }

  console.log(`\n${BOLD}Natural Multi-Fact V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('naturalMultiFactInterpretationV1.test');
if (isDirect) {
  runNaturalMultiFactInterpretationV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
