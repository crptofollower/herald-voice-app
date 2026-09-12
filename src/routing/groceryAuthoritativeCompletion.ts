// Shared post-write grocery completion: exact-ID authority, then OPR from
// remaining OPEN ids only. Not a second writer.

import {
  getPresentedOpenListItems,
  markOpenListItemRemovedById,
  type PresentedListItem,
} from '../db/listRead';
import type { ConversationalSubjectHolder } from './conversationalSubject';
import type { MedicationPresentationHolder } from './medicationPresentation';
import type { OrderedPresentationHolder } from './orderedPresentation';

export function completeOpenGroceryItemByExactId(
  id: string,
  holders?: {
    orderedPresentation?: OrderedPresentationHolder | null;
    subject?: ConversationalSubjectHolder | null;
    medicationPresentation?: MedicationPresentationHolder | null;
  },
): { ok: false } | { ok: true; removed: PresentedListItem; remaining: PresentedListItem[] } {
  const removed = markOpenListItemRemovedById(id, 'grocery');
  if (!removed) return { ok: false };
  const remaining = getPresentedOpenListItems('grocery');
  if (remaining.length === 0) {
    holders?.orderedPresentation?.clear();
  } else {
    holders?.subject?.clear();
    holders?.medicationPresentation?.clear();
    holders?.orderedPresentation?.establish(
      'grocery',
      remaining.map((item) => item.id),
    );
  }
  return { ok: true, removed, remaining };
}
