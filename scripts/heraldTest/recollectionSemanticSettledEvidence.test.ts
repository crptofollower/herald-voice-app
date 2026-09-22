// Settled 3B evidence collection — wait for native settlement, production deadlines unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRecollectionSemanticEvidence } from '../../src/dev/recollectionSemanticEvidenceCollect.ts';
import { RECOLLECTION_SEMANTIC_EVAL_FIXTURES } from '../../src/dev/recollectionSemanticEvalFixtures.ts';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import {
  isSemanticNativeCompletionInFlight,
  resetSemanticCompletionLifecycleForTests,
} from '../../src/utils/semanticCompletionLifecycle.ts';
import { generateRecollectionSemanticProposal } from '../../src/routing/recollectionSemanticNomination.ts';
import type { RecollectionSemanticEvalRow } from '../../src/dev/recollectionSemanticEvalFixtures.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const EXEC = {
  backend: 'test-settled-evidence',
  llamaRnAvailable: true,
  remoteFallback: false as const,
  privacy: 'local ctx.completion only',
  note: 'test',
  modelFilename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
  nCtx: 512,
  nGpuLayers: 0,
  interpreterStatus: 'ready',
};

const SCORED: RecollectionSemanticEvalRow[] = [
  {
    class: 'childhood_without_cue',
    utterance: 'The summer I turned eight we slept on the screened porch because the house stayed too hot.',
    expected: 'AUTOBIOGRAPHICAL',
    arcOpen: false,
    notes: 'scored',
    scoring: 'scored',
  },
  {
    class: 'present_transient',
    utterance: 'Traffic is awful this morning.',
    expected: 'TRANSIENT',
    arcOpen: false,
    notes: 'scored',
    scoring: 'scored',
  },
];

const OBS: RecollectionSemanticEvalRow = {
  class: 'g5_he_hated_mornings',
  utterance: 'He hated mornings.',
  expected: null,
  arcOpen: false,
  notes: 'observational',
  scoring: 'observational',
};

