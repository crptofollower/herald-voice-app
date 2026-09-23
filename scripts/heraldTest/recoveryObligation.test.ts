// Recovery Obligation V1 — create at canned default seam; consume before routeIntent.
import { processUtterance } from '../../src/routing/processUtterance.ts';
import { DiscourseContinuityHolder } from '../../src/routing/discourseContinuity.ts';
import { normalizeInput } from '../../src/utils/normalizeInput.ts';
import { ACTIVE_SUBJECT_GROUNDING_ACK } from '../../src/routing/activeSubjectReference.ts';
import {
  RecoveryObligationHolder,
  shouldEstablishRecoveryObligation,
  isRecoveryRepairSignal,
  formatRecoveryDomainClarification,
  formatRecoveryAmbiguousClarification,
} from '../../src/routing/recoveryObligation.ts';
import { openJourneyDb } from './journeyHarness.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const CANNED_CREATE = {
  processHandled: false,
  routeKind: 'needs_clarification',
  routeReason: 'default',
  recapHandled: false,
  activeSubjectHandled: false,
  seamKind: 'clarify' as const,
  hasPending: false,
};

export async function runRecoveryObligationV1Tests() {
  let passed = 0;
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
  function assert(label: string, cond: boolean, expected = 'true') {
    if (cond) {
      console.log(`${GREEN}PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}FAIL${RESET}  ${label}`);
      failures.push({ label, got: false, expected });
    }
  }

  console.log(`\n${BOLD}-- Recovery Obligation V1 ------------------------------------${RESET}\n`);

  assert('create seam: canned default clarify arms', shouldEstablishRecoveryObligation(CANNED_CREATE));
  assert(
    'no false create: recap success',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, recapHandled: true }),
  );
  assert(
    'no false create: Qwen generative',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, seamKind: 'generative' }),
  );
  assert(
    'no false create: authoritative owner',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, seamKind: 'authoritative' }),
  );
  assert(
    'no false create: process handled',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, processHandled: true }),
  );
  assert(
    'no false create: pending',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, hasPending: true }),
  );
  assert(
    'no false create: llm:failed',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, routeReason: 'llm:failed' }),
  );
  assert(
    'no false create: active_subject_identity',
    !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, routeReason: 'active_subject_identity' }),
  );
  assert('repair: I meant my calendar', isRecoveryRepairSignal('I meant my calendar.'));
  assert('repair: Actually I meant', isRecoveryRepairSignal('Actually, I meant my calendar.'));
  assert(
    'repair: that\'s not what I meant',
    isRecoveryRepairSignal("No, that's not what I meant. I was asking about my calendar."),
  );
  assert('bare No is not repair', !isRecoveryRepairSignal('No.'));
  assert('bare Yes is not repair', !isRecoveryRepairSignal('Yes.'));

  const { session, deps } = openJourneyDb();
  const discourse = new DiscourseContinuityHolder();
  const recovery = new RecoveryObligationHolder();
  const say = (t: string) =>
    processUtterance(normalizeInput(t), session, deps, null, null, null, null, null, discourse, null, null, recovery);

  async function armCannedDefault(miss: string) {
    const first = await say(miss);
    const eligible = !first.handled
      && first.routeDecision.kind === 'needs_clarification'
      && first.routeDecision.reason === 'default';
    const arm = shouldEstablishRecoveryObligation({
      processHandled: first.handled,
      routeKind: first.handled ? '' : first.routeDecision.kind,
      routeReason: first.handled ? '' : first.routeDecision.reason,
      recapHandled: false,
      activeSubjectHandled: false,
      seamKind: 'clarify',
      hasPending: session.hasPending(),
    });
    if (arm) recovery.establish();
    return { first, eligible, arm };
  }

  {
    const { first, eligible, arm } = await armCannedDefault('xyzzy unexplained blarg');
    assert('A miss is needs_clarification/default', eligible);
    assert('A ChatScreen canned seam would arm', arm);
    assert('A obligation stored after canned create', recovery.peek() !== null);
    assert('A not live until next user turn', recovery.hasLive() === false);
  }

  {
    const r = new RecoveryObligationHolder();
    r.beginUserTurn();
    assert(
      'B recap-answered miss does not arm',
      !shouldEstablishRecoveryObligation({ ...CANNED_CREATE, recapHandled: true }),
    );
    assert('B holder stays empty without establish', r.peek() === null);
  }

  {
    const { eligible, arm } = await armCannedDefault('xyzzy unexplained blarg');
    assert('C miss eligible', eligible && arm);
    const next = await say("No, that's not what I meant. I was asking about my calendar.");
    assert(
      'C targeted calendar clarification',
      next.handled
        && next.source === 'recovery_obligation'
        && next.responseText === formatRecoveryDomainClarification('calendar'),
    );
    assert('C no pending', session.peekPendingKey() === null);
    assert('C obligation consumed', recovery.peek() === null);
    assert('C no NMF hold', discourse.peekInterpretationHold() === null);
    assert('C not Okay.', next.handled && next.responseText !== ACTIVE_SUBJECT_GROUNDING_ACK);
    const monday = await say('Monday or Tuesday.');
    assert(
      'O Monday or Tuesday remains unsupported default',
      !monday.handled
        && monday.routeDecision.kind === 'needs_clarification'
        && monday.routeDecision.reason === 'default',
    );
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say('I meant my calendar.');
    assert(
      'D I meant my calendar',
      next.handled
        && next.source === 'recovery_obligation'
        && next.responseText === formatRecoveryDomainClarification('calendar'),
    );
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say('Actually, I meant my calendar.');
    assert(
      'E Actually I meant my calendar',
      next.handled
        && next.source === 'recovery_obligation'
        && next.responseText === formatRecoveryDomainClarification('calendar'),
    );
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say("No, that's not what I meant. I was asking about my medications.");
    assert(
      'F targeted medications clarification',
      next.handled
        && next.source === 'recovery_obligation'
        && next.responseText === formatRecoveryDomainClarification('medications'),
    );
    assert(
      'F is not medical:summary',
      next.handled && next.source !== 'hold_continuity' && !('routeDecision' in next),
    );
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say('my medications');
    assert(
      'G fresh my medications still medical:summary',
      !next.handled
        && next.routeDecision.kind === 'device_read'
        && next.routeDecision.reason === 'medical:summary',
    );
    assert('G obligation cleared on unused/fresh', recovery.peek() === null);
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say("What's on my calendar tomorrow?");
    assert(
      'H fresh calendar tomorrow still calendar:tomorrow',
      !next.handled
        && next.routeDecision.kind === 'device_read'
        && next.routeDecision.reason === 'calendar:tomorrow',
    );
  }

  {
    const med = await say('I take Metformin 500 mg twice a day.');
    assert(
      'I medical capture arms pending',
      med.handled && med.source === 'capture' && session.peekPendingKey() !== null,
    );
    const no = await say('No.');
    assert(
      'I bare No remains confirmation decline',
      no.handled && no.source === 'pending_resume' && session.peekPendingKey() === null,
    );
    assert('I bare No is not recovery', !(no.handled && no.source === 'recovery_obligation'));
  }

  {
    const fam = await say('my wife is Shannon');
    assert(
      'J family_capture pending',
      fam.handled && session.peekPendingKey() === 'family_capture',
    );
    recovery.beginUserTurn();
    recovery.establish();
    const steal = await say("No, that's not what I meant. I was asking about my calendar.");
    assert(
      'J recovery sentence stays pending-owned',
      steal.handled && steal.source === 'pending_resume',
    );
    assert('J still family_capture or released by domain, not recovery', steal.source !== 'recovery_obligation');
    session.clearPending();
    recovery.clear();
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say('I meant my calendar and my medications.');
    assert(
      'K ambiguous generic clarification',
      next.handled
        && next.source === 'recovery_obligation'
        && next.responseText === formatRecoveryAmbiguousClarification(),
    );
    assert('K no NMF hold', discourse.peekInterpretationHold() === null);
    assert('K not medical:summary', !('routeDecision' in next));
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    const next = await say('what time is it');
    assert(
      'L unrelated fresh time route',
      !next.handled && next.routeDecision.kind === 'device_action' && next.routeDecision.reason === 'action:time',
    );
    assert('L obligation cleared', recovery.peek() === null);
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    await say('what time is it');
    const late = await say('I meant my calendar.');
    assert(
      'M N+2 cannot claim recovery',
      !(late.handled && late.source === 'recovery_obligation'),
    );
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    assert('N armed before emergency', recovery.peek() !== null);
    const em = await say("I'm having an emergency");
    assert('N emergency handled', em.handled && em.source === 'emergency');
    assert('N emergency cleared obligation', recovery.peek() === null);
  }

  {
    await armCannedDefault('xyzzy unexplained blarg');
    recovery.clear();
    assert('N reset/clear drops obligation', recovery.peek() === null);
  }

  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('recoveryObligation.test.ts')) {
  runRecoveryObligationV1Tests().then((r) => {
    console.log(`\n${BOLD}RecoveryObligationV1: ${r.passed} passed, ${r.failed} failed${RESET}\n`);
    process.exit(r.failed ? 1 : 0);
  });
}
