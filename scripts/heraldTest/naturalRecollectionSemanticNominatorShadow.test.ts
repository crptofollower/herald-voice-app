// Natural Recollection Semantic Nominator Shadow V1 — evidence only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, SCHEMA_VERSION } from '../../src/db/schema.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { listActiveEvidence } from '../../src/db/evidenceDB.ts';
import { resetReminiscenceAdmissionState } from '../../src/db/reminiscenceWrite.ts';
import {
  ReminiscenceArcHolder,
  resetDefaultReminiscenceArc,
} from '../../src/routing/reminiscenceArc.ts';
import { resetReminiscenceNominator } from '../../src/utils/reminiscenceNominator.ts';
import {
  generateRecollectionSemanticProposal,
  observeRecollectionSemanticShadow,
  parseRecollectionSemanticProposal,
  peekLastRecollectionSemanticShadow,
  getRecollectionSemanticShadowCount,
  resetRecollectionSemanticShadow,
  RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT,
} from '../../src/routing/recollectionSemanticNomination.ts';
import { resetNow, setNow } from '../../src/utils/heraldClock.ts';
import { resetSemanticCompletionLifecycleForTests } from '../../src/utils/semanticCompletionLifecycle.ts';
import {
  RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER,
  isRecollectionSemanticDeviceEvidenceTrigger,
} from '../../src/dev/recollectionSemanticDeviceEvidenceTrigger.ts';
import {
  RECOLLECTION_SEMANTIC_EVAL_FIXTURES,
  RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL,
} from './recollectionSemanticEvalFixtures.ts';
import { REMINISCENCE_DISPOSITIONS } from '../../src/utils/reminiscenceDisposition.ts';
import { stubNominateReminiscence } from '../../src/utils/reminiscenceNominator.ts';
import {
  collectRecollectionSemanticEvidence,
  writeRecollectionSemanticEvidenceArtifact,
} from './recollectionSemanticDeviceEvidence.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const CHILDHOOD = 'When I was a kid, we spent summers at the lake.';
const NORTH_STAR = 'Dad wasn\'t much of a talker, but every Saturday he\'d have the fishing poles leaning against the garage before I even got downstairs.';
const ASSISTANT_Q = 'How old were you?';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function mockCtx(text: string | (() => Promise<{ text: string }>)) {
  return {
    completion: async () => (typeof text === 'function' ? text() : { text }),
  } as never;
}

async function fresh(opts?: { completionText?: string; hang?: boolean }) {
  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  resetReminiscenceAdmissionState();
  resetDefaultReminiscenceArc();
  resetReminiscenceNominator();
  resetRecollectionSemanticShadow();
  resetSemanticCompletionLifecycleForTests();
  setNow(new Date(2026, 8, 22, 12, 0, 0));
  const session = new ConversationSession();
  const subject = new ConversationalSubjectHolder();
  const arc = new ReminiscenceArcHolder();
  const getCtx = opts?.hang
    ? () => mockCtx(() => new Promise(() => {}))
    : opts?.completionText != null
      ? () => mockCtx(opts.completionText as string)
      : () => null;
  const deps = {
    classifyQuery: async (t: string) => classifyQuery(t),
    classifyLLM: async () => ({ status: 'ok' as const, intents: [] }),
    llmReady: false,
    llmStatus: 'unavailable' as const,
    captureContext: { contacts: [], lists: ['grocery'] },
    getMedicationSemanticInterpreterCtx: getCtx,
  };
  const say = (text: string) =>
    processUtterance(text, session, deps, subject, null, null, null, null, null, null, arc);
  return { db, session, subject, arc, say, deps };
}

function liveR() {
  return listActiveEvidence({ sourceClass: 'user_explicit', sourceKind: 'reminiscence' });
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number };
  return row.n;
}

function snapshotT(db: Database.Database) {
  return {
    medical: count(db, 'medical_records'),
    facts: count(db, 'facts'),
    contacts: count(db, 'contacts'),
    medications: count(db, 'medications'),
  };
}

