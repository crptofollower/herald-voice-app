// scripts/heraldTest/lawZero.test.ts
// Law 0 contract tests (S-DISCLOSE build arc, step 3).
// Tests EMERGENCY_SIGNALS/detectEmergency wired at the top of processUtterance —
// above pending resolution, headless, no routeIntent/classifyQuery call for an
// emergency utterance. Companion to confirmPrimitive.test.ts (step 2); together
// they close C-J: T1 there proves the primitive can't be forged by leading-token
// text, L3 here proves the emergency actually escapes and dispatches mid-pending.
//
// Runner: npx tsx scripts/heraldTest/lawZero.test.ts

import { processUtterance } from '../../src/routing/processUtterance.ts';
import { ConversationSession } from '../../src/routing/conversationSession.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

export async function runLawZeroTests() {
  const failures: any[] = [];
  let passed = 0;
  function assert(label: string, got: any, check: (v: any) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Law 0 (Emergency Preempts Everything) Contract Tests ---${RESET}\n`);

  function makeDeps() {
    const spy = { called: false };
    const deps = {
      classifyQuery: async (_msg: string) => { spy.called = true; return { tier: 3 as const }; },
      classifyLLM: null,
      llmReady: false,
      captureContext: { contacts: [], lists: [] },
    };
    return { deps, spy };
  }

  function medCommitResume(committed: { value: boolean }, spy: { called: boolean }) {
    return async (text: string): Promise<CommitResult> => {
      spy.called = true;
      const t = text.trim().toLowerCase();
      if (t === 'no') return { status: 'noop', ack: "No problem — I won't add that." };
      if (t === 'yes') { committed.value = true; return { status: 'committed', ack: 'Got it — I will remember that.' }; }
      return { status: 'noop', ack: '' };
    };
  }

  // ── L1: emergency, no pending — escapes before routing ────────────────────
  {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance('I need help', session, deps as any);
    assert('L1a outcome is the emergency outcome', outcome, v => v.handled === true && v.source === 'emergency', "{ handled: true, source: 'emergency' }");
    assert('L1b routeIntent/classifyQuery never invoked for an emergency utterance', spy.called, v => v === false, 'classifyQuery never called');
  }

  // ── L2: emergency mid a primitive-governed pending — released, not resumed ─
  {
    const session = new ConversationSession();
    const committed = { value: false };
    const resumeSpy = { called: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed, resumeSpy) });
    const { deps } = makeDeps();
    const outcome = await processUtterance('I need help right now', session, deps as any);
    assert('L2a outcome is emergency, not pending_resume', outcome, v => v.source === 'emergency', "source === 'emergency'");
    assert('L2b held pending is released, not resumed', session.hasPending(), v => v === false, 'released');
    assert('L2c domain resume never invoked — emergency preempts before the ladder runs', resumeSpy.called, v => v === false, 'resume never called');
  }

  // ── L3: C-J itself — leading-token "Ok I really need help now" mid-confirm ─
  {
    const session = new ConversationSession();
    const committed = { value: false };
    const resumeSpy = { called: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed, resumeSpy) });
    const { deps } = makeDeps();
    const outcome = await processUtterance('Ok I really need help now', session, deps as any);
    assert('L3a C-J utterance resolves as emergency, not a forged commit', outcome, v => v.source === 'emergency', "source === 'emergency'");
    assert('L3b nothing committed', committed.value, v => v === false, 'false');
    assert('L3c domain resume never reached — Law 0 fires before the primitive ever sees the text', resumeSpy.called, v => v === false, 'resume never called');
  }

  // ── L4: ordinary non-emergency utterance still routes normally ────────────
  {
    const session = new ConversationSession();
    const { deps, spy } = makeDeps();
    const outcome = await processUtterance('what is on my calendar today', session, deps as any);
    assert('L4a routing still runs for non-emergency text', spy.called, v => v === true, 'classifyQuery called');
    assert('L4b outcome is not misclassified as emergency', outcome, v => v.source !== 'emergency', "source !== 'emergency'");
  }

  // ── L5: non-emergency reply mid-pending still uses the normal ladder ──────
  {
    const session = new ConversationSession();
    const committed = { value: false };
    const resumeSpy = { called: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed, resumeSpy) });
    const { deps } = makeDeps();
    const outcome = await processUtterance('yes', session, deps as any);
    assert('L5a non-emergency reply still resolves via pending_resume, not emergency', outcome, v => v.source === 'pending_resume', "source === 'pending_resume'");
    assert('L5b domain resume was invoked normally — Law 0 does not over-fire', resumeSpy.called, v => v === true, 'resume called');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Law 0: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('lawZero.test.ts')) {
  runLawZeroTests().catch(console.error);
}
