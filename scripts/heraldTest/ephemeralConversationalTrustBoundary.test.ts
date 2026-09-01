// scripts/heraldTest/ephemeralConversationalTrustBoundary.test.ts
// Gate A commit 1 — ephemeral eligibility/containment (not phrase patches).

import {
  EPHEMERAL_CLARIFY_REPLY,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';
import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';
import { isHeraldSelfReferentConversationalShape } from '../../src/utils/ephemeralSelfReferent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const SEAM_READY = {
  reason: 'default' as const,
  hasPendingSession: false,
  hasContactCollectPending: false,
  rdTier: 3 as const,
  hasStructuredCaptures: false,
  isPersonalCaptureRisk: false,
  llmStatus: 'ready' as const,
  classifierBusy: false,
  ephemeralBusy: false,
};

export async function runEphemeralConversationalTrustBoundaryTests() {
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

  console.log(`\n${BOLD}-- Ephemeral Conversational Trust Boundary -------------------${RESET}`);

  assertTrue(
    'shape: created-you is Herald self-referent',
    isHeraldSelfReferentConversationalShape('Do you know why I created you?'),
  );
  assertTrue(
    'shape: talking-about-you is Herald self-referent',
    isHeraldSelfReferentConversationalShape("I'm talking about you"),
  );
  assertTrue(
    'shape: product copula is Herald self-referent',
    isHeraldSelfReferentConversationalShape("the product I'm building — that's you"),
  );
  assertTrue(
    'shape: know-about-me is not Herald self-referent',
    !isHeraldSelfReferentConversationalShape('What do you know about me?'),
  );

  assertTrue(
    'elig: created-you without thread evidence stays ineligible',
    !isEligibleForEphemeralConversation('Do you know why I created you?', false),
  );
  assertTrue(
    'elig: created-you with thread evidence is eligible without app-language',
    isEligibleForEphemeralConversation('Do you know why I created you?', true),
  );
  assertTrue(
    'elig: talking-about-you is eligible as natural continuation',
    isEligibleForEphemeralConversation("I'm talking about you", false),
  );

  // A1 — after failed clarify, natural self-repair continues (does not dead-end).
  {
    let generateCalled = false;
    const first = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Do you know why I created you?',
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'invented' };
      },
    });
    assert('A1a opening self-ask without evidence clarifies', first.kind, 'clarify');
    assertTrue('A1b opening self-ask does not generate', !generateCalled);
    assertTrue('A1c clarify grants the next continuation', first.grantContinuation === true);

    generateCalled = false;
    const second = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: "I'm talking about you",
      hasAuthorizedContinuation: true,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Got it — you mean me.' };
      },
    });
    assert('A1d talking-about-you continues', second.kind, 'generative');
    assertTrue('A1e talking-about-you reaches generate', generateCalled);
  }

  // A2 — identity copula continues.
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: "the product I'm building — that's you",
      hasAuthorizedContinuation: true,
      threadEvidence: 'Do you know why I created you?',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'That tracks.' };
      },
    });
    assert('A2a product copula continues', outcome.kind, 'generative');
    assertTrue('A2b product copula reaches generate', generateCalled);
  }

  // A6 — genuinely ambiguous demonstrative still clarifies, even with continuation.
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Did you get that?',
      hasAuthorizedContinuation: true,
      threadEvidence: 'We were talking about the beta.',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Yes I got that.' };
      },
    });
    assert('A6a ambiguous get-that clarifies', outcome.kind, 'clarify');
    assert('A6b ambiguous get-that uses canned clarify', outcome.reply, EPHEMERAL_CLARIFY_REPLY);
    assertTrue('A6c ambiguous get-that never generates', !generateCalled);
  }

  // B1 — Paul in evidence, Apollo is a near-miss: clarify, never invent Apollo.
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Apollo has always been anxious about this.',
      hasAuthorizedContinuation: true,
      threadEvidence: 'Paul is reviewing the beta tomorrow.',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Apollo has struggled with anxiety for years.' };
      },
    });
    assert('B1a Apollo near-miss clarifies', outcome.kind, 'clarify');
    assertTrue('B1b Apollo near-miss never generates biography', !generateCalled);
    assertTrue('B1c reply does not contain Apollo biography', !/anxious|anxiety/i.test(outcome.reply ?? ''));
  }

  // B3 — genuinely new Marcus: clarify, no biography.
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Marcus was never the same after the war.',
      hasAuthorizedContinuation: true,
      threadEvidence: 'Paul is reviewing the beta tomorrow.',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Marcus carried that trauma for decades.' };
      },
    });
    assert('B3a new Marcus clarifies', outcome.kind, 'clarify');
    assertTrue('B3b new Marcus never generates biography', !generateCalled);
  }

  // B5 — explicit correction back to an evidenced name recovers.
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'No, I meant Paul.',
      hasAuthorizedContinuation: true,
      threadEvidence: 'Paul is reviewing the beta tomorrow.',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Understood — Paul.' };
      },
    });
    assert('B5a correction to Paul recovers', outcome.kind, 'generative');
    assertTrue('B5b correction to Paul reaches generate', generateCalled);
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EphemeralConversationalTrustBoundary: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`,
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('ephemeralConversationalTrustBoundary.test.ts')) {
  runEphemeralConversationalTrustBoundaryTests().catch(console.error);
}
