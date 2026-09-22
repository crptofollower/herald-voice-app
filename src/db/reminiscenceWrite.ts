// Deterministic Track R append for the Slice-1 reminiscence proof seam.
// Verbatim + provenance only. Never truth, never entities, never domain stores.

import { persistEvidence, softRemoveEvidence } from './evidenceDB';
import { REMINISCENCE_SOURCE_KIND } from './recollectionRead';
import { now } from '../utils/heraldClock';
import {
  realizeRecollectionNothingToForget,
  realizeRecollectionSuppressed,
} from '../conversation/recollectionRealization';

let lastAdmittedId: string | null = null;

export function resetReminiscenceAdmissionState(): void {
  lastAdmittedId = null;
}

export function admitReminiscenceVerbatim(rawText: string): string {
  const stored = persistEvidence({
    sourceClass: 'user_explicit',
    sourceKind: REMINISCENCE_SOURCE_KIND,
    rawText,
    observedAt: now().toISOString(),
    eventAt: null,
  });
  lastAdmittedId = stored.id;
  return 'Okay.';
}

export function suppressLastReminiscence(): string {
  if (!lastAdmittedId) return realizeRecollectionNothingToForget();
  const id = lastAdmittedId;
  lastAdmittedId = null;
  const removed = softRemoveEvidence(id);
  if (!removed) return realizeRecollectionNothingToForget();
  return realizeRecollectionSuppressed();
}
