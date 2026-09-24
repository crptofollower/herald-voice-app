// Journey-only semantic proof. Detached by default.
// Notes are not admission, not machine state, and not spoken.

export type SemanticProposalClass =
  | 'applicable'
  | 'not'
  | 'unavailable'
  | 'timeout'
  | 'error'
  | 'parse_fail'
  | 'ok';

export type SemanticPacketProof = {
  hasCurrentUtterance: boolean;
  groundedPeople: boolean;
  groundedPresentedMaterial: boolean;
  includesNames: false;
  includesMedicationData: false;
  includesPhones: false;
  includesTranscript: false;
};

export type SemanticInvocationProof = {
  operation: 'reference_continuation' | 'capability';
  status: SemanticProposalClass;
  unavailableReason: string | null;
  packet: SemanticPacketProof;
  proposedCapability: string | null;
  identifiesEntity: false;
};

export type SemanticAdmissionProof = {
  mechanism: 'working_focus' | 'presented_set' | 'referents_in_play' | 'capability';
  eligibleCount: number;
  resolution: 'unique' | 'ambiguous' | 'none' | 'rejected' | 'admitted';
  candidateAdmitted: boolean;
  admittedInGroundedSet: boolean | null;
  clarificationRequired: boolean;
  capabilityDecision: 'ADMIT_READ' | 'ABSTAIN' | null;
  capabilityReason: string | null;
};

export type PresentedSetProof = {
  domain: string;
  memberCount: number;
  valid: boolean;
  identityDigest: string;
};

export type CanonicalStateProof = {
  workingFocus: { present: boolean; domain: string | null; count: number };
  presentedSets: PresentedSetProof[];
  referents: {
    present: boolean;
    purpose: string | null;
    candidateCount: number;
    identityDigest: string | null;
  };
  hardPending: { present: boolean; type: string | null };
  softObligation: {
    present: boolean;
    job: string | null;
    scopeKind: string | null;
    identityDigest: string | null;
  };
};

export type SemanticExecutionProof = {
  responseActKind: string | null;
  authoritativeRead: boolean;
  writeOccurred: boolean;
  externalActionArmed: boolean;
  routeKind: string | null;
  capabilityId: string | null;
};

export type SemanticJourneyRecord = {
  schema: 'herald.journey.semantic.v1';
  turnId: string;
  invocations: SemanticInvocationProof[];
  admissions: SemanticAdmissionProof[];
  stateBefore: CanonicalStateProof | null;
  stateAfter: CanonicalStateProof | null;
  execution: SemanticExecutionProof | null;
  modelUnavailableReason: string | null;
};

type OpenProof = SemanticJourneyRecord;

let open: OpenProof | null = null;

function digest(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return `d${hash.toString(16)}`;
}

function closedPacket(input: {
  hasCurrentUtterance: boolean;
  groundedPeople?: boolean;
  groundedPresentedMaterial?: boolean;
}): SemanticPacketProof {
  return {
    hasCurrentUtterance: input.hasCurrentUtterance,
    groundedPeople: input.groundedPeople === true,
    groundedPresentedMaterial: input.groundedPresentedMaterial === true,
    includesNames: false,
    includesMedicationData: false,
    includesPhones: false,
    includesTranscript: false,
  };
}

export function semanticProofAttached(): boolean {
  return open !== null;
}

export function beginSemanticProof(turnId: string): void {
  open = {
    schema: 'herald.journey.semantic.v1',
    turnId,
    invocations: [],
    admissions: [],
    stateBefore: null,
    stateAfter: null,
    execution: null,
    modelUnavailableReason: null,
  };
}

export function finishSemanticProof(): SemanticJourneyRecord | null {
  const record = open;
  open = null;
  if (!record) return null;
  const missing = record.invocations.find((row) => row.status === 'unavailable' && row.unavailableReason === 'ctx_missing');
  if (missing && !record.invocations.some((row) => row.status === 'ok' || row.status === 'applicable' || row.status === 'not')) {
    record.modelUnavailableReason = 'ctx_missing';
  }
  return record;
}

