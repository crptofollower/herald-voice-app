// Deterministic Track R append. Verbatim + provenance only.
// Never truth, never entities, never domain stores.
// Last-unit suppression identity lives on the session-owned arc holder.

import { persistEvidence, softRemoveEvidence } from './evidenceDB';
import { REMINISCENCE_SOURCE_KIND } from './recollectionRead';
import { now } from '../utils/heraldClock';
import {
  getDefaultReminiscenceArc,
  type ReminiscenceArcHolder,
} from '../routing/reminiscenceArc';
import {
  realizeRecollectionNothingToForget,
  realizeRecollectionSuppressed,
} from '../conversation/recollectionRealization';

export function resetReminiscenceAdmissionState(): void {
  getDefaultReminiscenceArc().clear();
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
  if (arc) {
    arc.appendRow(stored.id);
    arc.noteLastAdmitted(stored.id);
  }
  return 'Okay.';
}

export function suppressLastReminiscence(arc?: ReminiscenceArcHolder | null): string {
  const id = arc?.takeLastAdmitted() ?? null;
  if (!id) return realizeRecollectionNothingToForget();
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
  }
  arc.clear();
  if (!removedAny) return realizeRecollectionNothingToForget();
  return realizeRecollectionSuppressed();
}
