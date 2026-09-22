// Deterministic Track R append. Verbatim + provenance only.
// Never truth, never entities, never domain stores.

import { persistEvidence, softRemoveEvidence } from './evidenceDB';
import { REMINISCENCE_SOURCE_KIND } from './recollectionRead';
import { now } from '../utils/heraldClock';
import type { ReminiscenceArcHolder } from '../routing/reminiscenceArc';
import {
  realizeRecollectionNothingToForget,
  realizeRecollectionSuppressed,
} from '../conversation/recollectionRealization';

let lastAdmittedId: string | null = null;

export function resetReminiscenceAdmissionState(): void {
  lastAdmittedId = null;
}

export function admitReminiscenceVerbatim(
  rawText: string,
  arc?: ReminiscenceArcHolder | null,
): string {
  const stored = persistEvidence({
    sourceClass: 'user_explicit',
    sourceKind: REMINISCENCE_SOURCE_KIND,
    rawText,
    observedAt: now().toISOString(),
    eventAt: null,
  });
  lastAdmittedId = stored.id;
  arc?.appendRow(stored.id);
  return 'Okay.';
}

export function suppressLastReminiscence(arc?: ReminiscenceArcHolder | null): string {
  if (!lastAdmittedId) return realizeRecollectionNothingToForget();
  const id = lastAdmittedId;
  lastAdmittedId = null;
  const removed = softRemoveEvidence(id);
  arc?.dropRow(id);
  if (!removed) return realizeRecollectionNothingToForget();
  return realizeRecollectionSuppressed();
}

export function suppressCurrentReminiscenceArc(arc: ReminiscenceArcHolder): string {
  if (!arc.hasDeterministicIdentity()) return realizeRecollectionNothingToForget();
  const ids = [...arc.peekRowIds()];
  let removedAny = false;
  for (const id of ids) {
    if (softRemoveEvidence(id)) removedAny = true;
    if (lastAdmittedId === id) lastAdmittedId = null;
  }
  arc.clear();
  if (!removedAny) return realizeRecollectionNothingToForget();
  return realizeRecollectionSuppressed();
}
