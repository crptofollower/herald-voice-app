// scripts/heraldTest/capabilityExtractBoundary.test.ts
// Gate A commit 2 — clause/target extraction must not steal conversation.

import { classifyQuery } from '../../src/routing/tierRouter.ts';
import { parseSmsIntent } from '../../src/utils/parseTime.ts';
import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function isTelephony(d: Awaited<ReturnType<typeof classifyQuery>>): boolean {
  const t = d.actionIntent?.type;
  return t === 'sms' || t === 'call' || t === 'reminder'
    || (typeof d.reason === 'string' && (
      d.reason.startsWith('action:sms')
      || d.reason.startsWith('action:call')
      || d.reason === 'action:reminder'
      || d.reason.startsWith('contact:phone_lookup')
    ));
}

export async function runCapabilityExtractBoundaryTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, expected: unknown) {
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  function assertTrue(label: string, cond: boolean) {
    assert(label, cond, true);
  }

  console.log(`\n${BOLD}-- Capability Extract Boundary (T13) ------------------------${RESET}`);

  {
    const text = "text to talk what do you think Paul thinks";
    assert('C1a incidental text-to does not parse SMS', parseSmsIntent(text), null);
    const d = await classifyQuery(text);
    assertTrue('C1b incidental text-to is not SMS routing', !isTelephony(d) && d.actionIntent?.type !== 'sms');
    assertTrue('C1c leftover stays conversation-capable', d.tier === 3 || d.reason === 'default' || !d.actionIntent);
  }

  {
    const d = await classifyQuery('call this done');
    assertTrue('C2 call-this-done is not CALL', d.actionIntent?.type !== 'call');
    assertTrue('C2b call-this-done is not telephony', !isTelephony(d));
  }

  {
    const text = "remind me what we've been talking about";
    const d = await classifyQuery(text);
    assertTrue('C3a recap is not a reminder action', d.actionIntent?.type !== 'reminder');
    assertTrue('C3b recap is eligible for conversation', isEligibleForEphemeralConversation(text, true));
  }

  {
    const text = "Text Paul that I'll send the beta tomorrow";
    const parsed = parseSmsIntent(text);
    assertTrue('C4a explicit SMS still extracts Paul', parsed?.contact === 'Paul');
    const d = await classifyQuery(text);
    assertTrue('C4b explicit SMS still owns the turn', d.actionIntent?.type === 'sms' && d.reason === 'action:sms');
  }

  {
    const d = await classifyQuery('the number one thing');
    assertTrue('C5 ranking number-one is not phone-number routing', !isTelephony(d));
  }

  {
    const d = await classifyQuery('no number for how many beta users');
    assertTrue('C6 quantity number-for is not telephony', !isTelephony(d));
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}CapabilityExtractBoundary: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('capabilityExtractBoundary.test.ts')) {
  runCapabilityExtractBoundaryTests().catch(console.error);
}
