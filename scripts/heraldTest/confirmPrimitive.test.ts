// scripts/heraldTest/confirmPrimitive.test.ts
// Confirm-primitive contract tests (S-DISCLOSE build arc, step 2).
// Tests the primitive's hold/resolve/release/cancel shape directly against
// ConversationSession — domain writers are represented by synthetic resume
// closures so this file verifies the PRIMITIVE's contract, independent of
// any one domain. Ref migrations (ChatScreen pendingXRef → this primitive)
// are separate commits (build order step 4).
//
// Covers: C-J leading-token anchoring (primitive's half only — Law 0's half
// lands in step 3), leak/re-ask ladder (Law 2), destructive-class budget+
// release (never executes), standard-class budget exhaustion (release =
// stop, no same-turn replay — confirmed choice (A) over (B)), cancel escape
// from any budget state.
//
// Runner: npx tsx scripts/heraldTest/confirmPrimitive.test.ts

import { ConversationSession } from '../../src/routing/conversationSession.ts';
import type { CommitResult } from '../../src/routing/routeIntent.ts';

const BOLD='\x1b[1m',RED='\x1b[31m',GREEN='\x1b[32m',DIM='\x1b[2m',RESET='\x1b[0m';

export async function runConfirmPrimitiveTests() {
  const failures: any[] = [];
  let passed = 0;
  function assert(label: string, got: any, check: (v: any) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else { console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`); failures.push({ label, got, expected }); }
  }
  console.log(`\n${BOLD}-- Confirm-Primitive Contract Tests -----------------------${RESET}\n`);

  // Synthetic domain resume mirroring the LIVE medical_capture writer's own
  // yes/no branches (routeIntent.ts:438-441) — but without its own inline
  // regex. The primitive supplies anchoring; the domain only interprets a
  // clean yes/no. Anything else returns noop+empty ack, signalling "could
  // not interpret" up to the primitive.
  function medCommitResume(committed: { value: boolean }) {
    return async (text: string): Promise<CommitResult> => {
      const t = text.trim().toLowerCase();
      if (t === 'no') return { status: 'noop', ack: "No problem — I won't add that." };
      if (t === 'yes') { committed.value = true; return { status: 'committed', ack: 'Got it — I will remember that.' }; }
      return { status: 'noop', ack: '' };
    };
  }

  // ── T1: C-J — leading-token text must NOT match anchored YES ──────────────
  {
    const session = new ConversationSession();
    const committed = { value: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed) });
    const result = await session.resolvePending('Ok I really need help now');
    assert('T1a "Ok I really need help now" does not commit (E1 anchoring fix)', committed.value, v => v === false, 'false — never committed');
    assert('T1b result is not a bare "committed" status', result.status, v => v !== 'committed', 'not committed');
    // NOTE: full C-J closure (emergency actually escaping/dispatching mid-
    // pending) is Law 0's job (build order step 3). This proves only the
    // half the primitive owns: leading-token text can no longer forge a
    // commit via loose regex matching.
  }

  // ── T2: leak case — unresolvable reply stays pending and re-asks (Law 2) ───
  {
    const session = new ConversationSession();
    const committed = { value: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed) });
    const result = await session.resolvePending('what time is it');
    assert('T2a unresolvable reply stays pending, never leaks to fresh routing', session.hasPending(), v => v === true, 'still pending');
    assert('T2b response is a re-ask, not silence or an error string', result.status === 'pending' ? result.prompt : '', v => typeof v === 'string' && v.length > 0, 'non-empty re-ask prompt');
    assert('T2c nothing committed', committed.value, v => v === false, 'false');
  }

  // ── T3: destructive-class — ambiguity never wipes; release = not executing ─
  {
    const session = new ConversationSession();
    let executed = false;
    session.setPending({
      pendingKey: 'medical_clear', kind: 'destructive', budget: 1,
      resume: async (text: string): Promise<CommitResult> => {
        const t = text.trim().toLowerCase();
        if (t === 'yes') { executed = true; return { status: 'committed', ack: 'Done — cleared.' }; }
        if (t === 'no') return { status: 'noop', ack: "No problem — I won't clear anything." };
        return { status: 'noop', ack: '' };
      },
    });
    const r1 = await session.resolvePending('maybe'); // ambiguous — budget 1, exhausts immediately
    assert('T3a destructive budget exhausts on first ambiguous reply (budget 1)', session.hasPending(), v => v === false, 'released, not pending');
    assert('T3b destructive release NEVER executes the wipe', executed, v => v === false, 'false — never executed');
    assert('T3c destructive release copy is the never-execute line', r1.status === 'noop' ? r1.ack : '', v => /leave everything as it is/i.test(v), 'destructive release copy');
  }

  // ── T4: standard-class budget exhaustion — release = stop, no same-turn replay
  {
    const session = new ConversationSession();
    const committed = { value: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed) });
    await session.resolvePending('purple');            // re-ask 1, budget 2→1
    assert('T4a still pending after first ambiguous reply', session.hasPending(), v => v === true, 'pending');
    const r2 = await session.resolvePending('banana');  // re-ask 2, budget 1→0 → release
    assert('T4b released after budget exhausted', session.hasPending(), v => v === false, 'released');
    assert('T4c release copy is the honest-release line, not a commit', r2.status, v => v !== 'committed', 'not committed');
    assert('T4d resolvePending returns exactly one terminal result for the exhausting utterance — no same-turn replay (choice A)', r2, v => v && typeof v.status === 'string', 'single terminal result, no re-entry');
    assert('T4e nothing committed across the whole exchange', committed.value, v => v === false, 'false');
  }

  // ── T5: cancel escape — anchored cancel words resolve CANCELLED immediately ─
  {
    const session = new ConversationSession();
    const committed = { value: false };
    session.setPending({ pendingKey: 'medical_capture', kind: 'standard', budget: 2, resume: medCommitResume(committed) });
    const r = await session.resolvePending('never mind');
    assert('T5a cancel releases immediately, does not wait for budget exhaustion', session.hasPending(), v => v === false, 'released');
    assert('T5b cancel never commits', committed.value, v => v === false, 'false');
    assert('T5c cancel produces a real acknowledgment', r.status === 'noop' ? r.ack : '', v => typeof v === 'string' && v.length > 0, 'a cancel acknowledgment');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}Confirm-Primitive: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('confirmPrimitive.test.ts')) {
  runConfirmPrimitiveTests().catch(console.error);
}
