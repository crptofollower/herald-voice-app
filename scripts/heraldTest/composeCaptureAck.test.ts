// scripts/heraldTest/composeCaptureAck.test.ts
// Mechanism tests only — not a sentence-freezing suite. Proves the composer's
// behavior (type-keyed, deterministic, value-preserving), not the wording of
// any individual capture domain's body text.
//
// Runner: npx tsx scripts/heraldTest/composeCaptureAck.test.ts
// Gate:   wire from run.mjs when ready (EXPECTED_TOTAL bump).

import { composeCaptureAck } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runComposeCaptureAckTests() {
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

  console.log(`\n${BOLD}-- composeCaptureAck Mechanism Tests ----------------------${RESET}`);

  // 1. Types with no registered connector return the body unchanged — no
  //    unnecessary prefix on an already-complete statement.
  {
    const got = composeCaptureAck('service_capture', 'Joe is your plumber.');
    assert('service_capture: body passes through with no prefix', got, (v) => v === 'Joe is your plumber.', 'Joe is your plumber.');
  }
  {
    const got = composeCaptureAck('family_capture', "I'll remember Michael is your son.");
    assert('family_capture: body passes through with no prefix', got, (v) => v === "I'll remember Michael is your son.", "I'll remember Michael is your son.");
  }
  {
    const got = composeCaptureAck('list_add', 'Milk is on your grocery list.');
    assert('list_add: body passes through with no prefix', got, (v) => v === 'Milk is on your grocery list.', 'Milk is on your grocery list.');
  }
  {
    const got = composeCaptureAck('medical_capture', "I've updated your Lisinopril to 10mg.");
    assert('medical_capture: reshaped body passes through with no prefix', got, (v) => v === "I've updated your Lisinopril to 10mg.", "I've updated your Lisinopril to 10mg.");
  }

  // 2. The two types with a registered connector receive it, deterministically.
  {
    const got = composeCaptureAck('phone_capture', 'Sarah at (214) 555-0100.');
    assert('phone_capture: receives its fixed connector', got, (v) => v === 'Noted — Sarah at (214) 555-0100.', 'Noted — Sarah at (214) 555-0100.');
  }
  {
    const got = composeCaptureAck('insurance_capture', 'Allstate for your car insurance.');
    assert('insurance_capture: receives its fixed connector', got, (v) => v === 'Noted — Allstate for your car insurance.', 'Noted — Allstate for your car insurance.');
  }

  // 3. The body itself — the user-derived value — is never altered, reordered,
  //    or reworded by the composer, regardless of which branch fires.
  {
    const body = "Sarah's exact captured value, untouched — 555-0100.";
    const got = composeCaptureAck('phone_capture', body);
    assert('composer never rewrites the body it is given (connector path)', got, (v) => typeof v === 'string' && v.endsWith(body), `endsWith(${JSON.stringify(body)})`);
  }
  {
    const body = "Sarah's exact captured value, untouched — 555-0100.";
    const got = composeCaptureAck('service_capture', body);
    assert('composer never rewrites the body it is given (no-connector path)', got, (v) => v === body, body);
  }

  // 4. Determinism / no hidden state: identical input always yields identical
  //    output — no rotation, no randomness, no time-based selection.
  {
    const results = new Set(
      Array.from({ length: 10 }, () => composeCaptureAck('service_capture', 'Joe is your plumber.')),
    );
    assert('composeCaptureAck is pure — same input always yields same output', results.size, (v) => v === 1, '1');
  }

  // 5. An intent type with no entry in the connector table and an empty body
  //    still returns exactly the body (no stray connector leaks in).
  {
    const got = composeCaptureAck('address_capture', '');
    assert('no-connector types never inject text when body is empty', got, (v) => v === '', '');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}composeCaptureAck: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('composeCaptureAck.test.ts')) {
  runComposeCaptureAckTests().catch(console.error);
}
