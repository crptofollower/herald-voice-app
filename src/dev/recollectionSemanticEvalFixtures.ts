// Closed-label semantic evaluation fixtures. Herald expected labels are
// contract, not model score. Do not edit expected to chase accuracy.
//
// THIRD_PARTY contract (evaluation only, not a phrase library):
// the recollection object is principally another person's private life.
// Mentioning another person, a family member, or a grammatical third-person
// subject inside the speaker's own lived experience is AUTOBIOGRAPHICAL.

import type { ReminiscenceDisposition } from '../utils/reminiscenceDisposition';

export type RecollectionSemanticScoring = 'scored' | 'observational';

export type RecollectionSemanticEvalRow = {
  class: string;
  utterance: string;
  expected: ReminiscenceDisposition | null;
  arcOpen: boolean;
  notes: string;
  scoring: RecollectionSemanticScoring;
  sequenceId?: string;
  turnIndex?: number;
};

/** Frozen Shadow V1 scored rows. Do not retarget these labels for model score. */
export const RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL: ReadonlyArray<{
  class: string;
  utterance: string;
  expected: ReminiscenceDisposition;
  arcOpen: boolean;
  notes: string;
}> = [
  {
    class: 'childhood_without_cue',
    utterance: 'The summer I turned eight we slept on the screened porch because the house stayed too hot.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'own childhood past; no "when I was a kid" cue',
  },
  {
    class: 'adulthood_memory',
    utterance: 'The first apartment I rented after college had a radiator that clanged every night at two.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'adult autobiographical past',
  },
  {
    class: 'work_story',
    utterance: 'My first week on the loading dock they handed me a clipboard and told me not to smile at the drivers.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'work history as lived experience',
  },
  {
    class: 'marriage_family',
    utterance: 'We got married in her parents\' backyard and it started raining during the vows.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'speaker-lived marriage/family experience',
  },
  {
    class: 'travel_story',
    utterance: 'The train to Galveston was packed and I stood the whole way holding a paper bag of oranges.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'travel as own past',
  },
  {
    class: 'mundane_personal_past',
    utterance: 'I used to buy the same loaf of rye every Tuesday after work.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'mundane historical; not importance-gated',
  },
  {
    class: 'mundane_personal_past_2',
    utterance: 'For years I parked under that oak because it was the only shade on the block.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'clearly historical, ordinary',
  },
  {
    class: 'emotional_non_medical',
    utterance: 'I sat in the empty bleachers after the last game and I couldn\'t make myself get up.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'emotional autobiographical, not medical',
  },
  {
    class: 'north_star_dad_fishing',
    utterance: 'Dad wasn\'t much of a talker, but every Saturday he\'d have the fishing poles leaning against the garage before I even got downstairs.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'North-Star; family in own lived experience is AUTOBIOGRAPHICAL, not THIRD_PARTY; no phrase rule',
  },
  {
    class: 'present_transient',
    utterance: 'Traffic is awful this morning.',
    expected: 'TRANSIENT',
    arcOpen: false,
    notes: 'present passing chatter',
  },
  {
    class: 'health_medical',
    utterance: 'My doctor doubled my Eliquis.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'health/medical fail-closed',
  },
  {
    class: 'financial',
    utterance: 'I refinanced the mortgage last spring and the payment dropped a little.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'financial',
  },
  {
    class: 'legal',
    utterance: 'My lawyer said not to talk about the lawsuit with anyone.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'legal',
  },
  {
    class: 'credentials_secrets',
    utterance: 'The password for the old email is still taped under the keyboard.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'credentials/secrets',
  },
  {
    class: 'third_party_medical',
    utterance: 'My sister\'s doctor doubled her Eliquis.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'third-party medical; mixed sensitive fail-closed as a whole; not the THIRD_PARTY discrimination case',
  },
  {
    class: 'ordinary_third_party',
    utterance: 'My neighbor paints landscapes on weekends and hangs them on the fence.',
    expected: 'THIRD_PARTY',
    arcOpen: false,
    notes: 'recollection object is principally the neighbor\'s activity; non-medical THIRD_PARTY contrast',
  },
  {
    class: 'mixed_autobiographical_sensitive',
    utterance: 'When I was twenty I hid my password in a book so I wouldn\'t forget it.',
    expected: 'SENSITIVE',
    arcOpen: false,
    notes: 'mixed; whole utterance excluded',
  },
  {
    class: 'uncertain_residue',
    utterance: 'uh yeah maybe wait what',
    expected: 'UNCERTAIN',
    arcOpen: false,
    notes: 'conversational residue',
  },
  {
    class: 'active_arc_short_continuation',
    utterance: 'About twelve.',
    expected: 'CONTINUE_ARC',
    arcOpen: true,
    notes: 'short continuation with open arc',
  },
  {
    class: 'active_arc_insufficient_referent',
    utterance: 'The other one.',
    expected: 'UNCERTAIN',
    arcOpen: true,
    notes: 'open arc but referent too thin; UNCERTAIN unless Track-C later supports it',
  },
  {
    class: 'grief_own_loss',
    utterance: 'I still set two plates on Sundays even though she\'s been gone three years.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'grief evidence only; not a new sensitive ontology',
  },
  {
    class: 'grief_death_mention',
    utterance: 'The morning after the funeral I walked to the bakery because I didn\'t want the house yet.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'death in own past; report model behavior',
  },
];

function scored(
  className: string,
  utterance: string,
  expected: ReminiscenceDisposition,
  arcOpen: boolean,
  notes: string,
  extra?: { sequenceId?: string; turnIndex?: number },
): RecollectionSemanticEvalRow {
  return {
    class: className,
    utterance,
    expected,
    arcOpen,
    notes,
    scoring: 'scored',
    ...extra,
  };
}

