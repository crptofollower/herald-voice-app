// scripts/heraldTest/conversationOwnershipFence.test.ts
// Conversation Ownership Fence, design review 2026-08-15 (three rounds).
// Pure-function tests against isEligibleForEphemeralConversation only --
// no classifyQuery, no ctx, no routing. Call-routing expectations are out
// of scope for this file and are not proven here.

import { isEligibleForEphemeralConversation } from '../../src/utils/ephemeralConversation.ts';
import { routeIntent } from '../../src/routing/routeIntent.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runConversationOwnershipFenceTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, input: string, expected: boolean) {
    const got = isEligibleForEphemeralConversation(input);
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       input: ${DIM}"${input}"${RESET}\n       got: ${DIM}${got}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  function assertWithContext(label: string, input: string, ctx: boolean, expected: boolean) {
    const got = isEligibleForEphemeralConversation(input, ctx);
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       input: ${DIM}"${input}"${RESET} ctx=${ctx}\n       got: ${DIM}${got}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  console.log(`\n${BOLD}-- Conversation Ownership Fence Tests --------------------------${RESET}`);

  // ALLOW: ordinary narrative / fragments (round 1)
  assert('1: founding sentence', 'My son called this morning and he might come over this weekend to help me around the house.', true);
  assert('2: lunch with sister', 'I had lunch with my sister yesterday and we had a really nice time.', true);
  assert('3: miss grandkids', 'I really miss seeing my grandkids.', true);
  assert('4: getting older', 'Getting older sure changes the way you look at things.', true);
  assert('5: quiet today', 'It sure is quiet around here today.', true);
  assert('6: yeah probably', 'Yeah, probably.', true);
  assert('7: not really', 'Not really.', true);
  assert('8: maybe weekend', 'Maybe this weekend.', true);
  assert('9: sounded tired', 'He sounded tired.', true);
  assert('10: that surprised me', 'That surprised me.', true);
  assert('11: knee hurts', 'My knee hurts.', true);
  assert('12: money stress', 'Money has been stressing me out.', true);

  // ALLOW: opinion/reflection questions (round 2)
  assert('13: do you think come over', 'Do you think he\'ll come over?', true);
  assert('14: can you believe', 'Can you believe that?', true);
  assert('15: what do you think', 'What do you think about that?', true);
  assert('16: wouldnt that be nice', 'Wouldn\'t that be nice?', true);
  assert('17: how does that sound', 'How does that sound to you?', true);
  assert('18: why do you think people', 'Why do you think people do that?', true);
  assert('19: do you think overreacting', 'Do you think I\'m overreacting?', true);
  assert('20: wasnt that funny', 'Wasn\'t that funny?', true);
  assert('21: what would you do', 'What would you do?', true);
  assert('22: do you think should call', 'Do you think I should call him?', true);

  // BLOCK: fact-seeking personal/world questions (round 1 + round 2)
  assert('23: what do you know about me', 'What do you know about me?', false);
  assert('24: what do you remember about me', 'What do you remember about me?', false);
  assert('25: what have I told you', 'What have I told you about myself?', false);
  assert('26: what do you know family', 'What do you know about my family?', false);
  assert('27: remember about Hunter', 'What do you remember about Hunter?', false);
  assert('28: his name again', 'What\'s his name again?', false);
  assert('29: mRNA vaccines', 'Why do doctors prescribe mRNA vaccines?', false);
  assert('30: who won game', 'Who won the game last night?', false);
  assert('31: stocks sell', 'Tell me exactly what stocks I should sell.', false);
  assert('32: Hunters phone number', 'What\'s Hunter\'s phone number?', false);
  assert('33: what did doctor say', 'What did my doctor say?', false);
  assert('34: when doctor appointment', 'When is my doctor appointment?', false);
  assert('35: checking account', 'How much money is in my checking account?', false);
  assert('36: medications taking', 'What medications am I taking?', false);
  assert('37: weather tomorrow', 'What\'s the weather tomorrow?', false);

  // BLOCK: imperative/action-shaped (round 1; #40 is the motivating
  // embedded-clause case for Gap B below)
  assert('38: dont let me forget', 'Don\'t let me forget to call Hunter tomorrow.', false);
  assert('39: remind me call', 'Remind me to call Hunter tomorrow.', false);
  assert('40: hunter coming remind', 'Hunter\'s coming Saturday, remind me to call him Friday.', false);

  // Removed 2026-08-15: "No, that's not what I meant." / "Actually, I said
  // Grant, not Hunter." / "I need help." do not belong at this layer.
  // Corrections are protected upstream by pending/session ownership;
  // emergency is protected upstream by Law 0. The pure text predicate
  // deliberately cannot see that state and must not be made to duplicate
  // it. These belong in their own ownership-layer test suites, not here.

  // BLOCK: Gap A -- fact-seeking request in "tell me" imperative clothing.
  // #31 above ("stocks sell") is the original motivating case; these are
  // the additional authorized regression cases, including the
  // non-interrogative-complement case ("Hunter's phone number") that a
  // wh-shaped-only fact detector would miss.
  assert('41: tell me medications', 'Tell me what medications I\'m taking.', false);
  assert('42: tell me doctor said', 'Tell me what my doctor said.', false);
  assert('43: tell me phone number', 'Tell me Hunter\'s phone number.', false);

  // ALLOW: Gap A -- "tell me" wrapping a genuine opinion/social request.
  assert('44: tell me what you think', 'Tell me what you think about that.', true);
  assert('45: tell me how sounds', 'Tell me how that sounds to you.', true);
  assert('46: tell me about yourself', 'Tell me about yourself.', true);
  assert('47: tell me something funny', 'Tell me something funny.', true);
  assert('48: tell me what you would do', 'Tell me what you would do.', true);

  // BLOCK: Gap B -- action request embedded after a narrative clause.
  assert('49: busy today forget', 'I\'m busy today, don\'t let me forget to call Grant tomorrow.', false);
  assert('50: sounds good set alarm', 'That sounds good, set an alarm for seven.', false);
  assert('51: tired text Shannon', 'I\'m tired, text Shannon that I\'ll call later.', false);

  // ALLOW: Gap B -- reference to a past/reported action is not a request.
  assert('52: hunter reminded me', 'Hunter reminded me to call him.', true);
  assert('53: doesnt remind me', 'She doesn\'t remind me of anyone.', true);
  assert('54: talked about alarm', 'We talked about setting an alarm.', true);
  assert('55: shannon texted', 'Shannon texted me that she\'ll call later.', true);

  // ── 7b-A: Herald-response-meta leftover interrogative ────────────────────
  // Exception lives inside the existing interrogative rejection path.
  // Requires authorized immediate context AND verb∧manner. Default (no
  // second arg / false) must keep every existing case identical.
  const META_POS = [
    'Are you going to answer the same way each time?',
    'Do you always answer like that?',
    'Why did you say it that way?',
    'Are you always going to respond like that?',
  ];
  for (const [i, phrase] of META_POS.entries()) {
    assert(`56.${i + 1}a no-context "${phrase}" stays blocked`, phrase, false);
    assertWithContext(`56.${i + 1}b with-context "${phrase}" eligible`, phrase, true, true);
  }

  // Step 4 (2026-08-20): 57.x META_NEG retired — predicate-level interrogatives
  // with authorized context are now eligible by design; fact-seeking and action
  // ownership remain upstream (Group E). Imperatives with context stay blocked
  // in Group C below.

  // ── Step 4 Group A: eligible with authorized context ─────────────────────
  const STEP4_CTX_ELIGIBLE = [
    'How far away is it?',
    'Tell me more.',
    'What do you mean?',
    'Why do you say that?',
    'And then what?',
    'What did you mean by that?',
  ];
  for (const [i, phrase] of STEP4_CTX_ELIGIBLE.entries()) {
    assertWithContext(`58.${i + 1} ctx=true "${phrase}" eligible`, phrase, true, true);
  }

  // ── Step 4 Group B: same six with ctx=false ⇒ ineligible (load-bearing) ──
  for (const [i, phrase] of STEP4_CTX_ELIGIBLE.entries()) {
    assertWithContext(`59.${i + 1} ctx=false "${phrase}" ineligible`, phrase, false, false);
  }

  // ── Step 4 Group C: imperatives stay ineligible even with context ─────────
  const STEP4_CTX_BLOCKED = [
    'Remind me to call him Friday.',
    "Hunter's coming Saturday, remind me to call him Friday.",
    'Call Josh.',
    'Add milk to my grocery list.',
  ];
  for (const [i, phrase] of STEP4_CTX_BLOCKED.entries()) {
    assertWithContext(`60.${i + 1} ctx=true imperative blocked`, phrase, true, false);
  }

  // ── Step 4 Group D: opening-turn additions (one-arg / ctx=false unchanged) ─
  assert('61: tell me about the moon opening turn blocked', 'Tell me about the moon.', false);
  assert('62: do you think good idea opening turn eligible', "Do you think that's a good idea?", true);

  // ── Step 4 Group E: routing authority — personal fence upstream of slot ───
  {
    const decision = await routeIntent('What did I tell you about my insurance?', {
      classifyQuery: async () => ({ tier: 3, reason: 'default' }),
      classifyLLM: async () => ({ status: 'ok', intents: [] }),
      llmReady: true,
    });
    const reason = (decision as { reason?: string }).reason;
    if (decision.kind === 'needs_clarification' && reason === 'personal_memory:recall_declined') {
      console.log(`${GREEN}✓ PASS${RESET}  63: insurance recall → personal_memory:recall_declined`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  63: insurance recall → personal_memory:recall_declined\n       got: ${DIM}${JSON.stringify(decision)}${RESET}`);
      failures.push({ label: '63: insurance recall reason', got: decision, expected: 'personal_memory:recall_declined' });
    }
    if (reason !== 'default') {
      console.log(`${GREEN}✓ PASS${RESET}  64: insurance recall never reason:default`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  64: insurance recall never reason:default\n       got reason: ${DIM}${reason}${RESET}`);
      failures.push({ label: '64: insurance recall not default', got: reason, expected: 'not default' });
    }
  }

  // Step 4 Group F: takeLiveEphemeralContext is component-scoped in ChatScreen —
  // not extractable for headless harness; lifetime proven by device rows C/D (§5).
  // Step 4 Group G: slot population performs no SQLite write — architectural;
  // no ref in topicDB or any DB module (Step 0 audit).

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}ConversationOwnershipFence: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('conversationOwnershipFence.test.ts')) {
  runConversationOwnershipFenceTests().catch(console.error);
}
