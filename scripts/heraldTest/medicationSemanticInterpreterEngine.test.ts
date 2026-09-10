// scripts/heraldTest/medicationSemanticInterpreterEngine.test.ts
// Bounded production runtime wiring for Semantic Interpretation V1,
// authorized 2026-09-07 (Herald CTO design review — consolidated design).
//
// Covers two things the headless harness can and cannot exercise directly:
//
//   1. The concurrency guard + certified-model constant, both pure/testable
//      logic in src/routing/medicationSemanticInterpretation.ts and
//      src/utils/modelManager.ts — exercised for real, via the real
//      functions, no mocking framework.
//
//   2. src/hooks/useMedicationSemanticInterpreterEngine.ts itself — a React
//      hook that does a real `import { initLlama } from 'llama.rn'`, which
//      (confirmed directly: every existing hook of this shape in this
//      codebase — useLocalLLM.ts, useListRemoveInterpretationShadowEngine.ts,
//      useExperimentalConversationalEngine.ts — fails identically) cannot be
//      require()'d headlessly; it needs a React tree and the native llama.rn
//      bridge. This is a pre-existing, structural property of this hook
//      category, not something introduced here. The properties that matter
//      (never substitutes SMALL_MODEL, never uses getActiveModelPath, checks
//      the flag, checks LARGE_MODEL) are proven instead by static source
//      inspection of the actual shipped file — a deterministic, repeatable
//      check of the code that exists, not a runtime observation of one path
//      through it.
//
// Runner: wired from run.mjs (EXPECTED_TOTAL bump).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateMedicationSemanticProposal,
} from '../../src/routing/medicationSemanticInterpretation';
import { withLlamaContextExclusive } from '../../src/utils/llamaContextExclusive';
// NOTE: LARGE_MODEL/SMALL_MODEL are deliberately NOT imported as values here.
// modelManager.ts itself does an unconditional `import * as FileSystem from
// 'expo-file-system/legacy'` at module top level, which — like expo-sqlite/
// expo-calendar/expo-intent-launcher elsewhere in this codebase — transitively
// hits react-native's Flow syntax and cannot be require()'d headlessly.
// modelManager.ts is outside this change's authorized mutation surface, so
// its constants are verified below by static source inspection instead of a
// runtime import — the same technique already used for the hook checks.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function makeCtx(behavior: 'ok' | 'throw') {
  return {
    completion: async () => {
      if (behavior === 'throw') throw new Error('simulated inference failure');
      return { content: '{"mentions":[],"predicate":"take","focus":"","confidence":0.5}' };
    },
  } as any;
}

export async function runMedicationSemanticInterpreterEngineTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Medication Semantic Interpreter Engine (bounded runtime wiring) --${RESET}\n`);

  // ── Certified model identification (static source inspection —
  //    modelManager.ts cannot be require()'d headlessly, see note above). ──
  {
    const modelManagerPath = path.join(__dirname, '..', '..', 'src', 'utils', 'modelManager.ts');
    const mmSource = fs.readFileSync(modelManagerPath, 'utf8');
    assert('MODEL1 LARGE_MODEL filename is the certified artifact',
      mmSource, (v) => /LARGE_MODEL\s*=\s*\{[^}]*filename:\s*'llama-3\.2-3b-instruct-q4_k_m\.gguf'/.test(v as string), 'LARGE_MODEL.filename === llama-3.2-3b-instruct-q4_k_m.gguf');
    assert('MODEL2 LARGE_MODEL url matches the certified experiment source',
      mmSource, (v) => (v as string).includes("url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf'"), 'bartowski/Llama-3.2-3B-Instruct-GGUF Q4_K_M URL present in LARGE_MODEL');
    assert('MODEL3 SMALL_MODEL and LARGE_MODEL are distinct filenames (sanity check)',
      mmSource, (v) => /SMALL_MODEL\s*=\s*\{[^}]*filename:\s*'llama-3\.2-1b-instruct-q4_k_m\.gguf'/.test(v as string), 'SMALL_MODEL.filename is the distinct 1B artifact');
  }

  // ── Static source-inspection proof (the hook itself cannot be require()'d
  //    headlessly — see file header — so its structural guarantees are
  //    proven against the real, shipped source text). ─────────────────────
  {
    const hookPath = path.join(__dirname, '..', '..', 'src', 'hooks', 'useMedicationSemanticInterpreterEngine.ts');
    const source = fs.readFileSync(hookPath, 'utf8');
    // Strip // line comments before checking — the file's own header prose
    // explains, by name, that SMALL_MODEL/getActiveModelPath are NOT used;
    // that explanatory mention must not itself trip a "never references"
    // check. Checking only actual code proves the property the test needs.
    const code = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    assert('STATIC1 hook imports LARGE_MODEL', /\bLARGE_MODEL\b/.test(code), (v) => v === true, 'true');
    assert('STATIC2 hook delegates presence/provisioning to ensureSemanticLargeModel', /\bensureSemanticLargeModel\b/.test(code), (v) => v === true, 'true');
    assert('STATIC3 hook code never references SMALL_MODEL (comments excluded)', /\bSMALL_MODEL\b/.test(code), (v) => v === false, 'false (no occurrence outside comments)');
    assert('STATIC4 hook code never references getActiveModelPath (comments excluded)', /\bgetActiveModelPath\b/.test(code), (v) => v === false, 'false (no occurrence outside comments)');
    assert('STATIC5 hook checks the semantic feature flag before any model work', /MEDICATION_SEMANTIC_INTERPRETATION_ENABLED/.test(code), (v) => v === true, 'true');
    // Flag check must precede the model-touching call in source order — the
    // flag-gated early return is the mechanism that guarantees no init
    // merely because the app starts.
    const flagIdx = code.indexOf('MEDICATION_SEMANTIC_INTERPRETATION_ENABLED');
    const initIdx = code.indexOf('initLlama(');
    assert('STATIC6 flag check occurs before initLlama call in source order', flagIdx >= 0 && initIdx >= 0 && flagIdx < initIdx, (v) => v === true, 'true');
  }

  // ── Concurrency guard — exercised for real against the real function ────
  {
    const r1 = generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    // Fire a second call synchronously, before the first's completion promise
    // has resolved — this is the exact overlap window §3 of the design closes.
    const r2 = generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    const [res1, res2] = await Promise.all([r1, r2]);
    const statuses = [res1.status, res2.status].sort();
    assert('CONC1 exactly one of two concurrent calls proceeds, the other returns unavailable',
      JSON.stringify(statuses), (v) => v === JSON.stringify(['ok', 'unavailable']), '["ok","unavailable"]');
  }
  {
    // Guard releases after a SUCCESSFUL completion — a call after a prior
    // one has fully resolved must not be treated as still in flight.
    const first = await generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    assert('CONC2 first (isolated) call succeeds', first.status, (v) => v === 'ok', 'ok');
    const second = await generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    assert('CONC3 guard released after success — next isolated call also succeeds', second.status, (v) => v === 'ok', 'ok');
  }
  {
    // Guard releases after a THROWN/REJECTED completion — proves the
    // `finally` reset, not just the happy path.
    const first = await generateMedicationSemanticProposal('I take metformin.', () => makeCtx('throw'));
    assert('CONC4 a throwing completion resolves to unavailable, not an uncaught rejection', first.status, (v) => v === 'unavailable', 'unavailable');
    const second = await generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    assert('CONC5 guard released after a thrown completion — next isolated call still succeeds', second.status, (v) => v === 'ok', 'ok');
  }
  {
    // Shared Llama context busy — real exclusivity gate, real API, no mock.
    const outcome = await withLlamaContextExclusive('probe', 'wait', async () => {
      return generateMedicationSemanticProposal('I take metformin.', () => makeCtx('ok'));
    });
    assert('CONC6 shared context busy (real gate held) → interpreter reports unavailable',
      outcome.ok ? (outcome.value as any).status : 'gate-not-acquired',
      (v) => v === 'unavailable', 'unavailable');
  }
  {
    // No ctx at all (interpreter's own context unavailable) — pre-existing
    // behavior, reconfirmed still correct alongside the new guard.
    const r = await generateMedicationSemanticProposal('I take metformin.', () => null);
    assert('CONC7 no context → unavailable (unchanged pre-existing behavior)', r.status, (v) => v === 'unavailable', 'unavailable');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}MedicationSemanticInterpreterEngine: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('medicationSemanticInterpreterEngine.test.ts')) {
  runMedicationSemanticInterpreterEngineTests().catch(console.error);
}