export async function runNaturalRecollectionSemanticNominatorShadowV1Tests(): Promise<{
  passed: number; failed: number; total: number;
}> {
  let passed = 0;
  const failures: string[] = [];
  const assert = (label: string, value: unknown, pred: (v: unknown) => boolean, expected: string) => {
    if (pred(value)) {
      passed++;
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
    } else {
      failures.push(label);
      console.log(`${RED}✗ FAIL${RESET}  ${label}${DIM}  got ${JSON.stringify(value)} expected ${expected}${RESET}`);
    }
  };

  console.log(`\n${BOLD}-- Natural Recollection Semantic Nominator Shadow V1 --${RESET}\n`);

  try {
    assert('SCHEMA_VERSION remains 25', SCHEMA_VERSION, (v) => v === 25, '25');

    assert('closed-label parse accepts AUTOBIOGRAPHICAL',
      parseRecollectionSemanticProposal('{"disposition":"AUTOBIOGRAPHICAL","confidence":0.8}')?.disposition,
      (v) => v === 'AUTOBIOGRAPHICAL', 'AUTOBIOGRAPHICAL');

    assert('unknown label fails closed',
      parseRecollectionSemanticProposal('{"disposition":"NOSTALGIC","confidence":0.9}'),
      (v) => v == null, 'null');

    assert('malformed JSON fails closed',
      parseRecollectionSemanticProposal('not json'),
      (v) => v == null, 'null');

    {
      const gen = await generateRecollectionSemanticProposal('hello', () => null);
      assert('unavailable local context fails closed to UNCERTAIN generation',
        gen.status === 'unavailable' && gen.reason === 'no_ctx',
        (v) => v === true, 'true');
    }

    {
      const gen = await generateRecollectionSemanticProposal('hello', () => mockCtx('{not-json'), { timeoutMs: 50 });
      assert('malformed model output is parse_fail',
        gen.status === 'parse_fail',
        (v) => v === true, 'true');
    }

    {
      const gen = await generateRecollectionSemanticProposal(
        'hello',
        () => mockCtx(() => new Promise(() => {})),
        { timeoutMs: 20 },
      );
      assert('timeout fails closed',
        gen.status === 'unavailable' && gen.reason === 'timeout',
        (v) => v === true, 'true');
      resetSemanticCompletionLifecycleForTests();
    }

    {
      const gen = await generateRecollectionSemanticProposal(
        'hello',
        () => mockCtx(async () => { throw new Error('native boom'); }),
      );
      assert('completion error fails closed',
        gen.status === 'unavailable' && gen.reason === 'error',
        (v) => v === true, 'true');
    }

    {
      const hanging = generateRecollectionSemanticProposal(
        'hello',
        () => mockCtx(() => new Promise(() => {})),
        { timeoutMs: 120 },
      );
      await new Promise((r) => setTimeout(r, 15));
      const second = await generateRecollectionSemanticProposal('hello', () => mockCtx('{"disposition":"AUTOBIOGRAPHICAL"}'));
      assert('in-flight second call fails closed',
        second.status === 'unavailable' && second.reason === 'in_flight',
        (v) => v === true, 'true');
      await hanging.catch(() => {});
      resetSemanticCompletionLifecycleForTests();
    }

    {
      const shadow = await observeRecollectionSemanticShadow(
        'My doctor doubled my Eliquis.',
        { arcOpen: false },
        () => mockCtx('{"disposition":"AUTOBIOGRAPHICAL","confidence":0.99}'),
        'SENSITIVE',
      );
      assert('deterministic sensitive exclusion cannot be overridden by the semantic model',
        shadow.sensitiveOverride
          && shadow.modelDisposition === 'AUTOBIOGRAPHICAL'
          && shadow.effectiveDisposition === 'SENSITIVE',
        (v) => v === true, 'true');
    }

    const nominatorSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/recollectionSemanticNomination.ts'),
      'utf8',
    );
    const processSrc = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/processUtterance.ts'),
      'utf8',
    );
    assert('semantic nomination has no remote provider path',
      !/openrouter|railway|\/ask\b|fetch\(|XMLHttpRequest/i.test(nominatorSrc)
        && nominatorSrc.includes("runSpecialistInference('recollection_nomination'"),
      (v) => v === true, 'true');

    assert('authoritative nominator remains synchronous; C4 still follows routeIntent',
      fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/utils/reminiscenceDisposition.ts'), 'utf8').includes(') => ReminiscenceDisposition;')
        && processSrc.includes('const disposition = nominateReminiscence(text, { arcOpen: arc.isOpen() });')
        && processSrc.includes('if (!flowEligible && shouldObserveRecollectionSemanticShadow(getSemanticCtx))')
        && processSrc.includes('await observeRecollectionSemanticShadow(')
        && processSrc.indexOf('const routeDecision = routedClarificationInterrupt ?? await routeIntent')
          < processSrc.indexOf('await observeRecollectionSemanticShadow('),
      (v) => v === true, 'true');

    assert('provider/nominator seam is getCtx-replaceable and uses a dedicated recollection prompt',
      nominatorSrc.includes('RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT')
        && !nominatorSrc.includes('medication interpretation only')
        && !nominatorSrc.includes('grocery interpretation only')
        && RECOLLECTION_SEMANTIC_PROPOSAL_SYSTEM_PROMPT.includes('AUTOBIOGRAPHICAL'),
      (v) => v === true, 'true');

    {
      const { say } = await fresh({ completionText: '{"disposition":"AUTOBIOGRAPHICAL"}' });
      const beforeShadow = getRecollectionSemanticShadowCount();
      await say('Add milk to my grocery list.');
      assert('operational grocery still outranks C4; semantic shadow is not called',
        getRecollectionSemanticShadowCount() === beforeShadow && liveR().length === 0,
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh({ completionText: '{"disposition":"AUTOBIOGRAPHICAL"}' });
      await say('Remember that we went to the lake last Saturday.');
      assert('explicit Episode Capture remains separate; no silent R from semantic AUTOBIOGRAPHICAL',
        liveR().length === 0,
        (v) => v === true, 'true');
    }

    {
      const { db, say } = await fresh({ completionText: '{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}' });
      const beforeT = snapshotT(db);
      const out = await say(NORTH_STAR);
      const shadow = peekLastRecollectionSemanticShadow();
      assert('semantic AUTOBIOGRAPHICAL cannot independently write Track R when stub is UNCERTAIN',
        out.handled === false
          && liveR().length === 0
          && shadow?.modelDisposition === 'AUTOBIOGRAPHICAL'
          && shadow.stubDisposition === 'UNCERTAIN',
        (v) => v === true, 'true');
      assert('semantic shadow cannot write Track T',
        JSON.stringify(snapshotT(db)) === JSON.stringify(beforeT),
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh({ completionText: '{"disposition":"TRANSIENT"}' });
      await say(CHILDHOOD);
      const rows = liveR();
      assert('stub remains V1A admission authority even if semantic says TRANSIENT',
        rows.length === 1
          && rows[0].rawText === CHILDHOOD
          && peekLastRecollectionSemanticShadow()?.stubDisposition === 'AUTOBIOGRAPHICAL'
          && peekLastRecollectionSemanticShadow()?.modelDisposition === 'TRANSIENT',
        (v) => v === true, 'true');
    }

    {
      const { say } = await fresh({ completionText: '{"disposition":"AUTOBIOGRAPHICAL"}' });
      await say(CHILDHOOD);
      assert('stored R remains user verbatim; assistant wording is absent',
        liveR()[0]?.rawText === CHILDHOOD
          && !liveR().some((r) => r.rawText.includes(ASSISTANT_Q)),
        (v) => v === true, 'true');
    }

    {
      const required = [
        'childhood_without_cue', 'adulthood_memory', 'work_story', 'marriage_family',
        'travel_story', 'mundane_personal_past', 'emotional_non_medical',
        'present_transient', 'health_medical', 'financial', 'legal', 'credentials_secrets',
        'third_party_medical', 'ordinary_third_party', 'mixed_autobiographical_sensitive',
        'uncertain_residue', 'active_arc_short_continuation', 'active_arc_insufficient_referent',
        'north_star_dad_fishing', 'grief_own_loss',
        'g1_rye_loaf_short', 'g1_coffee_cold', 'g2_mom_christmas', 'g2_third_party_private_life',
        'g3_mixed_stt_blob', 'g5_he_hated_mornings', 'g5_yeah',
        'g7_t1_autobiographical_story', 'g7_t2_digression', 'g7_t3_return',
      ];
      const classes = new Set(RECOLLECTION_SEMANTIC_EVAL_FIXTURES.map((r) => r.class));
      assert('evaluation fixture set covers the required semantic classes',
        required.every((c) => classes.has(c)),
        (v) => v === true, 'true');
    }

    {
      const live = new Map(RECOLLECTION_SEMANTIC_EVAL_FIXTURES.map((r) => [r.class, r]));
      const intact = RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.every((orig) => {
        const row = live.get(orig.class);
        return row != null
          && row.utterance === orig.utterance
          && row.expected === orig.expected
          && row.arcOpen === orig.arcOpen
          && row.scoring === 'scored';
      });
      assert('frozen original expected labels and utterances were not retargeted',
        intact && RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.length === 22,
        (v) => v === true, '22 frozen scored rows unchanged');
    }

    {
      const dad = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'north_star_dad_fishing');
      const mom = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g2_mom_christmas');
      const neighbor = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'ordinary_third_party');
      const ken = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g2_third_party_private_life');
      const sisterMed = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'third_party_medical');
      assert('THIRD_PARTY is principal-object private life, not family mention or grammatical subject',
        dad?.expected === 'AUTOBIOGRAPHICAL'
          && mom?.expected === 'AUTOBIOGRAPHICAL'
          && neighbor?.expected === 'THIRD_PARTY'
          && ken?.expected === 'THIRD_PARTY'
          && sisterMed?.expected === 'SENSITIVE',
        (v) => v === true, 'Dad/Mom AUTO; neighbor/Ken THIRD_PARTY; sister medical SENSITIVE');
    }

    {
      const nominatorSrc = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/utils/reminiscenceNominator.ts'),
        'utf8',
      );
      const admissionSrc = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/utils/reminiscenceAdmission.ts'),
        'utf8',
      );
      assert('no Dad/Mom/neighbor phrase-rule expansion for THIRD_PARTY',
        !/\bDad\b/.test(nominatorSrc)
          && !/\bMom\b/.test(nominatorSrc)
          && !/neighbor/i.test(nominatorSrc)
          && !/\bDad\b/.test(admissionSrc)
          && !/\bMom\b/.test(admissionSrc)
          && stubNominateReminiscence('Mom always set an extra place at Christmas.', { arcOpen: false }) === 'UNCERTAIN'
          && stubNominateReminiscence(NORTH_STAR, { arcOpen: false }) === 'UNCERTAIN'
          && stubNominateReminiscence('Ken hasn\'t told his kids he\'s seeing someone in Dallas.', { arcOpen: false }) === 'UNCERTAIN',
        (v) => v === true, 'stub stays UNCERTAIN; no new family/neighbor regex');
    }

    {
      const blob = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g3_mixed_stt_blob');
      const hated = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g5_he_hated_mornings');
      assert('observational fixtures have no production admission expected label',
        blob?.scoring === 'observational' && blob.expected == null
          && hated?.scoring === 'observational' && hated.expected == null
          && hated.arcOpen === true,
        (v) => v === true, 'G3/G5 observational expected=null');
    }

    {
      const seq = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.filter((r) => r.sequenceId === 'g7_story_digression_return');
      assert('G7 multi-turn sequence is story then digression then return under current arc flags',
        seq.length === 3
          && seq[0].turnIndex === 1 && seq[0].expected === 'AUTOBIOGRAPHICAL' && seq[0].arcOpen === false
          && seq[1].turnIndex === 2 && seq[1].expected === 'TRANSIENT' && seq[1].arcOpen === true
          && seq[2].turnIndex === 3 && seq[2].expected === 'AUTOBIOGRAPHICAL' && seq[2].arcOpen === true
          && seq.every((r) => r.scoring === 'scored'),
        (v) => v === true, '3 scored G7 turns');
    }

    {
      const coffee = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g1_coffee_cold');
      const yeah = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === 'g5_yeah');
      assert('G1 coffee is TRANSIENT and G5 Yeah is UNCERTAIN',
        coffee?.expected === 'TRANSIENT' && coffee.scoring === 'scored'
          && yeah?.expected === 'UNCERTAIN' && yeah.arcOpen === true,
        (v) => v === true, 'coffee TRANSIENT; Yeah UNCERTAIN');
    }

    assert('closed disposition set remains exactly six labels',
      JSON.stringify(REMINISCENCE_DISPOSITIONS),
      (v) => v === JSON.stringify(['AUTOBIOGRAPHICAL', 'CONTINUE_ARC', 'TRANSIENT', 'SENSITIVE', 'THIRD_PARTY', 'UNCERTAIN']),
      'six dispositions');

    const probe = await classifyQuery('what have i told you');
    assert('memory:probe is unchanged',
      probe.tier === 2 && probe.reason === 'memory:probe',
      (v) => v === true, 'true');

    console.log(`\n${BOLD}-- Semantic evaluation matrix (live local model) --${RESET}`);
    console.log(`${DIM}class | utterance | expected | semantic | verdict | notes${RESET}`);
    const artifact = await collectRecollectionSemanticEvidence(() => null, {
      backend: 'node-no-llama.rn',
      llamaRnAvailable: false,
      remoteFallback: false,
      privacy: 'local generateRecollectionSemanticProposal only; no Railway/OpenRouter/fetch',
      note: 'Node and this host have no llama.rn runtime. Rows are UNAVAILABLE/no_ctx. Not a Track R/T write.',
      modelFilename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
      nCtx: 512,
      nGpuLayers: 0,
      interpreterStatus: 'unavailable',
    });
    const artifactPath = writeRecollectionSemanticEvidenceArtifact(artifact);
    console.log(`${DIM}wrote ${artifactPath}${RESET}`);
    for (const row of artifact.rows) {
      const semantic = row.parsedModelDisposition ?? 'UNCERTAIN';
      const note = row.unavailableReason ? `${row.generationStatus}:${row.unavailableReason}` : row.notes;
      console.log(
        `${row.verdict === 'PASS' ? GREEN : row.verdict === 'MISS' ? RED : DIM}${row.verdict}${RESET}  ${row.class} | ${JSON.stringify(row.utterance).slice(0, 72)} | ${row.expected} | stub=${row.stubDisposition} | model=${semantic} | effective=${row.effectiveDisposition} | ${note}`,
      );
    }

    {
      const { say } = await fresh();
      const before = getRecollectionSemanticShadowCount();
      await say(NORTH_STAR);
      assert('C4 with unavailable semantic ctx bypasses shadow observation (no await, no lastShadow)',
        peekLastRecollectionSemanticShadow() == null
          && getRecollectionSemanticShadowCount() === before
          && liveR().length === 0,
        (v) => v === true, 'lastShadow=null and shadow count unchanged');
    }

    {
      const chatSrc = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx'),
        'utf8',
      );
      const runSrc = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/dev/recollectionSemanticDeviceEvidenceRun.ts'),
        'utf8',
      );
      const collectSrc = fs.readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/dev/recollectionSemanticEvidenceCollect.ts'),
        'utf8',
      );
      assert('device evidence trigger is the exact bounded token',
        isRecollectionSemanticDeviceEvidenceTrigger(RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER)
          && !isRecollectionSemanticDeviceEvidenceTrigger('run the matrix')
          && RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER === '__HERALD_RECOLLECTION_SEMANTIC_3B__',
        (v) => v === true, 'exact token');
      assert('ChatScreen intercepts the token before routing and does not processUtterance it',
        chatSrc.includes('isRecollectionSemanticDeviceEvidenceTrigger(text)')
          && chatSrc.indexOf('isRecollectionSemanticDeviceEvidenceTrigger(text)')
            < chatSrc.indexOf('turnIndexRef.current += 1')
          && chatSrc.includes('runRecollectionSemanticDeviceEvidence(')
          && chatSrc.includes('getMedicationSemanticInterpreterCtx'),
        (v) => v === true, 'sendMessage intercept');
      assert('device runner uses local llama.rn semantic ctx.completion with no remote fallback',
        runSrc.includes('getCtx')
          && collectSrc.includes('generateRecollectionSemanticProposal')
          && !runSrc.includes('fetch(')
          && !collectSrc.includes('fetch(')
          && !runSrc.includes('openrouter.com')
          && runSrc.includes('Share.share'),
        (v) => v === true, 'local + share sheet');
      assert('device matrix is the accepted fixture set including frozen original 22',
        collectSrc.includes('RECOLLECTION_SEMANTIC_EVAL_FIXTURES')
          && RECOLLECTION_SEMANTIC_EVAL_FIXTURES.length >= 32
          && RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.length === 22,
        (v) => v === true, 'accepted matrix');
    }
  } finally {
    resetNow();
    resetReminiscenceAdmissionState();
    resetDefaultReminiscenceArc();
    resetReminiscenceNominator();
    resetRecollectionSemanticShadow();
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}NaturalRecollectionSemanticNominatorShadowV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('naturalRecollectionSemanticNominatorShadow')) {
  runNaturalRecollectionSemanticNominatorShadowV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
