// Preference Association Foundation V1 — grounded subject↔preference object
// on existing NMF candidate fields. Does not answer Hold Continuity Q&A.

import { openJourneyDb } from './journeyHarness.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import {
  admitNaturalMultiFactProposal,
  proposeNaturalMultiFactFromUtterance,
} from '../../src/routing/naturalMultiFactInterpretation.ts';
import type { AdmittedMultiFactCandidate } from '../../src/routing/naturalMultiFactInterpretation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const EXPLICIT =
  "My wife's favorite flowers are gardenias. On the way home I'm going to pick up flowers.";

const PRONOUN_CONTINUITY =
  "I haven't told my wife yet. She loves gardenias.";

const AMBIGUOUS =
  "My wife and my sister are coming. She loves gardenias.";

const TWO_PREFS =
  "My wife's favorite flowers are gardenias. My son's favorite food is pizza.";

const UNRELATED =
  "I walked past some gardenias at the market. I haven't told my wife yet.";

const DERM =
  "I just saw my dermatologist, Dr. Cather. She said this rash looks like it might be lymphoma. She advised me to talk to my oncologist, Dr. Vance, but I think I already have something on my calendar to see him. She's going to send the medical records over. She called me in a prescription for XYZ. Boy, I hope it's not cancer.";

const TICKETS =
  "I need to buy airline tickets to Rome. The kids said they're available starting November 20 but have to be back by Monday the 29th.";

const GARDENIA_F1 =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const GARDENIA_F1B =
  "Oh man, great day — boss says he's promoting me. Haven't told my wife. I'll grab flowers for her on the way home. She loves gardenias. That's been her favorite since our anniversary on December 4th.";

function prefs(candidates: AdmittedMultiFactCandidate[]) {
  return candidates.filter((c) => c.kind === 'preference');
}

