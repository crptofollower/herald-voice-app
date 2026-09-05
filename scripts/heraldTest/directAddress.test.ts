// Shared direct-address predicate isolation + 42-case help-me regression.
import {
  hasFirstPersonDistressNeedHelp,
  isDirectAddressToHerald,
  isDirectDistressHelpMe,
} from '../../src/routing/directAddress.ts';
import { detectEmergency } from '../../src/routing/emergencySignals.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const HELP_ME_MATRIX: [string, string, boolean][] = [
  ['1', 'Help me.', true],
  ['2', 'Please help me.', true],
  ['3', 'Herald, help me.', true],
  ['6', "Help me, I've fallen.", true],
  ['8', 'Somebody help me.', true],
  ['9', 'Can somebody help me?', true],
  ['10', 'Oh God, please help me.', true],
  ['11', 'Oh please help me.', true],
  ['12', 'Please, help me.', true],
  ['13', 'Someone help me.', true],
  ['14', 'Could you help me?', true],
  ['15', 'Would you please help me?', true],
  ['16', "I'm scared, please help me.", true],
  ['17', 'Hey Herald, help me.', true],
  ['18', 'Help me please.', true],
  ['19', 'Please help me, something is wrong.', true],
  ['20', 'My son called this morning and he might come over this weekend to help me around the house.', false],
  ['21', 'My daughter offered to help me clean the garage.', false],
  ['22', "He said he'd help me move the couch.", false],
  ['23', "She's going to help me paint the fence.", false],
  ['24', 'My neighbor came over yesterday to help me with the yard.', false],
  ['25', 'My son said he would help me tomorrow.', false],
  ['26', 'My wife used to help me with that.', false],
  ['29', 'My daughter said she could help me tomorrow.', false],
  ['30', 'He promised he can help me with the yard.', false],
  ['31', 'She asked if she could help me.', false],
  ['32', 'They said they might help me move.', false],
  ['33', 'My son may help me this weekend.', false],
  ['34', 'She was going to help me tomorrow.', false],
  ['37', "My son said he could help me but he isn't here, please help me.", true],
  ['38', 'She said she could help me but she left, help me.', true],
  ['39', 'My daughter was going to help me today, but please help me now.', true],
  ['41', 'My son said he could help me tomorrow.', false],
  ['42', "She said she'd help me and my daughter said she would help me too.", false],
];

export async function runDirectAddressTests() {
  const failures: string[] = [];
  let passed = 0;
  const check = (label: string, cond: boolean) => {
    if (cond) { passed++; console.log(`${GREEN}✓ PASS${RESET}  ${label}`); }
    else { failures.push(label); console.log(`${RED}✗ FAIL${RESET}  ${label}`); }
  };

  console.log(`\n${BOLD}-- Direct-address shared predicate --------------------------------${RESET}\n`);

  for (const [id, input, expected] of HELP_ME_MATRIX) {
    check(`DA-helpMe ${id} isDirectDistressHelpMe`, isDirectDistressHelpMe(input) === expected);
    check(`DA-helpMe ${id} detectEmergency agrees on help-me class`, detectEmergency(input) === expected);
  }

  check('DA: I need help is first-person distress need-help', hasFirstPersonDistressNeedHelp('I need help') === true);
  check('DA: I need help is direct address', isDirectAddressToHerald('I need help') === true);
  check('DA: I need help is detectEmergency', detectEmergency('I need help') === true);
  check('DA: Paul needs help is not direct address', isDirectAddressToHerald('I think Paul needs help with his move') === false);
  check('DA: Paul needs help is not distress need-help', hasFirstPersonDistressNeedHelp('I think Paul needs help with his move') === false);
  check('DA: I need to call the pharmacy is direct address', isDirectAddressToHerald('I need to call the pharmacy.') === true);
  check('DA: remembering remainder is not distress need-help', hasFirstPersonDistressNeedHelp('I need help remembering what he said') === false);
  check('DA: reported I might need help is not distress need-help', hasFirstPersonDistressNeedHelp('he said I might need help') === false);

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`\x1b[31m❌ directAddress: ${failures.length} failed\x1b[0m`);
  } else {
    console.log(`\x1b[32m✅ directAddress: ${passed}/${total} — all green\x1b[0m`);
  }
  return { passed, failed: failures.length, total };
}

if (process.argv[1]?.endsWith('directAddress.test.ts')) {
  runDirectAddressTests().then((r) => process.exit(r.failed ? 1 : 0));
}
