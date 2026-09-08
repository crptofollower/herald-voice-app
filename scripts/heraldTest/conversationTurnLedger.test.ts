// scripts/heraldTest/conversationTurnLedger.test.ts
// Conversation Continuity Contract V1 — Slice 1 unit tests (ledger module,
// no consumers yet) + Slice 2 coverage/trust contract tests (generic write
// hooks, source-locked against the actual production call sites).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createConversationTurnLedger,
  CONVERSATION_TURN_LEDGER_MAX_RECORDS,
  CONVERSATION_TURN_LEDGER_TTL_MS,
  CONVERSATION_TURN_UTTERANCE_MAX_CHARS,
  CONVERSATION_TURN_REPLY_SUMMARY_MAX_CHARS,
  type NewConversationTurnRecord,
} from '../../src/routing/conversationTurnLedger.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function rec(overrides: Partial<NewConversationTurnRecord> = {}): NewConversationTurnRecord {
  return {
    establishedAt: Date.now(),
    utterance: 'hello',
    intentType: null,
    operation: 'read',
    outcome: 'presented',
    authorityTier: 'deterministic',
    assistantReplySummary: null,
    ...overrides,
  };
}

export async function runConversationTurnLedgerTests() {
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

  console.log(`\n${BOLD}-- Conversation Turn Ledger — Slice 1 (module) ---------------${RESET}`);

  // ── Append-only ordering ────────────────────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    ledger.push(rec({ utterance: 'first', establishedAt: t0 }));
    ledger.push(rec({ utterance: 'second', establishedAt: t0 }));
    ledger.push(rec({ utterance: 'third', establishedAt: t0 }));
    assert('append-only: three records retained in push order', ledger.peek(t0).map((e) => e.utterance), ['first', 'second', 'third']);
  }

  // ── turnIndex is the ledger's own monotonic sequence ────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    const a = ledger.push(rec({ establishedAt: t0 }));
    const b = ledger.push(rec({ establishedAt: t0 }));
    const c = ledger.push(rec({ establishedAt: t0 }));
    assert('turnIndex: monotonic starting at 1', [a.turnIndex, b.turnIndex, c.turnIndex], [1, 2, 3]);
  }

  // ── Count bound eviction (oldest first) ─────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    for (let i = 1; i <= CONVERSATION_TURN_LEDGER_MAX_RECORDS + 3; i++) {
      ledger.push(rec({ utterance: `u${i}`, establishedAt: t0 }));
    }
    const raw = ledger._rawEntries();
    assert('count bound: storage capped at max records', raw.length, CONVERSATION_TURN_LEDGER_MAX_RECORDS);
    assert(
      'count bound: oldest evicted, newest retained in order',
      raw.map((e) => e.utterance),
      Array.from({ length: CONVERSATION_TURN_LEDGER_MAX_RECORDS }, (_, i) => `u${i + 4}`),
    );
  }

  // ── TTL eviction ─────────────────────────────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const now = Date.now();
    ledger.push(rec({ utterance: 'stale', establishedAt: now - CONVERSATION_TURN_LEDGER_TTL_MS - 1 }));
    ledger.push(rec({ utterance: 'fresh', establishedAt: now }));
    assert('TTL: expired record unavailable on peek', ledger.peek(now).map((e) => e.utterance), ['fresh']);
  }

  // ── Peek does not mutate non-expired storage ────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    ledger.push(rec({ establishedAt: t0 }));
    ledger.peek(t0);
    assert('peek: storage unchanged after a read with nothing expired', ledger._rawEntries().length, 1);
  }

  // ── Deterministic clear/reset ────────────────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    ledger.push(rec({ establishedAt: t0 }));
    ledger.push(rec({ establishedAt: t0 }));
    ledger.clear();
    assert('clear: peek empty after clear', ledger.peek(t0).length, 0);
    assert('clear: raw buffer empty after clear', ledger._rawEntries().length, 0);
  }

  // ── No persistence: RAM-only, no durable storage API in module ─────────
  assertTrue('no persistence: ledger module has no durable storage API', !('AsyncStorage' in globalThis));
  {
    const srcPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/routing/conversationTurnLedger.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');
    assertTrue('no persistence: module source imports no db/storage module', !/from ['"]\.\.\/db\//.test(src) && !/AsyncStorage|SecureStore|SQLite/.test(src));
    // The module discusses CommitResult in prose comments (explaining why it
    // deliberately has no dependency on it) — what matters is no import.
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    assertTrue('no write authority: module has no import of CommitResult (no actual dependency)', !importLines.includes('CommitResult'));
    assertTrue('no write authority: module has no import statement at all (fully standalone)', importLines.trim().length === 0);
  }

  // ── Focus (Semantic Focus Contract V1 — Slice 3): the ledger now STORES
  // a caller-supplied focus array as-is — it is domain-agnostic bounded
  // storage, not an authority gate. The authority guarantee moved to a
  // TYPE-LEVEL one in conversationTurnLedgerWrite.ts (DomainFocusEnvelope
  // has no tier field to smuggle) — see conversationTurnLedgerFocus.test.ts
  // for that contract's own dedicated proof. This ledger-module test only
  // proves storage fidelity: whatever ConversationTurnFocusEntry[] is
  // pushed comes back unchanged. ──────────────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    const focus: NewConversationTurnRecord['focus'] = [
      { kind: 'thing', displayValue: 'Eliquis', resolverKey: 'med_1', referable: true, tier: 'authoritative' },
    ];
    const pushed = ledger.push({ ...rec({ establishedAt: t0 }), focus });
    assert('storage fidelity: pushed focus array is stored and returned unchanged', pushed.focus, focus);
  }
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    const pushed = ledger.push(rec({ establishedAt: t0 }));
    assert('storage fidelity: omitting focus defaults to [] (missing focus stays legal)', pushed.focus, []);
  }

  // ── Bounded text ─────────────────────────────────────────────────────────
  {
    const ledger = createConversationTurnLedger();
    const t0 = Date.now();
    const bigUtterance = 'x'.repeat(CONVERSATION_TURN_UTTERANCE_MAX_CHARS + 500);
    const bigReply = 'y'.repeat(CONVERSATION_TURN_REPLY_SUMMARY_MAX_CHARS + 500);
    const pushed = ledger.push(rec({ establishedAt: t0, utterance: bigUtterance, assistantReplySummary: bigReply }));
    assert('bound: utterance truncated to max chars', pushed.utterance.length, CONVERSATION_TURN_UTTERANCE_MAX_CHARS);
    assert('bound: assistantReplySummary truncated to max chars', pushed.assistantReplySummary?.length, CONVERSATION_TURN_REPLY_SUMMARY_MAX_CHARS);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationTurnLedger: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationTurnLedger.test.ts')) {
  runConversationTurnLedgerTests().catch(console.error);
}
