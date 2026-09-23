// Slice 2 — one hard Pending Authority establishment boundary.
// ConversationSession stays the store. This file does not redesign confirmation.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationalSubjectHolder } from '../../src/routing/conversationalSubject.ts';
import { OrderedPresentationHolder } from '../../src/routing/orderedPresentation.ts';
import { RecoveryObligationHolder } from '../../src/routing/recoveryObligation.ts';
import {
  ACTIVE_SUBJECT_CLARIFY_KEY,
  CONTACT_COLLECT_PENDING_KEY,
  armContactCollect,
  contactCollectOwnsTurn,
  establishActiveSubjectClarification,
  establishHardPending,
  readHardPendingReference,
  releaseContactCollect,
} from '../../src/routing/hardPendingBoundary.ts';
import { admitStructuralOrdinal, presentedSet } from '../../src/routing/canonicalConversationState.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

export async function runConversationOrchestratorSlice2Tests() {
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

  console.log(`\n${BOLD}-- Conversation Orchestrator Slice 2 --${RESET}\n`);

  const callers = walk(path.join(root, 'src')).filter((file) => fs.readFileSync(file, 'utf8').includes('.setPending('));
  assert('production has one setPending call site', callers.map((file) => path.basename(file)),
    (v) => Array.isArray(v) && v.length === 1 && v[0] === 'hardPendingBoundary.ts',
    'hardPendingBoundary.ts');

  const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
  assert('active_subject_clarify is established through the boundary', chat.includes('establishActiveSubjectClarification('),
    (v) => v === true, 'boundary call');
  assert('contact collection still opens sms and tel itself', chat.includes('sms:${') && chat.includes('tel:${') && chat.includes("No problem — I won't call 911."),
    (v) => v === true, 'sms, tel, 911 decline');
  assert('soft obligation module does not establish hard pending',
    fs.readFileSync(path.join(root, 'src/routing/recoveryObligation.ts'), 'utf8').includes('establishHardPending'),
    (v) => v === false, 'no hard-pending import');

  {
    const session = new ConversationSession();
    establishHardPending(session, { pendingKey: 'first', resume: async () => ({ status: 'noop', ack: 'a' }) });
    establishHardPending(session, { pendingKey: 'second', resume: async () => ({ status: 'noop', ack: 'b' }) });
    assert('a second establishment replaces the one slot', session.peekPendingKey() === 'second' && readHardPendingReference(session)?.pendingKey === 'second',
      (v) => v === true, 'second');
    const view = readHardPendingReference(session) as Record<string, unknown> | null;
    assert('the pending reference exposes no resume or payload', view !== null && !('resume' in view) && Object.keys(view).join(',') === 'pendingKey',
      (v) => v === true, 'pendingKey only');
  }

  {
    const session = new ConversationSession();
    establishActiveSubjectClarification(session, async () => ({ status: 'noop', ack: 'Which person?', referenceOnly: true }));
    assert('active subject clarification uses the existing key', session.peekPendingKey(),
      (v) => v === ACTIVE_SUBJECT_CLARIFY_KEY, ACTIVE_SUBJECT_CLARIFY_KEY);
  }

  {
    const session = new ConversationSession();
    const ref: { current: { action: 'confirm_call'; name: string; phone: string } | null } = { current: null };
    armContactCollect(session, ref, { action: 'confirm_call', name: '911', phone: '911' });
    assert('contact collection arms the one pending slot', session.peekPendingKey() === CONTACT_COLLECT_PENDING_KEY && ref.current?.phone === '911',
      (v) => v === true, 'contact_collect / 911');
    assert('that armed collection owns the turn', contactCollectOwnsTurn(session, ref.current),
      (v) => v === true, 'owns');
    releaseContactCollect(session, ref);
    assert('releasing collection clears the slot and the payload', !session.hasPending() && ref.current === null,
      (v) => v === true, 'cleared');
    const stray: { current: { action: 'navigate'; name: string } | null } = { current: { action: 'navigate', name: 'Ada' } };
    assert('a navigate payload without the pending slot cannot own the turn', contactCollectOwnsTurn(session, stray.current),
      (v) => v === false, 'not an owner');
  }

  {
    const session = new ConversationSession();
    let calls = 0;
    armContactCollect(session, { current: null }, { action: 'text', name: 'Ada' });
    establishHardPending(session, {
      pendingKey: CONTACT_COLLECT_PENDING_KEY,
      resume: async () => {
        calls += 1;
        return { status: 'noop', ack: '' };
      },
    });
    const outcome = await processUtterance('I need help', session, {
      classifyQuery: async () => { throw new Error('classifier must not run'); },
      classifyLLM: null,
      llmReady: false,
      llmStatus: 'unavailable',
      captureContext: { contacts: [], lists: [] },
    });
    assert('Law 0 clears contact collection without resuming it', outcome.handled === true && outcome.source === 'emergency' && !session.hasPending() && calls === 0,
      (v) => v === true, 'emergency, pending cleared, resume not called');
  }

  {
    const session = new ConversationSession();
    let calls = 0;
    establishHardPending(session, {
      pendingKey: 'medical_capture',
      resume: async () => {
        calls += 1;
        return { status: 'committed', ack: 'Saved.' };
      },
    });
    const first = await session.resolvePending('yes');
    const second = await session.resolvePending('yes');
    assert('confirmation runs the pending resume once', calls === 1 && first.status === 'committed' && second.status === 'noop' && !session.hasPending(),
      (v) => v === true, 'one commit, then noop');
  }

  {
    const session = new ConversationSession();
    const subject = new ConversationalSubjectHolder();
    const ordered = new OrderedPresentationHolder();
    const recovery = new RecoveryObligationHolder();
    subject.establishMedical({ entityId: 'Dr. Patel', displayName: 'Dr. Patel' });
    ordered.establish('grocery', ['item_a', 'item_b']);
    recovery.establish();
    establishHardPending(session, { pendingKey: 'medical_capture', resume: async () => ({ status: 'committed', ack: 'Saved.' }) });
    const cancelled = await session.resolvePending('cancel');
    assert('cancel clears the hard pending and nothing else',
      cancelled.status === 'noop'
        && !session.hasPending()
        && subject.peek()?.displayName === 'Dr. Patel'
        && ordered.hasLive()
        && recovery.peek() !== null,
      (v) => v === true, 'pending gone, focus set and recovery remain');
  }

  {
    const session = new ConversationSession();
    const recovery = new RecoveryObligationHolder();
    recovery.establish();
    assert('a live soft obligation does not create hard pending', !session.hasPending() && readHardPendingReference(session) === null && recovery.peek() !== null,
      (v) => v === true, 'no pending');
  }

  {
    const admission = admitStructuralOrdinal('the second one', [
      presentedSet('calendar', ['evt_a', 'evt_b']),
      presentedSet('todo', ['todo_a', 'todo_b']),
    ]);
    assert('Slice 1 non-unique ordinal admission is unchanged', admission.kind === 'clarify',
      (v) => v === true, 'clarify');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}ConversationOrchestratorSlice2: ${passed}/${total} passed — ${failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`}${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('conversationOrchestratorSlice2');
if (invokedDirectly) {
  runConversationOrchestratorSlice2Tests()
    .then((result) => process.exit(result.failed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
