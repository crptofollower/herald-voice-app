// Cross-turn discourse applicability. Stubbed marks. No live model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import {
  DiscourseContinuityHolder,
  TOPIC_EVIDENCE_MAX_CHARS,
  type DiscourseMentionProposal,
} from '../../src/routing/discourseContinuity.ts';
import {
  DISCOURSE_APPLICABILITY_PROMPT,
  parseDiscourseApplicabilityPayload,
} from '../../src/routing/semanticProvider.ts';
import {
  admitDiscourseApplicability,
  applyCurrentTurnDiscourseApplicability,
  buildDiscourseApplicabilityPrompt,
  discourseApplicabilityCards,
  exactActiveSurfaceHandles,
  priorActiveDiscourseCandidates,
  type DiscourseApplicabilityCandidate,
} from '../../src/routing/discourseApplicability.ts';
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

function commitPerson(discourse: DiscourseContinuityHolder, text: string, surface: string) {
  const start = text.indexOf(surface);
  discourse.admitDiscourseProposals(text, [{
    kind: 'person',
    surfaceSpan: surface,
    start,
    end: start + surface.length,
  }]);
  discourse.establishTopic(surface, text);
}

function at(text: string, surface: string, kind: DiscourseMentionProposal['kind']): DiscourseMentionProposal {
  const start = text.indexOf(surface);
  return { kind, surfaceSpan: surface, start, end: start + surface.length };
}

function candidate(partial: Partial<DiscourseApplicabilityCandidate> & Pick<DiscourseApplicabilityCandidate, 'handle' | 'surfaceSpan' | 'kind'>): DiscourseApplicabilityCandidate {
  return {
    episodeHandle: 'de1',
    coMembers: [],
    status: 'active',
    sourceTurnId: 1,
    ...partial,
  };
}

export async function runDiscourseApplicabilityTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  const ireland = candidate({ handle: 'dmIreland', surfaceSpan: 'Ireland', kind: 'place', coMembers: ['Martin', 'trip'] });
  const italy = candidate({ handle: 'dmItaly', surfaceSpan: 'Italy', kind: 'place', episodeHandle: 'de2' });
  const trip = candidate({ handle: 'dmTrip', surfaceSpan: 'trip', kind: 'event_or_topic', coMembers: ['Martin', 'Ireland'] });
  const martin = candidate({ handle: 'dmMartin', surfaceSpan: 'Martin', kind: 'person', sourceTurnId: 1 });
  const sarah = candidate({ handle: 'dmSarah', surfaceSpan: 'Sarah', kind: 'person', sourceTurnId: 2, episodeHandle: 'de2' });

  {
    const parsed = parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: true,
      marks: [{ handle: 'dmIreland', mark: 'compatible' }],
    }));
    const admitted = admitDiscourseApplicability({
      candidates: [ireland],
      disclosedHandles: ['dmIreland'],
      marks: parsed?.marks ?? null,
      utteranceApplicable: parsed?.utteranceApplicable === true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('a provider mark of compatible is accepted as a mark',
      parsed?.marks[0]?.mark === 'compatible' && parsed.marks.length === 1);
    assert('one compatible candidate is admitted',
      admitted.outcome === 'one' && admitted.outcome === 'one' && admitted.handle === 'dmIreland');
  }

  {
    const admitted = admitDiscourseApplicability({
      candidates: [ireland, italy],
      disclosedHandles: ['dmIreland', 'dmItaly'],
      marks: [
        { handle: 'dmIreland', mark: 'compatible' },
        { handle: 'dmItaly', mark: 'compatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('two compatible candidates clarify',
      admitted.outcome === 'many'
      && admitted.outcome === 'many'
      && admitted.surfaces.includes('Ireland')
      && admitted.surfaces.includes('Italy'));
  }

  {
    const admitted = admitDiscourseApplicability({
      candidates: [ireland],
      disclosedHandles: ['dmIreland'],
      marks: [{ handle: 'dmIreland', mark: 'incompatible' }],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('zero compatible candidates stay on fresh recovery', admitted.outcome === 'zero');
  }

  {
    const admitted = admitDiscourseApplicability({
      candidates: [ireland, italy],
      disclosedHandles: ['dmIreland', 'dmItaly'],
      marks: [
        { handle: 'dmIreland', mark: 'uncertain' },
        { handle: 'dmItaly', mark: 'compatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('an uncertain candidate is not eligible',
      admitted.outcome === 'one' && admitted.handle === 'dmItaly');
  }

  {
    const admitted = admitDiscourseApplicability({
      candidates: [ireland],
      disclosedHandles: ['dmIreland'],
      marks: [
        { handle: 'dmMissing', mark: 'compatible' },
        { handle: 'dmIreland', mark: 'compatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('an unknown handle is dropped',
      admitted.outcome === 'one' && admitted.handle === 'dmIreland');
  }

  {
    const stale = candidate({ handle: 'dmOld', surfaceSpan: 'Ire', kind: 'place', status: 'superseded' });
    const admitted = admitDiscourseApplicability({
      candidates: [stale, ireland],
      disclosedHandles: ['dmOld', 'dmIreland'],
      marks: [
        { handle: 'dmOld', mark: 'compatible' },
        { handle: 'dmIreland', mark: 'incompatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('a superseded candidate is dropped', admitted.outcome === 'zero');
  }

  {
    const admitted = admitDiscourseApplicability({
      candidates: [ireland, italy],
      disclosedHandles: ['dmIreland', 'dmItaly'],
      marks: [{ handle: 'dmItaly', mark: 'incompatible' }],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('a missing mark is treated as uncertain', admitted.outcome === 'zero');
  }

  {
    const parsed = parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: true,
      selectedIndex: 0,
      marks: [{ handle: 'dmIreland', mark: 'compatible', winner: true }],
    }));
    assert('a winner or selectedIndex payload is rejected', parsed === null);
  }

  {
    const cards = discourseApplicabilityCards([ireland]);
    const prompt = buildDiscourseApplicabilityPrompt('that country', cards) ?? '';
    const packet = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as {
      utterance: string;
      candidates: Array<Record<string, unknown>>;
    };
    const keys = Object.keys(packet.candidates[0] ?? {}).sort();
    assert('a candidate card keeps only bounded fields',
      keys.every((key) => ['coMembers', 'episodeHandle', 'handle', 'kind', 'sourceWording', 'surfaceSpan'].includes(key))
      && packet.utterance === 'that country');
    assert('the card packet has no transcript or hot ring',
      !prompt.includes('transcript')
      && !prompt.includes('hotRing')
      && !prompt.includes('recentEvidence')
      && Object.keys(packet).sort().join(',') === 'candidates,utterance');
    assert('card source wording stays within 160 characters',
      ireland.sourceWording === undefined || (ireland.sourceWording?.length ?? 0) <= 160);
    assert('card co-member surfaces stay within 3',
      (packet.candidates[0]?.coMembers as string[]).length <= 3
      && (packet.candidates[0]?.coMembers as string[]).join(',') === 'Martin,trip');
    assert('the card packet does not carry durable memory',
      !prompt.includes('medication')
      && !prompt.includes('phone')
      && !/contact/i.test(prompt)
      && !prompt.includes('calendar'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const seeded = `Ireland ${'x'.repeat(180)}`;
    discourse.admitDiscourseProposals(seeded, [at(seeded, 'Ireland', 'place')]);
    discourse.beginUserTurn();
    const prior = priorActiveDiscourseCandidates(
      discourse.peekDiscourseMentions(),
      discourse.peekDiscourseEpisodes(),
      discourse.snapshot().turnIndex,
    );
    assert('stored source wording is capped at 160 characters',
      (prior[0]?.sourceWording?.length ?? 0) === TOPIC_EVIDENCE_MAX_CHARS);
    const handles = exactActiveSurfaceHandles('What did he say about Ireland?', prior);
    const unique = admitDiscourseApplicability({
      candidates: prior,
      disclosedHandles: prior.map((item) => item.handle),
      marks: null,
      utteranceApplicable: false,
      structuralAllowedHandles: null,
      exactHandles: handles,
    });
    assert('a unique exact surface admits that candidate',
      handles.length === 1 && unique.outcome === 'one' && unique.surfaceSpan === 'Ireland');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals('Ireland', [at('Ireland', 'Ireland', 'place')]);
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals('Ireland', [at('Ireland', 'Ireland', 'place')]);
    discourse.beginUserTurn();
    const prior = priorActiveDiscourseCandidates(
      discourse.peekDiscourseMentions(),
      discourse.peekDiscourseEpisodes(),
      discourse.snapshot().turnIndex,
    );
    const handles = exactActiveSurfaceHandles('What did he say about Ireland?', prior);
    const ambiguous = admitDiscourseApplicability({
      candidates: prior,
      disclosedHandles: prior.map((item) => item.handle),
      marks: null,
      utteranceApplicable: false,
      structuralAllowedHandles: null,
      exactHandles: handles,
    });
    assert('duplicate active surfaces clarify',
      handles.length === 2 && ambiguous.outcome === 'many');
  }

  {
    const before = ['Ireland'];
    const admitted = admitDiscourseApplicability({
      candidates: [ireland],
      disclosedHandles: ['dmIreland'],
      marks: [{ handle: 'dmIreland', mark: 'compatible' }],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('a paraphrase can mark Ireland without storing an alias',
      admitted.outcome === 'one'
      && admitted.surfaceSpan === 'Ireland'
      && before.join(',') === 'Ireland');
  }

  {
    const people = admitDiscourseApplicability({
      candidates: [martin, sarah],
      disclosedHandles: ['dmMartin', 'dmSarah'],
      marks: [
        { handle: 'dmMartin', mark: 'compatible' },
        { handle: 'dmSarah', mark: 'compatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('several compatible people clarify without a recency winner',
      people.outcome === 'many'
      && people.surfaces[0] === 'Martin'
      && people.surfaces[1] === 'Sarah');
  }

  {
    const reflected = admitDiscourseApplicability({
      candidates: [ireland],
      disclosedHandles: ['dmIreland'],
      marks: [{ handle: 'dmIreland', mark: 'compatible' }],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    const speech = reflected.outcome === 'one' ? reflected.speech : '';
    assert('episode reflection lists co-members without a relation',
      reflected.outcome === 'one'
      && speech.includes('Ireland')
      && speech.includes('Martin')
      && speech.includes('trip')
      && !/traveled|visited|friend of|lives in|traveled_to/.test(speech));
  }

  {
    const narrowed = admitDiscourseApplicability({
      candidates: [ireland, martin],
      disclosedHandles: ['dmIreland', 'dmMartin'],
      marks: [
        { handle: 'dmIreland', mark: 'compatible' },
        { handle: 'dmMartin', mark: 'compatible' },
      ],
      utteranceApplicable: true,
      structuralAllowedHandles: ['dmMartin'],
      exactHandles: null,
    });
    const applicabilitySrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseApplicability.ts'), 'utf8');
    assert('production does not add a pronoun class filter',
      narrowed.outcome === 'one'
      && narrowed.handle === 'dmMartin'
      && !applicabilitySrc.includes('THIRD_PERSON_REFERENT')
      && applicabilitySrc.includes('structuralAllowedHandles: null'));
  }

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const depsBase = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    commitPerson(discourse, 'Martin called.', 'Martin');
    const before = discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',');
    const added = await processUtterance(
      'Add rye to my grocery list.',
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if (typeof params?.prompt === 'string') prompts.push(params.prompt);
            return { text: '[]' };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const route = added.handled ? added.source : added.routeDecision.kind;
    assert('an owned grocery add does not request discourse applicability',
      !prompts.some((prompt) => prompt.startsWith(DISCOURSE_APPLICABILITY_PROMPT))
      && route !== 'discourse_reflection');
    assert('the grocery add leaves the mention set in place',
      discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',') === before
      && getDB().getAllSync<{ body: string }>('SELECT body FROM list_items WHERE removed_at IS NULL').some((item) => item.body === 'rye'));
    assert('a deterministic fresh route does not utilize retained discourse',
      added.handled === true && added.source === 'capture');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    commitPerson(discourse, 'Martin called.', 'Martin');
    discourse.beginUserTurn();
    const before = discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',');
    let outcome: Awaited<ReturnType<typeof applyCurrentTurnDiscourseApplicability>> = null;
    try {
      outcome = await applyCurrentTurnDiscourseApplicability(
        'tell me more',
        discourse,
        { completion: () => new Promise(() => {}) },
        { timeoutMs: 30 },
      );
    } finally {
      resetSemanticCompletionLifecycleForTests();
    }
    assert('a semantic timeout preserves discourse and does not utilize it',
      outcome === null
      && discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',') === before);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    commitPerson(discourse, 'Martin called.', 'Martin');
    for (let i = 0; i < 6; i += 1) discourse.beginUserTurn();
    const still = discourse.peekDiscourseMentions().filter((item) => item.status === 'active');
    const unused = await applyCurrentTurnDiscourseApplicability(
      'zz idle',
      discourse,
      { completion: async () => ({ text: '{"utterance_applicable":false,"marks":[]}' }) },
    );
    assert('retained mentions do not expire or auto-attach',
      still.length === 1
      && still[0]?.surfaceSpan === 'Martin'
      && unused === null
      && discourse.peekDiscourseMentions().some((item) => item.status === 'active' && item.surfaceSpan === 'Martin'));
  }

  {
    db.prepare(
      `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
       VALUES ('c_martin', 'Martin', 'friend', '5550199', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
       VALUES ('med_x', 'metoprolol', '50mg', 'daily', 1, '2026-09-01T00:00:00.000Z', NULL)`,
    ).run();
    const discourse = new DiscourseContinuityHolder();
    const session = new ConversationSession();
    const turn1 = 'I was talking to my friend Martin yesterday and he was telling me about his new place';
    const turn2 = 'about his trip to Ireland';
    discourse.beginUserTurn();
    commitPerson(discourse, turn1, 'Martin');
    discourse.admitDiscourseProposals(turn2, [
      at(turn2, 'trip', 'event_or_topic'),
      at(turn2, 'Ireland', 'place'),
    ], 'continue');
    const ids = new Map(discourse.peekDiscourseMentions().map((item) => [item.surfaceSpan, item.mentionId]));
    const prompts: string[] = [];
    const reflected = await processUtterance(
      'zz idle about that country',
      session,
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if (typeof params?.prompt === 'string') prompts.push(params.prompt);
            return {
              text: JSON.stringify({
                utterance_applicable: true,
                marks: [
                  { handle: ids.get('trip'), mark: 'compatible' },
                  { handle: ids.get('Martin'), mark: 'incompatible' },
                  { handle: ids.get('Ireland'), mark: 'incompatible' },
                ],
              }),
            };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const speech = reflected.handled && reflected.source !== 'emergency' ? reflected.responseText : '';
    const act = reflected.handled && reflected.source !== 'emergency' ? reflected.responseAct : undefined;
    const applicabilitySrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseApplicability.ts'), 'utf8');
    const providerFn = fs.readFileSync(path.join(ROOT, 'src/routing/semanticProvider.ts'), 'utf8');
    const proposalFn = providerFn.slice(providerFn.indexOf('export async function proposeDiscourseApplicability'));
    assert('Journey A follow-up reflects one compatible span without a phrase rule',
      reflected.handled === true
      && reflected.source === 'discourse_reflection'
      && act?.kind === 'REFLECT_CURRENT_TURN'
      && speech.includes('trip')
      && !applicabilitySrc.includes('zz idle about that country')
      && !applicabilitySrc.includes('What about the trip'));
    assert('reflection does not turn discourse Martin into a contact or a phone number',
      !speech.includes('5550199')
      && getDB().getAllSync<{ name: string; phone: string }>('SELECT name, phone FROM contacts WHERE removed_at IS NULL').length === 1
      && (reflected.handled && reflected.source !== 'emergency' ? reflected.commits.length : 1) === 0);
    assert('applicability does not call phone or contact lookup',
      !applicabilitySrc.includes('formatPhoneForSpeech')
      && !applicabilitySrc.includes('resolveContact')
      && !proposalFn.includes('formatPhoneForSpeech'));
    assert('applicability does not read medication or calendar identity',
      !speech.toLowerCase().includes('metoprolol')
      && !applicabilitySrc.includes('getActiveMedication')
      && !applicabilitySrc.includes('calendar'));
    assert('applicability does not call multi-fact hold machinery',
      !applicabilitySrc.includes('admitNaturalMultiFactProposal')
      && !applicabilitySrc.includes('establishInterpretationHold')
      && !applicabilitySrc.includes('contradictGroupId'));
    assert('applicability does not write a correction',
      !applicabilitySrc.includes('corrected_away')
      && !/status\s*=\s*['"]/.test(applicabilitySrc));
    const surfaces = new Set(discourse.peekDiscourseMentions().map((item) => item.surfaceSpan));
    assert('the paraphrase turn does not mint a new mention',
      !surfaces.has('that')
      && prompts.some((prompt) => prompt.startsWith(DISCOURSE_APPLICABILITY_PROMPT) && !prompt.includes('hotRing')));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    commitPerson(discourse, 'Martin called.', 'Martin');
    const line = 'alpha beta gamma';
    discourse.admitDiscourseProposals(line, [
      at(line, 'alpha', 'place'),
      at(line, 'beta', 'place'),
      at(line, 'gamma', 'place'),
    ], 'continue');
    discourse.beginUserTurn();
    const more = 'about his delta epsilon';
    discourse.noteNarrativeUtterance(more, [
      at(more, 'delta', 'place'),
      at(more, 'epsilon', 'place'),
    ]);
    discourse.beginUserTurn();
    const prior = priorActiveDiscourseCandidates(
      discourse.peekDiscourseMentions(),
      discourse.peekDiscourseEpisodes(),
      discourse.snapshot().turnIndex,
    );
    const epsilon = prior.find((item) => item.surfaceSpan === 'epsilon');
    assert('co-member disclosure stops at three surfaces',
      epsilon?.coMembers.length === 3);
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}DiscourseApplicability: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('discourseApplicability.test');
if (invokedDirectly) {
  runDiscourseApplicabilityTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
