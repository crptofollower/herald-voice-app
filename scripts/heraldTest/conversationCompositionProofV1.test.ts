// Conversation composition proof. Production seams, legal semantic stubs.
// The stub marks compatibility sets. It does not select a winner or mint ids.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import {
  DISCOURSE_APPLICABILITY_PROMPT,
  DISCOURSE_CORRECTION_PROMPT,
  DISCOURSE_MENTION_PROPOSAL_PROMPT,
} from '../../src/routing/semanticProvider.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', DIM = '\x1b[2m', RESET = '\x1b[0m';

type Span = { span: string; kind: 'person' | 'place' | 'event_or_topic' };
type SurfaceMark = { surface: string; kind: string };

type TurnScript = {
  text: string;
  mentions?: Span[];
  marks?: 'suppress' | { compatible: SurfaceMark[] };
  correction?: {
    target: SurfaceMark;
    replacementSurfaces?: SurfaceMark[];
    newSpans?: Span[];
  };
};

type TurnExpect = {
  label: string;
  owner: string;
  applicability: 'zero' | 'one' | 'many' | 'correction' | 'owned';
  active: SurfaceMark[];
  correctedAway?: string[];
  topic: string | null;
  speechIncludes?: string[];
  speechExcludes?: string[];
  act?: string;
  durableCommit?: boolean;
};

type Card = { handle: string; kind: string; surfaceSpan: string };

const CLUNKY: string[] = [];

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function packet(prompt: string): { candidates: Card[] } {
  const nl = prompt.indexOf('\n');
  const raw = nl >= 0 ? prompt.slice(nl + 1) : '';
  return JSON.parse(raw) as { candidates: Card[] };
}

function completionFor(turn: TurnScript) {
  return async (params: { prompt?: string }) => {
    const prompt = params.prompt ?? '';
    if (prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)) {
      if (!turn.correction) {
        return { text: JSON.stringify({ correction_turn: false, target_marks: [], replacement_marks: [] }) };
      }
      const cards = packet(prompt).candidates ?? [];
      const target_marks = cards.map((card) => ({
        handle: card.handle,
        mark: card.surfaceSpan === turn.correction!.target.surface && card.kind === turn.correction!.target.kind
          ? 'compatible'
          : 'incompatible',
      }));
      const replacement_marks = cards.map((card) => ({
        handle: card.handle,
        mark: (turn.correction!.replacementSurfaces ?? []).some((mark) => mark.surface === card.surfaceSpan && mark.kind === card.kind)
          ? 'compatible'
          : 'incompatible',
      }));
      const body: Record<string, unknown> = { correction_turn: true, target_marks, replacement_marks };
      if (turn.correction.newSpans) body.new_spans = turn.correction.newSpans;
      return { text: JSON.stringify(body) };
    }
    if (prompt.startsWith(DISCOURSE_APPLICABILITY_PROMPT)) {
      if (!turn.marks || turn.marks === 'suppress') {
        return { text: JSON.stringify({ utterance_applicable: false, marks: [] }) };
      }
      const cards = packet(prompt).candidates ?? [];
      const marks = cards.map((card) => ({
        handle: card.handle,
        mark: turn.marks !== 'suppress' && turn.marks.compatible.some((mark) => mark.surface === card.surfaceSpan && mark.kind === card.kind)
          ? 'compatible'
          : 'incompatible',
      }));
      return { text: JSON.stringify({ utterance_applicable: true, marks }) };
    }
    if (prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) {
      return { text: JSON.stringify(turn.mentions ?? []) };
    }
    return { text: '[]' };
  };
}

async function openDb() {
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  return db;
}

function activeOf(discourse: DiscourseContinuityHolder): SurfaceMark[] {
  return discourse.peekDiscourseMentions()
    .filter((mention) => mention.status === 'active')
    .map((mention) => ({ surface: mention.surfaceSpan, kind: mention.kind }))
    .sort((a, b) => `${a.kind}:${a.surface}`.localeCompare(`${b.kind}:${b.surface}`));
}

