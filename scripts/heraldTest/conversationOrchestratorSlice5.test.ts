// Slice 5 — soft obligation is machine state, not assistant prose.

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
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { RecoveryObligationHolder, isSoftObligationEligible, type SoftObligationJob } from '../../src/routing/recoveryObligation.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';
import { acknowledgeAct, inviteContinuationAct, requestConfirmationAct } from '../../src/routing/responseAct.ts';
import { admitDispatchedSemanticRead } from '../../src/routing/semanticAdmission.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

function makeShim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

export async function runConversationOrchestratorSlice5Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 5 --${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const src = fs.readFileSync(path.join(root, 'src/routing/recoveryObligation.ts'), 'utf8');
  assert('obligation module does not classify assistant wording', !src.includes('.match(') && !src.includes('RegExp'),
    (v) => v === true, 'no prose matcher');
  assert('one holder class', (src.match(/class RecoveryObligationHolder/g) ?? []).length === 1,
    (v) => v === true, 'one class');

  const prose = new RecoveryObligationHolder();
  prose.beginUserTurn();
  assert('question wording does not create an obligation', prose.peek() === null && prose.isOpenSoft() === false,
    (v) => v === true, 'empty');
  assert('acknowledge does not open an obligation', acknowledgeAct('Okay.').kind === 'ACKNOWLEDGE' && prose.peek() === null,
    (v) => v === true, 'ACK');
  const pending = new ConversationSession();
  establishHardPending(pending, { pendingKey: 'medical_capture', resume: async () => ({ status: 'noop', ack: 'No.', exit: 'cancelled' }) });
  const confirm = requestConfirmationAct('Save this?', 'medical_capture');
  assert('confirmation stays hard pending', confirm.kind === 'REQUEST_CONFIRMATION' && pending.hasPending() && prose.isOpenSoft() === false,
    (v) => v === true, 'pending');

  prose.establishJob('invite_continuation', { kind: 'turn_local' });
  assert('invitation job is explicit', prose.peek()?.job === 'invite_continuation' && prose.peek()?.scope.kind === 'turn_local' && inviteContinuationAct('Continue?').kind === 'INVITE_CONTINUATION',
    (v) => v === true, 'invite');
  assert('turn-local scope is not eligible later', isSoftObligationEligible(prose.peek()!, { liveSetIds: [], focusKey: null }) === false,
    (v) => v === true, 'not eligible');
  prose.establishJob('clarify_intent', { kind: 'intent_context', domains: ['grocery', 'todo'] });
  assert('intent context is stored and is not eligible without a live object',
    prose.peek()?.scope.kind === 'intent_context' && isSoftObligationEligible(prose.peek()!, { liveSetIds: ['grocery:a'], focusKey: null }) === false,
    (v) => v === true, 'narrow');

  const db = new Database(':memory:');
  setDB(makeShim(db));
  await runMigrations();
  const session = new ConversationSession();
  const recovery = new RecoveryObligationHolder();
  const medication = new MedicationPresentationHolder();
  const ordered = new OrderedPresentationHolder();
  const subject = new ConversationalSubjectHolder();
  const say = (text: string) => processUtterance(text, session, {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable',
    captureContext: { contacts: [], lists: ['grocery'] },
  }, subject, medication, ordered, null, null, null, null, null, recovery);

  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  const clarify = await say('the second one');
  const scopeIds = recovery.peek()?.scope.kind === 'presented_sets' ? recovery.peek()!.scope.setIds : [];
  assert('clarification establishes grounded set scope before the act is returned',
    clarify.handled === true && clarify.responseAct?.kind === 'CLARIFY_REFERENCE'
      && recovery.peek()?.job === 'clarify_reference' && scopeIds.length === 2,
    (v) => v === true, 'presented_sets');
  assert('an open slot with missing sets is not eligible',
    isSoftObligationEligible(recovery.peek()!, { liveSetIds: [], focusKey: null }) === false
      && isSoftObligationEligible({ ...recovery.peek()!, establishedAtTurn: 1 }, { liveSetIds: [...scopeIds], focusKey: null }) === true,
    (v) => v === true, 'scope');

  const milk = await say('Add milk to my grocery list.');
  assert('a grocery add leaves the obligation recoverable',
    milk.handled === true && milk.responseAct?.kind === 'EXECUTION_RESULT' && recovery.isOpenSoft() && medication.hasLive() && ordered.hasLive(),
    (v) => v === true, 'still open');

  const unrelated = await say('what time is it');
  assert('a turn keeps the obligation while its referenced sets stay live',
    recovery.peek()?.job === 'clarify_reference' && medication.hasLive() && ordered.hasLive()
      && !(unrelated.handled && unrelated.source === 'recovery_obligation'),
    (v) => v === true, 'grounded');

  const medOnly = scopeIds.filter((id) => id.startsWith('medication:'));
  recovery.establishJob('clarify_reference', { kind: 'presented_sets', setIds: medOnly });
  await say('what time is it');
  assert('an unreferenced grocery set is not pinned by the obligation',
    !ordered.hasLive() && medication.hasLive() && recovery.peek()?.job === 'clarify_reference',
    (v) => v === true, 'grocery cleared');

  medication.clear();
  await say('what time is it');
  assert('losing the referenced set clears the obligation', recovery.peek() === null,
    (v) => v === true, 'invalidated');

  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  await say('the second one');
  const groceryOnly = recovery.peek()?.scope.kind === 'presented_sets'
    ? recovery.peek()!.scope.setIds.filter((id) => id.startsWith('grocery:'))
    : [];
  recovery.establishJob('clarify_reference', { kind: 'presented_sets', setIds: groceryOnly });
  medication.clear();
  const answered = await say('the first one');
  assert('a unique reference closes the obligation once',
    answered.handled === true && recovery.peek() === null,
    (v) => v === true, 'closed');

  const armPending = (done: string) => establishHardPending(session, {
    pendingKey: 'medical_capture',
    resume: async (userText: string) => userText.trim().toLowerCase() === 'cancel'
      ? { status: 'noop', ack: "No problem — I won't do that.", exit: 'cancelled' }
      : { status: 'noop', ack: done },
  });
  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  await say('the second one');
  const bothIds = recovery.peek()?.scope.kind === 'presented_sets' ? [...recovery.peek()!.scope.setIds] : [];
  armPending('Saved.');
  const during = await say('yes');
  assert('hard pending consumes the turn and the grounded sets remain',
    during.handled === true && during.source === 'pending_resume' && !session.hasPending()
      && recovery.peek()?.job === 'clarify_reference' && medication.hasLive() && ordered.hasLive(),
    (v) => v === true, 'suspended');
  const continued = await say('the second one');
  assert('after pending resolves the same obligation can continue',
    continued.responseAct?.kind === 'CLARIFY_REFERENCE' && recovery.peek()?.scope.kind === 'presented_sets'
      && recovery.peek()!.scope.setIds.length === bothIds.length,
    (v) => v === true, 'resumed');

  await say('the second one');
  recovery.establishJob('clarify_reference', {
    kind: 'presented_sets',
    setIds: (recovery.peek()?.scope.kind === 'presented_sets' ? recovery.peek()!.scope.setIds : []).filter((id) => id.startsWith('medication:')),
  });
  armPending('Saved.');
  await say('yes');
  assert('pending does not keep an unreferenced grocery set',
    !session.hasPending() && !ordered.hasLive() && medication.hasLive() && recovery.peek()?.job === 'clarify_reference',
    (v) => v === true, 'grocery cleared');

  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  await say('the second one');
  armPending('Saved.');
  const cancelledPending = await say('cancel');
  assert('after pending cancel the grounded obligation can continue',
    cancelledPending.source === 'pending_resume' && !session.hasPending()
      && recovery.peek()?.job === 'clarify_reference' && medication.hasLive() && ordered.hasLive(),
    (v) => v === true, 'cancel resumes');

  medication.clear();
  armPending('Saved.');
  await say('yes');
  const revived = recovery.peek();
  await say('what time is it');
  assert('a set cleared while pending is armed does not revive the old obligation',
    revived === null && recovery.peek() === null,
    (v) => v === true, 'not revived');

  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  await say('the second one');
  const cancelled = await say('cancel');
  assert('cancelling the obligation keeps the presented sets',
    cancelled.handled === true && cancelled.responseAct?.kind === 'CANCELLED' && recovery.peek() === null && medication.hasLive() && ordered.hasLive(),
    (v) => v === true, 'sets live');

  medication.establish(['med_a', 'med_b']);
  ordered.establish('grocery', ['item_a', 'item_b']);
  await say('the second one');
  const grounded = recovery.peek()?.job;
  await say('No, Dave.');
  assert('a correction does not drop the grounded sets or invent authority',
    recovery.peek()?.job === grounded && medication.hasLive() && ordered.hasLive()
    && admitDispatchedSemanticRead({ capability: 'contact.call', confidence: 'high' }, { eligible: true, reason: 'instruction' }, 'No, Dave.').decision === 'ABSTAIN',
    (v) => v === true, 'preserved');

  const jobs: SoftObligationJob[] = ['clarify_reference', 'clarify_intent', 'invite_continuation'];
  assert('typed jobs are the obligation identity', jobs.includes('clarify_reference') && recovery.peek()?.job === 'clarify_reference',
    (v) => v === true, 'typed');

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice5: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice5');
if (invokedDirectly) {
  runConversationOrchestratorSlice5Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
