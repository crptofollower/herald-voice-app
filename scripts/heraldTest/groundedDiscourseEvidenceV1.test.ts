// Grounded discourse mentions. Representation only. Not applicability.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  DISCOURSE_EPISODE_MAX,
  DISCOURSE_MENTION_ACTIVE_MAX,
  DISCOURSE_MENTION_PER_TURN_MAX,
  DiscourseContinuityHolder,
  type DiscourseMentionProposal,
} from '../../src/routing/discourseContinuity.ts';

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

function at(text: string, surface: string): DiscourseMentionProposal {
  const start = text.indexOf(surface);
  return { kind: 'place', surfaceSpan: surface, start, end: start + surface.length };
}

export async function runGroundedDiscourseEvidenceV1Tests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'I was talking to my friend Martin yesterday.';
    discourse.beginUserTurn();
    const noted = discourse.noteNarrativeUtterance(text);
    const mention = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Martin');
    const start = text.indexOf('Martin');
    assert('one person mention keeps exact provenance',
      noted.exactlyOneNarrativePerson === 'Martin'
      && mention?.kind === 'person'
      && mention.start === start
      && mention.end === start + 'Martin'.length
      && mention.sourceTurnId === 1
      && mention.sourceUtteranceRef === 'turn:1'
      && mention.epistemic === 'current_conversation'
      && mention.durable === false
      && mention.status === 'active');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Martin and Sarah stopped by.';
    discourse.beginUserTurn();
    const noted = discourse.noteNarrativeUtterance(text);
    const names = discourse.peekDiscourseMentions().filter((item) => item.status === 'active').map((item) => item.surfaceSpan);
    assert('several people in one utterance all stay',
      noted.exactlyOneNarrativePerson === null
      && names.includes('Martin')
      && names.includes('Sarah')
      && discourse.peekTopic() === null);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'about his trip to Ireland';
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance('Martin called.');
    discourse.beginUserTurn();
    const ireland = at(text, 'Ireland');
    ireland.kind = 'place';
    const batch = discourse.noteNarrativeUtterance(text, [ireland]);
    const place = discourse.peekDiscourseMentions().find((item) => item.kind === 'place');
    assert('an exact place span is admitted',
      batch.exactlyOneNarrativePerson === null
      && place?.surfaceSpan === 'Ireland'
      && place.epistemic === 'current_conversation'
      && place.durable === false
      && text.slice(place.start, place.end) === 'Ireland');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'about his trip to Ireland';
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance('Martin called.');
    discourse.beginUserTurn();
    const trip = at(text, 'trip');
    trip.kind = 'event_or_topic';
    discourse.noteNarrativeUtterance(text, [trip]);
    const topic = discourse.peekDiscourseMentions().find((item) => item.kind === 'event_or_topic');
    assert('an exact event span is admitted',
      topic?.surfaceSpan === 'trip'
      && topic.durable === false
      && text.slice(topic.start, topic.end) === 'trip');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const batch = discourse.admitDiscourseProposals('Ireland', [
      { kind: 'place', surfaceSpan: 'Dublin', start: 0, end: 6 },
    ]);
    assert('a span that is not in the source is rejected',
      batch.rejected[0]?.reason === 'span_mismatch'
      && discourse.peekDiscourseMentions().length === 0);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const batch = discourse.admitDiscourseProposals('roses', [
      { kind: 'flower', surfaceSpan: 'roses', start: 0, end: 5 },
    ]);
    assert('a kind outside the closed set is rejected',
      batch.rejected[0]?.reason === 'invalid_kind'
      && discourse.peekDiscourseMentions().length === 0);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Martin called.';
    discourse.beginUserTurn();
    const start = text.indexOf('called');
    const batch = discourse.admitDiscourseProposals(text, [
      { kind: 'person', surfaceSpan: 'called', start, end: start + 'called'.length },
    ]);
    assert('a person proposal the name mechanism does not support is rejected',
      batch.rejected[0]?.reason === 'person_unsupported'
      && discourse.peekDiscourseMentions().every((item) => item.surfaceSpan !== 'called'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Ireland ireland';
    discourse.beginUserTurn();
    const first = at(text, 'Ireland');
    const secondStart = text.indexOf('ireland');
    const batch = discourse.admitDiscourseProposals(text, [
      first,
      { kind: 'place', surfaceSpan: 'ireland', start: secondStart, end: secondStart + 'ireland'.length },
    ]);
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    assert('the same kind and surface in one episode is reused',
      batch.admitted.length === 1
      && batch.reused.length === 1
      && active.length === 1
      && batch.reused[0]?.mentionId === batch.admitted[0]?.mentionId
      && batch.reused[0]?.sourceTurnId === batch.admitted[0]?.sourceTurnId);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Ireland and Dublin';
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(text, [at(text, 'Ireland'), at(text, 'Dublin')]);
    const places = discourse.peekDiscourseMentions().filter((item) => item.kind === 'place').map((item) => item.surfaceSpan);
    assert('distinct surfaces stay distinct',
      places.includes('Ireland') && places.includes('Dublin') && places.length === 2);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Ireland';
    discourse.beginUserTurn();
    const batch = discourse.admitDiscourseProposals(text, [
      { kind: 'place', surfaceSpan: 'Ire', start: 0, end: 3 },
      { kind: 'place', surfaceSpan: 'Ireland', start: 0, end: 7 },
    ]);
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    const prior = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ire');
    assert('a longer same-kind span supersedes the shorter one without rewriting it',
      batch.admitted.some((item) => item.surfaceSpan === 'Ireland')
      && active.length === 1
      && active[0]?.surfaceSpan === 'Ireland'
      && prior?.status === 'superseded'
      && prior.start === 0
      && prior.end === 3);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Ireland';
    discourse.beginUserTurn();
    const batch = discourse.admitDiscourseProposals(text, [
      { kind: 'place', surfaceSpan: 'Ire', start: 0, end: 3 },
      { kind: 'event_or_topic', surfaceSpan: 'relan', start: 1, end: 6 },
    ]);
    const active = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    assert('an ambiguous overlap is rejected',
      batch.rejected.some((item) => item.reason === 'overlap_conflict')
      && active.length === 1
      && active[0]?.surfaceSpan === 'Ire');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'Martin and Sarah stopped by.';
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance(text);
    const episodes = discourse.peekDiscourseEpisodes();
    const members = episodes[0]?.memberMentionIds ?? [];
    assert('mentions from one turn share one episode',
      episodes.length === 1
      && members.length === 2
      && episodes[0]?.sourceTurnIds.length === 1
      && !('relation' in (episodes[0] ?? {}))
      && !('predicate' in (episodes[0] ?? {}))
      && !('role' in (episodes[0] ?? {})));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'abcdefghi jk';
    discourse.beginUserTurn();
    const proposals: DiscourseMentionProposal[] = [];
    for (let i = 0; i < DISCOURSE_MENTION_PER_TURN_MAX + 1; i++) {
      const surface = text[i] ?? 'x';
      proposals.push({ kind: 'place', surfaceSpan: surface, start: i, end: i + 1 });
    }
    const before = discourse.peekDiscourseMentions().map((item) => item.mentionId);
    const batch = discourse.admitDiscourseProposals(text, proposals);
    const after = discourse.peekDiscourseMentions();
    assert('the per-turn admit limit rejects the overflow',
      batch.admitted.length === DISCOURSE_MENTION_PER_TURN_MAX
      && batch.rejected.some((item) => item.reason === 'turn_capacity')
      && after.length === DISCOURSE_MENTION_PER_TURN_MAX
      && before.length === 0);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const fill = (label: string) => {
      discourse.beginUserTurn();
      const text = `${label} w x y z`;
      const proposals = ['w', 'x', 'y', 'z'].map((surface) => {
        const proposal = at(text, surface);
        proposal.kind = 'place';
        return proposal;
      });
      return discourse.admitDiscourseProposals(text, proposals);
    };
    fill('one');
    fill('two');
    const kept = discourse.peekDiscourseMentions().map((item) => item.mentionId);
    discourse.beginUserTurn();
    const overflow = discourse.admitDiscourseProposals('qq', [
      { kind: 'place', surfaceSpan: 'qq', start: 0, end: 2 },
    ]);
    const still = discourse.peekDiscourseMentions().map((item) => item.mentionId);
    assert('the active mention limit does not evict',
      kept.length === DISCOURSE_MENTION_ACTIVE_MAX
      && overflow.rejected[0]?.reason === 'mention_capacity'
      && still.join(',') === kept.join(','));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const names = ['Martin', 'Sarah', 'Helen', 'Chris'];
    for (const name of names) {
      discourse.beginUserTurn();
      discourse.noteNarrativeUtterance(`${name} called.`);
    }
    const kept = discourse.peekDiscourseEpisodes().map((item) => item.episodeId);
    discourse.beginUserTurn();
    const overflow = discourse.noteNarrativeUtterance('Diana called.');
    const still = discourse.peekDiscourseEpisodes().map((item) => item.episodeId);
    const surfaces = discourse.peekDiscourseMentions().map((item) => item.surfaceSpan);
    assert('the episode limit does not evict',
      kept.length === DISCOURSE_EPISODE_MAX
      && overflow.exactlyOneNarrativePerson === null
      && still.join(',') === kept.join(',')
      && !surfaces.includes('Diana'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance('Martin called.');
    discourse.clear();
    assert('session clear drops mentions and episodes',
      discourse.peekDiscourseMentions().length === 0
      && discourse.peekDiscourseEpisodes().length === 0
      && discourse.peekTopic() === null);
  }

  {
    const src = fs.readFileSync(path.join(ROOT, 'src/routing/discourseContinuity.ts'), 'utf8');
    const admit = src.slice(src.indexOf('admitDiscourseProposals('), src.indexOf('noteNarrativeUtterance('));
    assert('admission does not call multi-fact hold machinery',
      !admit.includes('admitNaturalMultiFactProposal')
      && !admit.includes('establishInterpretationHold')
      && !admit.includes('contradictGroupId')
      && !admit.includes('CORRECTION_ACCEPTED'));
    assert('admission does not bind pronouns or paraphrase a span',
      !/\b(him|her|his|there|paraphrase)\b/i.test(admit)
      && !src.includes('peekCurrentPerson')
      && !src.includes('peekCurrentPlace')
      && !src.includes('getLatestPerson')
      && !src.includes('getMostRecentPlace')
      && !src.includes('currentEntity'));
  }

  {
    const db = new Database(':memory:');
    setDB(shim(db));
    await runMigrations();
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance('Martin called.');
    const beforeIds = discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',');
    const beforeItems = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL');
    await processUtterance(
      'Add rye to my grocery list.',
      new ConversationSession(),
      { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const },
      null,
      null,
      null,
      null,
      null,
      discourse,
    );
    const afterItems = getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL');
    assert('a grocery add leaves the mention set in place',
      discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',') === beforeIds
      && afterItems.some((item) => item.body === 'rye')
      && afterItems.length === beforeItems.length + 1);
  }

  {
    const db = new Database(':memory:');
    setDB(shim(db));
    await runMigrations();
    const discourse = new DiscourseContinuityHolder();
    const deps = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };
    const session = new ConversationSession();
    const turn1 = 'I was talking to my friend Martin yesterday and he was telling me about his new place.';
    const turn2 = 'about his trip to Ireland';
    const first = await processUtterance(turn1, session, deps, null, null, null, null, null, discourse);
    const second = await processUtterance(turn2, session, deps, null, null, null, null, null, discourse);
    const structural = new DiscourseContinuityHolder();
    structural.beginUserTurn();
    structural.noteNarrativeUtterance(turn1);
    structural.beginUserTurn();
    const trip = at(turn2, 'trip');
    trip.kind = 'event_or_topic';
    const ireland = at(turn2, 'Ireland');
    ireland.kind = 'place';
    structural.noteNarrativeUtterance(turn2, [trip, ireland]);
    const active = structural.peekDiscourseMentions().filter((item) => item.status === 'active');
    const episode = structural.peekDiscourseEpisodes()[0];
    const serialized = JSON.stringify({ mentions: active, episode });
    assert('turn two can hold Martin, trip, and Ireland as membership only',
      active.some((item) => item.kind === 'person' && item.surfaceSpan === 'Martin' && item.durable === false)
      && active.some((item) => item.kind === 'event_or_topic' && item.surfaceSpan === 'trip')
      && active.some((item) => item.kind === 'place' && item.surfaceSpan === 'Ireland')
      && episode?.memberMentionIds.length === 3
      && !/traveled_to|friend_of|visited|lives_in/.test(serialized));
    const secondRoute = second.handled ? null : second.routeDecision;
    assert('the live path does not answer Journey A from this representation',
      first.handled === false
      && second.handled === false
      && secondRoute?.kind === 'needs_clarification'
      && secondRoute.reason === 'default'
      && !discourse.peekDiscourseMentions().some((item) => item.kind === 'place'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const text = 'On the drive home I want to pick up roses for my wife. Our anniversary is June 12.';
    discourse.beginUserTurn();
    discourse.noteNarrativeUtterance(text);
    const kinds = new Set(discourse.peekDiscourseMentions().map((item) => item.kind));
    assert('Journey B wording does not gain a discourse kind', kinds.size === 0);
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}GroundedDiscourseEvidenceV1: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('groundedDiscourseEvidenceV1.test');
if (invokedDirectly) {
  runGroundedDiscourseEvidenceV1Tests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