function sameMarks(got: SurfaceMark[], want: SurfaceMark[]): boolean {
  const left = [...got].sort((a, b) => `${a.kind}:${a.surface}`.localeCompare(`${b.kind}:${b.surface}`));
  const right = [...want].sort((a, b) => `${a.kind}:${a.surface}`.localeCompare(`${b.kind}:${b.surface}`));
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownerOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  if (outcome.handled) return outcome.source;
  const reason = 'reason' in outcome.routeDecision && outcome.routeDecision.reason
    ? `:${outcome.routeDecision.reason}`
    : '';
  return `${outcome.routeDecision.kind}${reason}`;
}

function speechOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  if (outcome.handled && outcome.source !== 'emergency') return outcome.responseText;
  return '';
}

function actOf(outcome: Awaited<ReturnType<typeof processUtterance>>): string {
  const act = outcome.responseAct;
  return act && 'kind' in act ? String(act.kind) : '';
}

function durableCommit(outcome: Awaited<ReturnType<typeof processUtterance>>): boolean {
  if (!outcome.handled || outcome.source === 'emergency') return false;
  return outcome.commits.some((commit) => commit.status === 'committed');
}

function noteClunky(label: string, speech: string, owner: string) {
  if (!speech.trim() && !owner.startsWith('device_action')) CLUNKY.push(`${label}: no spoken reply`);
  if (speech === 'Okay.') CLUNKY.push(`${label}: hold acknowledgement only`);
  if (speech.includes('You said:')) CLUNKY.push(`${label}: provenance read back`);
  if (speech.startsWith('Which of these should I continue:')) CLUNKY.push(`${label}: clarify list`);
  if (speech.startsWith('We were talking about')) CLUNKY.push(`${label}: reflection frame`);
}

function snapshot(discourse: DiscourseContinuityHolder) {
  return {
    mentions: discourse.peekDiscourseMentions().map((mention) => ({
      id: mention.mentionId,
      surface: mention.surfaceSpan,
      kind: mention.kind,
      status: mention.status,
      durable: mention.durable,
      turn: mention.sourceTurnId,
    })),
    episodes: discourse.peekDiscourseEpisodes().map((episode) => ({
      id: episode.id,
      members: episode.memberMentionIds,
    })),
    topic: discourse.peekTopic()?.displayName ?? null,
  };
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail: string) {
  if (cond) {
    passed++;
    console.log(`${GREEN}✅ PASS${RESET}  ${name}`);
  } else {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`${RED}❌ FAIL${RESET}  ${name}\n      ${detail}`);
  }
}

