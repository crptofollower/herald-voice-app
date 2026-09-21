// Optional temporal constraint for the existing visit-history read.
// Reuses resolveHistoricalCalendarRange arithmetic; does not resolve month names.

import { resolveHistoricalCalendarRange, type HistoricalCalendarRange } from './historicalCalendarRange';
import { MONTHS } from '../utils/parseTime';

export type VisitHistoryTemporalConstraint =
  | { kind: 'none' }
  | { kind: 'resolved'; range: HistoricalCalendarRange }
  | { kind: 'unresolved' };

const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTH_NAMES = MONTHS.join('|');
const IN_MONTH_RE = new RegExp(`\\bin\\s+(?:the\\s+)?(?:month\\s+of\\s+)?(?:${MONTH_NAMES})\\b`, 'i');
const MONTH_DAY_RE = new RegExp(`\\b(?:${MONTH_NAMES})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i');
const NAMED_WEEKDAY_RE = new RegExp(`\\b(?:last|this|next|on)\\s+(?:${WEEKDAYS})\\b`, 'i');

function hasExplicitUnresolvedMedicalTemporal(msg: string): boolean {
  if (IN_MONTH_RE.test(msg)) return true;
  if (MONTH_DAY_RE.test(msg)) return true;
  if (/\blast\s+year\b/i.test(msg)) return true;
  if (/\bin\s+\d{4}\b/i.test(msg)) return true;
  if (NAMED_WEEKDAY_RE.test(msg)) return true;
  return false;
}

export function resolveVisitHistoryTemporalConstraint(msg: string): VisitHistoryTemporalConstraint {
  const range = resolveHistoricalCalendarRange(msg);
  if (range) return { kind: 'resolved', range };
  if (hasExplicitUnresolvedMedicalTemporal(msg)) return { kind: 'unresolved' };
  return { kind: 'none' };
}
