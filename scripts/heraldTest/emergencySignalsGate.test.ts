// scripts/heraldTest/emergencySignalsGate.test.ts
// Law 0 emergency-signal regression test, rev. 4 (2026-08-14). Full 42-case
// matrix from the design review: direct pleas that MUST trigger, ordinary
// third-person/reported narrative that MUST NOT trigger, and multi-clause
// utterances proving one narrative "help me" clause cannot suppress a
// separate later direct plea in the same utterance. Tests detectEmergency
// (the full exported detector) so the pre-existing EMERGENCY_SIGNALS[0]/[1]
// patterns are exercised exactly as production uses them, unchanged.

import { detectEmergency } from '../../src/routing/emergencySignals.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

export async function runEmergencySignalsGateTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;

  function assert(label: string, input: string, expected: boolean) {
    const got = detectEmergency(input);
    if (got === expected) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       input: ${DIM}"${input}"${RESET}\n       got: ${DIM}${got}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected: String(expected) });
    }
  }

  console.log(`\n${BOLD}-- Emergency Signals Gate Tests (Law 0, rev. 4) --------------------------${RESET}`);

  // Direct pleas -- MUST trigger (1-19)
  assert('1: Help me.', "Help me.", true);
  assert('2: Please help me.', "Please help me.", true);
  assert('3: Herald, help me.', "Herald, help me.", true);
  assert('4: I need help.', "I need help.", true);
  assert('5: I really need help now.', "I really need help now.", true);
  assert('6: Help me, I have fallen.', "Help me, I've fallen.", true);
  assert('7: I fell and I need help.', "I fell and I need help.", true);
  assert('8: Somebody help me.', "Somebody help me.", true);
  assert('9: Can somebody help me?', "Can somebody help me?", true);
  assert('10: Oh God, please help me.', "Oh God, please help me.", true);
  assert('11: Oh please help me.', "Oh please help me.", true);
  assert('12: Please, help me.', "Please, help me.", true);
  assert('13: Someone help me.', "Someone help me.", true);
  assert('14: Could you help me?', "Could you help me?", true);
  assert('15: Would you please help me?', "Would you please help me?", true);
  assert('16: I am scared, please help me.', "I'm scared, please help me.", true);
  assert('17: Hey Herald, help me.', "Hey Herald, help me.", true);
  assert('18: Help me please.', "Help me please.", true);
  assert('19: Please help me, something is wrong.', "Please help me, something is wrong.", true);

  // Ordinary narrative -- MUST NOT trigger (20-27)
  assert('20: founding sentence (son/weekend/house)', "My son called this morning and he might come over this weekend to help me around the house.", false);
  assert('21: daughter offered to help me clean garage', "My daughter offered to help me clean the garage.", false);
  assert('22: he said he would help me move couch', "He said he'd help me move the couch.", false);
  assert('23: she is going to help me paint fence', "She's going to help me paint the fence.", false);
  assert('24: neighbor came to help me with yard', "My neighbor came over yesterday to help me with the yard.", false);
  assert('25: son said he would help me tomorrow', "My son said he would help me tomorrow.", false);
  assert('26: wife used to help me with that', "My wife used to help me with that.", false);
  assert('27: grandson called, talked for an hour', "My grandson called me yesterday and we talked for an hour.", false);

  // Compound: narrative framing must not suppress genuine distress elsewhere (28)
  assert('28: supposed to help me, but I fell and now I need help', "My son was supposed to help me, but I fell and now I need help.", true);

  // Modal/narrative-subject adversarial cases (29-34)
  assert('29: daughter said she could help me tomorrow', "My daughter said she could help me tomorrow.", false);
  assert('30: he promised he can help me with the yard', "He promised he can help me with the yard.", false);
  assert('31: she asked if she could help me', "She asked if she could help me.", false);
  assert('32: they said they might help me move', "They said they might help me move.", false);
  assert('33: my son may help me this weekend', "My son may help me this weekend.", false);
  assert('34: she was going to help me tomorrow', "She was going to help me tomorrow.", false);

  // Self-distress scope containment -- MUST NOT become new emergencies (35-36)
  assert('35: fell yesterday but fine now', "I fell yesterday but I'm fine now.", false);
  assert('36: hurt knee last week but better now', "I hurt my knee last week but it's better now.", false);

  // Multi-clause: earlier narrative clause must not suppress a later direct plea (37-42)
  assert('37: son said he could help me but isnt here, please help me', "My son said he could help me but he isn't here, please help me.", true);
  assert('38: she said she could help me but she left, help me', "She said she could help me but she left, help me.", true);
  assert('39: daughter was going to help me today, but please help me now', "My daughter was going to help me today, but please help me now.", true);
  assert('40: he promised he would help me, but I need help now', "He promised he'd help me, but I need help now.", true);
  assert('41: son said he could help me tomorrow (single clause)', "My son said he could help me tomorrow.", false);
  assert('42: she would help me and daughter would help me too', "She said she'd help me and my daughter said she would help me too.", false);

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}EmergencySignalsGate: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.endsWith('emergencySignalsGate.test.ts')) {
  runEmergencySignalsGateTests().catch(console.error);
}