export function noteReferenceInvocation(input: {
  status: SemanticProposalClass;
  unavailableReason?: string | null;
  hasCurrentUtterance: boolean;
  groundedPeople?: boolean;
  groundedPresentedMaterial?: boolean;
}): void {
  if (!open) return;
  open.invocations.push({
    operation: 'reference_continuation',
    status: input.status,
    unavailableReason: input.unavailableReason ?? null,
    packet: closedPacket(input),
    proposedCapability: null,
    identifiesEntity: false,
  });
}

export function noteCapabilityInvocation(input: {
  status: SemanticProposalClass;
  unavailableReason?: string | null;
  hasCurrentUtterance: boolean;
  proposedCapability?: string | null;
}): void {
  if (!open) return;
  open.invocations.push({
    operation: 'capability',
    status: input.status,
    unavailableReason: input.unavailableReason ?? null,
    packet: closedPacket({ hasCurrentUtterance: input.hasCurrentUtterance }),
    proposedCapability: input.proposedCapability ?? null,
    identifiesEntity: false,
  });
}

export function noteSemanticAdmission(input: SemanticAdmissionProof): void {
  if (!open) return;
  open.admissions.push({
    mechanism: input.mechanism,
    eligibleCount: input.eligibleCount,
    resolution: input.resolution,
    candidateAdmitted: input.candidateAdmitted,
    admittedInGroundedSet: input.admittedInGroundedSet,
    clarificationRequired: input.clarificationRequired,
    capabilityDecision: input.capabilityDecision,
    capabilityReason: input.capabilityReason,
  });
}

export function noteCanonicalState(phase: 'before' | 'after', state: CanonicalStateProof): void {
  if (!open) return;
  if (phase === 'before') open.stateBefore = state;
  else open.stateAfter = state;
}

export function proofIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  return digest(value);
}

export function canonicalProofFromHolders(input: {
  focus: { domain: string } | null;
  presentedSets: readonly { domain: string; orderedMemberIds: readonly string[]; validity?: string }[];
  referents: { purpose: { kind: string }; candidateIds: readonly string[]; setId: string } | null;
  pendingKey: string | null;
  obligation: { job: string; scope: { kind: string; setId?: string; setIds?: readonly string[]; focusKey?: string } } | null;
}): CanonicalStateProof {
  const obligationIdentity = input.obligation?.scope.setId
    ?? input.obligation?.scope.setIds?.[0]
    ?? input.obligation?.scope.focusKey
    ?? null;
  return {
    workingFocus: {
      present: !!input.focus,
      domain: input.focus?.domain ?? null,
      count: input.focus ? 1 : 0,
    },
    presentedSets: input.presentedSets.map((set) => ({
      domain: set.domain,
      memberCount: set.orderedMemberIds.length,
      valid: (set.validity ?? 'live') === 'live',
      identityDigest: digest(`${set.domain}:${set.orderedMemberIds.join('|')}`),
    })),
    referents: {
      present: !!input.referents,
      purpose: input.referents?.purpose.kind ?? null,
      candidateCount: input.referents?.candidateIds.length ?? 0,
      identityDigest: input.referents ? digest(input.referents.setId) : null,
    },
    hardPending: {
      present: !!input.pendingKey,
      type: input.pendingKey,
    },
    softObligation: {
      present: !!input.obligation,
      job: input.obligation?.job ?? null,
      scopeKind: input.obligation?.scope.kind ?? null,
      identityDigest: proofIdentity(obligationIdentity),
    },
  };
}

export function noteSemanticExecution(input: SemanticExecutionProof): void {
  if (!open) return;
  open.execution = {
    responseActKind: input.responseActKind,
    authoritativeRead: input.authoritativeRead,
    writeOccurred: input.writeOccurred,
    externalActionArmed: input.externalActionArmed,
    routeKind: input.routeKind,
    capabilityId: input.capabilityId,
  };
}
