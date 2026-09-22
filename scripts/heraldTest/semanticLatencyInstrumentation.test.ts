// scripts/heraldTest/semanticLatencyInstrumentation.test.ts
// Conversational Latency V1 / Slice A — instrumentation must not change
// semantic proposal, timeout, grounding, or admission results.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCapabilityProposal } from '../../src/routing/capabilityRouting.ts';
import {
  admitTodoSemanticP2,
  generateTodoSemanticProposal,
  parseTodoSemanticProposal,
} from '../../src/routing/todoSemanticCapture.ts';
import {
  admitGrocerySemanticP2,
  generateGrocerySemanticProposal,
} from '../../src/routing/grocerySemanticDecomposition.ts';
import {
  admitMedicationSemanticProposal,
  generateMedicationSemanticProposal,
} from '../../src/routing/medicationSemanticInterpretation.ts';
import { generateRecapInterpretationProposal } from '../../src/routing/immediateSemanticRecap.ts';
import { generateActiveSubjectSelectionProposal } from '../../src/routing/activeSubjectReference.ts';
import { generateViaSelectedWorker } from '../../src/conversation/conversationalWorker.ts';
import type { RecapCandidate } from '../../src/routing/immediateSemanticRecap.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function mockCtx(content: string) {
  return {
    completion: async () => ({
      content,
      timings: { prompt_ms: 1, predicted_ms: 2, prompt_n: 3, cache_n: 4 },
      tokens_predicted: 4,
      tokens_cached: 5,
      tokens_evaluated: 6,
    }),
  } as any;
}

function captureLatencyLines<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? '');
    if (line.includes('[LATENCY-INSTRUMENT]')) lines.push(line);
    orig.apply(console, args as []);
  };
  return fn().then((result) => {
    console.log = orig;
    return { result, lines };
  }, (err) => {
    console.log = orig;
    throw err;
  });
}

function recapCandidate(): RecapCandidate {
  const focus = {
    kind: 'thing' as const,
    displayValue: 'oatmeal',
    resolverKey: 'item:oatmeal',
    referable: true,
    tier: 'authoritative' as const,
  };
  return {
    index: 0,
    kind: 'thing',
    displayValue: 'oatmeal',
    record: {
      turnIndex: 1,
      establishedAt: 1,
      utterance: 'please add oatmeal',
      intentType: 'list_add',
      operation: 'capture',
      outcome: 'committed',
      authorityTier: 'deterministic',
      assistantReplySummary: null,
      focus: [focus],
    },
    focus,
    intentType: 'list_add',
  };
}

export async function runSemanticLatencyInstrumentationTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Semantic latency instrumentation (no behavior change) --${RESET}\n`);

  {
    const json = '{"capability":"todo.capture","confidence":"high"}';
    const r = await generateCapabilityProposal('We need to water the plants.', () => mockCtx(json));
    assert('dispatch proposal parse is unchanged',
      r.status === 'ok' && r.status === 'ok' && (r as any).proposal?.capability === 'todo.capture'
      && (r as any).proposal?.confidence === 'high',
      (v) => v === true, 'todo.capture high');
  }

  {
    const json = JSON.stringify({
      capability: 'todo_capture',
      candidates: ['water the plants'],
      confidence: 0.92,
    });
    const r = await generateTodoSemanticProposal('We need to water the plants.', () => mockCtx(json));
    assert('todo specialist proposal is unchanged',
      r.status === 'ok' && (r as any).proposal?.candidates?.[0] === 'water the plants',
      (v) => v === true, 'water the plants');
  }

  {
    const json = JSON.stringify({
      capability: 'grocery_capture',
      candidates: ['milk'],
      confidence: 0.92,
    });
    const r = await generateGrocerySemanticProposal('We need milk.', () => mockCtx(json));
    assert('grocery specialist proposal is unchanged',
      r.status === 'ok' && (r as any).proposal?.candidates?.[0] === 'milk',
      (v) => v === true, 'milk');
  }

  {
    const json = JSON.stringify({
      mentions: ['lisinopril'],
      predicate: 'take',
      focus: 'lisinopril',
      confidence: 0.92,
    });
    const r = await generateMedicationSemanticProposal('I take lisinopril.', () => mockCtx(json));
    assert('medication specialist proposal is unchanged',
      r.status === 'ok' && (r as any).proposal?.focus === 'lisinopril',
      (v) => v === true, 'lisinopril');
  }

  {
    const parsed = parseTodoSemanticProposal('not json');
    assert('todo parse_fail still null', parsed, (v) => v === null, 'null');
    const r = await generateTodoSemanticProposal('We need to water the plants.', () => mockCtx('not json'));
    assert('todo specialist parse_fail status unchanged',
      r.status, (v) => v === 'parse_fail', 'parse_fail');
  }

  {
    const d = admitTodoSemanticP2(
      'We need to water the plants.',
      { capability: 'todo_capture', candidates: ['water the plants'], confidence: 0.92 },
      { hasPending: false },
    );
    assert('todo admission ADMIT unchanged',
      d.decision === 'ADMIT' && d.decision === 'ADMIT' && d.candidates[0] === 'water the plants',
      (v) => v === true, 'ADMIT water the plants');
  }

  {
    const d = admitGrocerySemanticP2(
      'We need milk.',
      { capability: 'grocery_capture', candidates: ['milk'], confidence: 0.92 },
      { hasPending: false },
    );
    assert('grocery admission ADMIT unchanged',
      d.decision === 'ADMIT' && d.decision === 'ADMIT' && d.candidates[0] === 'milk',
      (v) => v === true, 'ADMIT milk');
  }

  {
    const d = admitMedicationSemanticProposal(
      'My cardiologist put me on Eliquis.',
      { mentions: ['Eliquis'], predicate: 'put', focus: 'Eliquis', confidence: 0.92 },
      { hasPending: false },
    );
    assert('medication admission ADMIT unchanged',
      d.decision === 'ADMIT' && (d as any).drug === 'Eliquis',
      (v) => v === true, 'ADMIT Eliquis');
  }

  {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const cap = fs.readFileSync(path.join(root, 'src/routing/capabilityRouting.ts'), 'utf8');
    const todo = fs.readFileSync(path.join(root, 'src/routing/todoSemanticCapture.ts'), 'utf8');
    const grocery = fs.readFileSync(path.join(root, 'src/routing/grocerySemanticDecomposition.ts'), 'utf8');
    const med = fs.readFileSync(path.join(root, 'src/routing/medicationSemanticInterpretation.ts'), 'utf8');
    const engine = fs.readFileSync(path.join(root, 'src/hooks/useMedicationSemanticInterpreterEngine.ts'), 'utf8');
    const chat = fs.readFileSync(path.join(root, 'src/screens/ChatScreen.tsx'), 'utf8');
    const dispatch = fs.readFileSync(path.join(root, 'src/screens/chat/dispatch.ts'), 'utf8');
    assert('dispatch n_predict is 128 (one-pass write payload budget)', /n_predict:\s*128/.test(cap), (v) => v === true, '128');
    assert('specialist n_predict remains 128 and timeouts remain 8000',
      /n_predict:\s*128/.test(todo) && /TODO_SEMANTIC_TIMEOUT_MS = 8000/.test(todo)
      && /n_predict:\s*128/.test(grocery) && /GROCERY_SEMANTIC_TIMEOUT_MS = 8000/.test(grocery)
      && /n_predict:\s*128/.test(med),
      (v) => v === true, '128 / 8000');
    assert('semantic 3B stays CPU-only',
      /n_gpu_layers:\s*0/.test(engine) && !/n_gpu_layers:\s*[1-9]/.test(engine),
      (v) => v === true, 'n_gpu_layers 0');
    const lifecycle = fs.readFileSync(path.join(root, 'src/utils/semanticCompletionLifecycle.ts'), 'utf8');
    assert('timeout/error specialist outcomes still map identically',
      /String\(e\)\.includes\('timeout'\) \? 'timeout' : 'error'/.test(lifecycle)
      && /run\.reason === 'timeout' \|\| run\.reason === 'error'/.test(todo)
      && /run\.reason === 'timeout' \|\| run\.reason === 'error'/.test(grocery)
      && /logSemanticSpecialistInferenceEnd\('todo'/.test(todo)
      && /logSemanticSpecialistInferenceEnd\('grocery'/.test(grocery),
      (v) => v === true, 'timeout|error');
    assert('realization marker sits immediately before speak/dispatchRead handoff',
      /logRealizationDoneIfSemanticTurn\(\);[\s\S]{0,80}speak\(outcome\.responseText\)/.test(chat)
      && /logRealizationDoneIfSemanticTurn\(\);[\s\S]{0,80}speak\(response\)/.test(dispatch),
      (v) => v === true, 'before speak');
  }

  {
    const recapJson = '{"isImmediateRecap":false,"selectedIndex":null,"confidence":0.4}';
    const { result, lines } = await captureLatencyLines(() =>
      generateRecapInterpretationProposal('what was that again', [recapCandidate()], () => mockCtx(recapJson)));
    const joined = lines.join('\n');
    assert('recap Stage B result is unchanged',
      result.status === 'ok' && result.status === 'ok' && result.proposal.isImmediateRecap === false,
      (v) => v === true, 'ok not recap');
    assert('recap Stage B emits start/end timing with llama fields',
      /SEMANTIC_RECAP_INFERENCE_START/.test(joined)
      && /SEMANTIC_RECAP_INFERENCE_END/.test(joined)
      && /"prompt_ms":1/.test(joined)
      && /"model":"semantic-3b"/.test(joined),
      (v) => v === true, 'recap start/end');
  }

  {
    const subjJson = '{"applicable":false,"selectedIndex":null,"ambiguous":false,"confidence":0.2}';
    const { result, lines } = await captureLatencyLines(() =>
      generateActiveSubjectSelectionProposal('how is the weather', [recapCandidate()], () => mockCtx(subjJson)));
    const joined = lines.join('\n');
    assert('active-subject Stage B result is unchanged',
      result.status === 'ok' && result.status === 'ok' && result.proposal.applicable === false,
      (v) => v === true, 'ok not applicable');
    assert('active-subject Stage B emits start/end timing with llama fields',
      /ACTIVE_SUBJECT_INFERENCE_START/.test(joined)
      && /ACTIVE_SUBJECT_INFERENCE_END/.test(joined)
      && /"predicted_ms":2/.test(joined),
      (v) => v === true, 'active-subject start/end');
  }

  {
    const worker = {
      id: 'experimental-on-device-conversation',
      isAvailable: () => true,
      generate: async () => ({
        status: 'ok' as const,
        replyText: 'Glad it went well.',
        completionResult: {
          timings: { prompt_ms: 9, predicted_ms: 11, cache_n: 2, prompt_n: 8 },
          tokens_cached: 2,
          tokens_evaluated: 8,
          tokens_predicted: 12,
        },
      }),
    };
    const { result, lines } = await captureLatencyLines(() =>
      generateViaSelectedWorker(worker, { userText: 'I had a nice morning.', hotEntries: [] }));
    const joined = lines.join('\n');
    assert('conversation worker result is unchanged',
      result.status === 'ok' && result.status === 'ok' && result.text === 'Glad it went well.',
      (v) => v === true, 'ok reply');
    assert('conversation worker emits start/end timing with worker id',
      /CONVERSATION_INFERENCE_START/.test(joined)
      && /CONVERSATION_INFERENCE_END/.test(joined)
      && /experimental-on-device-conversation/.test(joined)
      && /"tokens_predicted":12/.test(joined),
      (v) => v === true, 'conversation start/end');
  }

  {
    const { result, lines } = await captureLatencyLines(() =>
      generateViaSelectedWorker(null, { userText: 'hello', hotEntries: [] }));
    const joined = lines.join('\n');
    assert('null conversational worker still returns no-ctx',
      result.status === 'unavailable' && result.status === 'unavailable' && result.reason === 'no-ctx',
      (v) => v === true, 'no-ctx');
    assert('null conversational worker does not emit conversation inference',
      /CONVERSATION_INFERENCE_START/.test(joined),
      (v) => v === false, 'no start');
  }

  {
    const { logQwenWarmupStart, logQwenWarmupEnd } = await import('../../src/utils/latencyInstrument.ts');
    const { lines } = await captureLatencyLines(async () => {
      logQwenWarmupStart();
      logQwenWarmupEnd(123.456, {
        timings: { prompt_ms: 9, predicted_ms: 1, cache_n: 2, prompt_n: 8 },
      }, 'ok');
      return null;
    });
    const joined = lines.join('\n');
    assert('qwen warmup instrumentation emits START before END',
      joined.indexOf('QWEN_WARMUP_START') < joined.indexOf('QWEN_WARMUP_END')
        && joined.indexOf('QWEN_WARMUP_START') >= 0,
      (v) => v === true, 'start then end');
    assert('qwen warmup END carries duration and llama timing fields',
      /"durationMs":123.46/.test(joined)
        && /"outcome":"ok"/.test(joined)
        && /"prompt_ms":9/.test(joined)
        && /"cache_n":2/.test(joined)
        && !/hello/.test(joined),
      (v) => v === true, 'bounded fields');
  }

  {
    const {
      logQwenRuntimeInitDiag,
      logQwenRuntimeBenchBaseline,
      logQwenRuntimeThreadProbeOmitted,
    } = await import('../../src/utils/latencyInstrument.ts');
    const { lines } = await captureLatencyLines(async () => {
      logQwenRuntimeInitDiag({ n_ctx: 2048, modelFile: 'Qwen3-1.7B-Q4_K_M.gguf' });
      logQwenRuntimeBenchBaseline({ outcome: 'ok', nThreads: 4 });
      logQwenRuntimeThreadProbeOmitted({ outcome: 'omitted' });
      return null;
    });
    const joined = lines.join('\n');
    assert('qwen runtime diagnostic events are bounded technical logs',
      /QWEN_RUNTIME_INIT_DIAG/.test(joined)
      && /QWEN_RUNTIME_BENCH_BASELINE/.test(joined)
      && /QWEN_RUNTIME_THREAD_PROBE_OMITTED/.test(joined)
      && !/hello/.test(joined),
      (v) => v === true, 'init/bench/omitted');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}SemanticLatencyInstrumentation: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('semanticLatencyInstrumentation.test.ts')) {
  runSemanticLatencyInstrumentationTests().catch(console.error);
}
