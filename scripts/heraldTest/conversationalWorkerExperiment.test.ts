// Independent Qwen ConversationalWorker — selection, flag, presentation, Gate A isolation.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED,
  LOCAL_LLM_ENABLED,
} from '../../src/constants/features.ts';
import {
  generateViaSelectedWorker,
  selectConversationalWorker,
} from '../../src/conversation/conversationalWorker.ts';
import { sanitizeConversationalPresentation } from '../../src/conversation/conversationalPresentation.ts';
import { createExperimentalQwenLlamaWorker } from '../../src/conversation/experimentalQwenLlamaWorker.ts';
import { createLlamaEphemeralWorker } from '../../src/conversation/llamaEphemeralWorker.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');
const WORKER_SRC = readFileSync(join(HERE, '../../src/conversation/conversationalWorker.ts'), 'utf8');
const ADAPTER = readFileSync(join(HERE, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
const HOOK = readFileSync(join(HERE, '../../src/conversation/useExperimentalConversationalEngine.ts'), 'utf8');
const MODEL = readFileSync(join(HERE, '../../src/conversation/experimentalQwenModel.ts'), 'utf8');

export async function runConversationalWorkerExperimentTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, ok: boolean, detail?: string) {
    if (ok) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}${detail ? `\n       ${DIM}${detail}${RESET}` : ''}`);
      failures.push({ label, got: detail ?? false, expected: 'true' });
    }
  }

  console.log(`\n${BOLD}-- Independent Qwen Conversational Worker -----------------${RESET}\n`);

  assert('CWX-1 LOCAL_LLM_ENABLED remains false', LOCAL_LLM_ENABLED === false);
  assert('CWX-2 experiment flag is independent and true', CONVERSATIONAL_WORKER_EXPERIMENT_ENABLED === true);
  assert('CWX-3 engine hook does not import LOCAL_LLM_ENABLED', !HOOK.includes('LOCAL_LLM_ENABLED'));
  assert('CWX-4 adapter does not import LOCAL_LLM_ENABLED', !/import \{[^}]*LOCAL_LLM_ENABLED/.test(ADAPTER));
  assert('CWX-5 model layer does not import src/dev', !MODEL.includes('../dev/') && !MODEL.includes("from '../dev"));
  assert(
    'CWX-6 artifact identity preserved',
    MODEL.includes("filename: 'Qwen3-1.7B-Q4_K_M.gguf'")
      && MODEL.includes('1_107_409_472')
      && MODEL.includes('b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897')
      && !MODEL.includes('../dev/'),
  );

  const qwenReady = createExperimentalQwenLlamaWorker({
    getCtx: () => ({}) as never,
    enabled: true,
  });
  const qwenFlagOff = createExperimentalQwenLlamaWorker({
    getCtx: () => ({}) as never,
    enabled: false,
  });
  const qwenNoCtx = createExperimentalQwenLlamaWorker({
    getCtx: () => null,
    enabled: true,
  });
  const llama = createLlamaEphemeralWorker({ getCtx: () => ({}) as never });

  assert(
    'CWX-A LOCAL_LLM false does not block Qwen when engine ctx is present',
    LOCAL_LLM_ENABLED === false && qwenReady.isAvailable() === true,
  );
  assert('CWX-B Qwen unavailable when its flag is false', qwenFlagOff.isAvailable() === false);
  assert('CWX-C Qwen unavailable when ctx is absent', qwenNoCtx.isAvailable() === false);
  assert('CWX-D llama unavailable while LOCAL_LLM is false', llama.isAvailable() === false);
  assert(
    'CWX-D2 selectConversationalWorker chooses Qwen when llama is down and Qwen is ready',
    selectConversationalWorker([llama, qwenReady])?.id === 'experimental-on-device-conversation',
  );
  assert(
    'CWX-D3 flag-off Qwen is not selected even with ctx',
    selectConversationalWorker([llama, qwenFlagOff]) === null,
  );

  const flagOffGen = await qwenFlagOff.generate({ userText: 'hello', hotEntries: [] });
  assert('CWX-B2 generate refuses when flag is false', flagOffGen.status === 'unavailable');

  const stripped = sanitizeConversationalPresentation('<think>secret</think>\nHello there.');
  assert(
    'CWX-E think tags stripped from Qwen presentation',
    stripped.text === 'Hello there.' && stripped.nonemptyThinkStripped === true,
  );
  assert(
    'CWX-E2 sanitation lives in the Qwen adapter, not the shared worker socket',
    ADAPTER.includes('sanitizeConversationalPresentation')
      && !WORKER_SRC.includes('sanitizeConversationalPresentation'),
  );

  assert(
    'CWX-F spike trigger is absent from ChatScreen',
    !CHAT.includes('isSpikeB1Trigger')
      && !CHAT.includes('__HERALD_SPIKE_B1__')
      && !CHAT.includes('runCapabilitySpikeB1'),
  );
  assert(
    'CWX-G Gate A diagnostic remains',
    CHAT.includes("console.warn('HERALD_GATE_A_DIAG ' + JSON.stringify({"),
  );
  assert(
    'CWX-H ChatScreen wires independent engine into seam status',
    CHAT.includes('conversationalSeamLlmStatus')
      && CHAT.includes('createExperimentalQwenLlamaWorker')
      && /experimentalConvStatus === 'ready' \? 'ready' : llmStatus/.test(CHAT),
  );
  assert(
    'CWX-I classifier still uses production llmStatus, not experiment ready',
    /llmReady: llmStatus === 'ready'/.test(CHAT)
      && /if \(llmStatus === 'ready' && rdTier === 3/.test(CHAT),
  );
  assert(
    'CWX-J adapter has no writer/action API',
    !/medicalDB|runCommitEffects|dispatchEmergency|writeMedication/.test(ADAPTER),
  );

  {
    const fake = createExperimentalQwenLlamaWorker({
      getCtx: () => ({
        completion: async () => ({ content: '<think>nope</think>Warm reply.' }),
      }) as never,
      enabled: true,
    });
    const out = await generateViaSelectedWorker(fake, { userText: 'hi', hotEntries: [] });
    assert(
      'CWX-E3 Qwen generate returns sanitized replyText',
      out.status === 'ok' && out.text === 'Warm reply.',
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationalWorkerExperiment: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalWorkerExperiment.test.ts')) {
  runConversationalWorkerExperimentTests().catch(console.error);
}
