// Single Grounded Preference Hold Admission V1 — admit one uniquely grounded
// preference into the existing interpretation hold. Conversational evidence only.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder, DISCOURSE_TURN_TTL } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { detectEmergency } from '../../src/routing/emergencySignals.ts';
import {
  admitNaturalMultiFactProposal,
  proposeNaturalMultiFactFromUtterance,
} from '../../src/routing/naturalMultiFactInterpretation.ts';
import { ACTIVE_SUBJECT_GROUNDING_ACK } from '../../src/routing/activeSubjectReference.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const BARE = 'my wife loves roses';
const S24 =
  'we were outside today and I was thinking of planting some roses my wife really loves roses';
const S24_Q = 'what flowers does my wife like';
const PUNCTUATED =
  "My wife's favorite flowers are gardenias. On the way home I'm going to pick up flowers.";
const TWO_PREFS =
  "My wife's favorite flowers are gardenias. My son's favorite food is pizza.";
const WIFE_AND_SISTER = 'my wife and my sister love roses';
const WIFE_AND_SISTER_LOVES = 'my wife and my sister really loves roses';
const AMBIGUOUS = "My wife and my sister are coming. She loves gardenias.";
const DURABLE_RE = /\b(remember(?:ed)?|saved|stored|i remember|i have stored|your profile says)\b/i;

function prefs(candidates: AdmittedMultiFactCandidate[]) {
  return candidates.filter((c) => c.kind === 'preference');
}

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
  };
}

function admit(raw: string) {
  return admitNaturalMultiFactProposal(raw, proposeNaturalMultiFactFromUtterance(raw));
}

