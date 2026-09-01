// scripts/heraldTest/listRemoveInterpretationShadow.test.ts
// list_remove interpretation shadow: exact grounding + authority gates.
// Qwen output is not ground truth. No writer/pending dependency.

import { computeShadowAuthority, fuzzyLikeCandidates, groundExactReferent, normalizeShadowReferent, parseSemanticProposal, runListRemoveInterpretationShadow, SHADOW_LOG_PREFIX, type SemanticProposal } from '../../src/dev/listRemoveInterpretationShadow.ts';
import { LIST_REMOVE_SHADOW_CORPUS } from '../../src/dev/listRemoveInterpretationShadowCorpus.ts';
import { LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED } from '../../src/constants/features.ts';
import fs from 'node:fs';
import path from 'node:path';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function directiveEggs(overrides: Partial<SemanticProposal> = {}): SemanticProposal {
  return {
    speech_act: 'directive',
    polarity: 'affirmative',
    tense_aspect: 'present',
    candidate: 'list_remove',
    op: 'list_remove',
    referents: [{ surface: 'eggs' }],
    linguistically_incomplete: false,
    confidence: 0.4,
    ...overrides,
  };
}

export async function runListRemoveInterpretationShadowTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- List-Remove Interpretation Shadow --------------------${RESET}`);

  const eggsRow = { id: 'li_eggs', body: 'eggs' };
  const snap = [eggsRow];

  assert(
    'normalize NFKC/trim/lower',
    normalizeShadowReferent('  Eggs   '),
    (v) => v === 'eggs',
    'eggs',
  );
  assert(
    'normalize collapses interior whitespace',
    normalizeShadowReferent('eggs   carton'),
    (v) => v === 'eggs carton',
    'eggs carton',
  );

  {
    const g = groundExactReferent('eggs', snap);
    assert('exact eggs → one durable id', g, (v) => {
      const x = v as { kind?: string; id?: string };
      return x.kind === 'exact_one' && x.id === 'li_eggs';
    }, 'exact_one li_eggs');
  }
  {
    const g = groundExactReferent('egg', snap);
    assert('no plural folding: egg ≠ eggs', g, (v) => (v as { kind?: string }).kind === 'none', 'none');
  }
  {
    const g = groundExactReferent('the eggs', snap);
    assert('no article stripping: the eggs ≠ eggs', g, (v) => (v as { kind?: string }).kind === 'none', 'none');
  }
  {
    const fuzzy = fuzzyLikeCandidates('egg', snap);
    const auth = computeShadowAuthority({ proposal: directiveEggs({ referents: [{ surface: 'egg' }] }), snapshot: snap });
    assert('fuzzy LIKE candidates may exist', fuzzy.length > 0, (v) => v === true, 'fuzzy nonempty');
    assert('fuzzy cannot authorize', auth.authorized, (v) => v === false, 'false');
    assert('egg vs eggs is clarify_ungrounded', auth.decision, (v) => v === 'clarify_ungrounded', 'clarify_ungrounded');
  }

  {
    const auth = computeShadowAuthority({
      proposal: {
        ...directiveEggs(),
        speech_act: 'narrative',
        confidence: 1,
      },
      snapshot: snap,
    });
    assert('narrative + grounded eggs cannot authorize', auth.authorized, (v) => v === false, 'false');
    assert('narrative fail_gate not_directive', auth.fail_gate, (v) => v === 'not_directive', 'not_directive');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ polarity: 'negated', confidence: 1 }),
      snapshot: snap,
    });
    assert('negation cannot authorize', auth.authorized, (v) => v === false, 'false');
    assert('negation decision reject', auth.decision, (v) => v === 'reject', 'reject');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ tense_aspect: 'prospective' }),
      snapshot: snap,
    });
    assert('prospective cannot authorize', auth.authorized, (v) => v === false, 'false');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ linguistically_incomplete: true }),
      snapshot: snap,
    });
    assert('incomplete cannot authorize', auth.authorized, (v) => v === false, 'false');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ referents: [{ surface: 'milk' }] }),
      snapshot: snap,
    });
    assert('absent item cannot authorize', auth.authorized, (v) => v === false, 'false');
    assert('absent item clarify_ungrounded', auth.decision, (v) => v === 'clarify_ungrounded', 'clarify_ungrounded');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ referents: [{ surface: 'eggs' }, { surface: 'milk' }] }),
      snapshot: snap,
    });
    assert('multiple referents unsupported', auth.decision, (v) => v === 'unsupported_multi_referent', 'unsupported_multi_referent');
    assert('multiple referents not authorized', auth.authorized, (v) => v === false, 'false');
  }
  {
    const auth = computeShadowAuthority({
      proposal: directiveEggs({ speech_act: 'narrative', confidence: 1 }),
      snapshot: snap,
    });
    assert('confidence 1 narrative cannot authorize', auth.authorized, (v) => v === false, 'false');
  }
  {
    const auth = computeShadowAuthority({ proposal: directiveEggs(), snapshot: snap });
    assert('explicit eggs directive authorizes exact id', auth, (v) => {
      const x = v as { authorized?: boolean; grounded_id?: string; decision?: string };
      return x.authorized === true && x.grounded_id === 'li_eggs' && x.decision === 'authorize_list_remove';
    }, 'authorize li_eggs');
  }

  {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/dev/listRemoveInterpretationShadow.ts'),
      'utf8',
    );
    assert('authority module has no setPending', src.includes('setPending'), (v) => v === false, 'false');
    assert('authority module has no runSync write', /runSync\(/.test(src), (v) => v === false, 'false');
    assert('authority module does not import dispatch', src.includes('chat/dispatch'), (v) => v === false, 'false');
    assert('authority module does not import conversationalWorker generate', src.includes('conversationalWorker'), (v) => v === false, 'false');
  }

  {
    const parsed = parseSemanticProposal('noise {"speech_act":"directive","polarity":"affirmative","tense_aspect":"present","candidate":"list_remove","op":"list_remove","referents":[{"surface":"eggs"}],"linguistically_incomplete":false,"confidence":0.2} trailing');
    assert('parse extracts JSON object', parsed?.referents[0]?.surface, (v) => v === 'eggs', 'eggs');
    assert('parse fail-closed on junk', parseSemanticProposal('hello'), (v) => v === null, 'null');
  }

  const automated = LIST_REMOVE_SHADOW_CORPUS.filter((r) => !r.device_spoken_cutoff);
  assert('corpus has required automated rows', automated.length >= 14, (v) => v === true, '>=14');
  for (const row of automated) {
    assert(`corpus ${row.id} has utterance`, row.utterance.trim().length > 0, (v) => v === true, 'nonempty');
    assert(`corpus ${row.id} has expected authority`, typeof row.expected_shadow_authority, (v) => v === 'string', 'string');
  }
  assert(
    'spoken cutoff marked device-only',
    LIST_REMOVE_SHADOW_CORPUS.some((r) => r.device_spoken_cutoff === true),
    (v) => v === true,
    'true',
  );

  {
    const CHAT = fs.readFileSync(
      path.join(process.cwd(), 'src/screens/ChatScreen.tsx'),
      'utf8',
    );
    const sendStart = CHAT.indexOf('const sendMessage = useCallback');
    const sendEnd = CHAT.indexOf('}, [userId, messages, personaKey', sendStart);
    const sendChunk = CHAT.slice(sendStart, sendEnd);
    const tryIdx = sendChunk.indexOf('\n    try {');
    const letIdx = sendChunk.indexOf('let shadowSnapshot');
    const innerLet = sendChunk.indexOf('let shadowSnapshot', tryIdx);
    assert('ChatScreen schedules shadow after production', CHAT.includes('runListRemoveInterpretationShadow'), (v) => v === true, 'true');
    assert('ChatScreen uses independent shadow ctx', CHAT.includes('getShadowCtx: getListRemoveShadowCtx'), (v) => v === true, 'true');
    assert(
      'ChatScreen snapshot is gated by the shadow flag',
      CHAT.includes('isListRemoveInterpretationShadowEnabled()'),
      (v) => v === true,
      'true',
    );
    assert(
      'shadowSnapshot is declared before try (finally-visible)',
      { letIdx, tryIdx },
      (v) => {
        const x = v as { letIdx: number; tryIdx: number };
        return x.letIdx >= 0 && x.tryIdx >= 0 && x.letIdx < x.tryIdx;
      },
      'let before try',
    );
    assert(
      'shadowSnapshot is not redeclared inside try',
      innerLet,
      (v) => v === -1,
      '-1',
    );
    assert(
      'finally still invokes shadow runner',
      sendChunk.includes('} finally {') && sendChunk.includes('runListRemoveInterpretationShadow'),
      (v) => v === true,
      'true',
    );
  }

  {
    const engine = fs.readFileSync(
      path.join(process.cwd(), 'src/dev/useListRemoveInterpretationShadowEngine.ts'),
      'utf8',
    );
    assert('shadow engine does not import conversational getCtx', engine.includes('useExperimentalConversationalEngine'), (v) => v === false, 'false');
    assert('shadow engine uses own initLlama', engine.includes('initLlama'), (v) => v === true, 'true');
    for (const ev of [
      'independent_ctx_init_begin',
      'independent_ctx_ready',
      'independent_ctx_cancelled',
      'independent_ctx_init_failed',
    ]) {
      assert(`engine logs ${ev}`, engine.includes(`'${ev}'`), (v) => v === true, ev);
    }
    const flagOff = engine.indexOf('if (!LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED)');
    const initCall = engine.indexOf('await initLlama(');
    const flagOffBlockEnd = engine.indexOf('(async () => {', flagOff);
    assert(
      'flag OFF returns before initLlama IIFE',
      { flagOff, initCall, flagOffBlockEnd },
      (v) => {
        const x = v as { flagOff: number; initCall: number; flagOffBlockEnd: number };
        return x.flagOff >= 0 && x.initCall >= 0 && x.flagOffBlockEnd >= 0
          && x.flagOff < x.flagOffBlockEnd && x.flagOffBlockEnd < x.initCall;
      },
      'flag-off before IIFE/initLlama',
    );
  }

  {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/dev/listRemoveInterpretationShadow.ts'),
      'utf8',
    );
    assert(
      'snapshot is a no-op when flag helper is false',
      src.includes('if (!isListRemoveInterpretationShadowEnabled()) return null;'),
      (v) => v === true,
      'true',
    );
    assert(
      'runner is a no-op when flag helper is false',
      /export async function runListRemoveInterpretationShadow[\s\S]*?if \(!isListRemoveInterpretationShadowEnabled\(\)\) return;/.test(src),
      (v) => v === true,
      'true',
    );
  }

  {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = ((...args: unknown[]) => {
      warns.push(String(args[0] ?? ''));
    }) as typeof console.warn;
    try {
      await runListRemoveInterpretationShadow({
        text: 'Remove eggs from my grocery list.',
        snapshot: { captured_at_ms: 0, elapsed_ms: 0, items: [{ id: 'li_eggs', body: 'eggs' }] },
        production: null,
        asr: { input_source: 'typed', committed_length: 12 },
        getShadowCtx: () => null,
      });
    } finally {
      console.warn = orig;
    }
    const row = warns.find((w) => w.startsWith(SHADOW_LOG_PREFIX + ' '));
    let parsed: { proposal_status?: string; shadow_authorized?: boolean } | null = null;
    try {
      parsed = row ? JSON.parse(row.slice(SHADOW_LOG_PREFIX.length + 1)) as { proposal_status?: string; shadow_authorized?: boolean } : null;
    } catch {
      parsed = null;
    }
    assert('null ctx still emits HERALD_INTERPRETATION_SHADOW turn row', !!row, (v) => v === true, 'true');
    assert(
      'null ctx diagnostic is unavailable, not silent',
      parsed,
      (v) => {
        const x = v as { proposal_status?: string; shadow_authorized?: boolean } | null;
        return x?.proposal_status === 'unavailable' && x.shadow_authorized === false;
      },
      'unavailable / not authorized',
    );
  }

  assert('shadow feature flag is on for this experiment APK', LIST_REMOVE_INTERPRETATION_SHADOW_ENABLED, (v) => v === true, 'true');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ListRemoveInterpretationShadow: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('listRemoveInterpretationShadow.test.ts')) {
  runListRemoveInterpretationShadowTests().catch(console.error);
}