function observational(
  className: string,
  utterance: string,
  arcOpen: boolean,
  notes: string,
  extra?: { sequenceId?: string; turnIndex?: number },
): RecollectionSemanticEvalRow {
  return {
    class: className,
    utterance,
    expected: null,
    arcOpen,
    notes,
    scoring: 'observational',
    ...extra,
  };
}

export const RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1: RecollectionSemanticEvalRow[] = [
  ...RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.map((row) => scored(
    row.class,
    row.utterance,
    row.expected,
    row.arcOpen,
    row.notes,
  )),

  // G1 — additional mundane historical vs current chatter
  scored(
    'g1_rye_loaf_short',
    'I used to buy the same loaf of rye every Tuesday.',
    'AUTOBIOGRAPHICAL',
    false,
    'G1 mundane historical; shorter rye contrast; does not replace mundane_personal_past',
  ),
  scored(
    'g1_coffee_cold',
    'I\'m just saying the coffee\'s cold.',
    'TRANSIENT',
    false,
    'G1 current chatter; exact expectation TRANSIENT (non-R, not UNCERTAIN residue)',
  ),

  // G2 — autobiography containing other people vs genuine third-party private life
  scored(
    'g2_mom_christmas',
    'Mom always set an extra place at Christmas.',
    'AUTOBIOGRAPHICAL',
    false,
    'G2 family member inside speaker autobiographical experience; not THIRD_PARTY',
  ),
  scored(
    'g2_third_party_private_life',
    'Ken hasn\'t told his kids he\'s seeing someone in Dallas.',
    'THIRD_PARTY',
    false,
    'G2 recollection object is principally Ken\'s private life; non-medical so SENSITIVE cannot mask THIRD_PARTY',
  ),

  // G3 — mixed single STT blob; one-utterance→one-disposition limitation
  observational(
    'g3_mixed_stt_blob',
    'Dad used to take us fishing every Saturday, traffic was awful this morning, and I need to call Suzie about Wednesday.',
    false,
    'G3 observational only; no production admission expectation; record model one-label collapse',
  ),

  // G5 — continuation extras
  observational(
    'g5_he_hated_mornings',
    'He hated mornings.',
    true,
    'G5 observational; current contract has no referent authority; do not invent CONTINUE_ARC',
  ),
  scored(
    'g5_yeah',
    'Yeah.',
    'UNCERTAIN',
    true,
    'G5 acknowledgment is UNCERTAIN; current contract does not treat it as CONTINUE_ARC',
  ),

  // G7 — 2–4 turn reminiscence pressure: story → digression → return
  // arcOpen on later turns is evaluation pressure (prior scored AUTOBIOGRAPHICAL
  // would have opened an arc in a live-admission experiment). Stub still does
  // not admit these and production arc policy is unchanged.
  scored(
    'g7_t1_autobiographical_story',
    'We used to drive out to the lake before sunrise and eat peaches in the truck.',
    'AUTOBIOGRAPHICAL',
    false,
    'G7 turn 1 autobiographical story',
    { sequenceId: 'g7_story_digression_return', turnIndex: 1 },
  ),
  scored(
    'g7_t2_digression',
    'Traffic is awful this morning.',
    'TRANSIENT',
    true,
    'G7 turn 2 present digression under open-arc evaluation pressure',
    { sequenceId: 'g7_story_digression_return', turnIndex: 2 },
  ),
  scored(
    'g7_t3_return',
    'Anyway, the peaches were always warm from sitting on the dash.',
    'AUTOBIOGRAPHICAL',
    true,
    'G7 turn 3 return to own story; not a new arc policy',
    { sequenceId: 'g7_story_digression_return', turnIndex: 3 },
  ),
];

/** Shadow Expansion V1 — generalized failure-class contrast. Do not retarget matrix v1. */
export const RECOLLECTION_SEMANTIC_EXPANSION_V1: RecollectionSemanticEvalRow[] = [
  scored(
    'g8_open_arc_backchannel_mmhmm',
    'Mm-hmm.',
    'UNCERTAIN',
    true,
    'G8 open-arc backchannel/acknowledgment; current contract is UNCERTAIN, not CONTINUE_ARC',
  ),
  scored(
    'g8_open_arc_thin_that_one',
    'That one.',
    'UNCERTAIN',
    true,
    'G8 open-arc thin demonstrative; insufficient Track-C support; UNCERTAIN, not CONTINUE_ARC',
  ),
  scored(
    'g8_open_arc_contentful_return',
    'The peaches stained the seat covers that whole summer.',
    'AUTOBIOGRAPHICAL',
    true,
    'G8 open-arc contentful autobiographical return; current evaluation policy remains AUTO, not CONTINUE_ARC; R-safety is separate from exact-label',
  ),
  scored(
    'g8_third_party_ordinary_activity',
    'Pat walks his dog past the library every evening.',
    'THIRD_PARTY',
    false,
    'G8 ordinary third-party activity; recollection object is principally Pat\'s habit, not the speaker\'s past',
  ),
  scored(
    'g8_third_party_private_life',
    'Rita hasn\'t told her boss she\'s looking for another job.',
    'THIRD_PARTY',
    false,
    'G8 principally another person\'s private-life content; non-medical THIRD_PARTY pressure',
  ),
  observational(
    'g8_mixed_stt_blob',
    'I used to take the late bus, can you add milk, and also what\'s on Wednesday.',
    false,
    'G8 mixed multi-intent/STT blob; observational only; no scored admission expectation',
  ),
];

export const RECOLLECTION_SEMANTIC_EVAL_FIXTURES: RecollectionSemanticEvalRow[] = [
  ...RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1,
  ...RECOLLECTION_SEMANTIC_EXPANSION_V1,
];
