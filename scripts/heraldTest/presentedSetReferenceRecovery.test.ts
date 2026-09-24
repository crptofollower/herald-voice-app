// A reference proposal can keep a live Presented Set. It cannot choose a member.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { shouldEstablishRecoveryObligation } from '../../src/routing/recoveryObligation.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

export async function runPresentedSetReferenceRecoveryTests() {
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

  console.log(`\n${BOLD}-- Presented-set reference recovery --${RESET}\n`);
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const now = '2026-09-01T15:00:00.000Z';
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, '50mg', 'daily', 1, ?, NULL)`,
  ).run('med_metoprolol', 'metoprolol', now);
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, '50mg', 'daily', 1, ?, NULL)`,
  ).run('med_lisinopril', 'lisinopril', now);

  const prompts: string[] = [];
  const applicable = {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    getMedicationSemanticInterpreterCtx: () => ({
      completion: async (params: { prompt: string }) => {
        prompts.push(params.prompt);
        return { text: 'applicable' };
      },
    }),
  };
  const silent = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };

  const medication = new MedicationPresentationHolder();
  const recovery = new RecoveryObligationHolder();
  const session = new ConversationSession();
  medication.establish(['med_metoprolol', 'med_lisinopril']);
  const asked = await processUtterance('the blue one', session, applicable, null, medication, null, null, null, null, null, null, recovery);
  const scope = recovery.peek()?.scope.kind === 'presented_sets' ? recovery.peek()!.scope.setIds.join(',') : '';
  assert('an unresolved reference clarifies and keeps the medication set',
    asked.responseAct?.kind === 'CLARIFY_REFERENCE'
      && /metoprolol/i.test(asked.responseText ?? '')
      && /lisinopril/i.test(asked.responseText ?? '')
      && !/blue/i.test(asked.responseText ?? '')
      && medication.peek()?.medicationIds.join(',') === 'med_metoprolol,med_lisinopril'
      && recovery.peek()?.job === 'clarify_reference'
      && scope.includes('medication:')
      && prompts.some((prompt) => !/metoprolol|lisinopril|50mg/i.test(prompt))
      && session.peekPendingKey() === null,
    (v) => v === true, 'pinned');
  assert('failed understanding does not replace the grounded obligation',
    shouldEstablishRecoveryObligation({
      processHandled: true,
      routeKind: 'needs_clarification',
      routeReason: 'default',
      recapHandled: false,
      activeSubjectHandled: false,
      seamKind: 'clarify',
      hasPending: false,
    }) === false && recovery.peek()?.job === 'clarify_reference',
    (v) => v === true, 'typed job stays');

  const first = await processUtterance('the first one', session, silent, null, medication, null, null, null, null, null, null, recovery);
  assert('a later ordinal reads only a retained medication',
    first.handled === true && /metoprolol/i.test(first.responseText ?? '') && !/lisinopril/i.test(first.responseText ?? ''),
    (v) => v === true, 'first medication');

  const unusedMeds = new MedicationPresentationHolder();
  const unusedRecovery = new RecoveryObligationHolder();
  unusedMeds.establish(['med_metoprolol', 'med_lisinopril']);
  await processUtterance('zz idle', new ConversationSession(), silent, null, unusedMeds, null, null, null, null, null, null, unusedRecovery);
  assert('a non-reference turn can still clear an unused medication set',
    unusedMeds.peek() === null && unusedRecovery.peek() === null,
    (v) => v === true, 'unused clear');

  const bothMeds = new MedicationPresentationHolder();
  const grocery = new OrderedPresentationHolder();
  const bothRecovery = new RecoveryObligationHolder();
  bothMeds.establish(['med_metoprolol', 'med_lisinopril']);
  grocery.establish('grocery', ['g1', 'g2']);
  const competing = await processUtterance('zz reference', new ConversationSession(), applicable, null, bothMeds, grocery, null, null, null, null, null, bothRecovery);
  assert('competing sets clarify and a proposal does not pick one',
    competing.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/metoprolol|lisinopril|milk/i.test(competing.responseText ?? '')
      && bothMeds.peek()?.medicationIds.length === 2
      && grocery.hasLive(),
    (v) => v === true, 'competing');

  const pinnedMeds = new MedicationPresentationHolder();
  const pinnedRecovery = new RecoveryObligationHolder();
  const pinnedSession = new ConversationSession();
  pinnedMeds.establish(['med_metoprolol', 'med_lisinopril']);
  await processUtterance('zz reference', pinnedSession, applicable, null, pinnedMeds, null, null, null, null, null, null, pinnedRecovery);
  const { establishHardPending } = await import('../../src/routing/hardPendingBoundary.ts');
  establishHardPending(pinnedSession, {
    pendingKey: 'active_subject_clarify',
    reaskPrompt: 'which?',
    ownsReply: () => true,
    resume: async () => ({ status: 'noop', ack: 'ok' }),
  });
  await processUtterance('yes', pinnedSession, silent, null, pinnedMeds, null, null, null, null, null, null, pinnedRecovery);
  assert('pending does not erase a pinned medication set',
    pinnedMeds.peek()?.medicationIds.join(',') === 'med_metoprolol,med_lisinopril'
      && pinnedRecovery.peek()?.job === 'clarify_reference',
    (v) => v === true, 'pending keeps set');

  const staleMeds = new MedicationPresentationHolder();
  const staleRecovery = new RecoveryObligationHolder();
  staleMeds.establish(['med_metoprolol', 'med_lisinopril']);
  await processUtterance('zz reference', new ConversationSession(), applicable, null, staleMeds, null, null, null, null, null, null, staleRecovery);
  staleMeds.clear();
  await processUtterance('zz again', new ConversationSession(), applicable, null, staleMeds, null, null, null, null, null, null, staleRecovery);
  assert('a cleared set is not revived by the old obligation',
    staleMeds.peek() === null && staleRecovery.peek() === null,
    (v) => v === true, 'no revival');

  const total = passed + failures.length;
  console.log(`\n${BOLD}PresentedSetReferenceRecovery: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('presentedSetReferenceRecovery.test');
if (invokedDirectly) {
  runPresentedSetReferenceRecoveryTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
