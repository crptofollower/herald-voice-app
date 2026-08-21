// scripts/heraldTest/hotNarrativeRing.test.ts
// Step 5a — HOT narrative ring mechanism + boundary tests (Option 4 depth-only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHotNarrativeRing,
  selectContiguousHotSuffix,
  hotAssistantPolicyForDeviceRead,
  hasImmediatelyAdjacentHotAuthorization,
  HOT_RING_TTL_MS,
  HOT_RING_MAX_PAIRS,
  HOT_RING_MAX_INCLUDED_CHARS,
  type HotRingEntry,
  type HotNarrativeRing,
} from '../../src/utils/hotNarrativeRing.ts';
import {
  buildEphemeralPromptMessages,
  isEligibleForEphemeralConversation,
} from '../../src/utils/ephemeralConversation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function entry(
  turnIndex: number,
  user: string,
  assistant: string,
  opts?: { policy?: 'include' | 'omit'; establishedAt?: number },
): HotRingEntry {
  return {
    turnIndex,
    user,
    assistant,
    establishedAt: opts?.establishedAt ?? Date.now(),
    assistantHotPolicy: opts?.policy ?? 'include',
  };
}

/** Mirrors ChatScreen sendMessage turn-entry wiring — production exports only. */
function turnEntry(
  ring: HotNarrativeRing,
  turnIndexRef: { current: number },
  nowMs: number,
): { authorized: boolean; turnIndex: number } {
  turnIndexRef.current += 1;
  const peeked = ring.peek(nowMs);
  const authorized = hasImmediatelyAdjacentHotAuthorization(peeked, turnIndexRef.current);
  return { authorized, turnIndex: turnIndexRef.current };
}

function pushAuthorizedPair(
  ring: HotNarrativeRing,
  turnIndex: number,
  user: string,
  assistant: string,
  nowMs: number,
): void {
  ring.push(entry(turnIndex, user, assistant, { establishedAt: nowMs }));
}

