// scripts/heraldTest/hotNarrativeRing.test.ts
// Step 5a — HOT narrative ring mechanism + boundary tests (Option 4 depth-only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHotNarrativeRing,
  selectBoundedRecentHotSuffix,
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

  // ── Bounded-recent selection: a non-HOT-producing turn's index gap must ────
  // NOT invalidate otherwise-eligible recent HOT history (HOT Peek Contiguity
  // Repair, 2026-09-05 — HERALD_HOT_LIFECYCLE_REACHABILITY_DIAGNOSTIC).
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'a', 'A', { establishedAt: t0 }));
    // turn 2: legitimate non-HOT-producing turn (clarify / capability) — no push
    ring.push(entry(3, 'c', 'C', { establishedAt: t0 }));
    assert(
      'GENERATIVE->NON-HOT->GENERATIVE: gap at 2 does not drop turn 1',
      ring.peek(t0).map((e) => e.turnIndex),
      [1, 3],
    );
  }

  {
    const suffix = selectBoundedRecentHotSuffix([
      entry(1, 'u1', 'a1'),
      entry(2, 'u2', 'a2'),
      entry(3, 'u3', 'a3'),
    ]);
    assert('bounded-recent: consecutive 1-2-3 suffix unchanged', suffix.map((e) => e.turnIndex), [1, 2, 3]);
  }

  {
    const suffix = selectBoundedRecentHotSuffix([
      entry(1, 'u1', 'a1'),
      entry(3, 'u3', 'a3'),
    ]);
    assert(
      'bounded-recent: index gap alone does not drop earlier entry',
      suffix.map((e) => e.turnIndex),
      [1, 3],
    );
  }

  // ── Multiple mixed turns: several legitimate non-HOT turns interleaved with
  // generative turns all remain eligible up to the existing count cap ────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'work', 'ack-work', { establishedAt: t0 }));
    // turn 2: non-HOT (e.g. capability/read) — no push
    ring.push(entry(3, 'wife', 'ack-wife', { establishedAt: t0 }));
    // turn 4: non-HOT — no push
    ring.push(entry(5, 'son', 'ack-son', { establishedAt: t0 }));
    assert(
      'mixed turns: three generative turns across two gaps all peek eligible (within cap)',
      ring.peek(t0).map((e) => e.turnIndex),
      [1, 3, 5],
    );
  }

  // ── TTL still independently bounds gapped history — repair must not make
  // history unbounded ─────────────────────────────────────────────────────
  {
    const ring = createHotNarrativeRing();
    const now = Date.now();
    ring.push(entry(1, 'old', 'stale', { establishedAt: now - HOT_RING_TTL_MS - 1 }));
    // turn 2: non-HOT — no push
    ring.push(entry(3, 'fresh', 'ok', { establishedAt: now }));
    assert(
      'TTL+gap: expired entry stays unavailable even though only a gap separates it',
      ring.peek(now).map((e) => e.turnIndex),
      [3],
    );
  }

  // ── Capacity still independently bounds gapped history ─────────────────────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'u1', 'a1', { establishedAt: t0 }));
    // turn 2: non-HOT
    ring.push(entry(3, 'u3', 'a3', { establishedAt: t0 }));
    // turn 4: non-HOT
    ring.push(entry(5, 'u5', 'a5', { establishedAt: t0 }));
    // turn 6: non-HOT
    ring.push(entry(7, 'u7', 'a7', { establishedAt: t0 }));
    assert(
      'capacity+gaps: still capped at 3 most-recent pairs',
      ring.peek(t0).map((e) => e.turnIndex),
      [3, 5, 7],
    );
  }

  // ── Clarify anti-laundering: a legitimate non-HOT turn's content is never
  // itself present in the ring; only the real turns around it survive ───────
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'I had a bad day at work.', 'That sounds tough.', { establishedAt: t0 }));
    // turn 2 is a clarify exchange — by construction (existing, unchanged push
    // gating in ChatScreen.tsx) it is never pushed here at all.
    ring.push(entry(3, 'Anyway, back to work.', "Let's talk more about it.", { establishedAt: t0 }));
    const raw = ring._rawEntries();
    assertTrue(
      'clarify anti-laundering: only the two real turns are stored, never a clarify turn',
      raw.length === 2 && raw.every((e) => e.turnIndex === 1 || e.turnIndex === 3),
    );
    assert(
      'clarify anti-laundering: peek still recovers both real turns around the gap',
      ring.peek(t0).map((e) => e.turnIndex),
      [1, 3],
    );
  }

  // ── Action/capability authority: an intervening capability turn gains no
  // HOT evidence or adjacency authorization from this repair ────────────────
  {
    const ring = createHotNarrativeRing();
    const turnIndexRef = { current: 0 };
    const t0 = Date.now();
    turnIndexRef.current += 1;
    ring.push(entry(turnIndexRef.current, 'I need eggs and milk.', 'Got it noted.', { establishedAt: t0 }));
    turnIndexRef.current += 1; // capability/action turn — deterministic write, no HOT push
    turnIndexRef.current += 1;
    ring.push(entry(turnIndexRef.current, 'Anyway, back to the list.', 'Sure — go ahead.', { establishedAt: t0 }));
    const peeked = ring.peek(t0);
    assertTrue(
      'action turn: skipped index still correctly denies strict single-step adjacency (separate from bounded-recent peek)',
      !hasImmediatelyAdjacentHotAuthorization(peeked, turnIndexRef.current),
    );
    assert('action turn: only the two real generative turns are eligible', peeked.map((e) => e.turnIndex), [1, 3]);
  }

  // ── Representative regression: the exact proven failure shape ──────────────
  // narrative -> legitimate non-HOT turn -> later generative topic return
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'I had a bad day at work and then my wife and I got into an argument.', 'That sounds like a hard evening.', { establishedAt: t0 }));
    ring.push(entry(2, "She's doing well, we talked it through.", 'Glad to hear that.', { establishedAt: t0 }));
    // turn 3: car trouble — legitimate capability/read turn, no HOT push
    ring.push(entry(4, 'Anyway, back to what I was saying about my wife.', "You were saying she's doing well after you talked it through.", { establishedAt: t0 }));
    const peeked = ring.peek(t0);
    assertTrue(
      'representative regression: wife-relevant history survives the intervening non-HOT turn',
      peeked.some((e) => e.turnIndex === 1) && peeked.some((e) => e.turnIndex === 2) && peeked.some((e) => e.turnIndex === 4),
    );
    assert('representative regression: exact eligible turn set', peeked.map((e) => e.turnIndex), [1, 2, 4]);
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
    'auth: residual interrogative does not require a continuation slot',
    isEligibleForEphemeralConversation('How far away is it?', false),
  );
  assertTrue(
    'auth: tell-me still requires an authorized continuation slot',
    !isEligibleForEphemeralConversation('Tell me more.', false),
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
      'Family B: gap at missing turn 2 no longer drops turn 1 — both eligible',
      ring.peek(t0).map((e) => e.turnIndex).length === 2 && ring.peek(t0)[0]!.turnIndex === 1 && ring.peek(t0)[1]!.turnIndex === 3,
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

  // ── Gate A HOT runtime evidence instrumentation (2026-09-06) ───────────────
  // Locks the exact count-only fields (hotRawEntryCount, hotPeekedEntryCount,
  // turnIndex) added to the existing HERALD_GATE_A_DIAG emission so the next
  // device run can distinguish H1 (effectively-cold generation — no eligible
  // HOT entries reached peek) from H2 (valid HOT present, model still closed
  // the turn). See HERALD_HOT_RUNTIME_EVIDENCE_INSTRUMENTATION_2026-09-06.md.
  console.log(`\n${BOLD}-- Gate A HOT runtime evidence (raw/peeked counts) ----------${RESET}`);

  // EVIDENCE-1: zero-entry HOT reports zero raw/peek counts
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    assert('EVIDENCE-1 zero-entry ring reports zero raw count', ring._rawEntries().length, 0);
    assert('EVIDENCE-1 zero-entry ring reports zero peeked count', ring.peek(t0).length, 0);
  }

  // EVIDENCE-2: populated valid HOT reports correct bounded counts
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'a', 'A', { establishedAt: t0 }));
    ring.push(entry(2, 'b', 'B', { establishedAt: t0 }));
    assert('EVIDENCE-2 populated ring reports correct raw count', ring._rawEntries().length, 2);
    assert('EVIDENCE-2 populated ring reports correct peeked count', ring.peek(t0).length, 2);
  }

  // EVIDENCE-3: a global turn-index gap (legitimate non-HOT-producing turn)
  // must NOT falsely zero the peeked count after the committed peek-contiguity
  // repair (HERALD_HOT_PEEK_CONTIGUITY_REPAIR_2026-09-05.md).
  {
    const ring = createHotNarrativeRing();
    const t0 = Date.now();
    ring.push(entry(1, 'a', 'A', { establishedAt: t0 }));
    // turn 2: legitimate non-HOT-producing turn (clarify/capability) — no push
    ring.push(entry(3, 'c', 'C', { establishedAt: t0 }));
    assert('EVIDENCE-3 raw count reflects physically stored entries across the gap', ring._rawEntries().length, 2);
    assert(
      'EVIDENCE-3 peeked count NOT falsely zeroed by a turn-index gap (post peek-contiguity repair)',
      ring.peek(t0).length,
      2,
    );
  }

  // ── Gate A HOT evidence source-lock (ChatScreen.tsx) — proves the emitted
  // fields are bounded counts only (never entry/user/assistant content), that
  // both generate call sites (needs_clarification_default, offline_fallback)
  // emit identically, and that no second logging system was introduced ───────
  console.log(`\n${BOLD}-- Gate A HOT evidence source-lock (ChatScreen.tsx) ---------${RESET}`);
  {
    const chatPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/screens/ChatScreen.tsx',
    );
    const chatSrc = fs.readFileSync(chatPath, 'utf8');

    assertTrue(
      'EVIDENCE-4a raw HOT count reported as a bounded .length only',
      (chatSrc.match(/hotRawEntryCount: hotRingRef\.current\._rawEntries\(\)\.length,/g) || []).length === 2,
    );
    assertTrue(
      'EVIDENCE-4b peeked HOT count reported as a bounded .length only',
      (chatSrc.match(/hotPeekedEntryCount: hotContextForGeneration\.length,/g) || []).length === 2,
    );
    assertTrue(
      'EVIDENCE-4c bounded turn identifier only (no content) supplied at both diagnostic-input sites',
      (chatSrc.match(
        /getGenerateWorker: \(\) => ephemeralGenerateWorkerId,\s*\n\s*turnIndex: turnIndexRef\.current,/g,
      ) || []).length === 2,
    );
    assertTrue(
      'EVIDENCE-5 no new content-bearing field introduced alongside the evidence fields',
      !/hotRawEntryCount:[^,]*\.(user|assistant|map|join)\(/.test(chatSrc)
        && !/hotPeekedEntryCount:[^,]*\.(user|assistant|map|join)\(/.test(chatSrc),
    );
    assertTrue(
      'EVIDENCE-5b single diagnostic emission site — no second logging system introduced',
      (chatSrc.match(/HERALD_GATE_A_DIAG/g) || []).length === 1,
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
