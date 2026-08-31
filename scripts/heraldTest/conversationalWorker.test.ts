// scripts/heraldTest/conversationalWorker.test.ts
// Conversational Worker foundation — selection, seam consumption, authority fence.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_LLM_ENABLED } from '../../src/constants/features.ts';
import {
  selectConversationalWorker,
  generateViaSelectedWorker,
  type ConversationalWorker,
  type ConversationRequest,
  type ConversationResponse,
} from '../../src/conversation/conversationalWorker.ts';
import { createLlamaEphemeralWorker } from '../../src/conversation/llamaEphemeralWorker.ts';
import {
  EPHEMERAL_CLARIFY_REPLY,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = readFileSync(join(HERE, '../../src/conversation/conversationalWorker.ts'), 'utf8');
const ADAPTER_SRC = readFileSync(join(HERE, '../../src/conversation/llamaEphemeralWorker.ts'), 'utf8');

function fakeWorker(
  id: string,
  available: boolean,
  generateImpl?: (req: ConversationRequest) => Promise<ConversationResponse>,
): ConversationalWorker {
  return {
    id,
    isAvailable: () => available,
    generate: generateImpl ?? (async () => ({ status: 'ok', replyText: `from:${id}` })),
  };
}

const SEAM_BASE = {
  text: 'It sure is quiet around here today.',
  reason: 'default' as const,
  hasAuthorizedContinuation: false,
  hasPendingSession: false,
  hasContactCollectPending: false,
  rdTier: 3 as const,
  hasStructuredCaptures: false,
  isPersonalCaptureRisk: false,
  llmStatus: 'ready' as const,
  classifierBusy: false,
  ephemeralBusy: false,
};

export async function runConversationalWorkerTests() {
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

  console.log(`\n${BOLD}-- Conversational Worker Foundation ------------------------${RESET}\n`);

  assert('CW-1 LOCAL_LLM_ENABLED remains false', LOCAL_LLM_ENABLED, (v) => v === false, 'false');

  {
    const available = fakeWorker('on-device-conversation', true);
    const selected = selectConversationalWorker([available]);
    assert('CW-2 available worker is selected', selected?.id, (v) => v === 'on-device-conversation', 'on-device-conversation');
  }

  {
    const down = fakeWorker('on-device-conversation', false);
    assert('CW-3 unavailable worker is not selected', selectConversationalWorker([down]), (v) => v === null, 'null');
  }

  {
    const down = fakeWorker('a', false);
    const up = fakeWorker('b', true);
    assert('CW-4 first available in order wins', selectConversationalWorker([down, up])?.id, (v) => v === 'b', 'b');
  }

  {
    const llama = createLlamaEphemeralWorker({ getCtx: () => ({}) as never });
    assert('CW-5 llama adapter unavailable while LOCAL_LLM_ENABLED is false',
      llama.isAvailable(), (v) => v === false, 'false');
    const out = await llama.generate({ userText: 'hello', hotEntries: [] });
    assert('CW-6 llama adapter generate is unavailable without enabling the flag',
      out, (v) => (v as { status: string; reason?: string }).status === 'unavailable'
        && (v as { reason?: string }).reason === 'no-ctx',
      'unavailable / no-ctx');
  }

  {
    const result = await generateViaSelectedWorker(null, { userText: 'hello', hotEntries: [] });
    assert('CW-7 no worker maps to existing no-ctx unavailable',
      result, (v) => (v as { status: string; reason?: string }).status === 'unavailable'
        && (v as { reason?: string }).reason === 'no-ctx',
      'unavailable / no-ctx');
  }

  {
    const outcome = await resolveEphemeralSeam({
      ...SEAM_BASE,
      generate: () => generateViaSelectedWorker(null, { userText: SEAM_BASE.text, hotEntries: [] }),
    });
    assert('CW-8 no qualifying worker → existing clarify fallback',
      { kind: outcome.kind, reply: outcome.reply },
      (v) => {
        const x = v as { kind: string; reply: string };
        return x.kind === 'clarify' && x.reply === EPHEMERAL_CLARIFY_REPLY;
      },
      'clarify + EPHEMERAL_CLARIFY_REPLY');
  }

  {
    const worker = fakeWorker('on-device-conversation', true, async () => ({
      status: 'ok',
      replyText: 'Quiet days can be a gift.',
    }));
    const outcome = await resolveEphemeralSeam({
      ...SEAM_BASE,
      generate: () => generateViaSelectedWorker(worker, { userText: SEAM_BASE.text, hotEntries: [] }),
    });
    assert('CW-9 seam consumes generation through the worker boundary',
      { kind: outcome.kind, reply: outcome.kind === 'generative' ? outcome.reply : '' },
      (v) => {
        const x = v as { kind: string; reply: string };
        return x.kind === 'generative' && x.reply === 'Quiet days can be a gift.';
      },
      'generative / worker replyText');
  }

  {
    const banned = [
      'DOMAIN_WRITERS', 'medicalDB', 'factDB', 'schema', 'routeIntent',
      'dispatchAction', 'setDB', 'writeMedication', 'todo_add',
    ];
    assert('CW-10 worker contract has no memory/write/action imports',
      banned.filter((token) => WORKER_SRC.includes(token)),
      (v) => Array.isArray(v) && v.length === 0,
      '[]');
    assert('CW-11 worker contract has no llama.rn import',
      /from ['"]llama\.rn['"]/.test(WORKER_SRC), (v) => v === false, 'false');
  }

  {
    let generateCalled = false;
    const worker = fakeWorker('on-device-conversation', true, async () => {
      generateCalled = true;
      return { status: 'ok', replyText: 'should not speak' };
    });
    const outcome = await resolveEphemeralSeam({
      ...SEAM_BASE,
      hasPendingSession: true,
      generate: () => generateViaSelectedWorker(worker, {
        userText: SEAM_BASE.text,
        hotEntries: [],
      }),
    });
    assert('CW-12 pending deterministic owner still preempts worker generate',
      { kind: outcome.kind, generateCalled, reply: outcome.reply },
      (v) => {
        const x = v as { kind: string; generateCalled: boolean; reply: string };
        return x.kind === 'clarify' && x.generateCalled === false && x.reply === EPHEMERAL_CLARIFY_REPLY;
      },
      'clarify, generate not called');
  }

  assert('CW-13 adapter may import llama.rn; contract must not',
    /from ['"]llama\.rn['"]/.test(ADAPTER_SRC) && !/from ['"]llama\.rn['"]/.test(WORKER_SRC),
    (v) => v === true,
    'adapter yes / contract no');

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationalWorker: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationalWorker.test.ts')) {
  runConversationalWorkerTests().catch(console.error);
}