function deferredCompletion() {
  const calls: unknown[] = [];
  const settles: Array<(value: unknown) => void> = [];
  const fails: Array<(err: Error) => void> = [];
  const ctx = {
    completion: (params: unknown) => {
      calls.push(params);
      return new Promise((resolve, reject) => {
        settles.push(resolve);
        fails.push(reject);
      });
    },
  };
  return {
    ctx,
    calls,
    resolve: (i: number, value: unknown) => { settles[i]?.(value); },
    reject: (i: number, err: Error) => { fails[i]?.(err); },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

export async function runRecollectionSemanticSettledEvidenceV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Recollection Settled 3B Evidence Collection V1 ---------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const collectSrc = fs.readFileSync(path.join(root, 'src/dev/recollectionSemanticEvidenceCollect.ts'), 'utf8');
  const nominatorSrc = fs.readFileSync(path.join(root, 'src/routing/recollectionSemanticNomination.ts'), 'utf8');
  const grocerySrc = fs.readFileSync(path.join(root, 'src/routing/grocerySemanticDecomposition.ts'), 'utf8');
  const todoSrc = fs.readFileSync(path.join(root, 'src/routing/todoSemanticCapture.ts'), 'utf8');
  const observeSrc = nominatorSrc.slice(nominatorSrc.indexOf('export async function observeRecollectionSemanticShadow'));

  assert('SCHEMA_VERSION remains 25', SCHEMA_VERSION, (v) => v === 25, '25');

  assert('production Recollection/Grocery/Todo caller deadlines remain 8000ms',
    nominatorSrc.includes('RECOLLECTION_SEMANTIC_TIMEOUT_MS = 8000')
      && grocerySrc.includes('GROCERY_SEMANTIC_TIMEOUT_MS = 8000')
      && todoSrc.includes('TODO_SEMANTIC_TIMEOUT_MS = 8000')
      && /callerDeadlineMs:\s*opts\?\.timeoutMs \?\? RECOLLECTION_SEMANTIC_TIMEOUT_MS/.test(nominatorSrc)
      && !/RECOLLECTION_SEMANTIC_TIMEOUT_MS\s*=\s*(?!8000)\d+/.test(nominatorSrc),
    (v) => v === true, '8000 production deadlines');

  assert('evidence collector waits for native settlement and does not pass the 8s caller deadline',
    collectSrc.includes('waitForNativeSettlement: true')
      && collectSrc.includes('generateRecollectionSemanticProposal')
      && !collectSrc.includes('timeoutMs')
      && nominatorSrc.includes('waitForNativeSettlement === true')
      && /opts\?\.waitForNativeSettlement === true[\s\S]{0,80}\{\s*\}/.test(nominatorSrc)
      && !observeSrc.includes('waitForNativeSettlement'),
    (v) => v === true, 'evidence-only no deadline');

  assert('device matrix remains the accepted fixture set',
    collectSrc.includes('RECOLLECTION_SEMANTIC_EVAL_FIXTURES')
      && RECOLLECTION_SEMANTIC_EVAL_FIXTURES.length >= 32,
    (v) => v === true, '>=32 fixtures');

  resetSemanticCompletionLifecycleForTests();

  {
    const d = deferredCompletion();
    const started = Date.now();
    const pending = collectRecollectionSemanticEvidence(() => d.ctx, EXEC, SCORED);
    await tick();
    const midCalls = d.calls.length;
    const held = isSemanticNativeCompletionInFlight();
    const overlapping = await generateRecollectionSemanticProposal(
      'The summer I turned eight we slept on the porch.',
      () => d.ctx,
      { waitForNativeSettlement: true },
    );
    assert('evidence mode waits for first native completion before second begins; no overlapping completion',
      midCalls === 1
        && held === true
        && overlapping.status === 'unavailable' && overlapping.reason === 'in_flight'
        && d.calls.length === 1,
      (v) => v === true, 'one native in flight');
    await new Promise((r) => setTimeout(r, 40));
    d.resolve(0, { text: '{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}' });
    await tick();
    await tick();
    d.resolve(1, { text: '{"disposition":"TRANSIENT","confidence":0.8}' });
    const artifact = await pending;
    const [a, b] = artifact.rows;
    assert('settled evidence records raw output, parsed disposition, verdict, status, and actual duration',
      a.generationStatus === 'ok'
        && a.rawSemanticOutput?.includes('AUTOBIOGRAPHICAL')
        && a.parsedModelDisposition === 'AUTOBIOGRAPHICAL'
        && a.effectiveDisposition === 'AUTOBIOGRAPHICAL'
        && a.expected === 'AUTOBIOGRAPHICAL'
        && a.verdict === 'PASS'
        && a.unavailableReason === null
        && a.durationMs >= 30
        && Date.now() - started >= a.durationMs
        && b.generationStatus === 'ok'
        && b.parsedModelDisposition === 'TRANSIENT'
        && b.verdict === 'PASS'
        && d.calls.length === 2
        && isSemanticNativeCompletionInFlight() === false,
      (v) => v === true, 'two settled rows');
    assert('latency summary includes all settled generation durations',
      artifact.latency.n === 2
        && artifact.latency.durationsMs.length === 2
        && artifact.latency.durationsMs[0] === a.durationMs
        && artifact.latency.durationsMs[1] === b.durationMs,
      (v) => v === true, 'latency n=2');
  }

  resetSemanticCompletionLifecycleForTests();

  {
    const d = deferredCompletion();
    const pending = collectRecollectionSemanticEvidence(() => d.ctx, EXEC, SCORED);
    await tick();
    d.reject(0, new Error('native boom'));
    await tick();
    await tick();
    d.resolve(1, { text: '{"disposition":"TRANSIENT","confidence":0.8}' });
    const artifact = await pending;
    assert('native rejection records error duration then proceeds to the next fixture',
      artifact.rows[0].generationStatus === 'unavailable'
        && artifact.rows[0].unavailableReason === 'error'
        && artifact.rows[0].verdict === 'UNAVAILABLE'
        && artifact.rows[0].durationMs >= 0
        && artifact.rows[1].generationStatus === 'ok'
        && artifact.rows[1].parsedModelDisposition === 'TRANSIENT'
        && artifact.latency.n === 2
        && artifact.latency.durationsMs.includes(artifact.rows[0].durationMs)
        && d.calls.length === 2
        && isSemanticNativeCompletionInFlight() === false,
      (v) => v === true, 'error then settle');
  }

  resetSemanticCompletionLifecycleForTests();

  {
    const ctx = {
      completion: async () => ({ text: '{"disposition":"UNCERTAIN","confidence":0.4}' }),
    };
    const artifact = await collectRecollectionSemanticEvidence(() => ctx, EXEC, [OBS]);
    assert('observational rows remain observational after settlement',
      artifact.rows[0].scoring === 'observational'
        && artifact.rows[0].verdict === 'OBSERVATIONAL'
        && artifact.rows[0].generationStatus === 'ok'
        && artifact.rows[0].expected === null,
      (v) => v === true, 'OBSERVATIONAL');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}RecollectionSemanticSettledEvidenceV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('recollectionSemanticSettledEvidence')) {
  runRecollectionSemanticSettledEvidenceV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
