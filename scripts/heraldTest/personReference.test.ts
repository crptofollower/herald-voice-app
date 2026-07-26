// scripts/heraldTest/personReference.test.ts
// Shared person-reference normalization + cross-action extraction consistency.

import { normalizePersonTarget, PERSON_RELATIONSHIP_ALTERNATION, liftRelationshipName } from '../../src/utils/personReference.ts';
import { parseSmsIntent } from '../../src/utils/parseTime.ts';
import { classifyQuery } from '../../src/routing/tierRouter.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

/** TEXT: parseSmsIntent first; else contactOnly path (mirrors tierRouter SMS block). */
function extractTextContact(msg: string): string | null {
  const parsed = parseSmsIntent(msg);
  if (parsed) return parsed.contact;
  const contactOnly =
    msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+to\s+(?:my\s+)?((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1] ??
    msg.match(new RegExp(`\\b(?:can\\s+you\\s+)?(?:text|message|msg)\\s+my\\s+(${PERSON_RELATIONSHIP_ALTERNATION})\\b`, 'i'))?.[1] ??
    msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1];
  if (!contactOnly) return null;
  const contactOnlyNorm = normalizePersonTarget(contactOnly.trim());
  const SMS_EXCLUDE = /^(me|you|us|them|it|myself|yourself)$/i;
  const SMS_POSSESSIVE_EXCLUDE = /^(my|our|his|her|their|the|a|an)$/i;
  if (!contactOnlyNorm || SMS_EXCLUDE.test(contactOnlyNorm) || SMS_POSSESSIVE_EXCLUDE.test(contactOnlyNorm)) {
    return null;
  }
  return contactOnlyNorm;
}

/** NAVIGATE: tierRouter destination + dispatch normalizePersonTarget + liftRelationshipName. */
async function extractNavContact(msg: string): Promise<string | null> {
  const decision = await classifyQuery(msg);
  if (decision.actionIntent?.type !== 'navigation') return null;
  return liftRelationshipName(normalizePersonTarget(decision.actionIntent.destination));
}

/** CALL: classifyQuery actionIntent.contact (normalize + lift in tierRouter). */
async function extractCallContact(msg: string): Promise<string | null> {
  const decision = await classifyQuery(msg);
  if (decision.actionIntent?.type !== 'call') return null;
  return decision.actionIntent.contact;
}

export async function runPersonReferenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, got: unknown, expected: unknown) {
    const ok = got === expected;
    if (ok) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${JSON.stringify(expected)}${RESET}`);
      failures.push({ label, got, expected: JSON.stringify(expected) });
    }
  }

  console.log(`\n${BOLD}-- personReference Contract Tests ---------------------------${RESET}\n`);

  // 1–8: normalizePersonTarget unit
  assert('T-PR-1 "my wife" → wife', normalizePersonTarget('my wife'), 'wife');
  assert('T-PR-2 "the plumber" → plumber', normalizePersonTarget('the plumber'), 'plumber');
  assert('T-PR-3 "our lawyer" → lawyer', normalizePersonTarget('our lawyer'), 'lawyer');
  assert('T-PR-4 "my wife\'s house" → wife', normalizePersonTarget("my wife's house"), 'wife');
  assert('T-PR-5 "Sarah\'s home" → Sarah', normalizePersonTarget("Sarah's home"), 'Sarah');
  assert('T-PR-6 "my wife\'s" → wife', normalizePersonTarget("my wife's"), 'wife');
  assert('T-PR-7 "Sarah" → Sarah', normalizePersonTarget('Sarah'), 'Sarah');
  assert('T-PR-8 "Myra" → Myra', normalizePersonTarget('Myra'), 'Myra');

  // 9: wife consistency across CALL / TEXT / NAVIGATE / drive
  {
    const call = await extractCallContact('call my wife');
    const text = extractTextContact('text my wife');
    const nav = await extractNavContact('navigate to my wife');
    const drive = await extractNavContact('drive to my wife');
    assert('T-PR-9a call my wife → wife', call, 'wife');
    assert('T-PR-9b text my wife → wife', text, 'wife');
    assert('T-PR-9c navigate to my wife → wife', nav, 'wife');
    assert('T-PR-9d drive to my wife → wife', drive, 'wife');
  }

  // 10: Hunter consistency
  {
    const call = await extractCallContact('call my son Hunter');
    const text = extractTextContact('text my son Hunter');
    const nav = await extractNavContact("navigate to my son Hunter's house");
    assert('T-PR-10a call my son Hunter → Hunter', call, 'Hunter');
    assert('T-PR-10b text my son Hunter → Hunter', text, 'Hunter');
    assert("T-PR-10c navigate to my son Hunter's house → Hunter", nav, 'Hunter');
  }

  // 11: grandson — CALL_SIGNALS fix
  {
    const call = await extractCallContact('call my grandson');
    const text = extractTextContact('text my grandson');
    assert('T-PR-11a call my grandson → grandson', call, 'grandson');
    assert('T-PR-11b text my grandson → grandson', text, 'grandson');
  }

  // 12: granddaughter regression
  {
    const call = await extractCallContact('call my granddaughter');
    assert('T-PR-12 call my granddaughter → granddaughter', call, 'granddaughter');
  }

  // liftRelationshipName regressions / no-ops
  {
    assert('T-PR-13 call my wife → wife (parts.length===1)', await extractCallContact('call my wife'), 'wife');
    assert('T-PR-14 call Sarah → Sarah (no rel word)', await extractCallContact('call Sarah'), 'Sarah');
    assert('T-PR-15 navigate to my daughter → daughter', await extractNavContact('navigate to my daughter'), 'daughter');
    assert('T-PR-16 call my son → son', await extractCallContact('call my son'), 'son');
  }

  const total = passed + failures.length;
  console.log(`\n${BOLD}personReference: ${passed}/${total} passed${failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`}${RESET}\n`);
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('personReference.test.ts')) {
  runPersonReferenceTests().catch(console.error);
}
