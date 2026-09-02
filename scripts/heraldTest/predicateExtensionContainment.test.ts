// scripts/heraldTest/predicateExtensionContainment.test.ts
// Predicate-Extension Containment — helper still exists; it is not a terminal
// reply owner for otherwise-safe residual narrative.

import {
  buildBoundedPastEventAcknowledgment,
  utteranceRequiresBoundedPastEventAck,
} from '../../src/utils/predicateExtensionContainment.ts';
import {
  mayRunGenerativeEphemeralPersonalProse,
  resolveEphemeralSeam,
} from '../../src/utils/ephemeralSeam.ts';
import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runPredicateExtensionContainmentTests() {
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

  function assertFalse(label: string, cond: boolean) {
    assert(label, cond, false);
  }

  console.log(`\n${BOLD}-- Predicate-Extension Containment V1 ------------------------${RESET}`);

  const sonCalled = 'My son called this morning.';
  const daughterStopped = 'My daughter stopped by yesterday.';
  const brotherTexted = 'My brother texted me.';
  const drVisit = 'I saw Dr. Smith Tuesday.';
  const lowercaseI = 'i saw my son yesterday';
  const richCaughtUp = 'I saw my son and we caught up for an hour.';

  for (const [label, utterance] of [
    ['PEC-1 son called', sonCalled],
    ['PEC-2 daughter stopped by', daughterStopped],
    ['PEC-3 brother texted', brotherTexted],
    ['PEC-4 Dr Smith visit', drVisit],
    ['PEC-5 lowercase i visit', lowercaseI],
    ['PEC-6 rich caught-up report', richCaughtUp],
  ] as const) {
    assertTrue(`${label} requires bounded ack`, utteranceRequiresBoundedPastEventAck(utterance));
  }

  assert('PEC-7 son called bounded ack',
    buildBoundedPastEventAcknowledgment(sonCalled),
    'Your son called this morning.');
  assert('PEC-8 daughter stopped bounded ack',
    buildBoundedPastEventAcknowledgment(daughterStopped),
    'Your daughter stopped by yesterday.');
  assert('PEC-9 brother texted bounded ack',
    buildBoundedPastEventAcknowledgment(brotherTexted),
    'Your brother texted you.');
  assert('PEC-10 Dr Smith visit bounded ack',
    buildBoundedPastEventAcknowledgment(drVisit),
    'You saw Dr. Smith Tuesday.');
  assert('PEC-11 lowercase i bounded ack',
    buildBoundedPastEventAcknowledgment(lowercaseI),
    'You saw your son yesterday.');
  assert('PEC-12 rich caught-up preserves user predicate',
    buildBoundedPastEventAcknowledgment(richCaughtUp),
    'You saw your son and we caught up for an hour.');

  assert('PEC-13 my/me shift on called-me report',
    buildBoundedPastEventAcknowledgment('My son called me this morning.'),
    'Your son called you this morning.');
  assert('PEC-14 met preserves name Michael',
    buildBoundedPastEventAcknowledgment('I met Michael yesterday.'),
    'You met Michael yesterday.');

  assertTrue('PEC-15 bounded son report may run Conversation Foundation generate',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: sonCalled,
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation(sonCalled, false),
    }));

  assertFalse('PEC-16 opinion question does not require bounded ack',
    utteranceRequiresBoundedPastEventAck("Do you think that's a good idea?"));
  assertTrue('PEC-17 opinion question may still run generative prose',
    mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: "Do you think that's a good idea?",
      hasAuthorizedContinuation: false,
      hasPendingSession: false,
      hasContactCollectPending: false,
      isEligible: isEligibleForEphemeralConversation("Do you think that's a good idea?", false),
    }));

  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      text: sonCalled,
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
        return { status: 'ok', text: "That's great that you got to catch up with him." };
      },
    });
    assert('PEC-18 son called seam returns generative kind', outcome.kind, 'generative');
    assert('PEC-19 son called uses generate reply not pronoun-shift echo',
      outcome.reply,
      "That's great that you got to catch up with him.");
    assertTrue('PEC-20 son called invokes generate', generateCalled);
  }

  {
    let generateCalled = false;
    const outcome = await resolveEphemeralSeam({
      text: richCaughtUp,
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
        return { status: 'ok', text: 'Glad you two talked.' };
      },
    });
    assertTrue('PEC-21 rich report invokes generate', generateCalled);
    assert('PEC-22 rich report uses generate reply not pronoun-shift echo',
      outcome.reply,
      'Glad you two talked.');
  }

  {
    const ineligibleBounded = 'My son called this morning, call Mom later.';
    assertTrue('PEC-23 ineligible bounded skips primary bypass',
      utteranceRequiresBoundedPastEventAck(ineligibleBounded)
      && !isEligibleForEphemeralConversation(ineligibleBounded, true));
    const outcome = await resolveEphemeralSeam({
      text: ineligibleBounded,
      reason: 'default',
      hasAuthorizedContinuation: true,
      hasPendingSession: false,
      hasContactCollectPending: false,
      rdTier: 3,
      hasStructuredCaptures: false,
      isPersonalCaptureRisk: false,
      llmStatus: 'ready',
      classifierBusy: false,
      ephemeralBusy: false,
      generate: async () => ({ status: 'ok', text: 'fabricated' }),
    });
    assert('PEC-24 ineligible bounded clarifies not bounded ack', outcome.kind, 'clarify');
  }

  assertTrue('PEC-25 pending repair blocks generative for bounded report',
    !mayRunGenerativeEphemeralPersonalProse({
      reason: 'default',
      text: sonCalled,
      hasAuthorizedContinuation: false,
      hasPendingSession: true,
      hasContactCollectPending: false,
      isEligible: true,
    }));

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}PredicateExtensionContainment: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('predicateExtensionContainment.test.ts')) {
  runPredicateExtensionContainmentTests().catch(console.error);
}
