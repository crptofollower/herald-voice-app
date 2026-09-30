// Discourse completions must be one closed proposal. No live model.
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder, TOPIC_EVIDENCE_MAX_CHARS } from '../../src/routing/discourseContinuity.ts';
import { DISCOURSE_APPLICABILITY_CARD_MAX } from '../../src/routing/discourseApplicability.ts';
import {
  DISCOURSE_OUTPUT_MAX_ITEMS,
  DISCOURSE_OUTPUT_SPAN_MAX_CHARS,
} from '../../src/routing/boundedOutputContracts.ts';
import {
  completeBoundedInterpretation,
  parseDiscourseApplicabilityPayload,
  parseDiscourseCorrectionPayload,
  parseDiscourseMentionPayload,
  proposeDiscourseMentions,
} from '../../src/routing/semanticProvider.ts';
import { resetSemanticCompletionLifecycleForTests } from '../../src/utils/semanticCompletionLifecycle.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

const MENTION = '[{"span":"Ireland","kind":"place"}]';
const APPLICABILITY = JSON.stringify({
  utterance_applicable: true,
  reference_attempt: false,
  marks: [{ handle: 'dm1', mark: 'uncertain' }],
});
const CORRECTION = JSON.stringify({
  correction_turn: false,
  target_marks: [],
  replacement_marks: [],
});

