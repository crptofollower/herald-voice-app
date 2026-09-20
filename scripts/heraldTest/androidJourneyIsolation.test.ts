// Android Journey Pre-EAS Gate V1 — isolation + pack contract (Node).
// Does not execute sendMessage or assemble an APK.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_IDS = [
  'grocery_capture_read_opr_remove_reread',
  'todo_capture_read_complete_reread',
  'med_eliquis_confirm_authoritative_recall',
  'doctor_visit_confirm_authoritative_recall',
  'denial_grocery_recovery_zero_write',
  'sequential_confirm_grocery_recovery',
  'call_unknown_contact_pending_no_launch',
  'unresolved_list_referent_zero_write',
  'same_utterance_list_add_self_repair',
  'operational_list_clarify_resume_grocery',
] as const;

export async function runAndroidJourneyIsolationV1Tests() {
  const failures: Array<{ label: string; got: unknown; expected: string }> = [];
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

  console.log(`\n${BOLD}-- Android Journey Pre-EAS Gate V1 isolation ----------------${RESET}\n`);

  const packPath = path.join(ROOT, 'scripts/heraldTest/conversation/android.journey.v1.scenarios.json');
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8')) as {
    schema: string;
    scenarios: Array<{ id: string; turns: unknown[] }>;
  };
  const ids = pack.scenarios.map((s) => s.id);
  assert('pack schema is herald.android.journey.v1', pack.schema, (v) => v === 'herald.android.journey.v1', 'herald.android.journey.v1');
  assert('pack has exactly ten scenarios', pack.scenarios.length, (v) => v === 10, '10');
  assert(
    'pack ids are the authorized V1 set',
    ids,
    (v) => JSON.stringify(v) === JSON.stringify([...PACK_IDS]),
    PACK_IDS.join(','),
  );
  assert(
    'wife→roses is not in the Android V1 pack',
    ids.every((id) => !/rose|wife|preference|hold/i.test(id)),
    (v) => v === true,
    'no preference/hold ids',
  );
  assert(
    'pack is not the discarded 24-scenario spike corpus',
    !ids.includes('empty_todo_read_zero_write') && !ids.includes('embedded_obligation_no_call_hijack'),
    (v) => v === true,
    'trimmed',
  );
  const maybe = fs.readFileSync(path.join(ROOT, 'src/dev/maybeJourneyHost.ts'), 'utf8');
  assert(
    'host load requires native DebugJourneyBridge',
    maybe.includes('DebugJourneyBridge') && maybe.includes("Platform.OS !== 'android'"),
    (v) => v === true,
    'native gate',
  );
  assert(
    'Node isolation test does not import the RN host',
    !maybe.includes('processUtterance'),
    (v) => v === true,
    'no router import in maybeJourneyHost',
  );

  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert(
    'ordinary variants set JOURNEY_EMBEDDED false',
    gradle.includes('buildConfigField "boolean", "JOURNEY_EMBEDDED", "false"'),
    (v) => v === true,
    'false default',
  );
  assert(
    'journey build type sets JOURNEY_EMBEDDED true',
    /journey\s*\{[\s\S]*JOURNEY_EMBEDDED", "true"/.test(gradle) && gradle.includes('testBuildType "journey"'),
    (v) => v === true,
    'journey type',
  );
  assert(
    'journey packages live in the journey source set',
    fs.existsSync(path.join(ROOT, 'android/app/src/journey/java/ai/apexempire/herald/journey/HeraldJourneyBridge.kt')),
    (v) => v === true,
    'journey/java present',
  );
  assert(
    'GroceryJourneySpikeTest is not in androidTest',
    fs.existsSync(path.join(ROOT, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/GroceryJourneySpikeTest.kt')),
    (v) => v === false,
    'absent',
  );

  const host = fs.readFileSync(path.join(ROOT, 'src/dev/androidJourneyHost.ts'), 'utf8');
  assert(
    'JS host invokes sendMessage, not a router substitute',
    host.includes('await runtime.sendMessage(text, \'typed\')') && !host.includes('processUtterance('),
    (v) => v === true,
    'sendMessage front door',
  );
  assert(
    'JS host snapshots lists/medications/medical_records only',
    host.includes('FROM medications') && host.includes('FROM medical_records') && !host.includes('FROM contacts') && !host.includes('FROM facts'),
    (v) => v === true,
    'V1 sqlite domains',
  );

  console.log(`\n${BOLD}Android Journey Pre-EAS Gate V1 isolation: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('androidJourneyIsolation');
if (isDirect) {
  runAndroidJourneyIsolationV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
