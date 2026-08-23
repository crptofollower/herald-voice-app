// scripts/heraldTest/ephemeralConversationStream.test.ts
// Minimal partial-callback wiring — final result semantics unchanged.

import { beginTurn, clearActiveTurn } from '../../src/utils/latencyInstrument.ts';
import { generateEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runEphemeralConversationStreamTests() {
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

  console.log(`\n${BOLD}-- Ephemeral Conversation Stream Tests --------------------${RESET}\n`);

  const finalText = 'Saturn has rings made mostly of ice and rock.';

  {
    beginTurn();
    const partials: string[] = [];
    let callbackCount = 0;
    const fakeCtx = {
      completion: async (
        _params: unknown,
        callback?: (data: { accumulated_text?: string }) => void,
      ) => {
        callback?.({ accumulated_text: 'Saturn has' });
        callback?.({ accumulated_text: finalText });
        callbackCount += 1;
        return { text: finalText };
      },
    };
    const result = await generateEphemeralConversation(
      'Tell me about Saturn',
      fakeCtx as any,
      [],
      (p) => partials.push(p),
    );
    assert('S1 final ok result unchanged with onPartial', result,
      v => (v as { status: string; text?: string }).status === 'ok'
        && (v as { text?: string }).text === finalText,
      'ok + finalText');
    assert('S2 partial callback receives accumulated text', partials,
      v => Array.isArray(v) && (v as string[]).length === 2
        && (v as string[])[0] === 'Saturn has'
        && (v as string[])[1] === finalText,
      'two accumulated updates');
    assert('S3 completion callback invoked', callbackCount, v => v === 1, '1');
    clearActiveTurn();
  }

  {
    beginTurn();
    const fakeCtx = {
      completion: async () => ({ text: finalText }),
    };
    const withPartial = await generateEphemeralConversation('x', fakeCtx as any, [], () => {});
    const withoutPartial = await generateEphemeralConversation('x', fakeCtx as any, []);
    assert('S4 onPartial omitted matches final semantics', { withPartial, withoutPartial },
      v => {
        const x = v as { withPartial: { status: string; text?: string }; withoutPartial: { status: string; text?: string } };
        return x.withPartial.status === 'ok'
          && x.withoutPartial.status === 'ok'
          && x.withPartial.text === x.withoutPartial.text;
      },
      'identical ok results');
    clearActiveTurn();
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EphemeralConversationStream: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('ephemeralConversationStream.test.ts')) {
  runEphemeralConversationStreamTests().catch(console.error);
}
