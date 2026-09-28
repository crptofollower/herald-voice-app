// Grounded person admission. Semantic kind plus exact span plus syntax fence.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import {
  DISCOURSE_CORRECTION_PROMPT,
  DISCOURSE_MENTION_PROPOSAL_PROMPT,
} from '../../src/routing/semanticProvider.ts';
import { acceptDiscourseSpanProposals } from '../../src/routing/discourseMentionProposal.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function personCtx(spans: Array<{ span: string; kind: string }>, prompts: string[]) {
  return () => ({
    completion: async (params: { prompt?: string }) => {
      const prompt = params.prompt ?? '';
      prompts.push(prompt);
      if (prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)) {
        return { text: JSON.stringify({ correction_turn: false, target_marks: [], replacement_marks: [] }) };
      }
      if (prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)) {
        return { text: JSON.stringify(spans) };
      }
      return { text: '[]' };
    },
  });
}

export async function runGroundedPersonAdmissionTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES ('c_sarah', 'Sarah', 'friend', '5550199', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL)`,
  ).run();
  const depsBase = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };

  function seedIreland(discourse: DiscourseContinuityHolder) {
    const martinLine = 'I was talking to my friend Martin yesterday and he was telling me about his new place';
    discourse.beginUserTurn();
    const martinStart = martinLine.indexOf('Martin');
    discourse.admitDiscourseProposals(martinLine, [{
      kind: 'person', surfaceSpan: 'Martin', start: martinStart, end: martinStart + 'Martin'.length,
    }]);
    discourse.establishTopic('Martin', martinLine);
    const line = 'about his trip to Ireland';
    discourse.admitDiscourseProposals(line, [
      { kind: 'event_or_topic', surfaceSpan: 'trip', start: line.indexOf('trip'), end: line.indexOf('trip') + 4 },
      { kind: 'place', surfaceSpan: 'Ireland', start: line.indexOf('Ireland'), end: line.indexOf('Ireland') + 7 },
    ], 'continue');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedIreland(discourse);
    const mentions = discourse.peekDiscourseMentions();
    const ireland = mentions.find((item) => item.surfaceSpan === 'Ireland')!;
    const martin = mentions.find((item) => item.surfaceSpan === 'Martin')!;
    const trip = mentions.find((item) => item.surfaceSpan === 'trip')!;
    const corrected = await processUtterance(
      'No, I meant Italy.',
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if ((params.prompt ?? '').startsWith(DISCOURSE_CORRECTION_PROMPT)) {
              return {
                text: JSON.stringify({
                  correction_turn: true,
                  target_marks: [
                    { handle: ireland.mentionId, mark: 'compatible' },
                    { handle: martin.mentionId, mark: 'incompatible' },
                    { handle: trip.mentionId, mark: 'incompatible' },
                  ],
                  replacement_marks: [],
                  new_spans: [{ span: 'Italy', kind: 'place' }],
                }),
              };
            }
            return { text: '[]' };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const after = discourse.peekDiscourseMentions();
    const italy = after.filter((item) => item.surfaceSpan === 'Italy');
    assert('Italy place correction leaves one place and no person',
      corrected.handled === true
      && corrected.source === 'discourse_correction'
      && after.find((item) => item.mentionId === ireland.mentionId)?.status === 'corrected_away'
      && italy.length === 1
      && italy[0]?.kind === 'place'
      && italy[0]?.status === 'active'
      && italy[0]?.durable === false
      && after.find((item) => item.mentionId === martin.mentionId)?.status === 'active'
      && after.find((item) => item.mentionId === trip.mentionId)?.status === 'active'
      && discourse.peekTopic()?.displayName === 'Martin');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedIreland(discourse);
    const before = discourse.peekDiscourseMentions().map((item) => `${item.mentionId}:${item.status}`).join(',');
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const martin = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Martin')!;
    const trip = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'trip')!;
    await processUtterance(
      'No, I meant Italy.',
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if ((params.prompt ?? '').startsWith(DISCOURSE_CORRECTION_PROMPT)) {
              return {
                text: JSON.stringify({
                  correction_turn: true,
                  target_marks: [
                    { handle: ireland.mentionId, mark: 'compatible' },
                    { handle: martin.mentionId, mark: 'incompatible' },
                    { handle: trip.mentionId, mark: 'incompatible' },
                  ],
                  replacement_marks: [],
                  new_spans: [
                    { span: 'Italy', kind: 'person' },
                    { span: 'Italy', kind: 'place' },
                  ],
                }),
              };
            }
            return { text: '[]' };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const after = discourse.peekDiscourseMentions();
    assert('conflicting Italy kinds admit neither and leave Ireland active',
      !after.some((item) => item.surfaceSpan === 'Italy')
      && after.find((item) => item.mentionId === ireland.mentionId)?.status === 'active'
      && after.map((item) => `${item.mentionId}:${item.status}`).join(',') === before
      && discourse.peekTopic()?.displayName === 'Martin');
  }

  {
    const utterance = 'No, I meant Italy.';
    const accepted = acceptDiscourseSpanProposals(utterance, [
      { span: 'Italy', kind: 'person' },
      { span: 'Italy', kind: 'place' },
    ]);
    assert('exact-span kind conflict drops the whole group',
      accepted.ready.length === 0
      && accepted.rejected.filter((item) => item.reason === 'cross_kind').length === 2);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedIreland(discourse);
    const martin = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Martin')!;
    const corrected = await processUtterance(
      'No, Sarah, not Martin.',
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if ((params.prompt ?? '').startsWith(DISCOURSE_CORRECTION_PROMPT)) {
              return {
                text: JSON.stringify({
                  correction_turn: true,
                  target_marks: [{ handle: martin.mentionId, mark: 'compatible' }],
                  replacement_marks: [],
                  new_spans: [{ span: 'Sarah', kind: 'person' }],
                }),
              };
            }
            return { text: '[]' };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const sarah = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Sarah');
    const contacts = getDB().getAllSync<{ id: string }>('SELECT id FROM contacts WHERE removed_at IS NULL');
    assert('Sarah is a current-conversation person replacement',
      corrected.handled === true
      && corrected.source === 'discourse_correction'
      && sarah?.kind === 'person'
      && sarah.status === 'active'
      && sarah.durable === false
      && sarah.epistemic === 'current_conversation'
      && sarah.mentionId !== 'c_sarah'
      && discourse.peekDiscourseMentions().find((item) => item.mentionId === martin.mentionId)?.status === 'corrected_away'
      && discourse.peekTopic()?.displayName === 'Sarah'
      && contacts.length === 1
      && (corrected.handled && corrected.source !== 'emergency' ? corrected.commits.length : 1) === 0);
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    const uttered = await processUtterance(
      'Sarah stopped by.',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: personCtx([{ span: 'Sarah', kind: 'person' }], prompts) },
      null, null, null, null, null, discourse,
    );
    const sarah = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Sarah');
    assert('a default miss admits one typed person and sets the topic',
      uttered.handled === false
      && sarah?.kind === 'person'
      && sarah.durable === false
      && sarah.status === 'active'
      && discourse.peekDiscourseMentions().filter((item) => item.kind === 'person').length === 1
      && discourse.peekTopic()?.displayName === 'Sarah'
      && prompts.some((prompt) => prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)));
  }

  {
    const monday = acceptDiscourseSpanProposals('Monday', [{ span: 'Monday', kind: 'person' }]);
    const no = acceptDiscourseSpanProposals('No, I meant Italy.', [{ span: 'No', kind: 'person' }]);
    assert('Monday and No fail the existing person syntax fence',
      monday.ready.length === 0
      && monday.rejected[0]?.reason === 'person_unsupported'
      && no.ready.length === 0
      && no.rejected[0]?.reason === 'person_unsupported');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(
      'Sarah stopped by.',
      new ConversationSession(),
      depsBase,
      null, null, null, null, null, discourse,
    );
    assert('missing semantic context admits no person and does not move the topic',
      discourse.peekDiscourseMentions().length === 0
      && discourse.peekTopic() === null);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const line = 'Martin called.';
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(line, [{
      kind: 'person', surfaceSpan: 'Martin', start: 0, end: 'Martin'.length,
    }]);
    discourse.establishTopic('Martin', line);
    await processUtterance(
      'how is he doing today',
      new ConversationSession(),
      depsBase,
      null, null, null, null, null, discourse,
    );
    const topic = discourse.peekTopic();
    assert('an established person topic still refreshes without semantic context',
      topic?.displayName === 'Martin'
      && topic.refreshedAtTurn === discourse.snapshot().turnIndex
      && discourse.peekDiscourseMentions().filter((item) => item.kind === 'person').length === 1);
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.establishTopic('Martin', 'Martin called.');
    const added = await processUtterance(
      'Add rye for Martin to my grocery list.',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: personCtx([{ span: 'Martin', kind: 'person' }], prompts) },
      null, null, null, null, null, discourse,
    );
    assert('a grocery add does not type or commit a title-case person',
      added.handled === true
      && added.source === 'capture'
      && discourse.peekDiscourseMentions().length === 0
      && discourse.peekTopic()?.displayName === 'Martin'
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT))
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)));
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    const added = await processUtterance(
      'add buy stamps to my todo list',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: personCtx([], prompts) },
      null, null, null, null, null, discourse,
    );
    assert('a todo add does not call discourse typing',
      added.handled === true
      && added.source === 'capture'
      && discourse.peekDiscourseMentions().length === 0
      && discourse.peekTopic() === null
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT))
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)));
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    const timed = await processUtterance(
      'what time is it',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: personCtx([], prompts) },
      null, null, null, null, null, discourse,
    );
    const route = timed.handled ? timed.source : timed.routeDecision.kind;
    assert('a device time read does not call discourse typing',
      route !== 'discourse_correction'
      && route !== 'discourse_reflection'
      && discourse.peekDiscourseMentions().length === 0
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT))
      && !prompts.some((prompt) => prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)));
  }

  {
    const text = 'Sarah went to Ireland';
    const accepted = acceptDiscourseSpanProposals(text, [
      { span: 'Sarah', kind: 'person' },
      { span: 'Ireland', kind: 'place' },
    ]);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(text, accepted.ready);
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    assert('different spans in one payload both admit',
      accepted.ready.length === 2
      && active.some((item) => item.kind === 'person' && item.surfaceSpan === 'Sarah')
      && active.some((item) => item.kind === 'place' && item.surfaceSpan === 'Ireland'));
  }

  {
    const text = 'about his trip to Ireland';
    const accepted = acceptDiscourseSpanProposals(text, [
      { span: 'trip', kind: 'event_or_topic' },
      { span: 'Ireland', kind: 'place' },
    ]);
    assert('place and event spans still ground unchanged',
      accepted.ready.length === 2
      && accepted.rejected.length === 0
      && accepted.ready.some((item) => item.kind === 'event_or_topic' && item.surfaceSpan === 'trip')
      && accepted.ready.some((item) => item.kind === 'place' && item.surfaceSpan === 'Ireland'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedIreland(discourse);
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const before = JSON.stringify(discourse.peekDiscourseMentions());
    await processUtterance(
      'No, I meant Italy.',
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async () => ({
            text: JSON.stringify({
              correction_turn: true,
              target_marks: [{ handle: ireland.mentionId, mark: 'compatible' }],
              replacement_marks: [],
              new_spans: [{ span: 'Italy', kind: 'place' }, { span: 'Italy', kind: 'person' }],
            }),
          }),
        }),
      },
      null, null, null, null, null, discourse,
    );
    assert('a cross-kind correction writes nothing',
      JSON.stringify(discourse.peekDiscourseMentions()) === before);
  }

  const mentionSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseMentionProposal.ts'), 'utf8');
  const correctionSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseCorrection.ts'), 'utf8');
  const holderSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseContinuity.ts'), 'utf8');
  const noteSrc = holderSrc.slice(holderSrc.indexOf('noteNarrativeUtterance('));
  assert('person admission does not look up contacts, phones, or the network',
    !mentionSrc.includes('resolveContact')
    && !mentionSrc.includes('formatPhoneForSpeech')
    && !mentionSrc.includes('fetch(')
    && !correctionSrc.includes('resolveContact')
    && !correctionSrc.includes('formatPhoneForSpeech')
    && !correctionSrc.includes('correctionPersonProposals')
    && !noteSrc.includes("kind: 'person'"));
  assert('person admission does not call multi-fact hold machinery or durable promotion',
    !mentionSrc.includes('admitNaturalMultiFactProposal')
    && !correctionSrc.includes('admitNaturalMultiFactProposal')
    && !mentionSrc.includes('durable: true')
    && !holderSrc.includes("durable: true"));

  const total = passed + failures.length;
  console.log(`\n${BOLD}GroundedPersonAdmission: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('groundedPersonAdmission.test');
if (invokedDirectly) {
  runGroundedPersonAdmissionTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
