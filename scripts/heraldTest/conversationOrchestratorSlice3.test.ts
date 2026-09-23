// Slice 3 — the act is chosen from the outcome, not from the wording.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';
import {
  acknowledgeAct,
  actForCommits,
  actForPendingResolution,
  actForRoute,
  correctionAcceptedAct,
  executionResultAct,
  inviteContinuationAct,
  projectRealization,
  reflectCurrentTurnAct,
  requestConfirmationAct,
} from '../../src/routing/responseAct.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

export async function runConversationOrchestratorSlice3Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${JSON.stringify(got)}\n       expected: ${expected}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 3 --${RESET}\n`);

  const actPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/responseAct.ts');
  const chatPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
  const actSrc = fs.readFileSync(actPath, 'utf8');
  const chatSrc = fs.readFileSync(chatPath, 'utf8');
  assert('the act module does not classify wording', !actSrc.includes('.match(') && !actSrc.includes('RegExp') && !actSrc.includes('.test('),
    (v) => v === true, 'no prose matcher');
  assert('ChatScreen consumes a present act and does not infer one',
    chatSrc.includes('projectRealization(outcome.responseAct, outcome.responseText)')
    && chatSrc.includes('projectRealization(outcome.responseAct, rdTier1Response)')
    && chatSrc.includes('projectRealization(outcome.responseAct, reply)')
    && chatSrc.includes('projectRealization(outcome.responseAct, notReadyReply)')
    && !chatSrc.includes("responseText.includes(")
    && !chatSrc.includes("responseText.match(")
    && !/kind:\s*'EXECUTION_RESULT'/.test(chatSrc)
    && !/kind:\s*'UNAVAILABLE'/.test(chatSrc),
    (v) => v === true, 'projection only');

  const sameWords = 'Okay.';
  const acknowledged = acknowledgeAct(sameWords);
  const unknown = actForRoute({ kind: 'needs_clarification', reason: 'default', response: sameWords });
  assert('an act exists before realization', acknowledged.kind === 'ACKNOWLEDGE' && projectRealization(acknowledged, 'different').speech === sameWords,
    (v) => v === true, 'ACKNOWLEDGE projected from the act');
  assert('the same wording does not choose the act', unknown?.kind === 'UNKNOWN' && unknown.kind !== acknowledged.kind,
    (v) => v === true, 'UNKNOWN');

  const added = 'Added milk to your grocery list.';
  assert('writer success selects execution', actForCommits([{ status: 'committed' }], added)?.kind === 'EXECUTION_RESULT',
    (v) => v === true, 'EXECUTION_RESULT');
  assert('writer failure does not select execution', actForCommits([{ status: 'failed' }], added)?.kind !== 'EXECUTION_RESULT',
    (v) => v === true, 'not EXECUTION_RESULT');
  assert('a request is not itself execution', executionResultAct(added).verified === true && actForRoute({ kind: 'device_action', reason: 'action:list_add', response: added }) === undefined,
    (v) => v === true, 'no act before a result');
  const consumed = projectRealization(executionResultAct(added), 'I remember adding milk.');
  assert('realization speaks the selected act, not independent prose', consumed.speech === added && consumed.act?.kind === 'EXECUTION_RESULT',
    (v) => v === true, 'act payload');
  const reworded = actForCommits([{ status: 'committed' }], 'Noted.');
  assert('changing the payload does not change the act kind', actForCommits([{ status: 'committed' }], added)?.kind === 'EXECUTION_RESULT' && reworded?.kind === 'EXECUTION_RESULT' && reworded?.text !== added,
    (v) => v === true, 'same kind');
  assert('a generic noop stays untyped', actForCommits([{ status: 'noop' }], "No problem — I won't add that.") === undefined && actForPendingResolution({ status: 'noop', ack: 'Okay.' }) === undefined,
    (v) => v === true, 'untyped noop');
  assert('unavailable is the not-ready route only', actForRoute({ kind: 'not_ready' })?.kind === 'UNAVAILABLE' && actForCommits([{ status: 'failed' }], added) === undefined && actForPendingResolution({ status: 'failed', ack: added }) === undefined,
    (v) => v === true, 'not_ready');

  const session = new ConversationSession();
  const recovery = new RecoveryObligationHolder();
  const ack = acknowledgeAct('Okay.');
  assert('acknowledgment creates no pending, truth, or obligation', !session.hasPending() && recovery.peek() === null && ack.impliesMemory === false && ack.impliesWrite === false && ack.impliesContinuation === false,
    (v) => v === true, 'acknowledgment only');

  const unavailable = actForRoute({ kind: 'not_ready' });
  assert('unknown and unavailable are not success', unknown?.kind === 'UNKNOWN' && unavailable?.kind === 'UNAVAILABLE' && unknown?.kind !== 'EXECUTION_RESULT' && unavailable?.kind !== 'EXECUTION_RESULT',
    (v) => v === true, 'not execution');

  const reflection = reflectCurrentTurnAct('You said Martin went to Ireland.');
  const correction = correctionAcceptedAct('Got it.');
  const invitation = inviteContinuationAct('Want to keep going?');
  assert('current-turn reflection is not durable memory', reflection.epistemic === 'current_conversation' && reflection.durable === false && correction.durable === false && invitation.kind === 'INVITE_CONTINUATION',
    (v) => v === true, 'current_conversation');

  {
    const db = new Database(':memory:');
    setDB(makeShim(db));
    await runMigrations();
    db.prepare(`INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at) VALUES ('v1', '2026-09-01', 'Dr. Patel', 'Checkup', '2026-09-01T15:00:00.000Z')`).run();
    const live = new ConversationSession();
    const addedOutcome = await processUtterance('Add milk to my grocery list.', live, {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: ['grocery'] },
    });
    assert('a verified grocery add carries execution before speech', addedOutcome.handled === true && addedOutcome.responseAct?.kind === 'EXECUTION_RESULT' && addedOutcome.responseAct.verified === true,
      (v) => v === true, 'EXECUTION_RESULT');
    assert('the grocery wording is the act payload', addedOutcome.handled === true && addedOutcome.responseAct != null && projectRealization(addedOutcome.responseAct, 'different').speech === addedOutcome.responseText,
      (v) => v === true, 'unchanged wording');
    const medication = new MedicationPresentationHolder();
    const ordered = new OrderedPresentationHolder();
    medication.establish(['med_a', 'med_b']);
    ordered.establish('grocery', ['item_a', 'item_b']);
    const ordinal = await processUtterance('the second one', new ConversationSession(), {
      classifyQuery,
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: [] },
    }, null, medication, ordered);
    assert('non-unique ordinal selects clarification without a new admission', ordinal.handled === true && ordinal.responseAct?.kind === 'CLARIFY_REFERENCE' && medication.hasLive() && ordered.hasLive(),
      (v) => v === true, 'CLARIFY_REFERENCE');
  }

  {
    const pendingSession = new ConversationSession();
    establishHardPending(pendingSession, { pendingKey: 'medical_capture', resume: async () => ({ status: 'committed', ack: 'Saved.' }) });
    const confirm = requestConfirmationAct('Save this?', 'medical_capture');
    assert('confirmation presents the existing pending and does not open another store', confirm.kind === 'REQUEST_CONFIRMATION' && confirm.pendingKey === pendingSession.peekPendingKey() && pendingSession.hasPending(),
      (v) => v === true, 'one pending');
    const resolved = await pendingSession.resolvePending('cancel');
    const cancelled = actForPendingResolution(resolved);
    assert('cancel selects cancelled from the pending exit', cancelled?.kind === 'CANCELLED' && !pendingSession.hasPending(),
      (v) => v === true, 'CANCELLED');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice3: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice3');
if (invokedDirectly) {
  runConversationOrchestratorSlice3Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