async function runTurn(
  discourse: DiscourseContinuityHolder,
  session: ConversationSession,
  script: TurnScript,
  expect: TurnExpect,
) {
  const before = snapshot(discourse);
  const outcome = await processUtterance(script.text, session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    getMedicationSemanticInterpreterCtx: () => ({ completion: completionFor(script) }),
  }, null, null, null, null, null, discourse);
  const after = snapshot(discourse);
  const speech = speechOf(outcome);
  const owner = ownerOf(outcome);
  const act = actOf(outcome);
  noteClunky(expect.label, speech, owner);
  console.log(`${DIM}${expect.label}${RESET} owner=${owner} act=${act || '-'} app=${expect.applicability}`);
  console.log(`${DIM}  text:${RESET} ${script.text}`);
  console.log(`${DIM}  speech:${RESET} ${speech || '(none)'}`);
  console.log(`${DIM}  active:${RESET} ${JSON.stringify(activeOf(discourse))}`);
  const problems: string[] = [];
  if (owner !== expect.owner) problems.push(`owner ${owner} wanted ${expect.owner}`);
  if (!sameMarks(activeOf(discourse), expect.active)) {
    problems.push(`active ${JSON.stringify(activeOf(discourse))} wanted ${JSON.stringify(expect.active)}`);
  }
  for (const surface of expect.correctedAway ?? []) {
    const row = after.mentions.find((mention) => mention.surface === surface);
    if (!row || row.status !== 'corrected_away') problems.push(`${surface} status ${row?.status ?? 'missing'}`);
    if (row && !after.episodes.some((episode) => episode.members.includes(row.id))) {
      problems.push(`${surface} left its episode`);
    }
  }
  if ((after.topic ?? null) !== expect.topic) problems.push(`topic ${after.topic} wanted ${expect.topic}`);
  if (expect.act && act !== expect.act) problems.push(`act ${act} wanted ${expect.act}`);
  for (const bit of expect.speechIncludes ?? []) {
    if (!speech.includes(bit)) problems.push(`speech missing ${bit}`);
  }
  for (const bit of expect.speechExcludes ?? []) {
    if (speech.includes(bit)) problems.push(`speech contained ${bit}`);
  }
  if (Boolean(expect.durableCommit) !== durableCommit(outcome)) {
    problems.push(`durable commit ${durableCommit(outcome)}`);
  }
  if (after.mentions.some((mention) => mention.durable)) problems.push('durable mention');
  if (JSON.stringify(after.episodes).includes('traveled_to')) problems.push('relation key');
  if (expect.applicability === 'one' && act !== 'REFLECT_CURRENT_TURN') problems.push(`applicability one act ${act}`);
  if (expect.applicability === 'many' && act !== 'CLARIFY_REFERENCE') problems.push(`applicability many act ${act}`);
  if (expect.applicability === 'correction' && owner !== 'discourse_correction') problems.push('correction owner');
  if (expect.applicability === 'owned' && (owner === 'discourse_reflection' || owner === 'discourse_correction')) {
    problems.push('owned turn used discourse');
  }
  if (expect.applicability === 'zero' && (owner === 'discourse_reflection' || owner === 'discourse_correction')) {
    problems.push('zero guessed a discourse answer');
  }
  check(expect.label, problems.length === 0, `${problems.join('; ')} | before ${JSON.stringify(before.mentions)} after ${JSON.stringify(after.mentions)} speech=${speech}`);
  return { before, after, speech, owner, act };
}

const FORBIDDEN_SPEECH = ['I saved', 'I updated', 'traveled', '555', 'phone number is'];

