// Five-slice Android journey harness. No live model and no Firebase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { answerImmediateSemanticRecap } from '../../src/routing/immediateSemanticRecap.ts';
import { answerActiveSubjectReference } from '../../src/routing/activeSubjectReference.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { resetSemanticCompletionLifecycleForTests } from '../../src/utils/semanticCompletionLifecycle.ts';
import {
  FIVE_SLICE_FOCUS_PURITY_TEXT,
  FIVE_SLICE_IMPURE_FOCUS,
  FIVE_SLICE_RECAP_VETO_TEXT,
  FIVE_SLICE_SCENARIO_COUNT,
  FIVE_SLICE_SCENARIO_IDS,
  armJourneyScriptedCompletion,
  clearJourneyScriptedCompletion,
  peekJourneyScriptedCompletions,
  selectJourneyScriptedCompletion,
  wrapJourneySemanticCtx,
} from '../../src/dev/journeyScriptedCompletion.ts';
import {
  applyJourneyAcknowledgementResponse,
  buildFiveSliceTurnEvidence,
  parseImmediateRecapDiagLine,
  parseSemanticAdmissionLine,
} from '../../src/dev/journeyFiveSliceEvidence.ts';
import { deterministicAcknowledgementSpeech } from '../../src/routing/responseAct.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function countAuthoritativeRows(db: Database.Database): number {
  const tables = ['lists', 'list_items', 'medications', 'medical_records'];
  return tables.reduce((sum, table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return sum + Number(row.n);
  }, 0);
}

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function depsWith(getCtx: () => { completion: (params: unknown) => Promise<unknown> } | null) {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    getMedicationSemanticInterpreterCtx: getCtx,
  };
}

function ledgerCandidate(): ConversationTurnRecord {
  return {
    turnIndex: 1,
    establishedAt: Date.now(),
    utterance: 'I take Metformin 500 mg twice a day.',
    intentType: 'medical_capture',
    operation: 'capture',
    outcome: 'committed',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    focus: [{ kind: 'thing', displayValue: 'Metformin', referable: true, tier: 'authoritative', resolverKey: 'med_1' }],
  };
}