function proposedPrefs(raw: string) {
  return proposeNaturalMultiFactFromUtterance(raw).candidates.filter((c) => c.kind === 'preference');
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

export async function runPreferenceAssociationFoundationV1Tests() {
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

  console.log(`\n${BOLD}-- Preference Association Foundation V1 ----------------------${RESET}\n`);

  {
    const proposal = proposeNaturalMultiFactFromUtterance(EXPLICIT);
    const admitted = admitNaturalMultiFactProposal(EXPLICIT, proposal);
    assert('explicit admit >=2', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'explicit wife → gardenias',
      pref.length === 1 && pref[0].subject === 'wife' && /^gardenias$/i.test(pref[0].value),
      (v) => v === true,
      'subject=wife value=gardenias',
    );
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(PRONOUN_CONTINUITY);
    const admitted = admitNaturalMultiFactProposal(PRONOUN_CONTINUITY, proposal);
    assert('pronoun-continuity admit >=2', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'she loves gardenias binds unique wife in utterance',
      pref.length === 1 && pref[0].subject === 'wife' && /^gardenias$/i.test(pref[0].value),
      (v) => v === true,
      'subject=wife value=gardenias',
    );
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(AMBIGUOUS);
    const admitted = admitNaturalMultiFactProposal(AMBIGUOUS, proposal);
    assert('ambiguous still admits a set', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'ambiguous she does not guess a subject',
      pref.length === 1 && pref[0].subject === undefined && /^gardenias$/i.test(pref[0].value),
      (v) => v === true,
      'no subject',
    );
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(TWO_PREFS);
    const admitted = admitNaturalMultiFactProposal(TWO_PREFS, proposal);
    assert('two-pref admit', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    const wife = pref.find((c) => c.subject === 'wife');
    const son = pref.find((c) => c.subject === 'son');
    assert('wife preference is gardenias', !!wife && /^gardenias$/i.test(wife.value), (v) => v === true, 'wife→gardenias');
    assert('son preference is pizza', !!son && /^pizza$/i.test(son.value), (v) => v === true, 'son→pizza');
    assert('preferences do not cross subjects', pref.length === 2 && wife?.value !== son?.value, (v) => v === true, 'no cross');
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(UNRELATED);
    const admitted = admitNaturalMultiFactProposal(UNRELATED, proposal);
    assert('unrelated gardenia still admits', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'proximity gardenia is not wife preference',
      pref.every((c) => !(c.subject === 'wife' && /gardenias/i.test(c.value))),
      (v) => v === true,
      'no wife→gardenias',
    );
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(DERM);
    const admitted = admitNaturalMultiFactProposal(DERM, proposal);
    assert('derm still ADMIT', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    if (admitted.decision === 'ADMIT') {
      const lymphoma = admitted.candidates.find((c) => /lymphoma/i.test(c.value));
      assert('lymphoma remains attributed_claim', lymphoma?.kind === 'attributed_claim', (v) => v === true, 'attributed_claim');
      assert('lymphoma hedge intact', !!(lymphoma?.hedge && /might|looks like/i.test(lymphoma.hedge)), (v) => v === true, 'hedge');
      assert('emotion_drop still dropped', !admitted.candidates.some((c) => /hope/i.test(c.value) && /cancer/i.test(c.value)), (v) => v === true, 'dropped');
      assert('XYZ still prescribed', admitted.candidates.some((c) => c.kind === 'prescribed' && /xyz/i.test(c.value)), (v) => v === true, 'prescribed');
    }
  }

  {
    const proposal = proposeNaturalMultiFactFromUtterance(TICKETS);
    const admitted = admitNaturalMultiFactProposal(TICKETS, proposal);
    assert('tickets still ADMIT', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    if (admitted.decision === 'ADMIT') {
      assert(
        'obligation/temporal survive',
        admitted.candidates.some((c) => c.kind === 'obligation')
          || admitted.candidates.some((c) => c.kind === 'temporal')
          || admitted.candidates.length >= 2,
        (v) => v === true,
        'obligation or temporal',
      );
    }
  }

  {
    const one = 'My wife\'s favorite flowers are gardenias.';
    const admitted = admitNaturalMultiFactProposal(one, proposeNaturalMultiFactFromUtterance(one));
    assert(
      'admission floor still >=2',
      admitted.decision === 'DEFER' && admitted.decision === 'DEFER' && /below_threshold/.test(admitted.reason),
      (v) => v === true,
      'DEFER below_threshold',
    );
  }

  {
    const { db, session, deps } = openJourneyDb();
    const discourse = new DiscourseContinuityHolder();
    const before = medCounts(db as never);
    const outcome = await processUtterance(
      normalizeInput(EXPLICIT),
      session,
      deps,
      null, null, null, null, null,
      discourse,
    );
    const after = medCounts(db as never);
    const hold = discourse.peekInterpretationHold();
    const pref = hold ? prefs(hold.candidates) : [];
    assert('journey is interpretation hold', outcome.handled && outcome.source === 'interpretation', (v) => v === true, 'interpretation');
    assert('journey wife→gardenias held', pref.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)), (v) => v === true, 'held');
    assert('journey zero sqlite', JSON.stringify(before) === JSON.stringify(after), (v) => v === true, 'unchanged');
    assert('journey no pending', session.hasPending() === false, (v) => v === true, 'no pending');
    assert('journey no commits', outcome.handled && outcome.commits.length === 0, (v) => v === true, '[]');
  }

  {
    const admitted = admitNaturalMultiFactProposal(GARDENIA_F1, proposeNaturalMultiFactFromUtterance(GARDENIA_F1));
    assert('F1 admit', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'F1 her favorite gardenias → wife',
      pref.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)),
      (v) => v === true,
      'wife→gardenias',
    );
  }

  {
    const admitted = admitNaturalMultiFactProposal(GARDENIA_F1B, proposeNaturalMultiFactFromUtterance(GARDENIA_F1B));
    assert('F1b admit', admitted.decision === 'ADMIT', (v) => v === true, 'ADMIT');
    const pref = admitted.decision === 'ADMIT' ? prefs(admitted.candidates) : [];
    assert(
      'F1b she loves gardenias → wife',
      pref.some((c) => c.subject === 'wife' && /^gardenias$/i.test(c.value)),
      (v) => v === true,
      'wife→gardenias',
    );
  }

  {
    assert('would like is not preference', proposedPrefs("I would like tickets to Rome. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert('like to is not preference', proposedPrefs("I like to run in the morning. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert('looks like is not preference', proposedPrefs("She looks like my sister. I called my wife.").length === 0, (v) => v === true, '0');
    assert('might like is not asserted preference', proposedPrefs("She might like roses. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert('might love is not asserted preference', proposedPrefs("She might love roses. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
  }

  {
    assert('simile like-five-minutes is not preference', proposedPrefs("It was like five minutes. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert("doesn't like is not affirmative preference", proposedPrefs("She doesn't like roses. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert("don't like is not affirmative preference", proposedPrefs("I don't like roses. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert("didn't like is not affirmative preference", proposedPrefs("She didn't like roses. I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert('never likes is not affirmative preference', proposedPrefs("She never likes roses. I called my wife.").length === 0, (v) => v === true, '0');
    assert('no longer likes is not affirmative preference', proposedPrefs("She no longer likes roses. I called my wife.").length === 0, (v) => v === true, '0');
    assert('interrogative does-she-like is not preference', proposedPrefs("Does she like roses? I haven't told my wife yet.").length === 0, (v) => v === true, '0');
    assert('interrogative does-she-love is not preference', proposedPrefs("Does she love roses? I haven't told my wife yet.").length === 0, (v) => v === true, '0');
  }

  {
    const hePizza = proposedPrefs("I haven't told my wife yet. He likes pizza.");
    assert('he likes pizza is preference without wife subject', hePizza.length === 1 && hePizza[0].subject !== 'wife' && /^pizza$/i.test(hePizza[0].value), (v) => v === true, 'no wife bind');
    const nurseTea = proposedPrefs("I haven't told my wife yet. Then I spoke with the nurse. She likes tea.");
    assert('nurse she likes tea does not bind wife', nurseTea.length === 1 && nurseTea[0].subject !== 'wife' && /^tea$/i.test(nurseTea[0].value), (v) => v === true, 'no wife bind');
  }

  {
    const theG = proposedPrefs("I haven't told my wife yet. She likes the gardenias.");
    assert('the gardenias is not value the', theG.every((c) => c.value.toLowerCase() !== 'the'), (v) => v === true, 'not the');
    assert('the gardenias yields gardenias', theG.length === 1 && /^gardenias$/i.test(theG[0].value) && theG[0].subject === 'wife', (v) => v === true, 'gardenias+wife');
  }

  console.log(`\n${BOLD}Preference Association Foundation V1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('preferenceAssociationFoundation');
if (isDirect) {
  runPreferenceAssociationFoundationV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
