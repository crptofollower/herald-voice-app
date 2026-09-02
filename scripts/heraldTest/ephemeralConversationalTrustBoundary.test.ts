// scripts/heraldTest/ephemeralConversationalTrustBoundary.test.ts
// Gate A commit 1 — ephemeral eligibility/containment (not phrase patches).

import {
  EPHEMERAL_CLARIFY_REPLY,
  hasUnresolvedThirdPartyName,
  mayRunGenerativeEphemeralPersonalProse,
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

  // T1 — first mention of a person inside a user-authored interaction report
  // must continue; names need not already be in thread evidence.
  {
    const paulReport =
      'I talked to Paul yesterday about Herald. He thinks the memory is what really makes this a different product.';
    assertTrue(
      'T1 names remain unresolved against empty evidence',
      hasUnresolvedThirdPartyName(paulReport, ''),
    );
    assertTrue(
      'T1 first-person Paul report may generate on empty evidence',
      mayRunGenerativeEphemeralPersonalProse({
        reason: 'default',
        text: paulReport,
        hasAuthorizedContinuation: false,
        hasPendingSession: false,
        hasContactCollectPending: false,
        isEligible: true,
        threadEvidence: '',
      }),
    );
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: paulReport,
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'That tracks with what you heard.' };
      },
    });
    assert('T1a Paul interaction report continues', outcome.kind, 'generative');
    assertTrue('T1b Paul interaction report reaches generate', generateCalled);
  }
  {
    const danaReport =
      'I talked to Dana yesterday about the beta. She thinks the local model is what makes it usable.';
    assertTrue(
      'T1c Dana names remain unresolved against empty evidence',
      hasUnresolvedThirdPartyName(danaReport, ''),
    );
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: danaReport,
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Sounds like Dana was focused on the local model.' };
      },
    });
    assert('T1d Dana interaction report continues', outcome.kind, 'generative');
    assertTrue('T1e Dana interaction report reaches generate', generateCalled);
  }
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Tell me about Marcus',
      hasAuthorizedContinuation: false,
      threadEvidence: '',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'Marcus grew up in Ohio and served overseas.' };
      },
    });
    assert('T1f tell-me-about unresolved name is an honest miss', outcome.kind, 'generative');
    assertTrue('T1g tell-me-about unresolved name never invents via generate', !generateCalled);
    assertTrue(
      'T1h tell-me-about unresolved name is not canned follow-confusion',
      outcome.reply !== EPHEMERAL_CLARIFY_REPLY,
    );
    assertTrue(
      'T1i tell-me-about unresolved name does not invent biography',
      /don't have anything stored about Marcus/i.test(outcome.reply ?? ''),
    );
  }

  // B1 — user-authored named report is conversation (invention is generation-side).
  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      ...SEAM_READY,
      text: 'Apollo has always been anxious about this.',
      hasAuthorizedContinuation: true,
      threadEvidence: 'Paul is reviewing the beta tomorrow.',
      generate: async () => {
        generateCalled = true;
        return { status: 'ok', text: 'That sounds like a lot to carry.' };
      },
    });
    assert('B1a Apollo user report reaches conversation', outcome.kind, 'generative');
    assertTrue('B1b Apollo user report invokes generate', generateCalled);
    assertTrue('B1c Apollo user report is not canned follow-confusion', outcome.reply !== EPHEMERAL_CLARIFY_REPLY);
  }

  // B3 — genuinely new Marcus in user-authored narrative reaches conversation.
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
    assert('B3a new Marcus user report reaches conversation', outcome.kind, 'generative');
    assertTrue('B3b new Marcus user report invokes generate', generateCalled);
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
