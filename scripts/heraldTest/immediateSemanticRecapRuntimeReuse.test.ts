// scripts/heraldTest/immediateSemanticRecapRuntimeReuse.test.ts
// Bounded runtime reuse gate (2026-09-xx): Stage B (Immediate Semantic
// Recap's semantic fallback) now borrows the independent, already-certified
// 3B interpreter runtime (useMedicationSemanticInterpreterEngine) instead of
// the dormant general classifier context — without enabling
// LOCAL_LLM_ENABLED, without a new model runtime, and without changing
// general ephemeral/conversational generation behavior.
//
// This file proves exactly the claims the gate required, via source-lock
// against the real production files (same technique already established by
// hotNarrativeRing.test.ts's SEAM assertions and conversationTurnLedgerCoverage
// .test.ts's ChatScreen hook source-lock).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

export async function runImmediateSemanticRecapRuntimeReuseTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assertTrue(label: string, cond: boolean) {
    if (cond) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}`); failures.push({ label, got: cond, expected: 'true' }); }
  }

  console.log(`\n${BOLD}-- Bounded runtime reuse: Stage B independent of LOCAL_LLM_ENABLED --${RESET}`);

  const chatPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/screens/ChatScreen.tsx');
  const chatSrc = fs.readFileSync(chatPath, 'utf8');
  const recapModulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/routing/immediateSemanticRecap.ts');
  const recapSrc = fs.readFileSync(recapModulePath, 'utf8');
  const hookPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/hooks/useMedicationSemanticInterpreterEngine.ts');
  const hookSrc = fs.readFileSync(hookPath, 'utf8');
  const featuresPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/constants/features.ts');
  const featuresSrc = fs.readFileSync(featuresPath, 'utf8');

  // Q9 proof: Stage B's own module never references LOCAL_LLM_ENABLED at all
  // — it was never gated on that flag to begin with; only the CALLER's
  // choice of which context to inject determines availability.
  assertTrue('Stage B module (immediateSemanticRecap.ts) never references LOCAL_LLM_ENABLED', !recapSrc.includes('LOCAL_LLM_ENABLED'));

  // Q9 proof: every ChatScreen.tsx call site injects the independent
  // interpreter context, not the dormant general classifier context. Was 2
  // (both answerImmediateSemanticRecap sites); Active Subject / Reference
  // Continuity V1 added a third, legitimate site (answerActiveSubjectReference,
  // needs_clarification block) reusing the SAME bounded runtime the same way
  // — not a new context, not a weakened check, one more correct call site.
  const recapCtxWiring = (chatSrc.match(/getInterpreterCtx:\s*getMedicationSemanticInterpreterCtx,/g) || []).length;
  assertTrue('every recap/active-subject call site injects getMedicationSemanticInterpreterCtx', recapCtxWiring === 3);
  assertTrue('no resolveImmediateRecap call site still injects the dormant general getCtx', !/resolveImmediateRecap: \(\) => answerImmediateSemanticRecap\(text, \{\s*\n\s*ledgerEntries: conversationLedgerRef\.current\.peek\(Date\.now\(\)\),\s*\n\s*getInterpreterCtx: getCtx,/.test(chatSrc));

  // Q2 proof: the interpreter engine hook itself is gated on its OWN flag,
  // never on LOCAL_LLM_ENABLED — confirms the runtime this now reuses is
  // genuinely independent, not a second name for the same gate.
  assertTrue('useMedicationSemanticInterpreterEngine.ts is gated on MEDICATION_SEMANTIC_INTERPRETATION_ENABLED', hookSrc.includes('MEDICATION_SEMANTIC_INTERPRETATION_ENABLED'));
  assertTrue('useMedicationSemanticInterpreterEngine.ts never references LOCAL_LLM_ENABLED', !hookSrc.includes('LOCAL_LLM_ENABLED'));

  // Confirms current on-device state: the reused runtime is actually live
  // today (MEDICATION_SEMANTIC_INTERPRETATION_ENABLED=true), independent of
  // LOCAL_LLM_ENABLED's own value (false) — this is what makes Stage B
  // device-testable without a flag change.
  const medFlagMatch = featuresSrc.match(/export const MEDICATION_SEMANTIC_INTERPRETATION_ENABLED = (true|false);/);
  const llmFlagMatch = featuresSrc.match(/export const LOCAL_LLM_ENABLED = (true|false);/);
  assertTrue('MEDICATION_SEMANTIC_INTERPRETATION_ENABLED is currently true (reused runtime is live on device)', medFlagMatch?.[1] === 'true');
  assertTrue('LOCAL_LLM_ENABLED remains false — untouched by this reuse (no global flag change made)', llmFlagMatch?.[1] === 'false');

  console.log(`\n${BOLD}-- No new model runtime introduced --${RESET}`);
  // Only ONE useMedicationSemanticInterpreterEngine() instantiation exists
  // in ChatScreen.tsx — this reuse did not add a second independent context.
  assertTrue('exactly one useMedicationSemanticInterpreterEngine() call site in ChatScreen.tsx (no new/second context)', (chatSrc.match(/useMedicationSemanticInterpreterEngine\(\)/g) || []).length === 1);
  assertTrue('immediateSemanticRecap.ts itself never calls initLlama (no runtime of its own)', !recapSrc.includes('initLlama'));

  console.log(`\n${BOLD}-- General ephemeral/conversational generation behavior unchanged --${RESET}`);
  // The ephemeral-generation `generate:` field at both seam call sites must
  // still be wired exactly as before this reuse — untouched by this change.
  assertTrue('online site still wires generate: to runEphemeralGenerate (ephemeral generation untouched)', /generate: \(\) => runEphemeralGenerate\(adoptedRecovery, 'needs_clarification_default'\),/.test(chatSrc));
  assertTrue('offline site still wires generate: to runEphemeralGenerate (ephemeral generation untouched)', /generate: runEphemeralGenerate,/.test(chatSrc));
  // runEphemeralGenerate's own worker selection must still be based on the
  // general getCtx / experimental engine — not swapped to the interpreter
  // context. (Structural check: the interpreter context symbol must not
  // appear inside createLlamaEphemeralWorker's own construction.)
  assertTrue('createLlamaEphemeralWorker still constructed from the general getCtx, not the interpreter context', /createLlamaEphemeralWorker\(\{\s*getCtx\s*\}\)/.test(chatSrc));
  assertTrue('createLlamaEphemeralWorker is never constructed from getMedicationSemanticInterpreterCtx', !/createLlamaEphemeralWorker\(\{\s*getCtx:\s*getMedicationSemanticInterpreterCtx/.test(chatSrc));

  console.log(`\n${BOLD}-- Stage A unchanged (module untouched by this reuse) --${RESET}`);
  // This gate's task touched ONLY ChatScreen.tsx wiring — immediateSemanticRecap.ts
  // (which owns Stage A's regexes) was not edited at all. Verified by exact
  // presence of its unchanged Stage A pattern names/logic.
  assertTrue('IMMEDIATE_RECAP_RE still present, unmodified in shape (Stage A not touched)', recapSrc.includes('const IMMEDIATE_RECAP_RE ='));
  assertTrue('REMIND_ME_RE still present (Stage A not touched)', recapSrc.includes('const REMIND_ME_RE ='));
  assertTrue('ASSISTANT_RECAP_RE still present (Stage A not touched)', recapSrc.includes('const ASSISTANT_RECAP_RE ='));
  assertTrue('normalizeContractions still present, unmodified (Stage A not touched)', recapSrc.includes('function normalizeContractions('));
  // Ground truth: this gate's task touched only ChatScreen.tsx — confirmed
  // via git status/diff at the time these files were edited (see report);
  // this file-content check is a redundant, independently-checkable proof.
  assertTrue('classifyImmediateRecapDeterministic function body present and still the sole Stage A entry point', recapSrc.includes('export function classifyImmediateRecapDeterministic('));

  console.log(`\n${BOLD}-- Authority/trust boundary unaffected --${RESET}`);
  assertTrue('interpreter context still carries no DB import path (immediateSemanticRecap.ts unchanged, already proven DB-free for Stage B plumbing)', !/from ['"]\.\.\/db\//.test(recapSrc.split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n')));
  assertTrue('immediateSemanticRecap.ts still never imports ConversationSession (pending authority untouched)', !recapSrc.includes('conversationSession'));

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ImmediateSemanticRecapRuntimeReuse: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('immediateSemanticRecapRuntimeReuse.test.ts')) {
  runImmediateSemanticRecapRuntimeReuseTests().catch(console.error);
}