async function conversation1() {
  console.log(`\n${BOLD}conversation 1 — person / place / side action / correction${RESET}`);
  const db = await openDb();
  const discourse = new DiscourseContinuityHolder();
  const session = new ConversationSession();
  const turns: Array<{ script: TurnScript; expect: TurnExpect }> = [
    {
      script: { text: 'I caught up with Elena yesterday.', mentions: [{ span: 'Elena', kind: 'person' }], marks: 'suppress' },
      expect: {
        label: 'c1t1 introduce Elena',
        owner: 'needs_clarification:default',
        applicability: 'zero',
        active: [{ surface: 'Elena', kind: 'person' }],
        topic: 'Elena',
        durableCommit: false,
        speechExcludes: FORBIDDEN_SPEECH,
      },
    },
    {
      script: { text: 'A reunion came up with her.', mentions: [{ span: 'reunion', kind: 'event_or_topic' }], marks: 'suppress' },
      expect: {
        label: 'c1t2 add reunion',
        owner: 'needs_clarification:default',
        applicability: 'zero',
        active: [{ surface: 'Elena', kind: 'person' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: 'Elena',
        durableCommit: false,
      },
    },
    {
      script: { text: 'She brought up Ireland.', mentions: [{ span: 'Ireland', kind: 'place' }], marks: 'suppress' },
      expect: {
        label: 'c1t3 add Ireland',
        owner: 'needs_clarification:default',
        applicability: 'zero',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Ireland', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        topic: 'Elena',
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about Ireland?', marks: 'suppress' },
      expect: {
        label: 'c1t4 follow up Ireland',
        owner: 'discourse_reflection',
        applicability: 'one',
        act: 'REFLECT_CURRENT_TURN',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Ireland', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        topic: 'Elena',
        speechIncludes: ['Ireland'],
        speechExcludes: FORBIDDEN_SPEECH,
        durableCommit: false,
      },
    },
    {
      script: { text: 'Add rye to my grocery list.', marks: 'suppress' },
      expect: {
        label: 'c1t5 grocery side action',
        owner: 'capture',
        applicability: 'owned',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Ireland', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        topic: 'Elena',
        speechIncludes: ['rye'],
        durableCommit: true,
      },
    },
    {
      script: { text: 'What about Elena?', marks: 'suppress' },
      expect: {
        label: 'c1t6 return to Elena',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Ireland', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        topic: 'Elena',
        speechIncludes: ['Elena'],
        durableCommit: false,
      },
    },
    {
      script: {
        text: 'No, I meant Portugal.',
        correction: { target: { surface: 'Ireland', kind: 'place' }, newSpans: [{ span: 'Portugal', kind: 'place' }] },
      },
      expect: {
        label: 'c1t7 correct Ireland to Portugal',
        owner: 'discourse_correction',
        applicability: 'correction',
        act: 'ACKNOWLEDGE',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: 'Elena',
        speechIncludes: ['Portugal'],
        speechExcludes: ['I saved'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about Portugal?', marks: 'suppress' },
      expect: {
        label: 'c1t8 continue Portugal',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: 'Elena',
        speechIncludes: ['Portugal'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: {
        text: 'Can we pick that back up?',
        marks: { compatible: [{ surface: 'reunion', kind: 'event_or_topic' }, { surface: 'Portugal', kind: 'place' }] },
      },
      expect: {
        label: 'c1t9 ambiguous reunion or Portugal',
        owner: 'discourse_reflection',
        applicability: 'many',
        act: 'CLARIFY_REFERENCE',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: 'Elena',
        speechIncludes: ['reunion', 'Portugal'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'The reunion.', marks: 'suppress' },
      expect: {
        label: 'c1t10 resolve reunion',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: 'Elena',
        speechIncludes: ['reunion'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'What else about the reunion?', marks: 'suppress' },
      expect: {
        label: 'c1t11 continue corrected context',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['reunion'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'And Elena is still who I meant.', marks: 'suppress' },
      expect: {
        label: 'c1t12 Elena remains available',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [
          { surface: 'Elena', kind: 'person' },
          { surface: 'Portugal', kind: 'place' },
          { surface: 'reunion', kind: 'event_or_topic' },
        ],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['Elena'],
        speechExcludes: ['Ireland', 'I saved'],
        durableCommit: false,
      },
    },
  ];
  for (const turn of turns) await runTurn(discourse, session, turn.script, turn.expect);
  const contacts = Number((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n);
  check('c1 no contact row', contacts === 0, `contacts ${contacts}`);
  check('c1 no relation graph', !JSON.stringify(discourse.peekDiscourseEpisodes()).includes('friend_of'), 'relation present');
}

async function conversation2() {
  console.log(`\n${BOLD}conversation 2 — two people / ambiguity / fresh route${RESET}`);
  await openDb();
  const discourse = new DiscourseContinuityHolder();
  const session = new ConversationSession();
  const people = [
    { surface: 'Nora', kind: 'person' },
    { surface: 'Jonas', kind: 'person' },
    { surface: 'wedding', kind: 'event_or_topic' },
  ];
  const turns: Array<{ script: TurnScript; expect: TurnExpect }> = [
    {
      script: { text: 'I had lunch with Nora.', mentions: [{ span: 'Nora', kind: 'person' }], marks: 'suppress' },
      expect: { label: 'c2t1 introduce Nora', owner: 'needs_clarification:default', applicability: 'zero', active: [{ surface: 'Nora', kind: 'person' }], topic: 'Nora', durableCommit: false },
    },
    {
      script: { text: 'Jonas stopped by with her.', mentions: [{ span: 'Jonas', kind: 'person' }], marks: 'suppress' },
      expect: { label: 'c2t2 introduce Jonas', owner: 'needs_clarification:default', applicability: 'zero', active: [{ surface: 'Jonas', kind: 'person' }, { surface: 'Nora', kind: 'person' }], topic: 'Jonas', durableCommit: false },
    },
    {
      script: { text: 'He mentioned the wedding.', mentions: [{ span: 'wedding', kind: 'event_or_topic' }], marks: 'suppress' },
      expect: { label: 'c2t3 shared wedding', owner: 'needs_clarification:default', applicability: 'zero', active: people, topic: 'Jonas', durableCommit: false },
    },
    {
      script: {
        text: 'How are they feeling about it?',
        marks: { compatible: [{ surface: 'Nora', kind: 'person' }, { surface: 'Jonas', kind: 'person' }] },
      },
      expect: {
        label: 'c2t4 ambiguous between Nora and Jonas',
        owner: 'discourse_reflection',
        applicability: 'many',
        active: people,
        topic: 'Jonas',
        speechIncludes: ['Nora', 'Jonas'],
        speechExcludes: ['wedding'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'I mean Nora.', marks: 'suppress' },
      expect: { label: 'c2t5 identify Nora', owner: 'discourse_reflection', applicability: 'one', active: people, topic: 'Jonas', speechIncludes: ['Nora'], durableCommit: false },
    },
    {
      script: { text: 'What about Nora?', marks: 'suppress' },
      expect: { label: 'c2t6 continue Nora', owner: 'discourse_reflection', applicability: 'one', active: people, topic: 'Jonas', speechIncludes: ['Nora'], durableCommit: false },
    },
    {
      script: { text: 'add buy stamps to my todo list', marks: 'suppress' },
      expect: { label: 'c2t7 todo side action', owner: 'capture', applicability: 'owned', active: people, topic: 'Jonas', durableCommit: true, speechIncludes: ['stamps'] },
    },
    {
      script: { text: 'What about the wedding?', marks: 'suppress' },
      expect: { label: 'c2t8 return to wedding', owner: 'discourse_reflection', applicability: 'one', active: people, topic: null, speechIncludes: ['wedding'], durableCommit: false },
    },
    {
      script: { text: 'what time is it', marks: 'suppress' },
      expect: { label: 'c2t9 fresh device read', owner: 'device_action:action:time', applicability: 'owned', active: people, topic: null, durableCommit: false },
    },
    {
      script: { text: 'The sky looks grey today.', mentions: [], marks: 'suppress' },
      expect: { label: 'c2t10 fresh line does not sticky-answer', owner: 'needs_clarification:default', applicability: 'zero', active: people, topic: null, durableCommit: false, speechExcludes: ['Nora', 'Jonas', 'wedding'] },
    },
    {
      script: { text: 'It might rain later.', mentions: [], marks: 'suppress' },
      expect: { label: 'c2t11 continue fresh line', owner: 'needs_clarification:default', applicability: 'zero', active: people, topic: null, durableCommit: false, speechExcludes: ['Nora', 'Jonas'] },
    },
    {
      script: {
        text: 'How are they doing with it?',
        marks: { compatible: [{ surface: 'Nora', kind: 'person' }, { surface: 'Jonas', kind: 'person' }] },
      },
      expect: {
        label: 'c2t12 continuation stays ambiguous',
        owner: 'discourse_reflection',
        applicability: 'many',
        active: people,
        topic: null,
        speechIncludes: ['Nora', 'Jonas'],
        durableCommit: false,
      },
    },
  ];
  for (const turn of turns) await runTurn(discourse, session, turn.script, turn.expect);
  const identity = await processUtterance('Who were we talking about?', session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    getMedicationSemanticInterpreterCtx: () => ({ completion: completionFor({ text: 'Who were we talking about?', marks: { compatible: [{ surface: 'Nora', kind: 'person' }, { surface: 'Jonas', kind: 'person' }] } }) }),
  }, null, null, null, null, null, discourse);
  check(
    'c2 closed identity lookup does not consult discourse',
    ownerOf(identity) === 'needs_clarification:active_subject_identity'
      && speechOf(identity) === ''
      && sameMarks(activeOf(discourse), people),
    `owner ${ownerOf(identity)} speech ${speechOf(identity)}`,
  );
}

async function conversation3() {
  console.log(`\n${BOLD}conversation 3 — paraphrase / second place / correction / recovery${RESET}`);
  await openDb();
  const discourse = new DiscourseContinuityHolder();
  const session = new ConversationSession();
  const turns: Array<{ script: TurnScript; expect: TurnExpect }> = [
    {
      script: { text: 'We passed through Ireland.', mentions: [{ span: 'Ireland', kind: 'place' }], marks: 'suppress' },
      expect: { label: 'c3t1 introduce Ireland', owner: 'needs_clarification:default', applicability: 'zero', active: [{ surface: 'Ireland', kind: 'place' }], topic: null, durableCommit: false },
    },
    {
      script: { text: 'A reunion came up in that same chat.', mentions: [{ span: 'reunion', kind: 'event_or_topic' }], marks: 'suppress' },
      expect: {
        label: 'c3t2 reunion by co-membership',
        owner: 'needs_clarification:default',
        applicability: 'zero',
        active: [{ surface: 'Ireland', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: null,
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about that country?', marks: { compatible: [{ surface: 'Ireland', kind: 'place' }] } },
      expect: {
        label: 'c3t3 paraphrase selects Ireland',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [{ surface: 'Ireland', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: null,
        speechIncludes: ['Ireland'],
        speechExcludes: ['country'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'Tell me more about that country.', marks: { compatible: [{ surface: 'Ireland', kind: 'place' }] } },
      expect: {
        label: 'c3t4 continue paraphrase',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [{ surface: 'Ireland', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: null,
        speechIncludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'Spain came up in the same conversation.', mentions: [{ span: 'Spain', kind: 'place' }], marks: 'suppress' },
      expect: {
        label: 'c3t5 second place Spain',
        owner: 'needs_clarification:default',
        applicability: 'zero',
        active: [{ surface: 'Ireland', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: null,
        durableCommit: false,
      },
    },
    {
      script: {
        text: 'What about that country?',
        marks: { compatible: [{ surface: 'Ireland', kind: 'place' }, { surface: 'Spain', kind: 'place' }] },
      },
      expect: {
        label: 'c3t6 paraphrase is ambiguous',
        owner: 'discourse_reflection',
        applicability: 'many',
        active: [{ surface: 'Ireland', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        topic: null,
        speechIncludes: ['Ireland', 'Spain'],
        durableCommit: false,
      },
    },
    {
      script: {
        text: 'No, I meant Portugal.',
        correction: { target: { surface: 'Ireland', kind: 'place' }, newSpans: [{ span: 'Portugal', kind: 'place' }] },
      },
      expect: {
        label: 'c3t7 correct Ireland to Portugal',
        owner: 'discourse_correction',
        applicability: 'correction',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['Portugal'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about Portugal?', marks: 'suppress' },
      expect: {
        label: 'c3t8 continue Portugal',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['Portugal'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'what time is it', marks: 'suppress' },
      expect: {
        label: 'c3t9 owned clock read',
        owner: 'device_action:action:time',
        applicability: 'owned',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about the reunion?', marks: 'suppress' },
      expect: {
        label: 'c3t10 return to reunion',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['reunion'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: {
        text: 'What about that country?',
        marks: { compatible: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }] },
      },
      expect: {
        label: 'c3t11 country still ambiguous',
        owner: 'discourse_reflection',
        applicability: 'many',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['Portugal', 'Spain'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
    {
      script: { text: 'What about Spain?', marks: 'suppress' },
      expect: {
        label: 'c3t12 resolve Spain',
        owner: 'discourse_reflection',
        applicability: 'one',
        active: [{ surface: 'Portugal', kind: 'place' }, { surface: 'Spain', kind: 'place' }, { surface: 'reunion', kind: 'event_or_topic' }],
        correctedAway: ['Ireland'],
        topic: null,
        speechIncludes: ['Spain'],
        speechExcludes: ['Ireland'],
        durableCommit: false,
      },
    },
  ];
  for (const turn of turns) await runTurn(discourse, session, turn.script, turn.expect);
  const alias = discourse.peekDiscourseMentions().some((mention) => mention.surfaceSpan === 'country' || mention.surfaceSpan === 'that country');
  check('c3 paraphrase stored no alias', !alias, 'alias mention present');
}

async function conversation4() {
  console.log(`\n${BOLD}conversation 4 — discourse is not contact or medical authority${RESET}`);
  const db = await openDb();
  const discourse = new DiscourseContinuityHolder();
  const session = new ConversationSession();
  await runTurn(discourse, session, { text: 'I caught up with Elena yesterday.', mentions: [{ span: 'Elena', kind: 'person' }], marks: 'suppress' }, {
    label: 'c4t1 conversational Elena',
    owner: 'needs_clarification:default',
    applicability: 'zero',
    active: [{ surface: 'Elena', kind: 'person' }],
    topic: 'Elena',
    durableCommit: false,
  });
  await runTurn(discourse, session, { text: 'What about Elena?', marks: 'suppress' }, {
    label: 'c4t2 Elena stays conversational',
    owner: 'discourse_reflection',
    applicability: 'one',
    active: [{ surface: 'Elena', kind: 'person' }],
    topic: 'Elena',
    speechIncludes: ['Elena'],
    durableCommit: false,
  });
  const phone = await processUtterance('What is her phone number?', session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    getMedicationSemanticInterpreterCtx: () => ({ completion: completionFor({ text: 'What is her phone number?', marks: 'suppress' }) }),
  }, null, null, null, null, null, discourse);
  const phoneSpeech = speechOf(phone);
  console.log(`${DIM}c4t3 phone${RESET} owner=${ownerOf(phone)} speech=${phoneSpeech || '(none)'}`);
  noteClunky('c4t3 phone ask', phoneSpeech, ownerOf(phone));
  check('c4t3 phone ask invents no number', !/\d{3}/.test(phoneSpeech) && !/555/.test(phoneSpeech), phoneSpeech);
  check('c4t3 phone ask writes no contact', Number((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n) === 0, 'contact row');
  const med = await processUtterance('What medications does she take?', session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    getMedicationSemanticInterpreterCtx: () => ({ completion: completionFor({ text: 'What medications does she take?', marks: 'suppress' }) }),
  }, null, null, null, null, null, discourse);
  const medSpeech = speechOf(med);
  console.log(`${DIM}c4t4 medical${RESET} owner=${ownerOf(med)} speech=${medSpeech || '(none)'}`);
  noteClunky('c4t4 medical ask', medSpeech, ownerOf(med));
  check('c4t4 medical ask invents no drug', !/lisinopril|metformin|mg/i.test(medSpeech), medSpeech);
  check('c4t4 medical ask writes no medication', Number((db.prepare('SELECT COUNT(*) AS n FROM medications').get() as { n: number }).n) === 0, 'medication row');
  check('c4 Elena mention is not a contact id', discourse.peekDiscourseMentions().every((mention) => !mention.mentionId.startsWith('contact')), 'id collision');
}

export async function runConversationCompositionProofV1Tests() {
  console.log(`\n${BOLD}── Conversation Composition Proof V1 ──${RESET}\n`);
  passed = 0;
  failed = 0;
  failures.length = 0;
  CLUNKY.length = 0;
  await conversation1();
  await conversation2();
  await conversation3();
  await conversation4();
  console.log(`\n${BOLD}clunky flags${RESET}`);
  for (const flag of CLUNKY) console.log(`${DIM}CLUNKY_BUT_CORRECT${RESET}  ${flag}`);
  console.log(`\n${BOLD}Conversation Composition Proof V1: ${passed} passed / ${failed} failed / ${passed + failed} total${RESET}`);
  if (failed > 0) {
    console.log(`${RED}${BOLD}COMPOSITION CONTRACT MISSES${RESET}`);
    for (const failure of failures) console.log(`${RED}  • ${failure}${RESET}`);
  }
  return { passed, failed, total: passed + failed, failures: failures.slice() };
}

const isDirect = process.argv[1]?.includes('conversationCompositionProofV1');
if (isDirect) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  process.chdir(root);
  runConversationCompositionProofV1Tests().then((result) => process.exit(result.failed > 0 ? 1 : 0));
}
