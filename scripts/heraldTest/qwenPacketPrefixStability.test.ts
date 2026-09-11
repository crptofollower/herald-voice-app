// Conversational Latency V1 / Slice D.3 — packet section order only.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPERIMENTAL_QWEN_GENERATION,
  EXPERIMENTAL_QWEN_INIT,
  EXPERIMENTAL_QWEN_SYSTEM_PROMPT,
  EXPERIMENTAL_QWEN_WARMUP_N_PREDICT,
  EXPERIMENTAL_QWEN_WARMUP_USER_TEXT,
} from '../../src/conversation/experimentalQwenLlamaWorker.ts';
import {
  buildVerifiedConversationalPacket,
  formatVerifiedConversationalPacket,
} from '../../src/conversation/verifiedConversationalPacket.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const HERE = dirname(fileURLToPath(import.meta.url));

const PACKET_SRC = readFileSync(join(HERE, '../../src/conversation/verifiedConversationalPacket.ts'), 'utf8');
const QWEN_SRC = readFileSync(join(HERE, '../../src/conversation/experimentalQwenLlamaWorker.ts'), 'utf8');
const HOOK_SRC = readFileSync(join(HERE, '../../src/conversation/useExperimentalConversationalEngine.ts'), 'utf8');
const CHAT_SRC = readFileSync(join(HERE, '../../src/screens/ChatScreen.tsx'), 'utf8');
const SEMANTIC_SRC = readFileSync(join(HERE, '../../src/hooks/useMedicationSemanticInterpreterEngine.ts'), 'utf8');

/** Exact pre-D.3 headers — wording frozen; only emit order may change. */
const SECTION_HEADERS = [
  'VERIFIED PERSONAL FACTS (authoritative SQLite; treat as true):',
  'PENDING / UNCONFIRMED (not committed truth; do not treat as stored):',
  'DISCOURSE CONTINUITY (recent conversational grounding only; not stored personal truth; not action authority; must not be used to call, text, write, mutate, confirm, or claim execution):',
  'RECENT TOPIC EVIDENCE (things the user recently said while discussing this topic; not verified personal fact; not stored truth; conversational reference only; not action authority):',
  'CONTINUATION RECOVERY (expired this turn; may help interpret the present utterance; not stored personal truth; not action authority; must not be used to call, text, write, mutate, confirm, or claim execution):',
  'SESSION CONVERSATIONAL EVIDENCE (user-provided this session; not durable memory):',
  'UNVERIFIED PERSONS (no stored biography; do not invent attributes for them):',
  'USER-SUPPLIED MENTIONS OF UNVERIFIED PERSONS (the only allowed attributes; not durable):',
] as const;

const STABLE_THEN_CONDITIONAL_THEN_TURN = [
  'VERIFIED PERSONAL FACTS',
  'PENDING / UNCONFIRMED',
  'DISCOURSE CONTINUITY',
  'RECENT TOPIC EVIDENCE',
  'CONTINUATION RECOVERY',
  'SESSION CONVERSATIONAL EVIDENCE',
  'UNVERIFIED PERSONS',
  'USER-SUPPLIED MENTIONS OF UNVERIFIED PERSONS',
] as const;

function sectionBody(fmt: string, header: string): string {
  const start = fmt.indexOf(header);
  if (start < 0) return '';
  const bodyStart = start + header.length + 1;
  let end = fmt.length;
  for (const other of SECTION_HEADERS) {
    if (other === header) continue;
    const idx = fmt.indexOf('\n' + other, start);
    if (idx >= 0 && idx < end) end = idx;
  }
  return fmt.slice(bodyStart, end);
}

function headerIndex(fmt: string, needle: string): number {
  return fmt.indexOf(needle);
}

