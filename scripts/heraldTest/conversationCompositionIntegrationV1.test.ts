// Conversation composition seam. Semantic applicability is not authority.
// A failed interpretation retains ground. It does not write or execute.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { setDB, runMigrations, getDB } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { MedicationPresentationHolder } from '../../src/routing/medicationPresentation.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { admitGroundedContinuation } from '../../src/routing/workingFocusReference.ts';
import {
  beginSemanticProof,
  finishSemanticProof,
} from '../../src/dev/semanticJourneyEvidence.ts';
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

function ctxReturning(text: string) {
  return {
    completion: async () => ({ text }),
  };
}

function depsWith(ctx: { completion: (params: unknown) => Promise<unknown> } | null) {
  return {
    classifyQuery,
    classifyLLM: null,
    llmReady: false,
    llmStatus: 'unavailable' as const,
    getMedicationSemanticInterpreterCtx: () => ctx,
  };
}

function openItems(): string[] {
  return getDB().getAllSync<{ body: string }>(
    'SELECT body FROM list_items WHERE removed_at IS NULL',
  ).map((row) => row.body);
}

export async function runConversationCompositionIntegrationV1Tests() {
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

  console.log(`\n${BOLD}-- Conversation composition integration --${RESET}\n`);
  const admissionSrc = fs.readFileSync(path.join(ROOT, 'src/routing/workingFocusReference.ts'), 'utf8');
  assert('admission does not parse wording, names, or pronouns',
    !admissionSrc.includes('RegExp') && !admissionSrc.includes('.test(') && !/patel|maya|him\b/i.test(admissionSrc),
    (v) => v === true, 'no grammar');

  const one = { domain: 'medical_doctor', entityId: 'Dr. Patel', displayName: 'Dr. Patel' };
  const two = { domain: 'medical_doctor', entityId: 'Dr. Shah', displayName: 'Dr. Shah' };
  assert('one grounded focus is admitted from applicability',
    admitGroundedContinuation({ applicable: true }, {
      interpretationFailed: false,
      focuses: [one],
      presentedSets: [],
      referents: [],
    }).kind === 'admit_focus',
    (v) => v === true, 'admit_focus');
  assert('two personal referents clarify',
    admitGroundedContinuation({ applicable: true }, {
      interpretationFailed: false,
      focuses: [],
      presentedSets: [],
      referents: [{ entityId: 'd1' }, { entityId: 'd2' }],
    }).kind === 'clarify',
    (v) => v === true, 'clarify');
  assert('two presented sets clarify',
    admitGroundedContinuation({ applicable: true }, {
      interpretationFailed: false,
      focuses: [],
      presentedSets: [
        { domain: 'medication', setId: 'medication:a|b', memberIds: ['a', 'b'] },
        { domain: 'grocery', setId: 'grocery:g1|g2', memberIds: ['g1', 'g2'] },
      ],
      referents: [],
    }).kind === 'clarify',
    (v) => v === true, 'clarify');
  assert('a failed interpretation retains ground and admits nobody',
    admitGroundedContinuation(null, {
      interpretationFailed: true,
      focuses: [one],
      presentedSets: [],
      referents: [],
    }).kind === 'retain',
    (v) => v === true, 'retain');
  assert('explicit non-applicability does not admit',
    admitGroundedContinuation({ applicable: false }, {
      interpretationFailed: false,
      focuses: [one, two],
      presentedSets: [],
      referents: [],
    }).kind === 'none',
    (v) => v === true, 'none');
  assert('one stored medication member is the admitted candidate',
    admitGroundedContinuation({ applicable: true }, {
      interpretationFailed: false,
      focuses: [],
      presentedSets: [{ domain: 'medication', setId: 'medication:m1', memberIds: ['m1'] }],
      referents: [],
    }).kind === 'admit_member',
    (v) => v === true, 'admit_member');

  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  const now = '2026-09-01T15:00:00.000Z';
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('visit_patel', '2026-09-01', 'Dr. Patel', 'Checkup', now);
  db.prepare(
    `INSERT INTO medical_records (id, visit_date, doctor_name, notes, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('visit_shah', '2026-08-01', 'Dr. Shah', 'Follow-up', now);
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, '50mg', 'daily', 1, ?, NULL)`,
  ).run('med_metoprolol', 'metoprolol', now);
  db.prepare(
    `INSERT INTO medications (id, name, dosage, frequency, is_active, created_at, removed_at)
     VALUES (?, ?, '50mg', 'daily', 1, ?, NULL)`,
  ).run('med_lisinopril', 'lisinopril', now);
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run('d1', 'Maya', 'daughter', '5125550111', 8, now, now);
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run('d2', 'Priya', 'daughter', '5125550122', 4, now, now);

  const applicable = depsWith(ctxReturning('applicable'));
  const notReference = depsWith(ctxReturning('not'));
  const silent = depsWith(null);

  const subject = new ConversationalSubjectHolder();
  subject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  beginSemanticProof('composition-focus');
  const followed = await processUtterance('zz reference', new ConversationSession(), applicable, subject);
  const proof = finishSemanticProof();
  assert('unique working focus is re-read by the visit reader',
    followed.handled === true
      && followed.responseText.includes('Patel')
      && /last saw/i.test(followed.responseText)
      && followed.responseText !== 'applicable'
      && followed.responseAct?.kind === 'ANSWER'
      && followed.responseAct.epistemic === 'deterministic_read'
      && subject.peek()?.entityId === 'Dr. Patel',
    (v) => v === true, 'reader');
  assert('proof records applicability then unique admission',
    proof?.invocations[0]?.status === 'applicable'
      && proof.invocations[0]?.identifiesEntity === false
      && proof.admissions[0]?.mechanism === 'working_focus'
      && proof.admissions[0]?.resolution === 'unique'
      && proof.admissions[0]?.candidateAdmitted === true
      && !JSON.stringify(proof).includes('512555'),
    (v) => v === true, 'proof');

  const people = new DiscourseContinuityHolder();
  people.establishReferentsInPlay(['d1', 'd2'], 'presented_people');
  const many = await processUtterance('zz reference', new ConversationSession(), applicable, null, null, null, null, null, people);
  assert('multiple personal referents clarify and speak no number',
    many.handled === true
      && many.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/512|555|0111|0122/.test(many.responseText ?? '')
      && people.peekReferentsInPlay()?.candidateIds.join(',') === 'd1,d2',
    (v) => v === true, 'clarify people');

  const meds = new MedicationPresentationHolder();
  const grocery = new OrderedPresentationHolder();
  meds.establish(['med_metoprolol', 'med_lisinopril']);
  grocery.establish('grocery', ['g1', 'g2']);
  const competing = await processUtterance(
    'zz reference',
    new ConversationSession(),
    applicable,
    null,
    meds,
    grocery,
  );
  assert('competing presented sets clarify and the proposal picks neither',
    competing.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/metoprolol|lisinopril|g1|g2/i.test(competing.responseText ?? '')
      && meds.peek()?.medicationIds.length === 2
      && grocery.hasLive(),
    (v) => v === true, 'competing sets');

  const sideSubject = new ConversationalSubjectHolder();
  sideSubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const beforeMilk = openItems().length;
  const milk = await processUtterance(
    'Add milk to my grocery list.',
    new ConversationSession(),
    notReference,
    sideSubject,
  );
  assert('a non-reference grocery add writes milk and keeps the doctor focus',
    milk.handled === true
      && openItems().includes('milk')
      && openItems().length === beforeMilk + 1
      && sideSubject.peek()?.entityId === 'Dr. Patel'
      && !(milk.responseText ?? '').toLowerCase().includes('patel'),
    (v) => v === true, 'focus preserved');

  const blocked = new ConversationalSubjectHolder();
  blocked.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const beforeEggs = openItems();
  const eggs = await processUtterance(
    'Add eggs to my grocery list.',
    new ConversationSession(),
    applicable,
    blocked,
  );
  assert('applicability alone does not authorize the grocery write',
    !openItems().includes('eggs')
      && openItems().join(',') === beforeEggs.join(',')
      && eggs.handled === true
      && eggs.responseText.includes('Patel')
      && eggs.responseText !== 'applicable',
    (v) => v === true, 'no eggs');

  const failedSubject = new ConversationalSubjectHolder();
  failedSubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const failedRecovery = new RecoveryObligationHolder();
  const beforeBread = openItems();
  const failed = await processUtterance(
    'Add bread to my grocery list.',
    new ConversationSession(),
    depsWith({ completion: async () => { throw new Error('semantic down'); } }),
    failedSubject,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    failedRecovery,
  );
  assert('a semantic error does not write, execute, or drop the focus',
    !openItems().includes('bread')
      && openItems().join(',') === beforeBread.join(',')
      && failed.handled === true
      && failed.responseAct?.kind === 'CLARIFY_REFERENCE'
      && failed.responseText !== 'semantic down'
      && failedSubject.peek()?.entityId === 'Dr. Patel'
      && failedRecovery.peek()?.job === 'clarify_reference'
      && failedRecovery.peek()?.scope.kind === 'working_focus',
    (v) => v === true, 'error retains');

  const garbledSubject = new ConversationalSubjectHolder();
  garbledSubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const garbledRecovery = new RecoveryObligationHolder();
  const garbled = await processUtterance(
    'Add cheese to my grocery list.',
    new ConversationSession(),
    depsWith(ctxReturning('banana')),
    garbledSubject,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    garbledRecovery,
  );
  assert('an unrecognized proposal does not write or clear the focus',
    !openItems().includes('cheese')
      && garbled.responseAct?.kind === 'CLARIFY_REFERENCE'
      && garbledSubject.peek()?.entityId === 'Dr. Patel'
      && garbledRecovery.peek()?.scope.kind === 'working_focus',
    (v) => v === true, 'unrecognized retains');

  const repairMeds = new MedicationPresentationHolder();
  const repairRecovery = new RecoveryObligationHolder();
  repairMeds.establish(['med_metoprolol', 'med_lisinopril']);
  const unresolved = await processUtterance(
    'zz reference',
    new ConversationSession(),
    applicable,
    null,
    repairMeds,
    null,
    null,
    null,
    null,
    null,
    null,
    repairRecovery,
  );
  const refined = await processUtterance(
    'the first one',
    new ConversationSession(),
    applicable,
    null,
    repairMeds,
    null,
    null,
    null,
    null,
    null,
    null,
    repairRecovery,
  );
  assert('an unresolved reference stays grounded for a later deterministic refinement',
    unresolved.responseAct?.kind === 'CLARIFY_REFERENCE'
      && /metoprolol/i.test(unresolved.responseText ?? '')
      && /lisinopril/i.test(unresolved.responseText ?? '')
      && refined.handled === true
      && /metoprolol/i.test(refined.responseText ?? '')
      && !/lisinopril/i.test(refined.responseText ?? '')
      && repairMeds.peek()?.medicationIds.includes('med_metoprolol')
      && openItems().join(',') === openItems().filter((item) => item !== 'metoprolol').join(','),
    (v) => v === true, 'refined');

  const shift = new ConversationalSubjectHolder();
  shift.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const shifted = await processUtterance(
    'When did I last see Dr. Shah?',
    new ConversationSession(),
    notReference,
    shift,
  );
  assert('an explicit other doctor supersedes the previous focus',
    shifted.handled === false
      && shifted.routeDecision.kind === 'device_read'
      && shifted.routeDecision.response.includes('Shah')
      && shift.peek()?.entityId === 'Dr. Shah',
    (v) => v === true, 'Shah');

  const solo = new MedicationPresentationHolder();
  solo.establish(['med_metoprolol']);
  const admittedMed = await processUtterance(
    'zz reference',
    new ConversationSession(),
    applicable,
    null,
    solo,
  );
  assert('the one grounded medication is read by the medication reader',
    admittedMed.handled === true
      && admittedMed.responseAct?.kind === 'ANSWER'
      && admittedMed.responseAct.epistemic === 'deterministic_read'
      && /metoprolol/i.test(admittedMed.responseText ?? '')
      && admittedMed.responseText !== 'applicable'
      && solo.peek()?.medicationIds.join(',') === 'med_metoprolol',
    (v) => v === true, 'one medication');

  const missingSubject = new ConversationalSubjectHolder();
  missingSubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const beforeJuice = openItems();
  const juice = await processUtterance(
    'Add juice to my grocery list.',
    new ConversationSession(),
    silent,
    missingSubject,
  );
  assert('a missing semantic context still performs the deterministic grocery write',
    openItems().includes('juice')
      && openItems().length === beforeJuice.length + 1
      && missingSubject.peek()?.entityId === 'Dr. Patel',
    (v) => v === true, 'ctx missing falls through');

  const chat = fs.readFileSync(path.join(ROOT, 'src/screens/ChatScreen.tsx'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src/dev/androidJourneyHost.ts'), 'utf8');
  assert('the journey proof still chains state and the response act around sendMessage',
    chat.includes('noteCanonicalState')
      && chat.includes('noteSemanticExecution')
      && chat.includes('authoritativeRead')
      && host.includes('beginSemanticProof')
      && host.includes('semantic,'),
    (v) => v === true, 'proof wired');

  resetSemanticCompletionLifecycleForTests();
  const timeoutSubject = new ConversationalSubjectHolder();
  timeoutSubject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
  const timeoutRecovery = new RecoveryObligationHolder();
  const beforeTimeout = openItems();
  let timed: Awaited<ReturnType<typeof processUtterance>> | null = null;
  try {
    timed = await processUtterance(
      'Add rice to my grocery list.',
      new ConversationSession(),
      depsWith({ completion: () => new Promise(() => {}) }),
      timeoutSubject,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      timeoutRecovery,
    );
  } finally {
    resetSemanticCompletionLifecycleForTests();
  }
  assert('a semantic timeout does not write or drop the focus',
    timed != null
      && !openItems().includes('rice')
      && openItems().join(',') === beforeTimeout.join(',')
      && timed.responseAct?.kind === 'CLARIFY_REFERENCE'
      && timeoutSubject.peek()?.entityId === 'Dr. Patel'
      && timeoutRecovery.peek()?.scope.kind === 'working_focus',
    (v) => v === true, 'timeout retains');

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationCompositionIntegrationV1: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationCompositionIntegrationV1.test');
if (invokedDirectly) {
  runConversationCompositionIntegrationV1Tests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
