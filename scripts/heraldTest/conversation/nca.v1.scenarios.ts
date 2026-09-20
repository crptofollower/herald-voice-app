/**
 * Natural Conversation Acceptance Corpus V1 — measurement only.
 * Does not claim product completeness. Continuity V1 scenarios set mustPass.
 */

export const NCA_V1_SCHEMA = 'herald.conversation.nca.v1';

export type NcaClass =
  | 'PASS'
  | 'UNSUPPORTED'
  | 'WRONG'
  | 'TRUST_FAILURE'
  | 'UNKNOWN';

export type NcaSeed = {
  contacts?: Array<{ id: string; name: string; phone?: string; relationship?: string }>;
  calendar?: Array<{ id: string; title: string; start_ms: number; end_ms: number }>;
};

export type NcaScenario = {
  id: string;
  family: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  /** True only for accepted Conversational Repair Continuity V1 contracts. */
  mustPass: boolean;
  seed?: NcaSeed;
  turns: string[];
  notes: string;
};

const GARDENIA =
  "I had a great day today. My boss called and told me he's going to promote me, and I haven't told my wife yet. On the way home I'm going to pick up flowers to surprise her. Her favorite flowers are gardenias. She told me that on our anniversary, December 4th.";

const GARDENIA_B =
  "Oh man, great day — boss says he's promoting me. Haven't told my wife. I'll grab flowers for her on the way home. She loves gardenias. That's been her favorite since our anniversary on December 4th.";

const DERM =
  "I just saw my dermatologist, Dr. Cather. She said this rash looks like it might be lymphoma. She advised me to talk to my oncologist, Dr. Vance, but I think I already have something on my calendar to see him. She's going to send the medical records over. She called me in a prescription for XYZ. Boy, I hope it's not cancer.";

const DERM_B =
  "Came from Dr. Cather, my dermatologist. She thinks the rash might be lymphoma — not sure. Wants me to talk with Dr. Vance, my oncologist. Pretty sure he's already on my calendar. She's sending records. Called in XYZ. I really hope this isn't cancer.";

const ITALY =
  "We're going to Italy this fall. We land in Rome first, then we're heading down to Sorrento on the Amalfi Coast. I think we leave around November 20th. Hunter and Grant, my sons, are coming, and Shannon — that's my wife — is coming too. The boys have to fly home earlier. Mike and Shannon are staying afterward. We get back December 4th so we can celebrate our anniversary.";

const ITALY_INCONSISTENT =
  "We're going to Italy this fall. Rome first, then Sorrento. We leave November 20th. Hunter and Grant, my sons, fly home Monday the 29th. Shannon my wife and I stay after they leave. We get back November 4th for our December 4th anniversary — wait, I mean we get back December 4th.";

const TICKETS =
  "I need to buy airline tickets to Rome. The kids said they're available starting November 20 but have to be back by Monday the 29th. I need Airbnbs in Rome and Sorrento and a rental car. I'm going to research the Airbnbs. We're going to celebrate our anniversary.";

const TICKETS_B =
  "Gotta get Rome plane tickets. Boys can go from November 20 and must be back Monday the 29th. Need a Rome Airbnb, a Sorrento Airbnb, and a car. I'll look at the Airbnbs myself. Anniversary trip.";

const MAPS =
  'Open Maps to 16205 Hickory Street, Little Elm, Texas. I\'m going to see my father-in-law.';

