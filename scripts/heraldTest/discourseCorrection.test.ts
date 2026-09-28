// Conversational discourse correction. Stubbed marks. No live model.
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
  type DiscourseMention,
  type DiscourseMentionProposal,
} from '../../src/routing/discourseContinuity.ts';
import { admitDiscourseApplicability, priorActiveDiscourseCandidates } from '../../src/routing/discourseApplicability.ts';
import {
  DISCOURSE_CORRECTION_PROMPT,
  parseDiscourseCorrectionPayload,
} from '../../src/routing/semanticProvider.ts';
import {
  admitDiscourseCorrection,
  considerCurrentTurnDiscourseCorrection,
} from '../../src/routing/discourseCorrection.ts';
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

function at(text: string, surface: string, kind: DiscourseMentionProposal['kind']): DiscourseMentionProposal {
  const start = text.indexOf(surface);
  return { kind, surfaceSpan: surface, start, end: start + surface.length };
}

function snapshot(mention: DiscourseMention | undefined) {
  if (!mention) return null;
  return {
    surface: mention.surfaceSpan,
    start: mention.start,
    end: mention.end,
    turn: mention.sourceTurnId,
    status: mention.status,
  };
}

function seedEpisode(discourse: DiscourseContinuityHolder) {
  discourse.beginUserTurn();
  const martin = 'Martin called.';
  discourse.admitDiscourseProposals(martin, [at(martin, 'Martin', 'person')]);
  discourse.establishTopic('Martin', martin);
  const line = 'about his trip to Ireland';
  discourse.beginUserTurn();
  discourse.noteNarrativeUtterance(line, [
    at(line, 'trip', 'event_or_topic'),
    at(line, 'Ireland', 'place'),
  ]);
  discourse.beginUserTurn();
}

