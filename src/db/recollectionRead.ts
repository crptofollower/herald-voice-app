// Track R recollection reader. Provenance-framed only. Never a domain reader.
// Never invents people, places, dates, sequence, or events (R12).

import { listActiveEvidence } from './evidenceDB';
import {
  realizeRecollectionMiss,
  realizeRecollectionTold,
} from '../conversation/recollectionRealization';

export const REMINISCENCE_SOURCE_KIND = 'reminiscence';

export function answerLiveReminiscenceRecall(): string {
  const rows = listActiveEvidence({
    sourceClass: 'user_explicit',
    sourceKind: REMINISCENCE_SOURCE_KIND,
  });
  if (rows.length === 0) return realizeRecollectionMiss();
  return rows.map((row) => realizeRecollectionTold(row.rawText)).join(' ');
}
