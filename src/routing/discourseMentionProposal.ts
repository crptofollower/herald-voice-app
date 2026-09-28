// Current-turn person, place, and event_or_topic proposals.
// The model proposes span text and a closed kind. Exact unique location is deterministic.
// A person span must also pass the name syntax fence. Admission stays on the holder.

import {
  qualifyingNarrativePersonNames,
  type DiscourseContinuityHolder,
  type DiscourseMentionProposal,
} from './discourseContinuity';
import {
  proposeDiscourseMentions,
  type DiscourseMentionProposalItem,
} from './semanticProvider';

export type DiscourseSpanRejection = {
  span: string;
  kind: string;
  reason: 'empty_span' | 'invalid_kind' | 'absent' | 'ambiguous' | 'person_unsupported' | 'cross_kind';
};

const DISCOURSE_SPAN_KINDS = new Set(['person', 'place', 'event_or_topic']);

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
    if (!DISCOURSE_SPAN_KINDS.has(item.kind)) {
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

/** One exact span with more than one kind is dropped entirely. */
export function dropCrossKindSpanGroups(
  proposals: readonly DiscourseMentionProposal[],
): DiscourseMentionProposal[] {
  const groups = new Map<string, DiscourseMentionProposal[]>();
  for (const proposal of proposals) {
    const key = `${proposal.start}:${proposal.end}`;
    const list = groups.get(key) ?? [];
    list.push(proposal);
    groups.set(key, list);
  }
  const kept: DiscourseMentionProposal[] = [];
  for (const group of groups.values()) {
    const kinds = new Set(group.map((item) => item.kind));
    if (kinds.size === 1) kept.push(group[0]);
  }
  return kept;
}

/**
 * Ground model spans, fence person spans, then drop same-offset kind conflicts.
 * Person-fence and cross-kind drops are span-local. Unlocatable spans stay rejected.
 */
export function acceptDiscourseSpanProposals(
  utterance: string,
  items: readonly DiscourseMentionProposalItem[],
): { ready: DiscourseMentionProposal[]; rejected: DiscourseSpanRejection[] } {
  const grounded = groundExactDiscourseSpans(utterance, items);
  const supported = new Set(
    qualifyingNarrativePersonNames(utterance).map((name) => name.toLowerCase()),
  );
  const fenced: DiscourseMentionProposal[] = [];
  const rejected = [...grounded.rejected];
  for (const proposal of grounded.ready) {
    if (proposal.kind === 'person' && !supported.has(proposal.surfaceSpan.toLowerCase())) {
      rejected.push({ span: proposal.surfaceSpan, kind: proposal.kind, reason: 'person_unsupported' });
      continue;
    }
    fenced.push(proposal);
  }
  const groups = new Map<string, DiscourseMentionProposal[]>();
  for (const proposal of fenced) {
    const key = `${proposal.start}:${proposal.end}`;
    const list = groups.get(key) ?? [];
    list.push(proposal);
    groups.set(key, list);
  }
  const ready: DiscourseMentionProposal[] = [];
  for (const group of groups.values()) {
    const kinds = new Set(group.map((item) => item.kind));
    if (kinds.size > 1) {
      for (const proposal of group) {
        rejected.push({ span: proposal.surfaceSpan, kind: proposal.kind, reason: 'cross_kind' });
      }
      continue;
    }
    ready.push(group[0]);
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
  const accepted = acceptDiscourseSpanProposals(utterance, items);
  if (accepted.ready.length === 0) return;
  const continued = discourse.admitDiscourseProposals(utterance, accepted.ready, 'continue');
  const unresolved = continued.admitted.length === 0
    && continued.reused.length === 0
    && continued.rejected.length > 0
    && continued.rejected.every((item) => item.reason === 'episode_unresolved');
  if (unresolved) discourse.admitDiscourseProposals(utterance, accepted.ready, 'new_episode');
}
