// Slice 6 — one semantic proposal seam, opaque packet, no second classifier.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildOpaqueHandleMap,
  buildSemanticPacket,
  packetContainsPersonalDump,
  proposeLocalClassification,
  resolveProposedHandle,
} from '../../src/routing/semanticProvider.ts';
import { buildAskWireBody } from '../../src/api/herald.ts';
import { applyWorldContext, worldContextForLiveSignal, NO_WORLD_CONTEXT } from '../../src/routing/worldContextNeed.ts';
import { admitDispatchedSemanticRead } from '../../src/routing/semanticAdmission.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import { projectRealization, clarifyReferenceAct } from '../../src/routing/responseAct.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { establishHardPending } from '../../src/routing/hardPendingBoundary.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

export async function runConversationOrchestratorSlice6Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 6 --${RESET}\n`);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/routing/semanticProvider.ts'), 'utf8');
  const specialists = [
    'src/routing/medicationSemanticInterpretation.ts',
    'src/routing/grocerySemanticDecomposition.ts',
    'src/routing/todoSemanticCapture.ts',
    'src/routing/capabilityRouting.ts',
    'src/routing/activeSubjectReference.ts',
    'src/routing/immediateSemanticRecap.ts',
    'src/routing/recollectionSemanticNomination.ts',
    'src/routing/recollectionConversationFlow.ts',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
  assert('specialists reach the model only through the provider',
    specialists.every((src) => (src.includes('runSpecialistInference(') || src.includes('completeBoundedInterpretation(')) && !src.includes('runSharedSemanticCompletion') && !src.includes('.completion(') && !src.includes('classifyWithLLM')),
    (v) => v === true, 'provider boundary');
  assert('ChatScreen classifies only through the provider seam',
    (chat.match(/proposeLocalClassification\(/g) ?? []).length === 2 && !chat.includes('classifyWithLLM('),
    (v) => v === true, 'two seam calls, no direct classifier');
  assert('the second classification pass is gone', !chat.includes('alreadyClassifiedByRouteIntent'),
    (v) => v === true, 'no second-pass gate');
  assert('the provider does not import writers or pending establishment',
    !provider.includes('establishHardPending') && !provider.includes('DOMAIN_WRITERS') && !provider.includes('applyIntents'),
    (v) => v === true, 'proposal only');

  const built = buildOpaqueHandleMap([
    { localId: 'person-secret', typeTag: 'person' },
    { localId: 'med-secret', typeTag: 'medication_list' },
  ]);
  const packet = buildSemanticPacket({
    userText: 'Add milk',
    refs: built.refs,
    hardPending: false,
    riskTier: 'write',
  });
  assert('personal entities are opaque handles',
    packet.refs[0].handle === 'ref_1' && packet.refs[0].typeTag === 'person' && !JSON.stringify(packet).includes('person-secret'),
    (v) => v === true, 'ref_1 person');
  assert('the packet has no recent evidence or transcript field',
    !('recentEvidence' in packet) && !packetContainsPersonalDump(packet),
    (v) => v === true, 'closed packet');

  const resolved = resolveProposedHandle({ status: 'proposal', handle: 'ref_1', typeTag: 'person' }, built.local, 'person');
  assert('a known handle resolves only through the local map',
    resolved.ok === true && resolved.ok && resolved.localId === 'person-secret',
    (v) => v === true, 'local id');
  const invented = resolveProposedHandle({ status: 'proposal', handle: 'ref_9', typeTag: 'person' }, built.local, 'person');
  assert('an invented handle is rejected', invented.ok === false && !invented.ok && invented.reason === 'unknown_handle',
    (v) => v === true, 'unknown');
  const mismatch = resolveProposedHandle({ status: 'proposal', handle: 'ref_2', typeTag: 'person' }, built.local, 'person');
  assert('a wrong-domain handle is rejected', mismatch.ok === false && !mismatch.ok && mismatch.reason === 'domain_mismatch',
    (v) => v === true, 'mismatch');
  assert('two eligible handles are not chosen by confidence',
    built.refs.length === 2 && resolveProposedHandle({ status: 'proposal', handle: 'ref_1' }, built.local).ok === true
      && resolveProposedHandle({ status: 'proposal', handle: 'ref_2' }, built.local, 'person').ok === false,
    (v) => v === true, 'no silent choice');

  const session = new ConversationSession();
  establishHardPending(session, { pendingKey: 'medical_capture', resume: async () => ({ status: 'noop', ack: 'Saved.' }) });
  assert('a proposal does not clear hard pending', session.hasPending() && session.peekPendingKey() === 'medical_capture',
    (v) => v === true, 'pending');
  const recovery = new RecoveryObligationHolder();
  assert('a proposal does not create a soft obligation', recovery.peek() === null,
    (v) => v === true, 'no obligation');
  const failed = resolveProposedHandle({ status: 'failed', reason: 'timeout' }, built.local);
  assert('provider failure does not resolve a handle', failed.ok === false, (v) => v === true, 'failed');
  const offline = await proposeLocalClassification('Add milk', null);
  assert('a missing local model abstains without a cloud call', offline.status === 'not_ready',
    (v) => v === true, 'not_ready');
  const act = clarifyReferenceAct("I'm not sure which one you mean.");
  assert('provider prose does not replace the selected act',
    projectRealization(act, 'Which one?').speech === act.text && act.kind === 'CLARIFY_REFERENCE',
    (v) => v === true, 'act kept');
  const heraldSrc = fs.readFileSync(path.join(root, 'src/api/herald.ts'), 'utf8');
  const noneFields = applyWorldContext(NO_WORLD_CONTEXT, { localTime: '12:00', localDate: '2026-09-23', lat: 30, lng: -97, locationLabel: 'Home' });
  const noneBody = buildAskWireBody({
    user_id: 'u1',
    message: 'what is the stock price',
    ...noneFields,
    history: [{ role: 'user', content: 'secret transcript' }],
    device_context: 'medical record',
  } as never);
  assert('no declared need sends no clock or location',
    noneFields.lat === undefined && noneFields.local_time === undefined && noneBody.lat === undefined && noneBody.history === undefined,
    (v) => v === true, 'closed');
  const dateNeed = worldContextForLiveSignal(0);
  const dateFields = applyWorldContext(dateNeed, { localTime: '12:00', localDate: '2026-09-23', lat: 30.1, lng: -97.7, locationLabel: 'Austin' });
  assert('the weather signal asks for a date and precise location, not the clock',
    dateNeed.time === 'local_date' && dateNeed.location === 'precise' && dateFields.local_date === '2026-09-23' && dateFields.local_time === undefined && dateFields.lat === 30.1,
    (v) => v === true, 'weather need');
  assert('transport does not infer need from prose',
    !heraldSrc.includes('backendDisclosureNeeds') && !heraldSrc.includes('.test(message)') && !heraldSrc.includes('.test(text)'),
    (v) => v === true, 'no phrase fence');
  assert('admission still refuses an unfenced contact call',
    admitDispatchedSemanticRead(
      { capability: 'contact.call', confidence: 'high' },
      { eligible: true, reason: 'instruction' },
      'call them',
    ).decision === 'ABSTAIN',
    (v) => v === true, 'abstain');

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice6: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice6');
if (invokedDirectly) {
  runConversationOrchestratorSlice6Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
