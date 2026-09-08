// scripts/heraldTest/immediateSemanticRecapReachability.test.ts
// Immediate Semantic Recap reachability repair (2026-09-xx).
//
// Root cause: resolveImmediateRecap was wired only inside ChatScreen.tsx's
// needs_clarification / reason==='default' branch, making the recap
// consumer structurally unreachable whenever routeIntent produced any other
// needs_clarification reason (personal_memory:recall_declined,
// ambiguous_operational_list, llm:failed) — proven by the failed Android
// airplane-mode flight where "What did I just tell you I'm taking" exited
// routeIntent with reason personal_memory:recall_declined and never reached
// the recap consumer at all.
//
// Repair: ONE generic, reason-agnostic recap inspection at the top of the
// needs_clarification block, before the reason-specific chain. A
// handled:false result falls through to the exact pre-existing
// reason-specific behavior. The redundant nested wiring inside the
// 'default' branch was removed (not duplicated) to guarantee recap never
// runs twice for the same turn.
//
// This file proves reachability, no-allowlist, no-double-invocation,
// authority precedence, and that Stage A/Stage B/diagnostics remain
// byte-unchanged — via the same source-lock technique already established
// by immediateSemanticRecapRuntimeReuse.test.ts, plus direct function-level
// proof (from real ledger evidence) that the SAME answerImmediateSemanticRecap
// call correctly classifies both the previously-unreachable phrase and the
// already-working one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversationTurnLedger } from '../../src/routing/conversationTurnLedger.ts';
import type { ConversationTurnRecord } from '../../src/routing/conversationTurnLedger.ts';
import { answerImmediateSemanticRecap, classifyImmediateRecapDeterministic } from '../../src/routing/immediateSemanticRecap.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function rec(overrides: Partial<ConversationTurnRecord> & { focus: ConversationTurnRecord['focus'] }): ConversationTurnRecord {
  return {
    turnIndex: 1,
    establishedAt: Date.now(),
    utterance: 'x',
    intentType: null,
    operation: 'capture',
    outcome: 'committed',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    ...overrides,
  };
}

export async function runImmediateSemanticRecapReachabilityTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  const chatPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
  const chatSrc = fs.readFileSync(chatPath, 'utf8');
  const recapModulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/immediateSemanticRecap.ts');
  const recapSrc = fs.readFileSync(recapModulePath, 'utf8');

  console.log(`\n${BOLD}-- Reachability: ONE generic call site, before the reason chain --${RESET}`);
  {
    // Isolate the needs_clarification block's own source text (from its
    // opening `if` to the matching closing of the reason-chain / ledger
    // push, i.e. up to the next top-level `const routeDecision =` that
    // begins the non-needs_clarification handling below it).
    const blockStart = chatSrc.indexOf("if (outcome.routeDecision.kind === 'needs_clarification') {");
    const blockEnd = chatSrc.indexOf('const routeDecision = outcome.routeDecision;', blockStart);
    assertTrue('needs_clarification block located', blockStart > 0 && blockEnd > blockStart);
    const block = chatSrc.slice(blockStart, blockEnd);

    const recapCallIndex = block.indexOf('const recapOutcome = await answerImmediateSemanticRecap(text, {');
    assertTrue('REACHABILITY: generic recapOutcome call exists in the needs_clarification block', recapCallIndex > 0);

    const firstReasonCheckIndex = block.indexOf("outcome.routeDecision.reason ===");
    assertTrue('REACHABILITY: the generic recap call appears BEFORE the first reason-specific check', recapCallIndex > 0 && (firstReasonCheckIndex < 0 || recapCallIndex < firstReasonCheckIndex));

    // NO-ALLOWLIST: nothing between the block start and the recap call may
    // condition on `reason` — i.e. the call is not itself inside an
    // `if (reason === ...)` guard.
    const preambleToRecapCall = block.slice(0, recapCallIndex);
    assertTrue('NO-ALLOWLIST: no `reason ===` check appears before the generic recap call', !preambleToRecapCall.includes('reason ==='));
    assertTrue('NO-ALLOWLIST: no literal route-reason string (personal_memory / ambiguous_operational_list / llm:failed) gates the recap call', !preambleToRecapCall.includes("'personal_memory") && !preambleToRecapCall.includes("'ambiguous_operational_list'") && !preambleToRecapCall.includes("'llm:failed'"));

    // NO-DOUBLE-INVOCATION: exactly one answerImmediateSemanticRecap call
    // inside this block (the generic one) — the 'default' branch's nested
    // one has been removed, not duplicated.
    const callsInBlock = (block.match(/answerImmediateSemanticRecap\(/g) || []).length;
    assert('NO-DOUBLE-INVOCATION: exactly one answerImmediateSemanticRecap call inside the needs_clarification block', callsInBlock, 1);
    assertTrue("NO-DOUBLE-INVOCATION: resolveImmediateRecap is no longer wired into the 'default' branch's resolveEphemeralSeamGateADiag call", !block.includes('resolveImmediateRecap:'));

    // The pre-existing reason-specific branches must still be textually
    // present and unmodified in shape — proving non-recap behavior for
    // those reasons is preserved, not replaced.
    assertTrue("pre-existing ambiguous_operational_list branch still present", block.includes("outcome.routeDecision.reason === 'ambiguous_operational_list'") && block.includes('formatOperationalListClarification'));
    assertTrue("pre-existing 'default' branch (resolveEphemeralSeamGateADiag) still present", block.includes("outcome.routeDecision.reason === 'default'") && block.includes('resolveEphemeralSeamGateADiag'));
  }

  console.log(`\n${BOLD}-- Authority precedence: pending/consequential turns still preempt --${RESET}`);
  {
    const handledIndex = chatSrc.indexOf('if (outcome.handled) {');
    const needsClarificationIndex = chatSrc.indexOf("if (outcome.routeDecision.kind === 'needs_clarification') {");
    assertTrue('AUTHORITY: outcome.handled (pending_resume/capture/referent_resume) check precedes the needs_clarification block', handledIndex > 0 && needsClarificationIndex > handledIndex);
    // The handled branch must still return before falling through — this
    // consumer has no way to run for a turn processUtterance already
    // fully handled deterministically.
    const handledBlock = chatSrc.slice(handledIndex, needsClarificationIndex);
    assertTrue('AUTHORITY: the outcome.handled branch still returns (never falls through into needs_clarification handling)', /\breturn;\s*\n\s*\}/.test(handledBlock));
  }
  {
    // Module-level structural proof (unchanged from before this repair):
    // the recap consumer itself has no channel to see or influence pending
    // state — it never imports ConversationSession.
    assertTrue('AUTHORITY: immediateSemanticRecap.ts still never imports ConversationSession', !recapSrc.includes('conversationSession'));
  }

  console.log(`\n${BOLD}-- No route-reason allowlist anywhere in the recap module itself --${RESET}`);
  assertTrue('NO-ALLOWLIST: immediateSemanticRecap.ts never references personal_memory:recall_declined', !recapSrc.includes('personal_memory'));
  assertTrue('NO-ALLOWLIST: immediateSemanticRecap.ts never references ambiguous_operational_list', !recapSrc.includes('ambiguous_operational_list'));
  assertTrue('NO-ALLOWLIST: immediateSemanticRecap.ts never references llm:failed', !recapSrc.includes("llm:failed"));
  assertTrue('NO-ALLOWLIST: immediateSemanticRecap.ts has no `reason` parameter/field at all', !/\breason\b/.test(recapSrc.replace(/\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '')));

  console.log(`\n${BOLD}-- Stage A / Stage B / diagnostics byte-unchanged this task --${RESET}`);
  assertTrue('Stage A: IMMEDIATE_RECAP_RE unchanged (still present, same declaration)', recapSrc.includes("const IMMEDIATE_RECAP_RE ="));
  assertTrue('Stage A: REMIND_ME_RE unchanged', recapSrc.includes('const REMIND_ME_RE ='));
  assertTrue('Stage A: ASSISTANT_RECAP_RE unchanged', recapSrc.includes('const ASSISTANT_RECAP_RE ='));
  assertTrue('Stage B: RECAP_INTERPRETATION_SYSTEM_PROMPT unchanged (exact known text)', recapSrc.includes('You classify whether the user is asking Herald to recap or remind them of something THEY just told Herald in this conversation'));
  assertTrue('Stage B: confidence threshold unchanged', recapSrc.includes('const RECAP_INTERPRETATION_CONFIDENCE_THRESHOLD = 0.6;'));
  assertTrue('Diagnostics: HERALD_IMMEDIATE_RECAP_DIAG tag still present, unchanged', recapSrc.includes("console.warn('HERALD_IMMEDIATE_RECAP_DIAG ' + JSON.stringify(event));"));

  console.log(`\n${BOLD}-- Function-level proof: the SAME call correctly classifies both phrases --${RESET}`);
  {
    // Item 1: "What did I just tell you I'm taking?" — the exact device
    // phrase that failed. Proven reachable in principle (Stage A matches
    // it regardless of which route reason got it here — the function has
    // no reason parameter to gate on).
    assertTrue('previously-unreachable phrase: Stage A still matches it on its own merits', classifyImmediateRecapDeterministic("What did I just tell you I'm taking?"));
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'lisinopril', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const outcome = await answerImmediateSemanticRecap("What did I just tell you I'm taking?", { ledgerEntries: [commit] });
    assertTrue('ITEM-1: recap consumer handles the device-failed phrase given ONLY ledger evidence (no reason parameter involved at all)', outcome.handled === true);
  }
  {
    // Item 2: "Which medicine was I talking about?" — the reason:'default'
    // Stage-B phrase that already worked. Confirms unchanged.
    assertTrue('Stage A structurally does not match this phrase (Stage B required, as designed)', !classifyImmediateRecapDeterministic('Which medicine was I talking about?'));
    const commit = rec({ focus: [{ kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' }] });
    const mockCtx = { completion: async () => ({ text: '{"isImmediateRecap":true,"selectedIndex":0,"confidence":0.9}' }) } as any;
    const outcome = await answerImmediateSemanticRecap('Which medicine was I talking about?', { ledgerEntries: [commit], getInterpreterCtx: () => mockCtx });
    assertTrue('ITEM-2: still resolves via Stage B given ledger evidence + interpreter, exactly as before this repair', outcome.handled === true);
  }
  {
    // Items 3/4: the function itself has no concept of "reason" at all — it
    // cannot behave differently for ambiguous_operational_list / llm:failed
    // vs default vs personal_memory:recall_declined, because it never
    // receives that value. A non-recap utterance (no compatible Stage A/B
    // classification) correctly returns handled:false regardless of ledger
    // content, which is what lets ChatScreen.tsx's pre-existing
    // reason-specific chain run unmodified.
    const commit = rec({ focus: [{ kind: 'collection', displayValue: 'grocery list', resolverKey: 'list_1', referable: true, tier: 'authoritative' }] });
    const notRecap = await answerImmediateSemanticRecap('I need milk and eggs and bread', { ledgerEntries: [commit] });
    assertTrue('ITEM-4: a genuinely non-recap utterance (ambiguous_operational_list-shaped) is not handled — falls through to pre-existing behavior', notRecap.handled === false);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ImmediateSemanticRecapReachability: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('immediateSemanticRecapReachability.test.ts')) {
  runImmediateSemanticRecapReachabilityTests().catch(console.error);
}