export async function runBoundedOutputContractTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  assert('output caps match the existing disclosure and evidence bounds',
    DISCOURSE_OUTPUT_MAX_ITEMS === DISCOURSE_APPLICABILITY_CARD_MAX
    && DISCOURSE_OUTPUT_SPAN_MAX_CHARS === TOPIC_EVIDENCE_MAX_CHARS);

  const mention = parseDiscourseMentionPayload(MENTION);
  assert('mention: one closed proposal is accepted',
    mention?.length === 1 && mention[0]?.span === 'Ireland' && mention[0]?.kind === 'place');
  assert('mention: JSON inside prose is rejected',
    parseDiscourseMentionPayload(`Sure. ${MENTION}`) === null
    && parseDiscourseMentionPayload(`${MENTION} Hope that helps.`) === null);
  assert('mention: a second value is rejected',
    parseDiscourseMentionPayload(`${MENTION}${MENTION}`) === null
    && parseDiscourseMentionPayload(`${MENTION}\n[]`) === null);
  assert('mention: an extra key is rejected',
    parseDiscourseMentionPayload('[{"span":"Ireland","kind":"place","start":0}]') === null);
  assert('mention: a wrong type is rejected',
    parseDiscourseMentionPayload('[{"span":1,"kind":"place"}]') === null);
  assert('mention: too many items are rejected',
    parseDiscourseMentionPayload(JSON.stringify(
      Array.from({ length: DISCOURSE_OUTPUT_MAX_ITEMS + 1 }, () => ({ span: 'Ireland', kind: 'place' })),
    )) === null);
  assert('mention: an over-long span is rejected',
    parseDiscourseMentionPayload(JSON.stringify([
      { span: 'a'.repeat(DISCOURSE_OUTPUT_SPAN_MAX_CHARS + 1), kind: 'place' },
    ])) === null
    && parseDiscourseMentionPayload(JSON.stringify([
      { span: 'a'.repeat(DISCOURSE_OUTPUT_SPAN_MAX_CHARS), kind: 'place' },
    ]))?.length === 1);
  assert('mention: malformed JSON is rejected', parseDiscourseMentionPayload('[') === null);
  assert('mention: a kind outside the closed set is rejected',
    parseDiscourseMentionPayload('[{"span":"roses","kind":"flower"}]') === null);

  const applicability = parseDiscourseApplicabilityPayload(APPLICABILITY);
  assert('applicability: one closed proposal is accepted',
    applicability?.utteranceApplicable === true
    && applicability.referenceAttempt === false
    && applicability.marks.length === 1
    && applicability.marks[0]?.mark === 'uncertain');
  assert('applicability: JSON inside prose is rejected',
    parseDiscourseApplicabilityPayload(`Note: ${APPLICABILITY}`) === null);
  assert('applicability: a second value is rejected',
    parseDiscourseApplicabilityPayload(`${APPLICABILITY}${APPLICABILITY}`) === null);
  assert('applicability: an extra key is rejected',
    parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: true,
      marks: [{ handle: 'dm1', mark: 'compatible' }],
      winner: 'dm1',
    })) === null);
  assert('applicability: a wrong type is rejected',
    parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: 'yes',
      marks: [],
    })) === null);
  assert('applicability: too many marks are rejected',
    parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: true,
      marks: Array.from({ length: DISCOURSE_OUTPUT_MAX_ITEMS + 1 }, (_, i) => ({
        handle: `dm${i}`,
        mark: 'uncertain',
      })),
    })) === null);
  assert('applicability: malformed JSON is rejected',
    parseDiscourseApplicabilityPayload('{') === null);
  assert('applicability: a mark outside the closed set is rejected',
    parseDiscourseApplicabilityPayload(JSON.stringify({
      utterance_applicable: true,
      marks: [{ handle: 'dm1', mark: 'yes' }],
    })) === null);

  const correction = parseDiscourseCorrectionPayload(CORRECTION);
  assert('correction: one closed proposal is accepted',
    correction?.correctionTurn === false
    && correction.targetMarks.length === 0
    && correction.replacementMarks.length === 0);
  assert('correction: JSON inside prose is rejected',
    parseDiscourseCorrectionPayload(`Correction: ${CORRECTION}`) === null);
  assert('correction: a second value is rejected',
    parseDiscourseCorrectionPayload(`${CORRECTION}{}`) === null);
  assert('correction: an extra key is rejected',
    parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      target_marks: [],
      replacement_marks: [],
      winner: 'dm1',
    })) === null);
  assert('correction: a wrong type is rejected',
    parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: 'yes',
      target_marks: [],
      replacement_marks: [],
    })) === null);
  assert('correction: too many marks are rejected',
    parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      target_marks: Array.from({ length: DISCOURSE_OUTPUT_MAX_ITEMS + 1 }, (_, i) => ({
        handle: `dm${i}`,
        mark: 'incompatible',
      })),
      replacement_marks: [],
    })) === null);
  assert('correction: an over-long new span is rejected',
    parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      target_marks: [],
      replacement_marks: [],
      new_spans: [{ span: 'a'.repeat(DISCOURSE_OUTPUT_SPAN_MAX_CHARS + 1), kind: 'place' }],
    })) === null);
  assert('correction: malformed JSON is rejected',
    parseDiscourseCorrectionPayload('not json') === null);
  assert('correction: a span kind outside the closed set is rejected',
    parseDiscourseCorrectionPayload(JSON.stringify({
      correction_turn: true,
      target_marks: [],
      replacement_marks: [],
      new_spans: [{ span: 'roses', kind: 'flower' }],
    })) === null);

  {
    let seen: { response_format?: { type?: string; json_schema?: { strict?: boolean } } } | null = null;
    const ignored = await proposeDiscourseMentions('about his trip to Ireland', {
      completion: async (params: { response_format?: { type?: string; json_schema?: { strict?: boolean } } }) => {
        seen = params;
        return { text: `Sure. ${MENTION}` };
      },
    });
    resetSemanticCompletionLifecycleForTests();
    assert('generation attaches llama.rn json_schema and the parser still rejects ignored prose',
      seen?.response_format?.type === 'json_schema'
      && seen.response_format.json_schema?.strict === true
      && ignored === null);
  }

  {
    let called = false;
    const overridden = await completeBoundedInterpretation('discourse_applicability', {
      completion: async () => {
        called = true;
        return { text: APPLICABILITY };
      },
    }, {
      prompt: 'x',
      n_predict: 8,
      response_format: { type: 'text' },
    });
    assert('a caller-supplied response format does not replace the discourse contract',
      overridden.status === 'unavailable' && called === false);
  }

  {
    let sawFormat = false;
    await completeBoundedInterpretation('recap', {
      completion: async (params: { response_format?: unknown }) => {
        sawFormat = 'response_format' in (params ?? {});
        return { text: '{}' };
      },
    }, { messages: [], n_predict: 8 });
    resetSemanticCompletionLifecycleForTests();
    assert('recap completions do not receive the discourse schema', sawFormat === false);
  }

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const depsBase = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };
  const utterance = 'about his trip to Ireland';

  {
    const discourse = new DiscourseContinuityHolder();
    const wrapped = await processUtterance(
      utterance,
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async () => ({ text: `I found this: ${MENTION}` }),
        }),
      },
      null, null, null, null, null, discourse,
    );
    resetSemanticCompletionLifecycleForTests();
    assert('prose-wrapped mention JSON admits nothing and leaves the miss in place',
      wrapped.handled === false
      && wrapped.routeDecision.kind === 'needs_clarification'
      && wrapped.routeDecision.reason === 'default'
      && discourse.peekDiscourseMentions().length === 0);
  }

  {
    const discourse = new DiscourseContinuityHolder();
    const admitted = await processUtterance(
      utterance,
      new ConversationSession(),
      {
        ...depsBase,
        getMedicationSemanticInterpreterCtx: () => ({
          completion: async () => ({ text: MENTION }),
        }),
      },
      null, null, null, null, null, discourse,
    );
    resetSemanticCompletionLifecycleForTests();
    const ireland = discourse.peekDiscourseMentions().find((item) => item.surfaceSpan === 'Ireland');
    assert('a closed mention proposal still reaches deterministic span admission',
      admitted.handled === false
      && admitted.routeDecision.kind === 'needs_clarification'
      && ireland?.status === 'active'
      && ireland.kind === 'place'
      && ireland.durable === false);
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}BoundedOutputContracts: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('boundedOutputContracts.test');
if (invokedDirectly) {
  runBoundedOutputContractTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
