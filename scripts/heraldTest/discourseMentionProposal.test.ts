// Current-turn discourse mention proposals. Representation only.
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
  DISCOURSE_MENTION_PROPOSAL_PROMPT,
  parseDiscourseMentionPayload,
} from '../../src/routing/semanticProvider.ts';
import {
  groundExactDiscourseSpans,
  populateCurrentTurnDiscourseMentions,
} from '../../src/routing/discourseMentionProposal.ts';
import { resetSemanticCompletionLifecycleForTests } from '../../src/utils/semanticCompletionLifecycle.ts';

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

function ctxReturning(text: string, prompts: string[]) {
  return {
    completion: async (params: { prompt?: string }) => {
      if (typeof params?.prompt === 'string') prompts.push(params.prompt);
      return { text };
    },
  };
}

export async function runDiscourseMentionProposalTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const depsBase = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(
      'zz idle',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: () => ctxReturning('[]', prompts) },
      null, null, null, null, null, discourse,
    );
    assert('a default miss with semantic context requests discourse spans',
      prompts.length === 1
      && prompts[0]?.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)
      && prompts[0]?.endsWith('zz idle'));
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    const before = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL').length;
    await processUtterance(
      'Add rye to my grocery list.',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: () => ctxReturning('[]', prompts) },
      null, null, null, null, null, discourse,
    );
    const after = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL');
    assert('a successful grocery capture does not request discourse spans',
      prompts.length === 0
      && after.some((item) => item.body === 'rye')
      && after.length === before + 1);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    await processUtterance(
      'zz idle',
      new ConversationSession(),
      { ...depsBase, getMedicationSemanticInterpreterCtx: () => null },
      null, null, null, null, null, discourse,
    );
    assert('missing semantic context does not admit a mention',
      discourse.peekDiscourseMentions().length === 0);
  }

  {
    const text = 'about his trip to Ireland';
    const grounded = groundExactDiscourseSpans(text, [
      { span: 'Ireland', kind: 'place', start: 0, end: 1 } as { span: string; kind: string },
    ]);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(text, grounded.ready);
    const place = discourse.peekDiscourseMentions().find((item) => item.kind === 'place');
    assert('Ireland is admitted from its exact span, not a supplied offset',
      grounded.ready[0]?.start === text.indexOf('Ireland')
      && grounded.ready[0]?.start !== 0
      && place?.surfaceSpan === 'Ireland'
      && place.durable === false
      && place.epistemic === 'current_conversation'
      && text.slice(place.start, place.end) === 'Ireland');
  }

  {
    const text = 'about his trip to Ireland';
    const grounded = groundExactDiscourseSpans(text, [{ span: 'trip', kind: 'event_or_topic' }]);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(text, grounded.ready);
    const topic = discourse.peekDiscourseMentions().find((item) => item.kind === 'event_or_topic');
    assert('trip is admitted as an event span',
      topic?.surfaceSpan === 'trip'
      && topic.start === text.indexOf('trip')
      && text.slice(topic.start, topic.end) === 'trip');
  }

  {
    const text = 'about his trip to Ireland';
    const grounded = groundExactDiscourseSpans(text, [
      { span: 'trip', kind: 'event_or_topic' },
      { span: 'Ireland', kind: 'place' },
    ]);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(text, grounded.ready);
    const episode = discourse.peekDiscourseEpisodes()[0];
    assert('two spans from one turn share one episode',
      grounded.ready.length === 2
      && discourse.peekDiscourseEpisodes().length === 1
      && episode?.memberMentionIds.length === 2);
  }

  {
    const text = 'about his trip to Ireland';
    const grounded = groundExactDiscourseSpans(text, [{ span: 'Ireland', kind: 'person' }]);
    assert('a person kind is rejected',
      grounded.ready.length === 0
      && grounded.rejected[0]?.reason === 'invalid_kind');
  }

  {
    const grounded = groundExactDiscourseSpans('roses', [{ span: 'roses', kind: 'flower' }]);
    assert('an unknown kind is rejected',
      grounded.ready.length === 0 && grounded.rejected[0]?.reason === 'invalid_kind');
  }

  {
    const grounded = groundExactDiscourseSpans('about his trip', [{ span: 'Ireland', kind: 'place' }]);
    assert('a span missing from the utterance is rejected',
      grounded.ready.length === 0 && grounded.rejected[0]?.reason === 'absent');
  }

  {
    const grounded = groundExactDiscourseSpans('Ireland and Ireland', [{ span: 'Ireland', kind: 'place' }]);
    assert('a span that occurs twice is rejected as ambiguous',
      grounded.ready.length === 0 && grounded.rejected[0]?.reason === 'ambiguous');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance('Martin called.');
    const before = discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',');
    await populateCurrentTurnDiscourseMentions(
      'about his trip to Ireland',
      { completion: async () => ({ text: 'not json' }) },
      discourse,
    );
    assert('malformed model output admits nothing',
      discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',') === before);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    try {
      await populateCurrentTurnDiscourseMentions(
        'about his trip to Ireland',
        { completion: () => new Promise(() => {}) },
        discourse,
        { timeoutMs: 30 },
      );
    } finally {
      resetSemanticCompletionLifecycleForTests();
    }
    assert('a semantic timeout admits nothing', discourse.peekDiscourseMentions().length === 0);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const text = 'abcdefghi';
    const items = ['a', 'b', 'c', 'd', 'e'].map((span) => ({ span, kind: 'place' }));
    await populateCurrentTurnDiscourseMentions(
      text,
      { completion: async () => ({ text: JSON.stringify(items) }) },
      discourse,
    );
    assert('the per-turn mention limit still rejects overflow',
      discourse.peekDiscourseMentions().filter((item) => item.status === 'active').length === 4);
  }

  {
    const text = 'Ireland';
    const grounded = groundExactDiscourseSpans(text, [
      { span: 'Ire', kind: 'place' },
      { span: 'relan', kind: 'event_or_topic' },
    ]);
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const batch = discourse.admitDiscourseProposals(text, grounded.ready);
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    assert('conflicting overlap is still rejected',
      batch.rejected.some((item) => item.reason === 'overlap_conflict')
      && active.length === 1
      && active[0]?.surfaceSpan === 'Ire');
  }

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    const session = new ConversationSession();
    const deps = {
      ...depsBase,
      getMedicationSemanticInterpreterCtx: () => ({
        completion: async (params: { prompt?: string }) => {
          if (typeof params?.prompt === 'string') prompts.push(params.prompt);
          return { text: JSON.stringify([
            { span: 'trip', kind: 'event_or_topic', start: 0, end: 1 },
            { span: 'Ireland', kind: 'place', start: 99, end: 100 },
          ]) };
        },
      }),
    };
    const turn1 = 'I was talking to my friend Martin yesterday and he was telling me about his new place';
    const turn2 = 'about his trip to Ireland';
    const first = await processUtterance(turn1, session, deps, null, null, null, null, null, discourse);
    const second = await processUtterance(turn2, session, deps, null, null, null, null, null, discourse);
    const turn2Prompt = prompts.find((prompt) => prompt.endsWith(turn2)) ?? '';
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    const ireland = active.find((item) => item.surfaceSpan === 'Ireland');
    const trip = active.find((item) => item.surfaceSpan === 'trip');
    const episodeIds = new Set(discourse.peekDiscourseEpisodes().flatMap((episode) => (
      episode.memberMentionIds.some((id) => id === ireland?.mentionId) ? [episode.episodeId] : []
    )));
    assert('the turn-2 prompt contains only that utterance',
      turn2Prompt.startsWith(DISCOURSE_MENTION_PROPOSAL_PROMPT)
      && turn2Prompt.endsWith(turn2)
      && !turn2Prompt.includes('Martin')
      && !turn2Prompt.includes('new place'));
    assert('turn 2 stores trip and Ireland without trusting model offsets',
      trip?.kind === 'event_or_topic'
      && ireland?.kind === 'place'
      && ireland.start === turn2.indexOf('Ireland')
      && ireland.start !== 99
      && ireland.durable === false
      && trip.durable === false
      && episodeIds.size === 1);
    const secondRoute = second.handled ? null : second.routeDecision;
    assert('admitting the spans does not answer the turn',
      first.handled === false
      && second.handled === false
      && secondRoute?.kind === 'needs_clarification'
      && secondRoute.reason === 'default'
      && (second.commits ?? []).length === 0
      && !/traveled_to|friend_of/.test(JSON.stringify(discourse.peekDiscourseEpisodes())));
    const items = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL');
    const contacts = getDB().getAllSync<{ name: string }>('SELECT name FROM contacts WHERE removed_at IS NULL');
    assert('the miss does not write personal records',
      !items.some((item) => item.body === 'Ireland')
      && !contacts.some((contact) => contact.name === 'Martin' || contact.name === 'Ireland'));
  }

  {
    assert('the payload parser keeps span and kind and drops offsets',
      JSON.stringify(parseDiscourseMentionPayload('[{"span":"Ireland","kind":"place","start":3,"end":9}]'))
        === JSON.stringify([{ span: 'Ireland', kind: 'place' }])
      && parseDiscourseMentionPayload('not json') === null);
  }

  {
    const proposalSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseMentionProposal.ts'), 'utf8');
    const providerSrc = fs.readFileSync(path.join(ROOT, 'src/routing/semanticProvider.ts'), 'utf8');
    const fn = providerSrc.slice(providerSrc.indexOf('export async function proposeDiscourseMentions'));
    assert('span grounding does not use the fuzzy span locator',
      !proposalSrc.includes('findStandardSpan')
      && !fn.includes('findStandardSpan'));
    assert('the proposal path does not call multi-fact hold machinery',
      !proposalSrc.includes('admitNaturalMultiFactProposal')
      && !proposalSrc.includes('establishInterpretationHold')
      && !proposalSrc.includes('contradictGroupId')
      && !fn.includes('admitNaturalMultiFactProposal')
      && !fn.includes('establishInterpretationHold'));
  }

  {
    const grounded = groundExactDiscourseSpans(
      'On the drive home I want to pick up roses for my wife. Our anniversary is June 12.',
      [{ span: 'June 12', kind: 'temporal' }, { span: 'roses', kind: 'flower' }],
    );
    assert('Journey B kinds stay outside this proposal schema',
      grounded.ready.length === 0
      && grounded.rejected.every((item) => item.reason === 'invalid_kind'));
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}DiscourseMentionProposal: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('discourseMentionProposal.test');
if (invokedDirectly) {
  runDiscourseMentionProposalTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
