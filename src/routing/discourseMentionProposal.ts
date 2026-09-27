// Current-turn place and event_or_topic proposals.
// The model proposes span text. Exact unique location is deterministic.
// Admission stays on DiscourseContinuityHolder. This module does not answer.

import type { DiscourseContinuityHolder, DiscourseMentionProposal } from './discourseContinuity';
import {
  proposeDiscourseMentions,
  type DiscourseMentionProposalItem,
} from './semanticProvider';

export type DiscourseSpanRejection = {
  span: string;
  kind: string;
  reason: 'empty_span' | 'invalid_kind' | 'absent' | 'ambiguous';
};

export function locateExactUniqueSpan(
  utterance: string,
  span: string,
): { start: number; end: number } | null {
  if (!span) return null;
  const start = utterance.indexOf(span);
  if (start < 0) return null;
  if (utterance.indexOf(span, start + span.length) !== -1) return null;
  return { start, end: start + span.length };
}

export function groundExactDiscourseSpans(
  utterance: string,
  items: readonly DiscourseMentionProposalItem[],
): { ready: DiscourseMentionProposal[]; rejected: DiscourseSpanRejection[] } {
  const ready: DiscourseMentionProposal[] = [];
  const rejected: DiscourseSpanRejection[] = [];
  for (const item of items) {
    if (item.kind !== 'place' && item.kind !== 'event_or_topic') {
      rejected.push({ span: item.span, kind: item.kind, reason: 'invalid_kind' });
      continue;
    }
    if (!item.span) {
      rejected.push({ span: item.span, kind: item.kind, reason: 'empty_span' });
      continue;
    }
    const located = locateExactUniqueSpan(utterance, item.span);
    if (!located) {
      const present = utterance.indexOf(item.span) >= 0;
      rejected.push({
        span: item.span,
        kind: item.kind,
        reason: present ? 'ambiguous' : 'absent',
      });
      continue;
    }
    if (utterance.slice(located.start, located.end) !== item.span) {
      rejected.push({ span: item.span, kind: item.kind, reason: 'absent' });
      continue;
    }
    ready.push({
      kind: item.kind,
      surfaceSpan: item.span,
      start: located.start,
      end: located.end,
    });
  }
  return { ready, rejected };
}

/** Populate representation only. Does not choose a response. */
export async function populateCurrentTurnDiscourseMentions(
  utterance: string,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  discourse: DiscourseContinuityHolder,
  opts?: { timeoutMs?: number },
): Promise<void> {
  if (!ctx) return;
  let items: DiscourseMentionProposalItem[] | null = null;
  try {
    items = await proposeDiscourseMentions(utterance, ctx, opts);
  } catch {
    return;
  }
  if (!items || items.length === 0) return;
  const grounded = groundExactDiscourseSpans(utterance, items);
  if (grounded.ready.length === 0) return;
  const continued = discourse.admitDiscourseProposals(utterance, grounded.ready, 'continue');
  const unresolved = continued.admitted.length === 0
    && continued.reused.length === 0
    && continued.rejected.length > 0
    && continued.rejected.every((item) => item.reason === 'episode_unresolved');
  if (unresolved) discourse.admitDiscourseProposals(utterance, grounded.ready, 'new_episode');
}
