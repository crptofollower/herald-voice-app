// Working-focus reference continuation.
// A proposal may say the utterance refers to an existing focus.
// It may not name the person. Exactly one compatible focus is admitted.

export type ReferenceContinuationProposal = {
  applicable: boolean;
};

export type WorkingFocusCandidate = {
  domain: string;
  entityId: string;
  displayName: string;
};

export type WorkingFocusAdmission =
  | { kind: 'none' }
  | { kind: 'admit'; focus: WorkingFocusCandidate }
  | { kind: 'clarify' };

export function admitWorkingFocusReference(
  proposal: ReferenceContinuationProposal | null,
  candidates: readonly WorkingFocusCandidate[],
): WorkingFocusAdmission {
  if (!proposal?.applicable) return { kind: 'none' };
  const compatible = candidates.filter((c) => c.domain === 'medical_doctor' && c.entityId.trim().length > 0);
  if (compatible.length === 0) return { kind: 'none' };
  if (compatible.length > 1) return { kind: 'clarify' };
  return { kind: 'admit', focus: compatible[0]! };
}

export type GroundedPresentedCandidate = {
  domain: string;
  setId: string;
  memberIds: readonly string[];
};

export type GroundedReferentCandidate = {
  entityId: string;
};

export type GroundedContinuationDecision =
  | { kind: 'none' }
  | { kind: 'retain' }
  | { kind: 'clarify'; eligibleCount: number }
  | { kind: 'admit_focus'; focus: WorkingFocusCandidate }
  | { kind: 'admit_member'; domain: string; setId: string; memberId: string };

type EligibleGround =
  | { kind: 'focus'; focus: WorkingFocusCandidate }
  | { kind: 'member'; domain: string; setId: string; memberId: string }
  | { kind: 'set'; domain: string; setId: string }
  | { kind: 'referent'; entityId: string };

/**
 * Applicability is the only semantic input. Zero grounded candidates fall
 * through. One registered candidate is admitted. More than one clarifies.
 * A failed interpretation retains ground and admits nothing.
 */
export function admitGroundedContinuation(
  proposal: ReferenceContinuationProposal | null,
  input: {
    interpretationFailed: boolean;
    focuses: readonly WorkingFocusCandidate[];
    presentedSets: readonly GroundedPresentedCandidate[];
    referents: readonly GroundedReferentCandidate[];
  },
): GroundedContinuationDecision {
  const hasGround = input.focuses.length > 0 || input.presentedSets.length > 0 || input.referents.length > 0;
  if (input.interpretationFailed && hasGround) return { kind: 'retain' };
  if (!proposal?.applicable) return { kind: 'none' };

  const eligible: EligibleGround[] = [];
  for (const focus of input.focuses) {
    if (focus.domain === 'medical_doctor' && focus.entityId.trim().length > 0) {
      eligible.push({ kind: 'focus', focus });
    }
  }
  if (input.presentedSets.length > 1) {
    for (const set of input.presentedSets) {
      if (set.memberIds.length > 0) eligible.push({ kind: 'set', domain: set.domain, setId: set.setId });
    }
  } else if (input.presentedSets.length === 1) {
    const set = input.presentedSets[0]!;
    for (const memberId of set.memberIds) {
      if (memberId.trim().length > 0) {
        eligible.push({ kind: 'member', domain: set.domain, setId: set.setId, memberId });
      }
    }
  }
  for (const referent of input.referents) {
    if (referent.entityId.trim().length > 0) eligible.push({ kind: 'referent', entityId: referent.entityId });
  }

  if (eligible.length === 0) return { kind: 'none' };
  if (eligible.length > 1) return { kind: 'clarify', eligibleCount: eligible.length };
  const only = eligible[0]!;
  if (only.kind === 'focus') return { kind: 'admit_focus', focus: only.focus };
  if (only.kind === 'member' && only.domain !== 'todo') {
    return { kind: 'admit_member', domain: only.domain, setId: only.setId, memberId: only.memberId };
  }
  return { kind: 'clarify', eligibleCount: eligible.length };
}