export async function runSingleGroundedPreferenceAdmissionV1Tests() {
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

  console.log(`\n${BOLD}-- Single Grounded Preference Hold Admission V1 --------------${RESET}\n`);

  {
    const admitted = admit(BARE);
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'bare wife loves roses singleton ADMIT',
      admitted.decision === 'ADMIT' && admitted.candidates.length === 1 && pref.length === 1
        && pref[0].subject === 'wife' && /^roses$/i.test(pref[0].value),
      (v) => v === true,
      'ADMIT wife→roses',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const outcome = await processUtterance(normalizeInput(BARE), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    const hold = discourse.peekInterpretationHold();
    const pref = hold ? prefs(hold.candidates) : [];
    assert('bare journey is interpretation hold', outcome.handled && outcome.source === 'interpretation', (v) => v === true, 'interpretation');
    assert('bare live wife→roses hold', pref.length === 1 && pref[0].subject === 'wife' && /^roses$/i.test(pref[0].value), (v) => v === true, 'held');
    assert('bare ack is Okay.', outcome.handled && outcome.responseText === ACTIVE_SUBJECT_GROUNDING_ACK, (v) => v === true, 'Okay.');
    assert('bare zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('bare no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('bare no commits', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
    assert('bare no durable claim', outcome.handled && !DURABLE_RE.test(outcome.responseText), (v) => v === true, 'ephemeral');
  }

  {
    const proposed = proposeNaturalMultiFactFromUtterance(S24);
    const prefsProposed = proposed.candidates.filter((c) => c.kind === 'preference');
    assert(
      'S24 proposer yields one preference wife→roses',
      prefsProposed.length === 1 && prefsProposed[0].subject === 'wife' && /^roses$/i.test(prefsProposed[0].value ?? ''),
      (v) => v === true,
      'one preference',
    );
    const admitted = admit(S24);
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'S24 singleton preference ADMIT',
      admitted.decision === 'ADMIT' && admitted.candidates.length === 1 && pref.length === 1
        && pref[0].subject === 'wife' && /^roses$/i.test(pref[0].value),
      (v) => v === true,
      'ADMIT wife→roses',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const first = await processUtterance(normalizeInput(S24), session, deps, null, null, null, null, null, discourse);
    const afterFirst = medCounts(db as never);
    const hold = discourse.peekInterpretationHold();
    const pref = hold ? prefs(hold.candidates) : [];
    assert('S24 journey is interpretation hold', first.handled && first.source === 'interpretation', (v) => v === true, 'interpretation');
    assert('S24 live wife→roses hold', pref.length === 1 && pref[0].subject === 'wife' && /^roses$/i.test(pref[0].value), (v) => v === true, 'held');
    assert('S24 first-turn zero sqlite', JSON.stringify(before) === JSON.stringify(afterFirst), (v) => v === true, 'unchanged');
    assert('S24 first-turn no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('S24 first-turn no commits', first.handled && first.commits.length === 0, (v) => v === true, '[]');
    const qBefore = medCounts(db as never);
    const q = await processUtterance(normalizeInput(S24_Q), session, deps, null, null, null, null, null, discourse);
    const qAfter = medCounts(db as never);
    assert(
      'S24 follow-up Hold Continuity roses',
      q.handled && q.source === 'hold_continuity' && /roses/i.test(q.responseText),
      (v) => v === true,
      'hold_continuity roses',
    );
    assert('S24 follow-up is not capture', q.handled && q.source !== 'capture', (v) => v === true, 'not capture');
    assert('S24 Q&A zero sqlite', JSON.stringify(qBefore) === JSON.stringify(qAfter), (v) => v === true, 'unchanged');
    assert('S24 Q&A no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('S24 Q&A no commits', q.handled && q.commits.length === 0, (v) => v === true, '[]');
    assert('S24 Q&A no durable claim', q.handled && !DURABLE_RE.test(q.responseText), (v) => v === true, 'ephemeral');
  }

  {
    const admitted = admit(TWO_PREFS);
    assert('existing >=2 multi-candidate still ADMIT', admitted.decision === 'ADMIT' && admitted.candidates.length >= 2, (v) => v === true, 'ADMIT >=2');
  }

  {
    const admitted = admit(PUNCTUATED);
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'existing punctuated version still ADMIT',
      admitted.decision === 'ADMIT' && admitted.candidates.length >= 2
        && pref.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)),
      (v) => v === true,
      'ADMIT wife→gardenias',
    );
  }

  {
    const likeFive = admit('It was like five minutes');
    assert(
      'like five minutes is not singleton preference',
      likeFive.decision === 'DEFER' || (likeFive.decision === 'ADMIT' && !prefs(likeFive.candidates).length),
      (v) => v === true,
      'no preference hold',
    );
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('It was like five minutes'), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert('like five minutes establishes no preference hold', !hold || prefs(hold.candidates).length === 0, (v) => v === true, 'no pref');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput("She doesn't like roses"), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert("doesn't like roses no preference hold", !hold || prefs(hold.candidates).length === 0, (v) => v === true, 'no pref');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('Does she like roses?'), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert('interrogative no preference hold', !hold || prefs(hold.candidates).length === 0, (v) => v === true, 'no pref');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('She would like roses'), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert('would like no preference hold', !hold || prefs(hold.candidates).length === 0, (v) => v === true, 'no pref');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput('She might like roses'), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert('might like no preference hold', !hold || prefs(hold.candidates).length === 0, (v) => v === true, 'no pref');
  }

  {
    const noSubject = admit('She loves roses');
    assert(
      'preference without explicit grounded family subject DEFER',
      noSubject.decision === 'DEFER',
      (v) => v === true,
      'DEFER',
    );
  }

  {
    const fallback = admitNaturalMultiFactProposal(BARE, {
      episodeId: 'ep-fallback',
      candidates: [{ kind: 'preference', value: BARE, subject: 'wife' }],
    });
    assert(
      'whole-sentence preference value is not singleton-admissible',
      fallback.decision === 'DEFER',
      (v) => v === true,
      'DEFER',
    );
  }

  {
    const proposed = proposeNaturalMultiFactFromUtterance(WIFE_AND_SISTER_LOVES);
    const prefProposed = proposed.candidates.filter((c) => c.kind === 'preference');
    assert(
      'wife+sister loves proposer would otherwise first-key one relation',
      prefProposed.length === 1
        && (prefProposed[0].subject === 'wife' || prefProposed[0].subject === 'sister')
        && /^roses$/i.test(prefProposed[0].value ?? ''),
      (v) => v === true,
      'first key wife or sister',
    );
    const admittedLoves = admit(WIFE_AND_SISTER_LOVES);
    assert(
      'wife+sister loves does not singleton-assign roses to one relation',
      admittedLoves.decision === 'DEFER',
      (v) => v === true,
      'DEFER',
    );
    const admitted = admit(WIFE_AND_SISTER);
    assert(
      'wife+sister does not singleton-assign roses to wife',
      admitted.decision === 'DEFER'
        || (admitted.decision === 'ADMIT' && !prefs(admitted.candidates).some((c) => c.subject === 'wife' && /^roses$/i.test(c.value) && admitted.candidates.length === 1)),
      (v) => v === true,
      'no singleton wife→roses',
    );
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(WIFE_AND_SISTER), session, deps, null, null, null, null, null, discourse);
    const hold = discourse.peekInterpretationHold();
    assert(
      'wife+sister live hold is not singleton wife→roses',
      !hold || hold.candidates.length !== 1 || !prefs(hold.candidates).some((c) => c.subject === 'wife' && /^roses$/i.test(c.value)),
      (v) => v === true,
      'not singleton wife→roses',
    );
  }

  {
    const admitted = admit('my wife and my sister and my daughter love roses');
    assert(
      'multiple family subjects are not singleton-admissible',
      admitted.decision === 'DEFER',
      (v) => v === true,
      'DEFER',
    );
  }

  {
    const admitted = admit(AMBIGUOUS);
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert('ambiguous still admits a >=2 set', admitted.decision === 'ADMIT' && admitted.candidates.length >= 2, (v) => v === true, 'ADMIT');
    assert(
      'ambiguous she does not guess a subject',
      pref.length === 1 && pref[0].subject === undefined && /^gardenias$/i.test(pref[0].value),
      (v) => v === true,
      'no subject',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    await processUtterance(normalizeInput(BARE), session, deps, null, null, null, null, null, discourse);
    const after = medCounts(db as never);
    assert('singleton admit no sqlite write', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('singleton admit no family/profile write', before.contacts === after.contacts && before.facts === after.facts, (v) => v === true, 'no contacts/facts');
    assert('singleton admit no pending', session.hasPending() === false, (v) => v === true, 'no pending');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(BARE), session, deps, null, null, null, null, null, discourse);
    const establishedTurn = discourse.peekInterpretationHold()?.refreshedAtTurn;
    for (let i = 0; i < DISCOURSE_TURN_TTL + 1; i++) discourse.beginUserTurn();
    assert('singleton TTL expires like existing holds', discourse.peekInterpretationHold(), (v) => v === null, 'null');
    assert('TTL used the existing constant', establishedTurn != null && DISCOURSE_TURN_TTL === 4, (v) => v === true, 'TTL=4');
  }

  {
    const { session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(normalizeInput(BARE), session, deps, null, null, null, null, null, discourse);
    const outcome = await processUtterance(normalizeInput('I need help'), session, deps, null, null, null, null, null, discourse);
    assert('Law 0 still emergency', outcome.handled && outcome.source === 'emergency' && detectEmergency('I need help'), (v) => v === true, 'emergency');
    assert('Law 0 cleared singleton hold', discourse.peekInterpretationHold(), (v) => v === null, 'null');
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
    assert('Law 0 still releases pending', outcome.handled && outcome.source === 'emergency' && session.hasPending() === false, (v) => v === true, 'released');
  }

  {
    const eventOnly = admitNaturalMultiFactProposal('I went to Rome yesterday', {
      episodeId: 'ep-event',
      candidates: [{ kind: 'event', value: 'I went to Rome yesterday' }],
    });
    assert('non-preference singleton remains DEFER', eventOnly.decision === 'DEFER', (v) => v === true, 'DEFER');
  }

  {
    const empty = new DiscourseContinuityHolder();
    empty.beginUserTurn();
    empty.establishInterpretationHold('ep-empty', []);
    assert('empty candidate array still cannot establish', empty.peekInterpretationHold(), (v) => v === null, 'null');
  }

  console.log(`\n${BOLD}Single Grounded Preference Hold Admission V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('singleGroundedPreferenceAdmission');
if (isDirect) {
  runSingleGroundedPreferenceAdmissionV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