export const NCA_V1_SCENARIOS: NcaScenario[] = [
  {
    id: 'nca.f1.everyday_gardenia',
    family: 1,
    title: 'Everyday life: promotion / wife / gardenias / anniversary',
    mustPass: false,
    turns: [
      GARDENIA,
      'What flowers does my wife like?',
      'What was I going to pick up?',
      'When is our anniversary?',
    ],
    notes: 'Separate promotion, wife, flower pickup, gardenia preference, Dec 4, vs narrative emotion.',
  },
  {
    id: 'nca.f1b.everyday_gardenia_variant',
    family: 1,
    title: 'Everyday life wording variant',
    mustPass: false,
    turns: [GARDENIA_B, 'What flowers does my wife like?'],
    notes: 'Same facts, different wording — mechanism not phrase.',
  },
  {
    id: 'nca.f2.dermatologist',
    family: 2,
    title: 'Medical: Cather / possible lymphoma / Vance / XYZ / emotion',
    mustPass: false,
    seed: {
      calendar: [{
        id: 'cal_vance',
        title: 'Dr. Vance oncology',
        start_ms: Date.UTC(2026, 10, 5, 15, 0),
        end_ms: Date.UTC(2026, 10, 5, 16, 0),
      }],
    },
    turns: [
      DERM,
      'What did Dr. Cather say about the rash?',
      'Why am I supposed to see Dr. Vance?',
      'What did the dermatologist prescribe?',
    ],
    notes: 'Never promote might-be-lymphoma or hope-not-cancer into diagnosis; XYZ is prescribed not taking.',
  },
  {
    id: 'nca.f2b.dermatologist_variant',
    family: 2,
    title: 'Medical wording variant',
    mustPass: false,
    turns: [DERM_B, 'What did the dermatologist prescribe?'],
    notes: 'Same medical invariants, different wording.',
  },
  {
    id: 'nca.f3.italy',
    family: 3,
    title: 'Family travel: Italy / sons / Shannon / return Dec 4',
    mustPass: false,
    turns: [
      ITALY,
      'When are the boys flying home?',
      'Where are we going after Rome?',
      'How long are Shannon and I staying after they leave?',
      'What did I tell you about our anniversary?',
    ],
    notes: 'Natural kin identification; do not invent missing dates.',
  },
  {
    id: 'nca.f3b.italy_inconsistent_date',
    family: 3,
    title: 'Family travel with internal date contradiction',
    mustPass: false,
    turns: [ITALY_INCONSISTENT, 'When do we get back?'],
    notes: 'Must not silently pick November 4 vs December 4.',
  },
  {
    id: 'nca.f4.travel_obligations',
    family: 4,
    title: 'Travel obligations: tickets, two Airbnbs, car, research',
    mustPass: false,
    turns: [TICKETS],
    notes: 'Separate obligations; no poke. Record later poke evidence.',
  },
  {
    id: 'nca.f4b.travel_obligations_variant',
    family: 4,
    title: 'Travel obligations wording variant',
    mustPass: false,
    turns: [TICKETS_B],
    notes: 'Same obligation set, different wording.',
  },
  {
    id: 'nca.f5.maps_father_in_law',
    family: 5,
    title: 'Maps address + father-in-law, then name fragment',
    mustPass: false,
    turns: [
      MAPS,
      'Open Maps to my father-in-law.',
      'David is my father-in-law.',
    ],
    notes: 'No FIL-specific rule. Destination vs relationship vs fragment merge.',
  },
  {
    id: 'nca.f6.continuity_paul_sms',
    family: 6,
    title: 'Continuity V1: unmatched name holds SMS; spelling proposes; YES sends body',
    mustPass: true,
    seed: {
      contacts: [
        { id: 'c_a', name: 'Paul Cioffre', phone: '5553010001' },
        { id: 'c_b', name: 'Paul Smith', phone: '5553010002' },
      ],
    },
    turns: [
      "Text him I'll be home at 8.",
      'Paul.',
      'Show Fray',
      'c i o f f r e',
      'yes',
    ],
    notes: 'Accepted Continuity V1 contract via processUtterance.',
  },
  {
    id: 'nca.f6.self_correction_grocery',
    family: 6,
    title: 'Self-correction: drop bread, keep coffee',
    mustPass: false,
    turns: [
      "I need eggs and maybe bread—actually don't worry about bread, Linda bought some yesterday. But we're almost out of coffee too.",
    ],
    notes: 'Reversal must not special-case Linda/bread wording.',
  },
  {
    id: 'nca.f6.interruption_return',
    family: 6,
    title: 'Interruption then return to grocery confirm',
    mustPass: false,
    turns: [
      'For my grocery list, we need milk and bananas.',
      'what time is it',
      'yes',
    ],
    notes: 'Measure pending absorption; do not repair (out of Continuity V1 grocery scope).',
  },
  {
    id: 'nca.f6.pronoun_todo',
    family: 6,
    title: 'Pronoun / fragment after a named obligation',
    mustPass: false,
    turns: [
      'Remind me I need to pick up that wine we had at Sea Fields.',
      'What was I supposed to bring Saturday?',
    ],
    notes: 'Reference continuity / recap — likely ChatScreen-only.',
  },
  {
    id: 'nca.f6.call_spelling_hold',
    family: 6,
    title: 'Continuity V1 CALL: miss holds, typed fragment completes',
    mustPass: true,
    seed: {
      contacts: [
        { id: 'c_a', name: 'Paul Cioffre', phone: '18178468607' },
        { id: 'c_b', name: 'Paul Smith', phone: '5551112222' },
      ],
    },
    turns: [
      'Call Paul.',
      'Shaffery',
      'Cioffre',
    ],
    notes: 'Accepted CALL finite recovery contract.',
  },
];