export async function runDiscourseCorrectionTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    discourse.admitDiscourseProposals('Italy', [at('Italy', 'Italy', 'place')]);
    discourse.beginUserTurn();
    const mentions = discourse.peekDiscourseMentions();
    const ireland = mentions.find((item) => item.surfaceSpan === 'Ireland')!;
    const italy = mentions.find((item) => item.surfaceSpan === 'Italy')!;
    const beforeIds = discourse.peekDiscourseEpisodes()[0]?.memberMentionIds.join(',') ?? '';
    const beforeIreland = snapshot(ireland);
    const decision = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: ireland.mentionId, mark: 'compatible' }],
      replacementMarks: [{ handle: italy.mentionId, mark: 'compatible' }],
      groundedNew: [],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const applied = decision.outcome === 'plan'
      ? discourse.applyDiscourseCorrection({
          targetMentionId: decision.targetMentionId,
          replacement: decision.replacement,
          utterance: 'the other place',
        })
      : { applied: false as const };
    const after = discourse.peekDiscourseMentions();
    const irelandAfter = after.find((item) => item.mentionId === ireland.mentionId);
    const italyAfter = after.find((item) => item.mentionId === italy.mentionId);
    const episode = discourse.peekDiscourseEpisodes().find((item) => item.memberMentionIds.includes(ireland.mentionId));
    assert('one existing replacement commits',
      decision.outcome === 'plan' && applied.applied === true);
    assert('the target becomes corrected_away and the replacement stays active',
      irelandAfter?.status === 'corrected_away' && italyAfter?.status === 'active');
    assert('historical span, offsets, and source turn stay put',
      snapshot(irelandAfter)?.surface === beforeIreland?.surface
      && snapshot(irelandAfter)?.start === beforeIreland?.start
      && snapshot(irelandAfter)?.end === beforeIreland?.end
      && snapshot(irelandAfter)?.turn === beforeIreland?.turn);
    assert('the episode keeps the target and appends the replacement',
      beforeIds.split(',').every((id) => episode?.memberMentionIds.includes(id))
      && episode?.memberMentionIds.includes(italy.mentionId)
      && episode?.memberMentionIds.filter((id) => id === ireland.mentionId).length === 1);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const mentions = discourse.peekDiscourseMentions();
    const ireland = mentions.find((item) => item.surfaceSpan === 'Ireland')!;
    const utterance = 'No, I meant Italy.';
    const decision = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [
        { handle: ireland.mentionId, mark: 'compatible' },
        { handle: mentions.find((item) => item.surfaceSpan === 'Martin')!.mentionId, mark: 'incompatible' },
        { handle: mentions.find((item) => item.surfaceSpan === 'trip')!.mentionId, mark: 'uncertain' },
      ],
      replacementMarks: [],
      groundedNew: [at(utterance, 'Italy', 'place')],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const before = snapshot(discourse.peekDiscourseMentions().find((item) => item.mentionId === ireland.mentionId));
    const applied = decision.outcome === 'plan'
      ? discourse.applyDiscourseCorrection({
          targetMentionId: decision.targetMentionId,
          replacement: decision.replacement,
          utterance,
        })
      : { applied: false as const };
    const afterMentions = discourse.peekDiscourseMentions();
    const italy = afterMentions.find((item) => item.surfaceSpan === 'Italy' && item.kind === 'place');
    const episode = discourse.peekDiscourseEpisodes().find((item) => item.memberMentionIds.includes(ireland.mentionId));
    assert('a newly grounded place replacement commits',
      decision.outcome === 'plan'
      && decision.speech === 'Got it — you meant Italy.'
      && applied.applied === true
      && italy?.status === 'active'
      && italy.durable === false);
    assert('Martin and trip stay active beside the place correction',
      afterMentions.find((item) => item.surfaceSpan === 'Martin')?.status === 'active'
      && afterMentions.find((item) => item.surfaceSpan === 'trip')?.status === 'active'
      && snapshot(afterMentions.find((item) => item.mentionId === ireland.mentionId))?.start === before?.start
      && episode?.memberMentionIds.includes(ireland.mentionId)
      && episode?.memberMentionIds.includes(italy?.mentionId ?? ''));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const mentions = discourse.peekDiscourseMentions();
    const martin = mentions.find((item) => item.surfaceSpan === 'Martin')!;
    const utterance = 'No, Sarah, not Martin.';
    const decision = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: martin.mentionId, mark: 'compatible' }],
      replacementMarks: [],
      groundedNew: [at(utterance, 'Sarah', 'person')],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const applied = decision.outcome === 'plan'
      ? discourse.applyDiscourseCorrection({
          targetMentionId: decision.targetMentionId,
          replacement: decision.replacement,
          utterance,
        })
      : { applied: false as const };
    const after = discourse.peekDiscourseMentions();
    const sarah = after.find((item) => item.surfaceSpan === 'Sarah');
    assert('a deterministic person replacement commits without a contact id',
      decision.outcome === 'plan'
      && decision.speech === 'Got it — Sarah.'
      && applied.applied === true
      && sarah?.kind === 'person'
      && sarah.status === 'active'
      && !sarah.mentionId.startsWith('c_')
      && after.find((item) => item.mentionId === martin.mentionId)?.status === 'corrected_away');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const before = JSON.stringify(discourse.peekDiscourseMentions());
    const mentions = discourse.peekDiscourseMentions();
    const none = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: mentions.map((item) => ({ handle: item.mentionId, mark: 'incompatible' as const })),
      replacementMarks: [],
      groundedNew: [],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const many = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: mentions.filter((item) => item.surfaceSpan !== 'trip').map((item) => ({ handle: item.mentionId, mark: 'compatible' as const })),
      replacementMarks: [],
      groundedNew: [],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const missingReplacement = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: mentions.find((item) => item.surfaceSpan === 'Ireland')!.mentionId, mark: 'compatible' }],
      replacementMarks: [],
      groundedNew: [],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const manyReplacement = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: mentions.find((item) => item.surfaceSpan === 'Ireland')!.mentionId, mark: 'compatible' }],
      replacementMarks: [],
      groundedNew: [
        { kind: 'place', surfaceSpan: 'Italy', start: 0, end: 5 },
        { kind: 'place', surfaceSpan: 'Spain', start: 8, end: 13 },
      ],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    assert('zero targets do not mutate',
      none.outcome === 'no_correction'
      && JSON.stringify(discourse.peekDiscourseMentions()) === before);
    assert('many targets clarify and do not mutate',
      many.outcome === 'clarify_target'
      && JSON.stringify(discourse.peekDiscourseMentions()) === before);
    assert('zero replacements do not mutate',
      missingReplacement.outcome === 'no_correction'
      && JSON.stringify(discourse.peekDiscourseMentions()) === before);
    assert('many replacements clarify and do not mutate',
      manyReplacement.outcome === 'clarify_replacement'
      && JSON.stringify(discourse.peekDiscourseMentions()) === before);
  }

  {
    const winner = parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      selectedIndex: 0,
      replace: 'Ireland',
      target_marks: [{ handle: 'dm1', mark: 'compatible' }],
      replacement_marks: [],
    }));
    const directed = parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      from: 'dm1',
      to: 'dm2',
      replacementId: 'dm2',
      winner: 'dm2',
      target_marks: [],
      replacement_marks: [],
    }));
    const personKind = parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      target_marks: [],
      replacement_marks: [],
      new_spans: [{ span: 'Sarah', kind: 'person' }],
    }));
    assert('winner and replace fields reject the payload, and a person span is legal',
      winner === null && directed === null && personKind?.newSpans[0]?.kind === 'person');
    assert('a malformed correction payload is not a plan',
      parseDiscourseCorrectionPayload('not json') === null
      && parseDiscourseCorrectionPayload('{"correction_turn":true}') === null);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const before = JSON.stringify(discourse.peekDiscourseMentions());
    let turn: Awaited<ReturnType<typeof considerCurrentTurnDiscourseCorrection>> = { kind: 'continue' };
    try {
      turn = await considerCurrentTurnDiscourseCorrection(
        'No, I meant Italy.',
        discourse,
        { completion: () => new Promise(() => {}) },
        { timeoutMs: 30 },
      );
    } finally {
      resetSemanticCompletionLifecycleForTests();
    }
    assert('a correction timeout does not mutate',
      turn.kind === 'continue' && JSON.stringify(discourse.peekDiscourseMentions()) === before);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const line = 'alpha beta gamma delta';
    discourse.admitDiscourseProposals(line, [
      at(line, 'alpha', 'place'),
      at(line, 'beta', 'place'),
      at(line, 'gamma', 'place'),
      at(line, 'delta', 'place'),
    ], 'continue');
    const before = discourse.peekDiscourseMentions().map((item) => `${item.mentionId}:${item.status}`).join(',');
    const utterance = 'No, I meant Italy.';
    const applied = discourse.applyDiscourseCorrection({
      targetMentionId: ireland.mentionId,
      replacement: { source: 'new', proposal: at(utterance, 'Italy', 'place') },
      utterance,
    });
    assert('turn capacity blocks the replacement without a mutation',
      applied.applied === false
      && discourse.peekDiscourseMentions().map((item) => `${item.mentionId}:${item.status}`).join(',') === before
      && !discourse.peekDiscourseMentions().some((item) => item.surfaceSpan === 'Italy'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const host = 'xxItaly';
    discourse.admitDiscourseProposals(host, [at(host, 'xxItaly', 'event_or_topic')], 'continue');
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const before = discourse.peekDiscourseMentions().map((item) => `${item.mentionId}:${item.status}`).join(',');
    const applied = discourse.applyDiscourseCorrection({
      targetMentionId: ireland.mentionId,
      replacement: { source: 'new', proposal: at(host, 'Italy', 'place') },
      utterance: host,
    });
    const statuses = discourse.peekDiscourseMentions().map((item) => item.status);
    assert('an overlap blocks the replacement without superseding',
      applied.applied === false
      && discourse.peekDiscourseMentions().map((item) => `${item.mentionId}:${item.status}`).join(',') === before
      && !statuses.includes('corrected_away'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    discourse.beginUserTurn();
    const host = 'Ireland';
    discourse.admitDiscourseProposals(host, [
      { kind: 'place', surfaceSpan: 'Ire', start: 0, end: 3 },
      { kind: 'place', surfaceSpan: 'Ireland', start: 0, end: 7 },
    ]);
    discourse.beginUserTurn();
    const ire = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ire')!;
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const utterance = 'Use Italy.';
    discourse.applyDiscourseCorrection({
      targetMentionId: ireland.mentionId,
      replacement: { source: 'new', proposal: at(utterance, 'Italy', 'place') },
      utterance,
    });
    const after = discourse.peekDiscourseMentions();
    assert('superseded and corrected_away stay different statuses',
      after.find((item) => item.mentionId === ire.mentionId)?.status === 'superseded'
      && after.find((item) => item.mentionId === ireland.mentionId)?.status === 'corrected_away'
      && ire.status !== 'corrected_away');
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const mentions = discourse.peekDiscourseMentions();
    const ireland = mentions.find((item) => item.surfaceSpan === 'Ireland')!;
    const utterance = 'No, I meant Italy.';
    const decision = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(mentions, discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: ireland.mentionId, mark: 'compatible' }],
      replacementMarks: [],
      groundedNew: [at(utterance, 'Italy', 'place')],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    if (decision.outcome === 'plan') {
      discourse.applyDiscourseCorrection({
        targetMentionId: decision.targetMentionId,
        replacement: decision.replacement,
        utterance,
      });
    }
    discourse.beginUserTurn();
    const prior = priorActiveDiscourseCandidates(
      discourse.peekDiscourseMentions(),
      discourse.peekDiscourseEpisodes(),
      discourse.snapshot().turnIndex,
    );
    const italy = prior.find((item) => item.surfaceSpan === 'Italy');
    const reflected = admitDiscourseApplicability({
      candidates: prior,
      disclosedHandles: prior.map((item) => item.handle),
      marks: [{ handle: italy?.handle ?? '', mark: 'compatible' }],
      utteranceApplicable: true,
      structuralAllowedHandles: null,
      exactHandles: null,
    });
    assert('corrected_away mentions drop out of later applicability',
      !prior.some((item) => item.surfaceSpan === 'Ireland'));
    assert('the active replacement can be applied later',
      reflected.outcome === 'one' && reflected.surfaceSpan === 'Italy');
    assert('correction speech does not claim a saved record',
      decision.outcome === 'plan'
      && decision.speech.startsWith('Got it')
      && !/updated your records|saved that|corrected your profile|changed your contact|updated your memory/i.test(decision.speech)
      && !/traveled_to|friend_of/.test(JSON.stringify(discourse.peekDiscourseEpisodes())));
  }

  const correctionSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseCorrection.ts'), 'utf8');
  const holderSrc = fs.readFileSync(path.join(ROOT, 'src/routing/discourseContinuity.ts'), 'utf8');
  const applySrc = holderSrc.slice(holderSrc.indexOf('applyDiscourseCorrection'));
  assert('correction does not call multi-fact, pending, phone, or record writers',
    !correctionSrc.includes('admitNaturalMultiFactProposal')
    && !correctionSrc.includes('establishInterpretationHold')
    && !correctionSrc.includes('contradictGroupId')
    && !correctionSrc.includes('CORRECTION_MARKER')
    && !correctionSrc.includes('correctable')
    && !correctionSrc.includes('formatPhoneForSpeech')
    && !correctionSrc.includes('getActiveMedication')
    && !correctionSrc.includes('calendar')
    && !applySrc.includes('admitNaturalMultiFactProposal')
    && !correctionSrc.includes('alias'));

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES ('c_sarah', 'Sarah', 'friend', '5550199', 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL)`,
  ).run();
  const depsBase = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };

  {
    const prompts: string[] = [];
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
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
    assert('an owned grocery add does not request correction',
      !prompts.some((prompt) => prompt.startsWith(DISCOURSE_CORRECTION_PROMPT))
      && (added.handled ? added.source : '') !== 'discourse_correction'
      && discourse.peekDiscourseMentions().map((item) => item.mentionId).join(',') === before);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const session = new ConversationSession();
    const martinLine = 'I was talking to my friend Martin yesterday and he was telling me about his new place';
    discourse.beginUserTurn();
    discourse.admitDiscourseProposals(martinLine, [at(martinLine, 'Martin', 'person')]);
    discourse.establishTopic('Martin', martinLine);
    const line = 'about his trip to Ireland';
    discourse.admitDiscourseProposals(line, [
      at(line, 'trip', 'event_or_topic'),
      at(line, 'Ireland', 'place'),
    ], 'continue');
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland')!;
    const martin = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Martin')!;
    const trip = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'trip')!;
    const corrected = await processUtterance(
      'No, I meant Italy.',
      session,
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async (params: { prompt?: string }) => {
            if (typeof params?.prompt === 'string' && params.prompt.startsWith(DISCOURSE_CORRECTION_PROMPT)) {
              return {
                text: JSON.stringify({
                  correction_turn: true,
                  target_marks: [
                    { handle: ireland.mentionId, mark: 'compatible' },
                    { handle: martin.mentionId, mark: 'incompatible' },
                    { handle: trip.mentionId, mark: 'incompatible' },
                  ],
                  replacement_marks: [],
                  new_spans: [{ span: 'Italy', kind: 'place', start: 0, end: 1 }],
                }),
              };
            }
            return { text: '[]' };
          },
        }),
      },
      null, null, null, null, null, discourse,
    );
    const speech = corrected.handled && corrected.source !== 'emergency' ? corrected.responseText : '';
    const act = corrected.handled && corrected.source !== 'emergency' ? corrected.responseAct : undefined;
    const after = discourse.peekDiscourseMentions();
    const placeItaly = after.find((item) => item.surfaceSpan === 'Italy' && item.kind === 'place');
    const episode = discourse.peekDiscourseEpisodes().find((item) => item.memberMentionIds.includes(ireland.mentionId));
    const followed = await processUtterance(
      'Add rye to my grocery list.',
      session,
      depsBase,
      null, null, null, null, null, discourse,
    );
    assert('the live correction acknowledges Italy and does not write records',
      corrected.handled === true
      && corrected.source === 'discourse_correction'
      && act?.kind === 'ACKNOWLEDGE'
      && speech === 'Got it — you meant Italy.'
      && placeItaly?.status === 'active'
      && !after.some((item) => item.kind === 'person' && item.surfaceSpan === 'Italy')
      && discourse.peekTopic()?.displayName === 'Martin'
      && after.find((item) => item.mentionId === ireland.mentionId)?.status === 'corrected_away'
      && episode?.memberMentionIds.includes(ireland.mentionId)
      && episode?.memberMentionIds.includes(placeItaly?.mentionId ?? '')
      && (corrected.handled && corrected.source !== 'emergency' ? corrected.commits.length : 1) === 0
      && getDB().getAllSync<{ name: string }>('SELECT name FROM contacts WHERE removed_at IS NULL').length === 1);
    assert('grocery after correction preserves the corrected discourse',
      followed.handled === true
      && followed.source === 'capture'
      && discourse.peekDiscourseMentions().find((item) => item.mentionId === ireland.mentionId)?.status === 'corrected_away'
      && discourse.peekDiscourseMentions().some((item) => item.kind === 'place' && item.surfaceSpan === 'Italy' && item.status === 'active'));
    assert('same-text Sarah is not created from the contact row',
      !after.some((item) => item.mentionId === 'c_sarah')
      && !speech.includes('5550199'));
    assert('the correction does not mint an alias for the utterance',
      !after.some((item) => item.surfaceSpan === 'meant' || item.surfaceSpan === 'that country'));
  }

  {
    const discourse = new DiscourseContinuityHolder();
    seedEpisode(discourse);
    const mentions = discourse.peekDiscourseMentions();
    const martin = mentions.find((item) => item.surfaceSpan === 'Martin')!;
    const trip = mentions.find((item) => item.surfaceSpan === 'trip')!;
    const voyageLine = 'a voyage';
    discourse.admitDiscourseProposals(voyageLine, [at(voyageLine, 'voyage', 'event_or_topic')]);
    const voyage = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'voyage')!;
    discourse.beginUserTurn();
    const before = JSON.stringify(discourse.peekDiscourseMentions());
    const ambiguous = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(discourse.peekDiscourseMentions(), discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [
        { handle: trip.mentionId, mark: 'compatible' },
        { handle: voyage.mentionId, mark: 'compatible' },
      ],
      replacementMarks: [],
      groundedNew: [],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const plan = admitDiscourseCorrection({
      candidates: priorActiveDiscourseCandidates(discourse.peekDiscourseMentions(), discourse.peekDiscourseEpisodes(), discourse.snapshot().turnIndex),
      targetMarks: [{ handle: martin.mentionId, mark: 'compatible' }],
      replacementMarks: [],
      groundedNew: [{ kind: 'place', surfaceSpan: 'Italy', start: 0, end: 5 }],
      groundingFailed: false,
      admittedThisTurn: 0,
      structuralAllowedHandles: null,
    });
    const refused = plan.outcome === 'plan'
      ? discourse.applyDiscourseCorrection({
          targetMentionId: plan.targetMentionId,
          replacement: plan.replacement,
          utterance: 'xxItaly',
        })
      : { applied: false as const };
    assert('an ambiguous correction and a refused apply leave state untouched',
      ambiguous.outcome === 'clarify_target'
      && plan.outcome === 'plan'
      && refused.applied === false
      && JSON.stringify(discourse.peekDiscourseMentions()) === before);
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}DiscourseCorrection: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('discourseCorrection.test');
if (invokedDirectly) {
  runDiscourseCorrectionTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
