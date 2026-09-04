// scripts/evidence/runCalendarFocused.mjs
// Hard-coded calendar-diagnosis test command for Packet Builder V1.
// Runs only from scripts/heraldTest (tsx stubs). No network. No installs.

import { runCalendarContinuationTests } from '../heraldTest/calendarContinuation.test.ts';
import { runCalendarPresentationTests } from '../heraldTest/calendarPresentation.test.ts';
import { runCalendarUnresolvableDateTests } from '../heraldTest/calendarUnresolvableDate.test.ts';

const ccv = await runCalendarContinuationTests();
const cph = await runCalendarPresentationTests();
const cud = await runCalendarUnresolvableDateTests();

console.log(
  JSON.stringify({
    calendarContinuation: { passed: ccv.passed, failed: ccv.failed, total: ccv.total },
    calendarPresentation: { passed: cph.passed, failed: cph.failed, total: cph.total },
    calendarUnresolvableDate: { passed: cud.passed, failed: cud.failed, total: cud.total },
  }),
);

const failed = ccv.failed + cph.failed + cud.failed;
process.exit(failed > 0 ? 1 : 0);
