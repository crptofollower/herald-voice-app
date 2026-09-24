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
