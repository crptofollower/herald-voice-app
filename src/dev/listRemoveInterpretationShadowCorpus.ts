// Pre-written ground truth for the list_remove interpretation shadow.
// Labels are independent of Qwen output. Qwen fields are measurements.

export type CorpusExpectedSpeechAct = 'directive' | 'narrative' | 'question' | 'other';

export type CorpusExpectedAuthority =
  | 'authorize_list_remove'
  | 'reject'
  | 'clarify_ungrounded';

export type CorpusProductionRisk =
  | 'list_remove'
  | 'list_remove_miss'
  | 'todo_complete_or_other_deterministic'
  | 'conversation_or_other';

export type ListRemoveShadowCorpusRow = {
  id: string;
  utterance: string;
  expected_speech_act: CorpusExpectedSpeechAct;
  expected_shadow_authority: CorpusExpectedAuthority;
  expected_referent: string | null;
  expected_production_risk: CorpusProductionRisk;
  grocery_open_bodies: string[];
  /** Spoken cutoff cannot be proven by typing. Device-only. */
  device_spoken_cutoff?: boolean;
};

export const LIST_REMOVE_SHADOW_CORPUS: ListRemoveShadowCorpusRow[] = [
  {
    id: 'explicit-remove-eggs',
    utterance: 'Remove eggs from my grocery list.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'authorize_list_remove',
    expected_referent: 'eggs',
    expected_production_risk: 'list_remove',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'explicit-take-off-eggs',
    utterance: 'Take eggs off my grocery list.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'authorize_list_remove',
    expected_referent: 'eggs',
    expected_production_risk: 'list_remove',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'narrative-bought-eggs-susan',
    utterance: 'We bought eggs yesterday when we went to see Susan.',
    expected_speech_act: 'narrative',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'todo_complete_or_other_deterministic',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'narrative-cantaloupes-bananas',
    utterance: "We bought cantaloupes and bananas but didn't get meat.",
    expected_speech_act: 'narrative',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'todo_complete_or_other_deterministic',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'i-got-eggs',
    utterance: 'I got eggs.',
    expected_speech_act: 'narrative',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'list_remove',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'ive-got-to-get-eggs',
    utterance: "I've got to get eggs.",
    expected_speech_act: 'directive',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'i-gotta-get-some-eggs',
    utterance: 'I gotta get some eggs.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'dont-remove-eggs',
    utterance: "Don't remove eggs.",
    expected_speech_act: 'directive',
    expected_shadow_authority: 'reject',
    expected_referent: 'eggs',
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'remove-egg-singular',
    utterance: 'Remove egg from my grocery list.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'clarify_ungrounded',
    expected_referent: 'egg',
    expected_production_risk: 'list_remove_miss',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'remove-milk-absent',
    utterance: 'Remove milk from my grocery list.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'clarify_ungrounded',
    expected_referent: 'milk',
    expected_production_risk: 'list_remove_miss',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'remove-the-eggs-article',
    utterance: 'Remove the eggs.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'clarify_ungrounded',
    expected_referent: 'the eggs',
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'eggs-noun-only',
    utterance: 'Eggs.',
    expected_speech_act: 'other',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'empty-list-remove-eggs',
    utterance: 'Remove eggs.',
    expected_speech_act: 'directive',
    expected_shadow_authority: 'clarify_ungrounded',
    expected_referent: 'eggs',
    expected_production_risk: 'list_remove_miss',
    grocery_open_bodies: [],
  },
  {
    id: 'grocery-trip-narrative',
    utterance: 'My wife and I went to the grocery store yesterday.',
    expected_speech_act: 'narrative',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'todo_complete_or_other_deterministic',
    grocery_open_bodies: ['eggs'],
  },
  {
    id: 'spoken-asr-cutoff',
    utterance: '(device spoken cutoff of remove-shaped or narrative turn)',
    expected_speech_act: 'other',
    expected_shadow_authority: 'reject',
    expected_referent: null,
    expected_production_risk: 'conversation_or_other',
    grocery_open_bodies: ['eggs'],
    device_spoken_cutoff: true,
  },
];
