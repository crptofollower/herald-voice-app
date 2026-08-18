// scripts/heraldTest/speechActAuthority.test.ts
// CONV-C1 — pure speech-act authority predicates (D1 + D3 only).

import {
  isExplicitInstructionToHerald,
  isD1InteractionReportRefusal,
  isD3CompletedPastActionRefusal,
  shouldRefuseLlmCaptureProposal,
} from '../../src/routing/speechActAuthority.ts';
import type { IntentRecord } from '../../src/hooks/llmLayers.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const FAM_JOSH: IntentRecord = {
  type: 'family_capture',
  relation: 'brother',
  name: 'Josh',
};

export async function runSpeechActAuthorityTests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Speech-Act Authority (CONV-C1 pure) -------------------${RESET}\n`);

  // ── Explicit instruction override ─────────────────────────────────────────
  check('C1-E1 remember my brother\'s name is Josh → explicit instruction',
    isExplicitInstructionToHerald("Remember my brother's name is Josh."));
  check('C1-E2 my brother is Josh → explicit instruction',
    isExplicitInstructionToHerald('My brother is Josh.'));
  check('C1-E3 remind me to call Josh → explicit instruction',
    isExplicitInstructionToHerald('Remind me to call Josh tomorrow.'));
  check('C1-E4 add milk to grocery list → explicit instruction',
    isExplicitInstructionToHerald('Add milk to my grocery list.'));

  // ── D1 isolation + controls ───────────────────────────────────────────────
  check('C1-D1a brother Josh called → D1 refuses family_capture',
    isD1InteractionReportRefusal('My brother Josh called me today.', [FAM_JOSH]));
  check('C1-D1b brother Josh called → shouldRefuse (primary case)',
    shouldRefuseLlmCaptureProposal('My brother Josh called me today.', [FAM_JOSH]));
  check('C1-D1c remember brother Josh → explicit instruction survives',
    !shouldRefuseLlmCaptureProposal("Remember my brother's name is Josh.", [FAM_JOSH]));
  check('C1-D1d my brother is Josh → explicit instruction survives',
    !shouldRefuseLlmCaptureProposal('My brother is Josh.', [FAM_JOSH]));
  check('C1-D1e D2 excluded: doctor mentioned metformin → no D1 refuse',
    !shouldRefuseLlmCaptureProposal('My doctor mentioned metformin.', [{
      type: 'medical_capture',
      drug: 'metformin',
      raw: 'My doctor mentioned metformin.',
    }]));
  check('C1-D1f narration without state-capture proposal → no refuse',
    !shouldRefuseLlmCaptureProposal('My brother Josh called me today.', [{
      type: 'todo_add',
      body: 'call Josh back',
    }]));

  // ── D3 completed past action ──────────────────────────────────────────────
  check('C1-D3a I bought milk yesterday + todo_add → D3 refuses',
    isD3CompletedPastActionRefusal('I bought milk yesterday.', [{ type: 'todo_add', body: 'buy milk' }]));
  check('C1-D3b I bought milk yesterday + todo_add → shouldRefuse',
    shouldRefuseLlmCaptureProposal('I bought milk yesterday.', [{ type: 'todo_add', body: 'buy milk' }]));
  check('C1-D3c I bought milk yesterday + family_capture → D3 does not apply',
    !shouldRefuseLlmCaptureProposal('I bought milk yesterday.', [FAM_JOSH]));
  check('C1-D3d forgot to call Josh + todo_add → not D3 (deferred; D4 out of scope)',
    !isD3CompletedPastActionRefusal('I forgot to call Josh.', [{ type: 'todo_add', body: 'call Josh' }]));

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ speechActAuthority: ${failures.length} failed\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ speechActAuthority: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSpeechActAuthorityTests().then(r => process.exit(r.failed ? 1 : 0));
}
