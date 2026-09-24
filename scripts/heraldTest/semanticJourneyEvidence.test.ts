// Semantic proof observability. Mocks the provider result. Does not download a model.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeReferenceContinuation } from '../../src/routing/semanticProvider.ts';
import {
  beginSemanticProof,
  canonicalProofFromHolders,
  finishSemanticProof,
  noteCapabilityInvocation,
  noteCanonicalState,
  noteReferenceInvocation,
  noteSemanticAdmission,
  noteSemanticExecution,
} from '../../src/dev/semanticJourneyEvidence.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function runSemanticJourneyEvidenceV1Tests() {
  const failures: string[] = [];
  let passed = 0;
  function assert(label: string, ok: boolean) {
    if (ok) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- Semantic journey evidence --------------------------------${RESET}\n`);

  noteReferenceInvocation({ status: 'applicable', hasCurrentUtterance: true });
  assert('detached notes do not create a record', finishSemanticProof() === null);

  beginSemanticProof('turn-c');
  const applicable = await proposeReferenceContinuation('What about him?', {
    completion: async () => ({ text: 'applicable' }),
  });
  const record = finishSemanticProof();
  const dumped = JSON.stringify(record);
  assert('provider invocation emits a semantic record', record?.schema === 'herald.journey.semantic.v1' && record.invocations.length === 1);
  assert('applicable proposal stays applicable', applicable?.applicable === true && record?.invocations[0]?.status === 'applicable');
  assert('reference packet is shape only', record?.invocations[0]?.packet.includesNames === false
    && record?.invocations[0]?.packet.includesMedicationData === false
    && record?.invocations[0]?.packet.includesPhones === false
    && record?.invocations[0]?.packet.includesTranscript === false
    && record?.invocations[0]?.identifiesEntity === false);
  assert('proof record has no personal values', !/patel|maya|priya|512|metoprolol|lisinopril/i.test(dumped));

  beginSemanticProof('turn-status');
  noteReferenceInvocation({ status: 'not', hasCurrentUtterance: true });
  noteReferenceInvocation({ status: 'unavailable', unavailableReason: 'ctx_missing', hasCurrentUtterance: true });
  noteReferenceInvocation({ status: 'timeout', unavailableReason: 'timeout', hasCurrentUtterance: true });
  noteReferenceInvocation({ status: 'error', unavailableReason: 'error', hasCurrentUtterance: true });
  const statuses = finishSemanticProof()?.invocations.map((row) => row.status).join(',');
  assert('applicable/not/unavailable/timeout/error stay distinct', statuses === 'not,unavailable,timeout,error');

  beginSemanticProof('turn-focus');
  noteSemanticAdmission({
    mechanism: 'working_focus',
    eligibleCount: 1,
    resolution: 'unique',
    candidateAdmitted: true,
    admittedInGroundedSet: true,
    clarificationRequired: false,
    capabilityDecision: null,
    capabilityReason: null,
  });
  noteSemanticAdmission({
    mechanism: 'presented_set',
    eligibleCount: 2,
    resolution: 'ambiguous',
    candidateAdmitted: false,
    admittedInGroundedSet: false,
    clarificationRequired: true,
    capabilityDecision: null,
    capabilityReason: null,
  });
  noteSemanticAdmission({
    mechanism: 'referents_in_play',
    eligibleCount: 2,
    resolution: 'ambiguous',
    candidateAdmitted: false,
    admittedInGroundedSet: false,
    clarificationRequired: true,
    capabilityDecision: null,
    capabilityReason: null,
  });
  const admissions = finishSemanticProof()?.admissions ?? [];
  assert('working focus one-candidate admission is metadata', admissions[0]?.resolution === 'unique' && admissions[0]?.eligibleCount === 1);
  assert('presented set stays ambiguous at count 2', admissions[1]?.eligibleCount === 2 && admissions[1]?.candidateAdmitted === false && admissions[1]?.clarificationRequired === true);
  assert('two referents stay ambiguous without an identity', admissions[2]?.eligibleCount === 2 && admissions[2]?.resolution === 'ambiguous' && !JSON.stringify(admissions[2]).includes('Maya'));

  beginSemanticProof('turn-e');
  noteCapabilityInvocation({ status: 'ok', hasCurrentUtterance: true, proposedCapability: 'medication.read_summary' });
  noteSemanticAdmission({
    mechanism: 'capability',
    eligibleCount: 0,
    resolution: 'rejected',
    candidateAdmitted: false,
    admittedInGroundedSet: null,
    clarificationRequired: false,
    capabilityDecision: 'ABSTAIN',
    capabilityReason: 'capability_not_wired:calendar.read',
  });
  const capability = finishSemanticProof();
  assert('capability proposal and rejection are structured', capability?.invocations[0]?.proposedCapability === 'medication.read_summary'
    && capability?.admissions[0]?.capabilityDecision === 'ABSTAIN');

  beginSemanticProof('turn-state');
  noteCanonicalState('before', canonicalProofFromHolders({
    focus: { domain: 'medical_doctor' },
    presentedSets: [{ domain: 'medication', orderedMemberIds: ['med_a', 'med_b'] }],
    referents: { purpose: { kind: 'presented_people' }, candidateIds: ['d1', 'd2'], setId: 'contacts:presented_people:d1|d2' },
    pendingKey: null,
    obligation: { job: 'clarify_reference', scope: { kind: 'presented_sets', setIds: ['medication:med_a|med_b'] } },
  }));
  noteSemanticExecution({
    responseActKind: 'CLARIFY_REFERENCE',
    authoritativeRead: false,
    writeOccurred: false,
    externalActionArmed: false,
    routeKind: 'referent_resume',
    capabilityId: null,
  });
  const state = finishSemanticProof();
  const stateDump = JSON.stringify(state);
  assert('state snapshot keeps counts and drops member values', state?.stateBefore?.presentedSets[0]?.memberCount === 2
    && state?.stateBefore?.referents.candidateCount === 2
    && state?.stateBefore?.workingFocus.domain === 'medical_doctor'
    && !stateDump.includes('med_a')
    && !stateDump.includes('d1|d2'));
  assert('response act is recorded without speech', state?.execution?.responseActKind === 'CLARIFY_REFERENCE' && !stateDump.includes('text'));
  assert('call pending stays false in the execution proof', state?.execution?.externalActionArmed === false && state?.stateBefore?.hardPending.present === false);

  const host = fs.readFileSync(path.join(ROOT, 'src/dev/androidJourneyHost.ts'), 'utf8');
  const journey = fs.readFileSync(path.join(ROOT, 'scripts/heraldTest/conversation/android.journey.v1.scenarios.json'), 'utf8');
  assert('existing typed journey front door remains sendMessage', host.includes("await runtime.sendMessage(text, 'typed')") && host.includes('beginSemanticProof'));
  assert('existing Android journey pack schema is unchanged', journey.includes('"schema": "herald.android.journey.v1"'));

  console.log(`\n${BOLD}SemanticJourneyEvidenceV1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('semanticJourneyEvidence');
if (isDirect) {
  runSemanticJourneyEvidenceV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