export async function runFiveSliceJourneyHarnessTests() {
  let passed = 0;
  const failures: string[] = [];
  function assert(name: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${name}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${name}`); failures.push(name); }
  }

  clearJourneyScriptedCompletion();
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/heraldTest/conversation/android.five-slice.v1.scenarios.json'), 'utf8')) as {
    schema: string;
    scenarioCount: number;
    scenarios: Array<{ id: string; turns: Array<{ evidenceClass: string; scriptedCompletionIds?: string[] }> }>;
  };
  const ids = pack.scenarios.map((scenario) => scenario.id);
  assert('pack schema is herald.android.five-slice.v1', pack.schema === 'herald.android.five-slice.v1');
  assert('pack scenarioCount is 9', pack.scenarioCount === 9 && pack.scenarios.length === 9);
  assert('pack ids match the harness constant', JSON.stringify(ids) === JSON.stringify([...FIVE_SLICE_SCENARIO_IDS]));
  assert('harness constant count is 9', FIVE_SLICE_SCENARIO_COUNT === 9);
  const injected = pack.scenarios.filter((scenario) => scenario.turns.some((turn) => turn.evidenceClass === 'injected')).map((scenario) => scenario.id);
  assert(
    'injected scenarios are the five scripted cases',
    JSON.stringify(injected) === JSON.stringify([
      'five_slice_recap_veto',
      'five_slice_correction_fallthrough',
      'five_slice_bounded_reject',
      'five_slice_bounded_admit',
      'five_slice_focus_purity',
    ]),
  );

  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert('gradle copies the five-slice scenario contract', gradle.includes('android.five-slice.v1.scenarios.json'));
  const kotlin = fs.readFileSync(path.join(ROOT, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldFiveSliceJourneyV1Test.kt'), 'utf8');
  const v1 = fs.readFileSync(path.join(ROOT, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldAndroidJourneyV1Test.kt'), 'utf8');
  const semanticProof = fs.readFileSync(path.join(ROOT, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldSemanticProofV1Test.kt'), 'utf8');
  assert('instrumentation class grades exactly 9 scenarios', kotlin.includes('SCENARIO_COUNT = 9'));
  assert('existing journey pack test is not retargeted', !v1.includes('five_slice_') && !v1.includes('android.five-slice'));
  assert('semantic proof test is not retargeted', !semanticProof.includes('five_slice_') && !semanticProof.includes('HeraldFiveSlice'));

  const chat = fs.readFileSync(path.join(ROOT, 'src/screens/ChatScreen.tsx'), 'utf8');
  const maybe = fs.readFileSync(path.join(ROOT, 'src/dev/maybeJourneyHost.ts'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src/dev/androidJourneyHost.ts'), 'utf8');
  assert('ChatScreen asks the journey host for a context and does not import the script module',
    chat.includes('host.journeySemanticCtx(real)') && !chat.includes('journeyScriptedCompletion'));
  assert('journey host loads only after the native bridge check',
    maybe.indexOf('if (!bridge) return null;') < maybe.indexOf("require('./androidJourneyHost')"));
  assert('only the journey host imports the script module from production surfaces',
    host.includes("from './journeyScriptedCompletion'") && !maybe.includes('journeyScriptedCompletion'));
  for (const rel of [
    'src/routing/semanticProvider.ts',
    'src/routing/processUtterance.ts',
    'src/routing/medicationSemanticInterpretation.ts',
    'src/routing/immediateSemanticRecap.ts',
    'src/routing/routeIntent.ts',
    'src/routing/discourseCorrection.ts',
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(`${rel} does not select a scripted completion`, !src.includes('journeyScriptedCompletion') && !src.includes('fs-focus-purity'));
  }

  let liveCalls = 0;
  const live = {
    completion: async () => {
      liveCalls += 1;
      return { text: 'LIVE_MODEL' };
    },
  };
  clearJourneyScriptedCompletion();
  const unarmed = wrapJourneySemanticCtx(live);
  await unarmed.completion({ prompt: 'anything' });
  assert('an unarmed journey context consumes the real completion', liveCalls === 1 && peekJourneyScriptedCompletions().length === 0);

  armJourneyScriptedCompletion('five_slice_bounded_admit');
  const rawCalls = { n: 0 };
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const isolated = await processUtterance(
    'about his trip to Ireland',
    new ConversationSession(),
    depsWith(() => ({
      completion: async () => {
        rawCalls.n += 1;
        return { text: '[]' };
      },
    })),
    null, null, null, null, null, new DiscourseContinuityHolder(),
  );
  resetSemanticCompletionLifecycleForTests();
  assert('arming the script does not intercept a production-supplied context',
    rawCalls.n >= 1
    && peekJourneyScriptedCompletions().length === 0
    && isolated.handled === false
    && isolated.routeDecision.kind === 'needs_clarification');
  clearJourneyScriptedCompletion();

  armJourneyScriptedCompletion('five_slice_bounded_admit');
  const armed = wrapJourneySemanticCtx(null);
  const scripted = await (armed as { completion: (params: unknown) => Promise<{ text?: string }> }).completion({
    prompt: 'Reply with JSON only: an array of objects. Each object has span and kind. kind is person, place, or event_or_topic. span is copied exactly from the utterance. Return [] when none apply.\nabout his trip to Ireland',
  });
  assert('an armed context returns the closed mention and does not call the live model',
    scripted.text === '[{"span":"Ireland","kind":"place"}]' && liveCalls === 1);
  clearJourneyScriptedCompletion();

  const floorDb = new Database(':memory:');
  setDB(shim(floorDb));
  await runMigrations();
  const floorSession = new ConversationSession();
  const floorDeps = depsWith(() => null);
  const floor = await processUtterance('I take Metformin 500 mg twice a day.', floorSession, floorDeps);
  const pendingAfterFloor = floorSession.peekPendingKey();
  const yes = await processUtterance('Yes.', floorSession, floorDeps);
  const meds = getDB().getAllSync<{ name: string; dosage: string | null }>('SELECT name, dosage FROM medications WHERE is_active = 1');
  assert('medication floor capture stays deterministic and pending',
    floor.handled === true && floor.source === 'capture' && pendingAfterFloor === 'medical_capture');
  assert('confirmed floor stores Metformin and 500mg, not the dosage phrase as the name',
    yes.handled === true
    && yes.source === 'pending_resume'
    && meds.length === 1
    && meds[0]?.name === 'Metformin'
    && meds[0]?.name !== 'Metformin 500 mg'
    && meds[0]?.dosage === '500 mg');

  const catalog = await processUtterance('What medications am I taking?', new ConversationSession(), floorDeps);
  assert('catalog read stays medical:summary without a scripted completion',
    catalog.handled === false
    && catalog.routeDecision.kind === 'device_read'
    && catalog.routeDecision.reason === 'medical:summary'
    && peekJourneyScriptedCompletions().length === 0);

  const sky = await processUtterance('The sky looks grey today.', new ConversationSession(), floorDeps);
  assert('ordinary declarative remains a clarification miss',
    sky.handled === false && sky.routeDecision.kind === 'needs_clarification' && sky.routeDecision.reason === 'default');
  const recapLines: string[] = [];
  const warn = console.warn;
  console.warn = ((...args: unknown[]) => {
    recapLines.push(args.map((arg) => String(arg)).join(' '));
    warn.apply(console, args as []);
  }) as typeof console.warn;
  let recapCalled = 0;
  const declarative = await answerImmediateSemanticRecap('The sky looks grey today.', {
    ledgerEntries: [ledgerCandidate()],
    getInterpreterCtx: () => {
      recapCalled += 1;
      return null;
    },
  });
  console.warn = warn;
  const declarativeDiag = parseImmediateRecapDiagLine(recapLines.find((line) => line.includes('HERALD_IMMEDIATE_RECAP_DIAG')) ?? '');
  const declarativeStage = declarativeDiag?.stageB as { status?: string } | undefined;
  assert('declarative with a candidate does not invoke Stage B',
    declarative.handled === false
    && recapCalled === 0
    && declarativeStage?.status === 'not_invoked'
    && declarativeDiag?.finalResult === 'not_recap');

  armJourneyScriptedCompletion('five_slice_recap_veto');
  const vetoSession = new ConversationSession();
  const vetoRouted = await processUtterance(
    'What did you just tell me?',
    vetoSession,
    depsWith(() => wrapJourneySemanticCtx(null)),
  );
  const vetoLines: string[] = [];
  console.warn = ((...args: unknown[]) => {
    vetoLines.push(args.map((arg) => String(arg)).join(' '));
    warn.apply(console, args as []);
  }) as typeof console.warn;
  const veto = await answerImmediateSemanticRecap('What did you just tell me?', {
    ledgerEntries: [ledgerCandidate()],
    getInterpreterCtx: () => wrapJourneySemanticCtx(null),
  });
  console.warn = warn;
  resetSemanticCompletionLifecycleForTests();
  const active = await answerActiveSubjectReference('What did you just tell me?', {
    ledgerEntries: [ledgerCandidate()],
    getInterpreterCtx: () => wrapJourneySemanticCtx(null),
  });
  const vetoHits = peekJourneyScriptedCompletions().map((hit) => hit.id);
  const vetoDiag = parseImmediateRecapDiagLine(vetoLines.find((line) => line.includes('HERALD_IMMEDIATE_RECAP_DIAG')) ?? '');
  const vetoStage = vetoDiag?.stageB as { status?: string; isImmediateRecap?: boolean; confidence?: number; selectedIndex?: number } | undefined;
  const vetoRecap = peekJourneyScriptedCompletions().find((hit) => hit.id === 'fs-recap-veto');
  assert(`assistant-recap veto hits ${JSON.stringify(vetoHits)}`,
    vetoHits.includes('fs-capability-abstain')
    && vetoHits.includes('fs-recap-veto')
    && vetoHits.indexOf('fs-recap-veto') > vetoHits.indexOf('fs-capability-abstain')
    && vetoRecap?.text === FIVE_SLICE_RECAP_VETO_TEXT
    && active.handled === false);
  assert('Stage B proposal is visible and the veto does not admit it',
    vetoRouted.handled === false
    && vetoRouted.routeDecision.kind === 'needs_clarification'
    && veto.handled === false
    && vetoStage?.status === 'ok'
    && vetoStage.isImmediateRecap === true
    && (vetoStage.confidence ?? 0) >= 0.6
    && vetoStage.selectedIndex === 0
    && vetoDiag?.selectedCandidateIndex == null
    && vetoDiag?.finalResult === 'not_recap'
    && vetoDiag?.stageAMatched === false);
  clearJourneyScriptedCompletion();

  const correctionDb = new Database(':memory:');
  setDB(shim(correctionDb));
  await runMigrations();
  const discourse = new DiscourseContinuityHolder();
  const correctionSession = new ConversationSession();
  const rowsBeforeIreland = countAuthoritativeRows(correctionDb);
  const irelandAdmissionLines: string[] = [];
  const irelandLog = console.log;
  console.log = ((...args: unknown[]) => {
    irelandAdmissionLines.push(args.map((arg) => String(arg)).join(' '));
    irelandLog.apply(console, args as []);
  }) as typeof console.log;
  armJourneyScriptedCompletion('five_slice_correction_fallthrough');
  const seeded = await processUtterance(
    'about his trip to Ireland',
    correctionSession,
    depsWith(() => wrapJourneySemanticCtx(null)),
    null, null, null, null, null, discourse,
  );
  console.log = irelandLog;
  const rowsAfterIreland = countAuthoritativeRows(correctionDb);
  const irelandAdmission = parseSemanticAdmissionLine(irelandAdmissionLines.find((line) => line.includes('SEMANTIC_ADMISSION_DONE')) ?? '');
  const irelandAct = seeded.handled ? undefined : seeded.responseAct;
  const irelandRoute = seeded.handled ? undefined : seeded.routeDecision;
  const irelandSerialized = applyJourneyAcknowledgementResponse(seeded, null);
  assert('journey evidence keeps the Ireland acknowledgement without taking the route',
    seeded.handled === false
    && irelandRoute?.kind === 'needs_clarification'
    && irelandRoute.reason === 'default'
    && discourse.peekDiscourseMentions().some((mention) => mention.surfaceSpan === 'Ireland' && mention.kind === 'place' && mention.status === 'active' && mention.durable === false)
    && irelandAct?.kind === 'ACKNOWLEDGE'
    && deterministicAcknowledgementSpeech(irelandAct) === 'Got it — Ireland.'
    && irelandAdmission === null
    && rowsAfterIreland === rowsBeforeIreland
    && irelandSerialized === 'Got it — Ireland.');
  const bareDiscourse = new DiscourseContinuityHolder();
  const bare = await processUtterance(
    'maybe later',
    new ConversationSession(),
    depsWith(() => null),
    null, null, null, null, null, bareDiscourse,
  );
  const bareAct = bare.handled ? undefined : bare.responseAct;
  assert('an unhandled turn without an acknowledgement does not gain journey response text',
    bare.handled === false
    && deterministicAcknowledgementSpeech(bareAct) === null
    && applyJourneyAcknowledgementResponse(bare, null) === null);
  const seedHits = peekJourneyScriptedCompletions().map((hit) => hit.id);
  clearJourneyScriptedCompletion();
  armJourneyScriptedCompletion('five_slice_correction_fallthrough');
  const harbor = await processUtterance(
    'She mentioned the harbor.',
    correctionSession,
    depsWith(() => wrapJourneySemanticCtx(null)),
    null, null, null, null, null, discourse,
  );
  resetSemanticCompletionLifecycleForTests();
  const harborHits = peekJourneyScriptedCompletions();
  const ireland = discourse.peekDiscourseMentions().find((mention) => mention.surfaceSpan === 'Ireland');
  const correctionAt = harborHits.findIndex((hit) => hit.id === 'fs-correction-rejected');
  const applicabilityAt = harborHits.findIndex((hit) => hit.id === 'fs-applicability-ireland');
  assert(`correction seed hits ${JSON.stringify(seedHits)}`,
    seeded.handled === false
    && seedHits.includes('fs-mention-closed')
    && seedHits[seedHits.length - 1] === 'fs-mention-closed'
    && ireland?.status === 'active'
    && ireland.kind === 'place'
    && ireland.durable === false);
  assert(`rejected correction hits ${JSON.stringify(harborHits.map((hit) => hit.id))}`,
    correctionAt >= 0
    && applicabilityAt > correctionAt
    && harborHits[applicabilityAt + 1]?.id === 'fs-mention-empty'
    && harbor.handled === true
    && harbor.source === 'discourse_reflection'
    && harbor.responseText.startsWith('We were talking about Ireland.')
    && !harbor.responseText.startsWith('Got it')
    && ireland?.status === 'active'
    && !discourse.peekDiscourseMentions().some((mention) => mention.status === 'corrected_away'));
  clearJourneyScriptedCompletion();

  async function mentionCase(scenarioId: string) {
    const holder = new DiscourseContinuityHolder();
    armJourneyScriptedCompletion(scenarioId);
    const outcome = await processUtterance(
      'about his trip to Ireland',
      new ConversationSession(),
      depsWith(() => wrapJourneySemanticCtx(null)),
      null, null, null, null, null, holder,
    );
    const hits = peekJourneyScriptedCompletions();
    const hit = hits.find((item) => item.promptKind === 'discourse_mention');
    resetSemanticCompletionLifecycleForTests();
    clearJourneyScriptedCompletion();
    return { outcome, hit, hits: hits.map((item) => item.id), mentions: holder.peekDiscourseMentions() };
  }
  const rejected = await mentionCase('five_slice_bounded_reject');
  const admitted = await mentionCase('five_slice_bounded_admit');
  assert(`prose-wrapped mention hits ${JSON.stringify(rejected.hits)}`,
    rejected.hit?.id === 'fs-mention-prose'
    && rejected.hit.text.startsWith('I found this: ')
    && rejected.outcome.handled === false
    && rejected.outcome.routeDecision.kind === 'needs_clarification'
    && rejected.mentions.length === 0);
  assert('closed mention JSON is the admitted script and reaches Ireland',
    admitted.hit?.id === 'fs-mention-closed'
    && admitted.hit.text === '[{"span":"Ireland","kind":"place"}]'
    && admitted.outcome.handled === false
    && admitted.mentions.some((mention) => mention.surfaceSpan === 'Ireland' && mention.status === 'active' && mention.durable === false));

  const focusDb = new Database(':memory:');
  setDB(shim(focusDb));
  await runMigrations();
  armJourneyScriptedCompletion('five_slice_focus_purity');
  const admissionLines: string[] = [];
  const log = console.log;
  console.log = ((...args: unknown[]) => {
    admissionLines.push(args.map((arg) => String(arg)).join(' '));
    log.apply(console, args as []);
  }) as typeof console.log;
  const focus = await processUtterance(
    'The pharmacy filled my Lisinopril 10mg refill today.',
    new ConversationSession(),
    depsWith(() => wrapJourneySemanticCtx(null)),
    null, null, null, null, null, new DiscourseContinuityHolder(),
  );
  console.log = log;
  resetSemanticCompletionLifecycleForTests();
  const focusHits = peekJourneyScriptedCompletions();
  const admission = parseSemanticAdmissionLine(admissionLines.find((line) => line.includes('SEMANTIC_ADMISSION_DONE')) ?? '');
  const focusNames = getDB().getAllSync<{ name: string }>('SELECT name FROM medications WHERE removed_at IS NULL');
  assert(`impure focus hits ${JSON.stringify(focusHits.map((hit) => hit.id))}`,
    focusHits.some((hit) => hit.id === 'fs-focus-purity')
    && focusHits.find((hit) => hit.id === 'fs-focus-purity')?.text === FIVE_SLICE_FOCUS_PURITY_TEXT
    && focusHits[0]?.id === 'fs-focus-purity'
    && focusHits[0]?.text === FIVE_SLICE_FOCUS_PURITY_TEXT
    && focusHits[0]?.text.includes(`"focus":"${FIVE_SLICE_IMPURE_FOCUS}"`)
    && admission?.decision === 'REJECT'
    && admission.reason === 'focus_contains_dosage'
    && focus.handled === false
    && focus.routeDecision.kind === 'needs_clarification'
    && focusNames.length === 0);
  clearJourneyScriptedCompletion();

  const evidence = buildFiveSliceTurnEvidence({
    hits: [{ id: 'fs-focus-purity', promptKind: 'capability', text: FIVE_SLICE_FOCUS_PURITY_TEXT }],
    immediateRecap: null,
    discourseMentions: [],
    semanticAdmission: { decision: 'REJECT', reason: 'focus_contains_dosage', capability: 'medication.capture' },
  });
  assert('injected evidence is labeled from consumed script hits, not from a live model',
    evidence.evidenceClass === 'injected' && evidence.scriptedCompletions[0]?.id === 'fs-focus-purity');
  const deterministicEvidence = buildFiveSliceTurnEvidence({
    hits: [],
    immediateRecap: { stageB: { status: 'not_invoked' }, finalResult: 'not_recap' },
    discourseMentions: [],
    semanticAdmission: null,
  });
  assert('a turn with no script hit stays deterministic', deterministicEvidence.evidenceClass === 'deterministic');
  assert('selector refuses an unscripted prompt instead of inventing a proposal',
    selectJourneyScriptedCompletion('five_slice_focus_purity', { prompt: 'not a known prompt' }).id === 'fs-unscripted'
    && selectJourneyScriptedCompletion('five_slice_focus_purity', { prompt: 'not a known prompt' }).text === '');

  function contractIds(scenarioId: string, turnIndex: number): string[] {
    return pack.scenarios.find((scenario) => scenario.id === scenarioId)?.turns[turnIndex]?.scriptedCompletionIds ?? [];
  }
  assert('veto completion ids match the scenario contract',
    JSON.stringify(vetoHits) === JSON.stringify(contractIds('five_slice_recap_veto', 2)));
  assert('correction seed completion ids match the scenario contract',
    JSON.stringify(seedHits) === JSON.stringify(contractIds('five_slice_correction_fallthrough', 0)));
  assert('correction fall-through completion ids match the scenario contract',
    JSON.stringify(harborHits.map((hit) => hit.id)) === JSON.stringify(contractIds('five_slice_correction_fallthrough', 1)));
  assert('bounded rejection completion ids match the scenario contract',
    JSON.stringify(rejected.hits) === JSON.stringify(contractIds('five_slice_bounded_reject', 0)));
  assert('bounded admission completion ids match the scenario contract',
    JSON.stringify(admitted.hits) === JSON.stringify(contractIds('five_slice_bounded_admit', 0)));
  assert('focus purity completion ids match the scenario contract',
    JSON.stringify(focusHits.map((hit) => hit.id)) === JSON.stringify(contractIds('five_slice_focus_purity', 0)));

  console.log(`\n${BOLD}FiveSliceJourneyHarness: ${passed}/${passed + failures.length} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('fiveSliceJourneyHarness.test');
if (invokedDirectly) {
  runFiveSliceJourneyHarnessTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