export async function runHotNarrativeRingTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, expected: unknown) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (ok) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  function assertTrue(label: string, cond: boolean) {
    if (cond) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
      failures.push({ label, got: cond, expected: 'true' });
    }
  }

  console.log(`\n${BOLD}-- HOT Narrative Ring Tests (Step 5a) ------------------------${RESET}`);

  // ── Boundary A: multiple pairs retained in order ─────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'Tell me about yourself.', 'I am Herald.', { establishedAt: t0 }));
    ring.push(entry(2, 'What can you do?', 'Many things locally.', { establishedAt: t0 }));
    ring.push(entry(3, 'Tell me more.', 'Sure — ask away.', { establishedAt: t0 }));
    const peeked = ring.peek(t0);
    assert('A: three contiguous pairs retained in order', peeked.map((e) => e.turnIndex), [1, 2, 3]);
  }

  // ── Boundary B: oldest evicted when count bound exceeded ───────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    for (let i = 1; i <= 4; i++) {
      ring.push(entry(i, `user-${i}`, `assistant-${i}`, { establishedAt: t0 }));
    }
    assert('B: storage keeps max 3 pairs', ring._rawEntries().map((e) => e.turnIndex), [2, 3, 4]);
  }

  // ── Boundary C: TTL per-entry ──────────────────────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const now = Date.now();
    ring.push(entry(1, 'old', 'stale', { establishedAt: now - HOT_RING_TTL_MS - 1 }));
    ring.push(entry(2, 'fresh', 'ok', { establishedAt: now }));
    assert('C: expired entry unavailable on peek', ring.peek(now).map((e) => e.turnIndex), [2]);
  }

  // ── Boundary D: RAM-only — no import of storage modules ───────────────────
  assertTrue('D: ring module has no durable storage API', !('AsyncStorage' in globalThis));

  // ── Contiguity: never bridge across missing turnIndex ─────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'a', 'A', { establishedAt: t0 }));
    ring.push(entry(3, 'c', 'C', { establishedAt: t0 }));
    assert('contiguity: gap at 2 drops turn 1', ring.peek(t0).map((e) => e.turnIndex), [3]);
  }

  {
    const suffix = selectContiguousHotSuffix([
      entry(1, 'u1', 'a1'),
      entry(2, 'u2', 'a2'),
      entry(3, 'u3', 'a3'),
    ]);
    assert('contiguity: consecutive 1-2-3 suffix', suffix.map((e) => e.turnIndex), [1, 2, 3]);
  }

  // ── Char bound ────────────────────────────────────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    const big = 'x'.repeat(900);
    ring.push(entry(1, big, big, { establishedAt: t0 }));
    ring.push(entry(2, big, big, { establishedAt: t0 }));
    ring.push(entry(3, big, big, { establishedAt: t0 }));
    const peeked = ring.peek(t0);
    let chars = 0;
    for (const e of peeked) chars += e.user.length + e.assistant.length;
    assertTrue('char bound: peek payload <= 2400 included chars', chars <= HOT_RING_MAX_INCLUDED_CHARS);
    assertTrue('char bound: evicted oldest to satisfy bound', peeked.length < 3);
  }

  // ── Authorization decoupled from ring fullness ────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'Tell me about yourself.', 'Hi there.', { establishedAt: t0 }));
    assertTrue(
      'auth: ring non-empty does NOT authorize Tell me more.',
      !isEligibleForEphemeralConversation('Tell me more.', false),
    );
    assertTrue(
      'auth: explicit flag still authorizes Tell me more.',
      isEligibleForEphemeralConversation('Tell me more.', true),
    );
  }

  assertTrue(
    'auth: ring fullness cannot latch authorization true',
    !isEligibleForEphemeralConversation('How far away is it?', false),
  );

  // ── Trust-critical policy (existing owner) ────────────────────────────────
  assert('policy: medical read omits assistant', hotAssistantPolicyForDeviceRead('medical:summary', true), 'omit');
  assert('policy: chit_chat includes assistant', hotAssistantPolicyForDeviceRead('chit_chat:identity', false), 'include');
  assert('policy: non-chit_chat device_read omits', hotAssistantPolicyForDeviceRead('family:read', false), 'omit');

  // ── Structural Test M: deterministic values absent from generative payload ─
  {
    const trustValue = 'You take metformin 500mg daily.';
    const messages = buildEphemeralPromptMessages('Tell me more.', [
      entry(1, 'What medications am I taking?', trustValue, { policy: 'omit' }),
    ]);
    const assistantContents = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    assertTrue('M: trust-critical assistant absent from payload', !assistantContents.some((c) => c.includes('metformin')));
    assertTrue('M: user leg still present', messages.some((m) => m.role === 'user' && m.content.includes('medications')));
  }

  {
    const messages = buildEphemeralPromptMessages('Follow up.', [
      entry(1, 'Hello', 'Hi!', { policy: 'include' }),
    ]);
    assertTrue('M: authorized assistant present when policy include', messages.some((m) => m.role === 'assistant' && m.content === 'Hi!'));
  }

  // ── Law 0 clear ───────────────────────────────────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'u', 'a', { establishedAt: t0 }));
    ring.clear();
    assert('Law0: clear empties ring', ring.peek(t0).length, 0);
    assert('Law0: raw buffer empty after clear', ring._rawEntries().length, 0);
  }

  // ── Family A: general conversation chain depth ───────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    const chain = [
      ['Tell me about yourself.', 'I am Herald, a companion.'],
      ['What can you do?', 'I help with local device tasks.'],
      ['Tell me more.', 'Happy to — what interests you?'],
    ] as const;
    chain.forEach(([u, a], i) => ring.push(entry(i + 1, u, a, { establishedAt: t0 })));
    const peeked = ring.peek(t0);
    assertTrue('Family A: three-turn chain fully peeked', peeked.length === 3);
    assert('Family A: order preserved', peeked.map((e) => e.user), chain.map(([u]) => u));
  }

  // ── Family B: deterministic gap does not authorize ambiguous follow-up ─────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'Tell me about yourself.', 'I am Herald.', { establishedAt: t0 }));
    // turn 2: trust-critical deterministic — no ring write (Option 4)
    ring.push(entry(3, 'Still here.', 'Yes.', { establishedAt: t0 }));
    assertTrue(
      'Family B: ring retained entries across gap',
      ring._rawEntries().length === 2,
    );
    assertTrue(
      'Family B: Tell me more ineligible without authorization flag',
      !isEligibleForEphemeralConversation('Tell me more.', false),
    );
    assertTrue(
      'Family B: contiguity breaks at missing turn 2 — latest suffix only',
      ring.peek(t0).map((e) => e.turnIndex).length === 1 && ring.peek(t0)[0]!.turnIndex === 3,
    );
  }

  // ── Family C (held-out): cedar pergola context carry-forward ───────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'When should I stain the cedar pergola?', 'Spring is often best.', { establishedAt: t0 }));
    ring.push(entry(2, 'How long between coats?', 'Usually 24 to 48 hours.', { establishedAt: t0 }));
    const peeked = ring.peek(t0);
    assertTrue(
      'Family C: pergola context carries forward in peek',
      peeked.some((e) => e.user.includes('cedar pergola')) && peeked.some((e) => e.user.includes('between coats')),
    );
  }

  // ── Peek does not mutate storage on read ──────────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'u', 'a', { establishedAt: t0 }));
    ring.peek(t0);
    assert('peek: storage unchanged after read', ring._rawEntries().length, 1);
  }

  assertTrue('constants: max pairs is 3', HOT_RING_MAX_PAIRS === 3);
  assertTrue('constants: max chars is 2400', HOT_RING_MAX_INCLUDED_CHARS === 2400);

  // ── Source-lock: ChatScreen Step 5a turn-entry wiring enforceability ────────
  console.log(`\n${BOLD}-- HOT turn-entry source-lock (ChatScreen.tsx) -------------${RESET}`);
  {
    const chatPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/screens/ChatScreen.tsx',
    );
    const chatSrc = fs.readFileSync(chatPath, 'utf8');
    const turnEntrySeam = chatSrc.match(
      /\/\/ Step 5a: monotonic turn identity[\s\S]*?immediateContextAuthorizedRef\.current = hasImmediatelyAdjacentHotAuthorization\(\s*hotContextForGeneration,\s*turnIndexRef\.current,\s*\);/,
    )?.[0] ?? '';

    assertTrue(
      'SEAM-1 ChatScreen turn-entry derives via hasImmediatelyAdjacentHotAuthorization',
      turnEntrySeam.includes('hasImmediatelyAdjacentHotAuthorization('),
    );
    assertTrue(
      'SEAM-2 uses hotContextForGeneration from hotRingRef.current.peek',
      turnEntrySeam.includes('hotContextForGeneration')
        && /hotRingRef\.current\.peek\(Date\.now\(\)\)/.test(turnEntrySeam),
    );
    assertTrue(
      'SEAM-3 passes current turnIndexRef.current to adjacency helper',
      /turnIndexRef\.current \+= 1/.test(turnEntrySeam)
        && turnEntrySeam.includes('turnIndexRef.current,'),
    );
    assertTrue(
      'SEAM-4 no unconditional immediateContextAuthorizedRef=false at turn-entry seam',
      !/immediateContextAuthorizedRef\.current = false/.test(turnEntrySeam),
    );
    assertTrue(
      'SEAM-5 imports hasImmediatelyAdjacentHotAuthorization from hotNarrativeRing',
      /import \{[^}]*hasImmediatelyAdjacentHotAuthorization[^}]*\} from '\.\.\/utils\/hotNarrativeRing'/.test(chatSrc),
    );
  }

  // ── Integration: sendMessage turn-entry authorization wiring (device repro) ─
  console.log(`\n${BOLD}-- HOT turn-entry integration (S24+ repro) -------------------${RESET}`);

  // A: chit_chat turn 1 -> adjacent "Tell me more" eligible (not Graceful Confusion path)
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const t0 = Date.now();
    const t1 = turnEntry(ring, turnIndexRef, t0);
    assertTrue('A: turn 1 entry not authorized (no prior)', !t1.authorized);
    pushAuthorizedPair(ring, t1.turnIndex, 'Tell me about yourself.', 'I am Herald.', t0);
    const t2 = turnEntry(ring, turnIndexRef, t0);
    assertTrue('A: turn 2 derives authorization from adjacent turn 1', t2.authorized);
    assertTrue(
      'A: Tell me more eligible with derived authorization',
      isEligibleForEphemeralConversation('Tell me more.', t2.authorized),
    );
  }

  // B: chit_chat -> deterministic gap (no push) -> Tell me more ineligible
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const t0 = Date.now();
    const t1 = turnEntry(ring, turnIndexRef, t0);
    pushAuthorizedPair(ring, t1.turnIndex, 'Tell me about yourself.', 'I am Herald.', t0);
    turnEntry(ring, turnIndexRef, t0); // turn 2 deterministic — no ring push
    const t3 = turnEntry(ring, turnIndexRef, t0);
    assertTrue('B: gap at turn 2 breaks adjacency authorization', !t3.authorized);
    assertTrue(
      'B: Tell me more ineligible after deterministic gap',
      !isEligibleForEphemeralConversation('Tell me more.', t3.authorized),
    );
  }

  // C: three consecutive authorized pairs — each immediate follow-up authorized
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const t0 = Date.now();
    const phrases = [
      ['Tell me about yourself.', 'I am Herald.'],
      ['What can you do?', 'Local device tasks.'],
      ['Tell me more.', 'Happy to expand.'],
    ] as const;
    for (let i = 0; i < phrases.length; i++) {
      const te = turnEntry(ring, turnIndexRef, t0);
      if (i === 0) {
        assertTrue('C: opening turn not authorized', !te.authorized);
      } else {
        assertTrue(`C: turn ${te.turnIndex} authorized by adjacent prior`, te.authorized);
      }
      pushAuthorizedPair(ring, te.turnIndex, phrases[i]![0], phrases[i]![1], t0);
    }
    const followUp = turnEntry(ring, turnIndexRef, t0);
    assertTrue('C: fourth turn authorized after third push', followUp.authorized);
    assertTrue(
      'C: follow-up eligible without latching beyond adjacency',
      isEligibleForEphemeralConversation('Why is that useful?', followUp.authorized),
    );
  }

  // D: TTL-expired entry does not authorize next turn
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const now = Date.now();
    const t1 = turnEntry(ring, turnIndexRef, now - HOT_RING_TTL_MS - 1000);
    pushAuthorizedPair(ring, t1.turnIndex, 'Tell me about yourself.', 'Stale.', now - HOT_RING_TTL_MS - 1000);
    const t2 = turnEntry(ring, turnIndexRef, now);
    assertTrue('D: expired HOT does not authorize adjacent turn', !t2.authorized);
    assertTrue(
      'D: Tell me more ineligible after TTL expiry',
      !isEligibleForEphemeralConversation('Tell me more.', t2.authorized),
    );
  }

  // E: emergency clear removes authorization
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const t0 = Date.now();
    const t1 = turnEntry(ring, turnIndexRef, t0);
    pushAuthorizedPair(ring, t1.turnIndex, 'Tell me about yourself.', 'I am Herald.', t0);
    ring.clear();
    const t2 = turnEntry(ring, turnIndexRef, t0);
    assertTrue('E: post-clear no adjacent authorization', !t2.authorized);
    assertTrue(
      'E: Tell me more ineligible after Law 0 clear',
      !isEligibleForEphemeralConversation('Tell me more.', t2.authorized),
    );
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}HotNarrativeRing: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('hotNarrativeRing.test.ts')) {
  runHotNarrativeRingTests().catch(console.error);
}
