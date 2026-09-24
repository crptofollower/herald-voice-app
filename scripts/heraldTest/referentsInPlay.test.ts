// Referents in Play — ambiguous phone read keeps candidate ids and does not speak a number.

import Database from 'better-sqlite3';
import { setDB, runMigrations } from '../../src/db/schema.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { admitReferentResolution } from '../../src/routing/canonicalConversationState.ts';
import { resolveBoundedPhoneReferent } from '../../src/routing/referentPhoneClarification.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function shim(db: Database.Database) {
  return {
    getAllSync: (s: string, p: unknown[] = []) => db.prepare(s).all(...p),
    getFirstSync: (s: string, p: unknown[] = []) => db.prepare(s).get(...p) ?? null,
    runSync: (s: string, p: unknown[] = []) => db.prepare(s).run(...p),
    execSync: (s: string) => db.exec(s),
  };
}

function seed(db: Database.Database, id: string, name: string, phone: string, importance: number, relationship: string | null = null) {
  const now = '2026-09-01T15:00:00.000Z';
  db.prepare(
    `INSERT INTO contacts (id, name, relationship, phone, importance, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, name, relationship, phone, importance, now, now);
}

export async function runReferentsInPlayTests() {
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

  console.log(`\n${BOLD}-- Referents in Play --${RESET}\n`);
  const db = new Database(':memory:');
  setDB(shim(db));
  await runMigrations();
  seed(db, 'j_b', 'Jordan Hale', '5125550101', 9);
  seed(db, 'j_a', 'Jordan Hale', '5125550199', 1);
  seed(db, 'solo', 'Linda', '5125550142', 4);

  const deps = { classifyQuery, classifyLLM: null, llmReady: false, llmStatus: 'unavailable' as const };
  const discourse = new DiscourseContinuityHolder();
  const recovery = new RecoveryObligationHolder();
  const session = new ConversationSession();
  const asked = await processUtterance("What's Jordan's number?", session, deps, null, null, null, null, null, discourse, null, null, recovery);
  const set = discourse.peekReferentsInPlay();
  assert('two same-name matches clarify without a phone or identical choices',
    asked.handled === true
      && asked.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/555|512|0101|0199/.test(asked.responseText ?? '')
      && !/Jordan Hale or Jordan Hale/i.test(asked.responseText ?? '')
      && /distinguishes/i.test(asked.responseText ?? '')
      && set?.candidateIds.join(',') === 'j_a,j_b'
      && !('relationship' in (set ?? {}))
      && recovery.peek()?.scope.kind === 'referents_in_play'
      && recovery.peek()?.scope.kind === 'referents_in_play'
      && recovery.peek()?.scope.setId === set?.setId
      && JSON.stringify(recovery.peek()?.scope).includes('candidateIds') === false
      && session.peekPendingKey() === null,
    (v) => v === true, 'clarify');

  const invented = admitReferentResolution('someone else', set!, 'not-a-contact', false);
  assert('an invented candidate id is not admitted', invented.kind === 'hold', (v) => v === true, 'hold');

  const ordinalBlocked = await processUtterance('the first one', session, deps, null, null, null, null, null, discourse, null, null, recovery);
  assert('ordinal does not select identical unnamed alternatives',
    ordinalBlocked.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/555|512|0101|0199/.test(ordinalBlocked.responseText ?? '')
      && discourse.peekReferentsInPlay()?.candidateIds.join(',') === 'j_a,j_b'
      && session.peekPendingKey() === null,
    (v) => v === true, 'ordinal held');

  seed(db, 's_a', 'Sam Rivera', '5125550171', 2, 'cousin');
  seed(db, 's_b', 'Sam Rivera', '5125550182', 8, 'coworker');
  const distinguishedDiscourse = new DiscourseContinuityHolder();
  const distinguishedRecovery = new RecoveryObligationHolder();
  const distinguishedSession = new ConversationSession();
  const distinguished = await processUtterance("What's Sam's number?", distinguishedSession, deps, null, null, null, null, null, distinguishedDiscourse, null, null, distinguishedRecovery);
  const distinguishedSet = distinguishedDiscourse.peekReferentsInPlay();
  assert('stored relationships distinguish same-name candidates',
    distinguished.responseAct?.kind === 'CLARIFY_REFERENCE'
      && /cousin/i.test(distinguished.responseText ?? '')
      && /coworker/i.test(distinguished.responseText ?? '')
      && !/0171|0182|555/.test(distinguished.responseText ?? '')
      && distinguishedSet?.candidateIds.join(',') === 's_a,s_b'
      && !JSON.stringify(distinguishedSet).includes('cousin'),
    (v) => v === true, 'relationship labels');

  const ordinal = await processUtterance('the first one', distinguishedSession, deps, null, null, null, null, null, distinguishedDiscourse, null, null, distinguishedRecovery);
  assert('ordinal selects only after a distinguishable presentation',
    ordinal.responseAct?.kind === 'ANSWER'
      && ordinal.responseText.includes('0171')
      && !ordinal.responseText.includes('0182')
      && distinguishedDiscourse.peekReferentsInPlay() === null
      && distinguishedSession.peekPendingKey() === null,
    (v) => v === true, 'ordered');

  const cousinDiscourse = new DiscourseContinuityHolder();
  const cousinRecovery = new RecoveryObligationHolder();
  const cousinSession = new ConversationSession();
  await processUtterance("What's Sam's number?", cousinSession, deps, null, null, null, null, null, cousinDiscourse, null, null, cousinRecovery);
  const sharedName = await processUtterance('Sam Rivera', cousinSession, deps, null, null, null, null, null, cousinDiscourse, null, null, cousinRecovery);
  assert('a shared name leaves both candidates unresolved',
    sharedName.responseAct?.kind === 'CLARIFY_REFERENCE'
      && !/0171|0182/.test(sharedName.responseText ?? '')
      && cousinDiscourse.peekReferentsInPlay()?.candidateIds.join(',') === 's_a,s_b',
    (v) => v === true, 'still ambiguous');

  const cousin = await processUtterance('my cousin', cousinSession, deps, null, null, null, null, null, cousinDiscourse, null, null, cousinRecovery);
  assert('a stored relationship selects only that member',
    cousin.responseAct?.kind === 'ANSWER'
      && cousin.responseText.includes('0171')
      && !cousin.responseText.includes('0182')
      && cousinDiscourse.peekReferentsInPlay() === null
      && cousinSession.peekPendingKey() === null,
    (v) => v === true, 'cousin');

  const outside = resolveBoundedPhoneReferent('Linda', [
    { id: 's_a', name: 'Sam Rivera', relationship: 'cousin' },
    { id: 's_b', name: 'Sam Rivera', relationship: 'coworker' },
  ]);
  assert('the bounded resolver cannot select an identity outside the set',
    outside.kind === 'none',
    (v) => v === true, 'none');

  seed(db, 'r_a', 'Riley Chen', '5125550133', 3);
  seed(db, 'r_b', 'Riley Chen', '5125550144', 6);
  db.prepare('UPDATE contacts SET location = ? WHERE id = ?').run('Austin', 'r_a');
  db.prepare('UPDATE contacts SET location = ? WHERE id = ?').run('Dallas', 'r_b');
  const placeDiscourse = new DiscourseContinuityHolder();
  const placeRecovery = new RecoveryObligationHolder();
  const placeSession = new ConversationSession();
  const placed = await processUtterance("What's Riley's number?", placeSession, deps, null, null, null, null, null, placeDiscourse, null, null, placeRecovery);
  assert('stored locations distinguish same-name candidates',
    placed.responseAct?.kind === 'CLARIFY_REFERENCE'
      && /Austin/i.test(placed.responseText ?? '')
      && /Dallas/i.test(placed.responseText ?? '')
      && !/0133|0144|555/.test(placed.responseText ?? '')
      && placeDiscourse.peekReferentsInPlay()?.candidateIds.join(',') === 'r_a,r_b',
    (v) => v === true, 'locations');
  const austin = await processUtterance('the one in Austin', placeSession, deps, null, null, null, null, null, placeDiscourse, null, null, placeRecovery);
  assert('a stored location selects only that member',
    austin.responseAct?.kind === 'ANSWER'
      && austin.responseText.includes('0133')
      && !austin.responseText.includes('0144')
      && placeDiscourse.peekReferentsInPlay() === null
      && placeSession.peekPendingKey() === null,
    (v) => v === true, 'austin');

  seed(db, 'n_a', 'Noah Blake', '5125550155', 2);
  seed(db, 'n_b', 'Noah Blake', '5125550166', 7);
  db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run('piano teacher', 'n_a');
  db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run('neighbor', 'n_b');
  const notesDiscourse = new DiscourseContinuityHolder();
  const notesAsked = await processUtterance("What's Noah's number?", new ConversationSession(), deps, null, null, null, null, null, notesDiscourse, null, null, new RecoveryObligationHolder());
  assert('notes are not presented as a resolvable distinction',
    /distinguishes/i.test(notesAsked.responseText ?? '')
      && !/piano|neighbor/i.test(notesAsked.responseText ?? '')
      && !/0155|0166/.test(notesAsked.responseText ?? '')
      && notesDiscourse.peekReferentsInPlay()?.candidateIds.join(',') === 'n_a,n_b',
    (v) => v === true, 'notes withheld');

  const one = await processUtterance("What's Linda's number?", new ConversationSession(), deps, null, null, null, null, null, new DiscourseContinuityHolder(), null, null, new RecoveryObligationHolder());
  assert('one match still speaks the stored number',
    one.handled === false && one.routeDecision.kind === 'device_read' && one.routeDecision.response.includes('512') && one.routeDecision.response.includes('0142'),
    (v) => v === true, 'linda');

  const none = await processUtterance("What's Xavier's number?", new ConversationSession(), deps);
  assert('zero matches invent no number',
    none.handled === false && none.routeDecision.kind === 'device_read' && !/555|512/.test(none.routeDecision.response),
    (v) => v === true, 'miss');

  const cancelDiscourse = new DiscourseContinuityHolder();
  const cancelRecovery = new RecoveryObligationHolder();
  const cancelSession = new ConversationSession();
  await processUtterance("What's Jordan's number?", cancelSession, deps, null, null, null, null, null, cancelDiscourse, null, null, cancelRecovery);
  const cancelled = await processUtterance('cancel', cancelSession, deps, null, null, null, null, null, cancelDiscourse, null, null, cancelRecovery);
  assert('cancel clears the referent set',
    cancelled.responseAct?.kind === 'CANCELLED' && cancelDiscourse.peekReferentsInPlay() === null && cancelRecovery.peek() === null,
    (v) => v === true, 'cleared');

  const lawDiscourse = new DiscourseContinuityHolder();
  const lawRecovery = new RecoveryObligationHolder();
  await processUtterance("What's Jordan's number?", new ConversationSession(), deps, null, null, null, null, null, lawDiscourse, null, null, lawRecovery);
  const emergency = await processUtterance('help me', new ConversationSession(), deps, null, null, null, null, null, lawDiscourse, null, null, lawRecovery);
  assert('law 0 clears the referent set',
    emergency.handled === true && emergency.source === 'emergency' && lawDiscourse.peekReferentsInPlay() === null,
    (v) => v === true, 'law 0');

  const pendingDiscourse = new DiscourseContinuityHolder();
  const pendingRecovery = new RecoveryObligationHolder();
  const pendingSession = new ConversationSession();
  await processUtterance("What's Jordan's number?", pendingSession, deps, null, null, null, null, null, pendingDiscourse, null, null, pendingRecovery);
  const { establishHardPending } = await import('../../src/routing/hardPendingBoundary.ts');
  establishHardPending(pendingSession, {
    pendingKey: 'active_subject_clarify',
    reaskPrompt: 'which?',
    ownsReply: () => true,
    resume: async () => ({ status: 'noop', ack: 'ok' }),
  });
  await processUtterance('yes', pendingSession, deps, null, null, null, null, null, pendingDiscourse, null, null, pendingRecovery);
  assert('pending does not erase a still-valid referent set',
    pendingDiscourse.peekReferentsInPlay()?.candidateIds.join(',') === 'j_a,j_b' && pendingRecovery.peek()?.scope.kind === 'referents_in_play',
    (v) => v === true, 'kept');

  seed(db, 'd1', 'Maya', '5125550111', 8, 'daughter');
  seed(db, 'd2', 'Priya', '5125550122', 4, 'daughter');
  const familyDiscourse = new DiscourseContinuityHolder();
  const familyRecovery = new RecoveryObligationHolder();
  const familySession = new ConversationSession();
  const familySubject = new ConversationalSubjectHolder();
  await processUtterance("What's Jordan's number?", familySession, deps, familySubject, null, null, null, null, familyDiscourse, null, null, familyRecovery);
  const daughters = await processUtterance('Who is my daughter?', familySession, deps, familySubject, null, null, null, null, familyDiscourse, null, null, familyRecovery);
  const presented = familyDiscourse.peekReferentsInPlay();
  assert('a plural family read keeps both contact ids and does not ask for a choice',
    daughters.handled === false
      && daughters.responseAct?.kind === 'ANSWER_WITH_PROVENANCE'
      && /Maya/.test(daughters.routeDecision.kind === 'device_read' ? daughters.routeDecision.response : '')
      && /Priya/.test(daughters.routeDecision.kind === 'device_read' ? daughters.routeDecision.response : '')
      && presented?.purpose.kind === 'presented_people'
      && presented.candidateIds.join(',') === 'd1,d2'
      && familyRecovery.peek() === null
      && familySession.peekPendingKey() === null
      && familySubject.peek() === null,
    (v) => v === true, 'presented people');

  const seenPrompts: string[] = [];
  const applicableDeps = {
    ...deps,
    getMedicationSemanticInterpreterCtx: () => ({
      completion: async (params: { prompt: string }) => {
        seenPrompts.push(params.prompt);
        return { text: 'applicable' };
      },
    }),
  };
  const her = await processUtterance("What's her number?", familySession, applicableDeps, familySubject, null, null, null, null, familyDiscourse, null, null, familyRecovery);
  const blocked = familyDiscourse.peekReferentsInPlay();
  assert('a reference proposal clarifies both daughters without a number or their private facts in the packet',
    her.responseAct?.kind === 'CLARIFY_REFERENCE'
      && /Maya/.test(her.responseText ?? '')
      && /Priya/.test(her.responseText ?? '')
      && !/0111|0122|555|0101|0199/.test(her.responseText ?? '')
      && blocked?.purpose.kind === 'read_phone'
      && blocked.candidateIds.join(',') === 'd1,d2'
      && familyRecovery.peek()?.scope.kind === 'referents_in_play'
      && familyRecovery.peek()?.scope.kind === 'referents_in_play'
      && familyRecovery.peek()?.scope.setId === blocked.setId
      && familySession.peekPendingKey() === null
      && seenPrompts.some((prompt) => !/Maya|Priya|daughter|512|0111|0122/.test(prompt)),
    (v) => v === true, 'clarify daughters');

  const picked = await processUtterance('Maya', familySession, deps, familySubject, null, null, null, null, familyDiscourse, null, null, familyRecovery);
  assert('the named daughter is read from stored contact data',
    picked.responseAct?.kind === 'ANSWER'
      && picked.responseText.includes('0111')
      && !picked.responseText.includes('0122')
      && familyDiscourse.peekReferentsInPlay() === null
      && familySession.peekPendingKey() === null,
    (v) => v === true, 'maya number');

  seed(db, 'evan', 'Evan', '5125550130', 5, 'son');
  const oneSubject = new ConversationalSubjectHolder();
  const oneDiscourse = new DiscourseContinuityHolder();
  const oneSon = await processUtterance('Who is my son?', new ConversationSession(), deps, oneSubject, null, null, null, null, oneDiscourse, null, null, new RecoveryObligationHolder());
  assert('one family match still establishes working focus and no referent set',
    oneSon.routeDecision.kind === 'device_read'
      && /Evan/.test(oneSon.routeDecision.response)
      && oneSubject.peek()?.entityId === 'evan'
      && oneDiscourse.peekReferentsInPlay() === null,
    (v) => v === true, 'one son');

  const noneFamily = await processUtterance('Who is my brother?', new ConversationSession(), deps, null, null, null, null, null, new DiscourseContinuityHolder(), null, null, new RecoveryObligationHolder());
  assert('zero family matches invent no person',
    noneFamily.routeDecision.kind === 'device_read'
      && /don't have your brother/i.test(noneFamily.routeDecision.response),
    (v) => v === true, 'no brother');

  const total = passed + failures.length;
  console.log(`\n${BOLD}ReferentsInPlay: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('referentsInPlay.test');
if (invokedDirectly) {
  runReferentsInPlayTests().then((r) => process.exit(r.failed ? 1 : 0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
