// scripts/heraldTest/ephemeralTrustContainment.test.ts
// Ephemeral Trust Containment V1 — mechanism tests (not phrase-specific fixtures).

import {
  EPHEMERAL_CLARIFY_REPLY,
  isBareZeroEvidenceOpeningFragment,
  mayRunGenerativeEphemeralPersonalProse,
  tryAuthoritativeLocalOwnersBeforeEphemeral,
  resolveEphemeralSeam,
  hasPendingRepairOwnership,
} from '../../src/utils/ephemeralSeam.ts';
import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';
import { captureHousehold } from '../../src/utils/householdCapture.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runEphemeralTrustContainmentTests() {
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

  console.log(`\n${BOLD}-- Ephemeral Trust Containment V1 -----------------------------${RESET}`);

  // ── 1. Authoritative first refusal — household capture in owner chain ───────
  {
    const utterance = 'My trust is in the filing cabinet.';
    const directCapture = captureHousehold(utterance);
    assertTrue('ETC-1 household capture matches legal utterance',
      directCapture != null && directCapture.type !== 'needs_llm' && 'captured' in directCapture);
    const owner = tryAuthoritativeLocalOwnersBeforeEphemeral(utterance);
    assertTrue('ETC-2 authoritative owner handles before generative path', owner.handled === true);
  }

  // ── 2. Zero-evidence bare opening fragments — multiple fixtures ─────────────
  const bareFixtures = [
    'Alpha Beta',
    'The Lanterns',
    'North Harbor',
    'Blue Ridge',
  ];
  for (const [i, phrase] of bareFixtures.entries()) {
    assertTrue(`ETC-3.${i + 1} bare fixture "${phrase}" is zero-evidence`, isBareZeroEvidenceOpeningFragment(phrase));
    assertTrue(
      `ETC-4.${i + 1} bare fixture blocked from generative prose`,
      !mayRunGenerativeEphemeralPersonalProse({
        reason: 'default',
        text: phrase,
        hasAuthorizedContinuation: false,
        hasPendingSession: false,
        hasContactCollectPending: false,
        isEligible: isEligibleForEphemeralConversation(phrase, false),
      }),
    );
  }

  // ── 3. Grounded narrative remains generative-eligible ─────────────────────
  assertTrue('ETC-5 grounded narrative not bare zero-evidence',
    !isBareZeroEvidenceOpeningFragment('My son called this morning.'));
  assertTrue('ETC-6 grounded narrative may run generative prose',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: 'My son called this morning.',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation('My son called this morning.', false),
    }));

  // ── 3b. Copula does not independently ground unresolved referents ───────────
  const copulaBareFixtures = [
    'Alpha Beta are wonderful',
    'North Harbor is nearby',
  ];
  for (const [i, phrase] of copulaBareFixtures.entries()) {
    assertTrue(`ETC-5b.${i + 1} copula+bare referent is zero-evidence`, isBareZeroEvidenceOpeningFragment(phrase));
    assertTrue(
      `ETC-5c.${i + 1} copula+bare referent blocked from generative`,
      !mayRunGenerativeEphemeralPersonalProse({
        reason: 'default',
        text: phrase,
        hasAuthorizedContinuation: false,
        hasPendingSession: false,
        hasContactCollectPending: false,
        isEligible: isEligibleForEphemeralConversation(phrase, false),
      }),
    );
  }
  assertTrue('ETC-5d longer copula utterance without anchor not bare',
    !isBareZeroEvidenceOpeningFragment('It sure is quiet around here today.'));
  assertTrue('ETC-5e first-person narrative still not bare',
    !isBareZeroEvidenceOpeningFragment('My son called this morning.'));

  // ── 4. Opinion / social speech-act paths remain available ─────────────────
  assertTrue('ETC-7 opinion question may run generative',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: "Do you think that's a good idea?",
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation("Do you think that's a good idea?", false),
    }));
  assertTrue('ETC-8 tell-me social complement may run generative',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: 'Tell me something funny.',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation('Tell me something funny.', false),
    }));

  // ── 5. Authorized continuation bypasses zero-evidence floor ───────────────
  assertTrue('ETC-9 continuation authorizes bare follow-up generative',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: 'Tell me more.',
      hasAuthorizedContinuation: true,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation('Tell me more.', true),
    }));

  // ── 6. Pending repair ownership blocks generative ─────────────────────────
  assertTrue('ETC-10 session pending blocks generative',
    !mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: 'My son called this morning.',
      hasAuthorizedContinuation: false,
      hasPendingSession: true,
      hasContactCollectPending: false,
      isEligible: true,
    }));
  assertTrue('ETC-11 contact-collect pending blocks generative',
    !mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: 'My son called this morning.',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: true,
      isEligible: true,
    }));
  assertTrue('ETC-12 repair ownership predicate',
    hasPendingRepairOwnership({ hasSessionPending: false, hasContactCollectPending: true }));

  // ── 7. resolveEphemeralSeam — bare fragment clarifies without generate ────
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      text: 'Alpha Beta',
      reason: 'default',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'fabricated prose' };
      },
    });
    assert('ETC-13 bare seam returns clarify', outcome.kind, 'clarify');
    assert('ETC-14 bare seam uses canned clarify', outcome.reply, EPHEMERAL_CLARIFY_REPLY);
    assertTrue('ETC-15 bare seam never invoked generate', !generateCalled);
  }

  // ── 8. Poison containment — failed generative does not grant continuation ─
  {
    const outcome = await resolveEphemeralSeam({
      text: 'My son called this morning.',
      reason: 'default',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => ({ status: 'unavailable', reason: 'empty-output' }),
    });
    assert('ETC-16 failed generative returns clarify', outcome.kind, 'clarify');
    assertTrue('ETC-17 failed generative has no grantContinuation flag',
      !('grantContinuation' in outcome && (outcome as { grantContinuation?: boolean }).grantContinuation === true));
  }

  // ── 9. Successful generative grants continuation flag ─────────────────────
  {
    const outcome = await resolveEphemeralSeam({
      text: 'My son called this morning.',
      reason: 'default',
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => ({ status: 'ok', text: 'That sounds nice.' }),
    });
    assert('ETC-18 successful generative kind', outcome.kind, 'generative');
    assertTrue('ETC-19 successful generative grants continuation',
      outcome.kind === 'generative' && outcome.grantContinuation === true);
  }

  // ── 10. v1 accepted tradeoff — short reaction may fail bare floor ─────────
  assertTrue('ETC-20 short reaction may classify as bare (v1 tradeoff)',
    isBareZeroEvidenceOpeningFragment('Yeah, probably.'));

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EphemeralTrustContainment: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('ephemeralTrustContainment.test.ts')) {
  runEphemeralTrustContainmentTests().catch(console.error);
}