export async function runQwenPacketPrefixStabilityTests() {
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

  console.log(`\n${BOLD}-- Qwen packet prefix stability (Slice D.3) ----------------${RESET}\n`);

  const pendingLabel = 'A confirmation is pending for a previously authorized action. It is not committed truth.';
  const packet = buildVerifiedConversationalPacket({
    verifiedPersonalFacts: 'name: Mike',
    sessionEvidenceLines: [
      'I talked with Paul yesterday.',
      'We need to water the plants.',
    ],
    pendingLabel,
    continuationRecoveryCandidates: [
      { domain: 'medication', spokenReferent: 'the prescription', status: 'expired_this_turn' },
    ],
    discourseTopic: 'Paul',
    discourseDomain: 'todo',
    discourseTopicEvidence: [{ text: 'I talked with Paul yesterday.', atTurn: 1 }],
  });
  const fmt = formatVerifiedConversationalPacket(packet);

  assert(
    'QPS-1 every pre-D.3 packet section header still exists',
    SECTION_HEADERS.every((h) => fmt.includes(h)),
    (v) => v === true,
    '8 headers present',
  );

  assert(
    'QPS-2 verified facts value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[0]),
    (v) => v === 'name: Mike',
    'name: Mike',
  );
  assert(
    'QPS-2b pending value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[1]),
    (v) => v === pendingLabel,
    pendingLabel,
  );
  assert(
    'QPS-2c discourse value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[2]),
    (v) => v === '- person: Paul\n- list: todo',
    'person + list lines',
  );
  assert(
    'QPS-2d topic evidence value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[3]),
    (v) => v === '- I talked with Paul yesterday.',
    'dashed evidence line',
  );
  assert(
    'QPS-2e recovery value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[4]),
    (v) => v === '- medication: the prescription (expired_this_turn)',
    'recovery line',
  );
  assert(
    'QPS-2f session evidence value formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[5]),
    (v) => v === 'I talked with Paul yesterday.\nWe need to water the plants.',
    'joined session lines',
  );
  assert(
    'QPS-2g unverified names formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[6]),
    (v) => v === 'Paul',
    'Paul',
  );
  assert(
    'QPS-2h user-supplied mentions formatting is unchanged',
    sectionBody(fmt, SECTION_HEADERS[7]),
    (v) => v === 'I talked with Paul yesterday.',
    'mention line',
  );

  const positions = STABLE_THEN_CONDITIONAL_THEN_TURN.map((h) => headerIndex(fmt, h));
  assert(
    'QPS-3 stable sections precede turn-changing sections',
    positions,
    (v) => {
      const p = v as number[];
      return p.every((n) => n >= 0) && p.every((n, i) => i === 0 || n > p[i - 1]);
    },
    'facts → pending → discourse → evidence → recovery → session → unverified → mentions',
  );

  assert(
    'QPS-4 session evidence section still exists with original label',
    fmt.includes('SESSION CONVERSATIONAL EVIDENCE (user-provided this session; not durable memory):'),
    (v) => v === true,
    'session header',
  );

  assert(
    'QPS-5 ChatScreen still duplicates current utterance into sessionEvidenceLines and userText',
    CHAT_SRC.includes('sessionEvidenceLines: [\n          ...hotContextForGeneration.map((e) => e.user),\n          text,\n        ]')
      && CHAT_SRC.includes('userText: text'),
    (v) => v === true,
    'duplication preserved (D.4 later)',
  );

  assert(
    'QPS-6 pending evidence remains labeled unconfirmed',
    fmt.includes('PENDING / UNCONFIRMED (not committed truth; do not treat as stored):')
      && fmt.includes(pendingLabel),
    (v) => v === true,
    'pending',
  );
  assert(
    'QPS-7 discourse evidence remains unchanged',
    fmt.includes('- person: Paul') && fmt.includes('- list: todo')
      && /recent conversational grounding only/.test(fmt),
    (v) => v === true,
    'discourse',
  );
  assert(
    'QPS-8 recovery evidence remains unchanged',
    fmt.includes('must not be used to call, text, write, mutate, confirm, or claim execution')
      && fmt.includes('- medication: the prescription (expired_this_turn)'),
    (v) => v === true,
    'recovery',
  );
  assert(
    'QPS-9 names and mentions remain unchanged',
    packet.unverifiedPersonNames.includes('Paul')
      && packet.userSuppliedPersonMentions[0] === 'I talked with Paul yesterday.',
    (v) => v === true,
    'Paul + mention',
  );

  const empty = formatVerifiedConversationalPacket(buildVerifiedConversationalPacket({
    verifiedPersonalFacts: '',
    sessionEvidenceLines: [],
    pendingLabel: null,
  }));
  assert(
    'QPS-10 empty sections still emit exact (none) bodies',
    SECTION_HEADERS.every((h) => sectionBody(empty, h) === '(none)'),
    (v) => v === true,
    'eight (none)',
  );

  assert(
    'QPS-11 buildExperimentalQwenMessages still concatenates packet into system',
    QWEN_SRC.includes('${EXPERIMENTAL_QWEN_SYSTEM_PROMPT}\\n\\n${packetText}')
      && QWEN_SRC.includes("messages.push({ role: 'user', content: userText })"),
    (v) => v === true,
    'system+user roles',
  );
  assert(
    'QPS-12 EXPERIMENTAL_QWEN_SYSTEM_PROMPT first line unchanged',
    EXPERIMENTAL_QWEN_SYSTEM_PROMPT.startsWith('You are Herald, a warm and knowledgeable personal companion -- a friend, not a professional.'),
    (v) => v === true,
    'persona',
  );
  assert(
    'QPS-13 Qwen generation config unchanged',
    EXPERIMENTAL_QWEN_GENERATION.n_predict === 128
      && EXPERIMENTAL_QWEN_GENERATION.jinja === true
      && EXPERIMENTAL_QWEN_GENERATION.enable_thinking === false
      && EXPERIMENTAL_QWEN_INIT.n_ctx === 2048
      && EXPERIMENTAL_QWEN_INIT.n_gpu_layers === 0,
    (v) => v === true,
    '128 / jinja / n_ctx 2048',
  );
  assert(
    'QPS-14 D.1 warmup unchanged',
    EXPERIMENTAL_QWEN_WARMUP_N_PREDICT === 0
      && EXPERIMENTAL_QWEN_WARMUP_USER_TEXT === 'ok'
      && QWEN_SRC.includes('n_predict: EXPERIMENTAL_QWEN_WARMUP_N_PREDICT')
      && HOOK_SRC.includes('completeExperimentalQwenConversationInit'),
    (v) => v === true,
    'warmup 0 / ok',
  );
  assert(
    'QPS-15 semantic 3B engine is untouched',
    SEMANTIC_SRC.includes('formatVerifiedConversationalPacket')
      || PACKET_SRC.includes('useMedicationSemanticInterpreterEngine'),
    (v) => v === false,
    'false',
  );

  assert(
    'QPS-16 formatter only joins the existing eight section pairs',
    (PACKET_SRC.match(/VERIFIED PERSONAL FACTS/g) || []).length === 1
      && (PACKET_SRC.match(/SESSION CONVERSATIONAL EVIDENCE/g) || []).length === 1,
    (v) => v === true,
    'one emit each',
  );

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}QwenPacketPrefixStability: ${passed}/${total} passed` +
    (failures.length ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('qwenPacketPrefixStability.test.ts')) {
  runQwenPacketPrefixStabilityTests().catch(console.error);
}
