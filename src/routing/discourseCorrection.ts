// Current-conversation correction. Two independent 0/1/many sets.
// The provider marks compatibility. It does not choose the replacement.

import type {
  DiscourseContinuityHolder,
  DiscourseMention,
  DiscourseMentionKind,
  DiscourseMentionProposal,
} from './discourseContinuity';
import {
  DISCOURSE_MENTION_PER_TURN_MAX,
  TOPIC_EVIDENCE_MAX_CHARS,
} from './discourseContinuity';
import {
  DISCOURSE_APPLICABILITY_CARD_MAX,
  buildDiscourseApplicabilityPrompt,
  discourseApplicabilityCards,
  priorActiveDiscourseCandidates,
  type DiscourseApplicabilityCandidate,
} from './discourseApplicability';
import { acceptDiscourseSpanProposals, dropCrossKindSpanGroups } from './discourseMentionProposal';
import {
  DISCOURSE_CORRECTION_PROMPT,
  proposeDiscourseCorrection,
  type DiscourseCorrectionPayload,
} from './semanticProvider';

export type DiscourseCorrectionDecision =
  | { outcome: 'no_correction' }
  | { outcome: 'clarify_target'; surfaces: string[]; speech: string }
  | { outcome: 'clarify_replacement'; surfaces: string[]; speech: string }
  | {
      outcome: 'plan';
      targetMentionId: string;
      replacement:
        | { source: 'existing'; mentionId: string }
        | { source: 'new'; proposal: DiscourseMentionProposal };
      speech: string;
    };

type ReplacementChoice = {
  key: string;
  surface: string;
  existingId?: string;
  proposal?: DiscourseMentionProposal;
};

function compatibleHandles(
  marks: DiscourseCorrectionPayload['targetMarks'],
  disclosed: ReadonlySet<string>,
): Set<string> {
  const chosen = new Set<string>();
  for (const mark of marks) {
    if (!disclosed.has(mark.handle)) continue;
    if (mark.mark === 'compatible') chosen.add(mark.handle);
  }
  return chosen;
}

function clarifySpeech(intro: string, surfaces: readonly string[]): string {
  return `${intro} ${surfaces.join(', ')}?`;
}

export function correctionSpeech(kind: DiscourseMentionKind, surface: string): string {
  if (kind === 'person') return `Got it — ${surface}.`;
  return `Got it — you meant ${surface}.`;
}

/**
 * Pure correction plan. Zero or many on either side does not describe a mutation.
 * A new span that failed grounding is not a candidate.
 * Person replacements arrive only as grounded spans. The name heuristic does not mint them.
 */
export function admitDiscourseCorrection(input: {
  candidates: readonly DiscourseApplicabilityCandidate[];
  targetMarks: DiscourseCorrectionPayload['targetMarks'];
  replacementMarks: DiscourseCorrectionPayload['replacementMarks'];
  groundedNew: readonly DiscourseMentionProposal[];
  groundingFailed: boolean;
  admittedThisTurn: number;
  structuralAllowedHandles?: readonly string[] | null;
}): DiscourseCorrectionDecision {
  if (input.groundingFailed) return { outcome: 'no_correction' };
  const allowed = input.structuralAllowedHandles ?? null;
  const disclosed = new Set(input.candidates.map((candidate) => candidate.handle));
  const targets = input.candidates.filter((candidate) => {
    if (candidate.status !== 'active') return false;
    if (!disclosed.has(candidate.handle)) return false;
    if (allowed && !allowed.includes(candidate.handle)) return false;
    return compatibleHandles(input.targetMarks, disclosed).has(candidate.handle);
  });
  if (targets.length === 0) return { outcome: 'no_correction' };
  if (targets.length > 1) {
    const surfaces = targets.map((item) => item.surfaceSpan);
    return {
      outcome: 'clarify_target',
      surfaces,
      speech: clarifySpeech('Which one should I correct:', surfaces),
    };
  }
  const target = targets[0];
  const groundedNew = dropCrossKindSpanGroups(input.groundedNew);
  const replacements: ReplacementChoice[] = [];
  for (const candidate of input.candidates) {
    if (candidate.handle === target.handle) continue;
    if (candidate.status !== 'active') continue;
    if (!compatibleHandles(input.replacementMarks, disclosed).has(candidate.handle)) continue;
    replacements.push({
      key: `existing:${candidate.handle}`,
      surface: candidate.surfaceSpan,
      existingId: candidate.handle,
    });
  }
  for (const proposal of groundedNew) {
    if (proposal.surfaceSpan.toLowerCase() === target.surfaceSpan.toLowerCase() && proposal.kind === target.kind) {
      continue;
    }
    replacements.push({
      key: `new:${proposal.kind}:${proposal.surfaceSpan}`,
      surface: proposal.surfaceSpan,
      proposal,
    });
  }
  if (replacements.length === 0) return { outcome: 'no_correction' };
  if (replacements.length > 1) {
    const surfaces = replacements.map((item) => item.surface);
    return {
      outcome: 'clarify_replacement',
      surfaces,
      speech: clarifySpeech('Which one did you mean:', surfaces),
    };
  }
  const replacement = replacements[0];
  if (replacement.proposal && input.admittedThisTurn >= DISCOURSE_MENTION_PER_TURN_MAX) {
    return { outcome: 'no_correction' };
  }
  if (replacement.proposal && replacement.proposal.surfaceSpan.length > TOPIC_EVIDENCE_MAX_CHARS) {
    return { outcome: 'no_correction' };
  }
  const kind = replacement.proposal?.kind ?? input.candidates.find((item) => item.handle === replacement.existingId)?.kind;
  if (kind !== 'person' && kind !== 'place' && kind !== 'event_or_topic') return { outcome: 'no_correction' };
  return {
    outcome: 'plan',
    targetMentionId: target.handle,
    replacement: replacement.existingId
      ? { source: 'existing', mentionId: replacement.existingId }
      : { source: 'new', proposal: replacement.proposal! },
    speech: correctionSpeech(kind, replacement.surface),
  };
}

export function buildDiscourseCorrectionPrompt(
  utterance: string,
  candidates: readonly DiscourseApplicabilityCandidate[],
): string | null {
  const cards = discourseApplicabilityCards(candidates).slice(0, DISCOURSE_APPLICABILITY_CARD_MAX);
  const body = buildDiscourseApplicabilityPrompt(utterance, cards);
  if (!body) return null;
  const packet = body.slice(body.indexOf('\n') + 1);
  return `${DISCOURSE_CORRECTION_PROMPT}\n${packet}`;
}

export type DiscourseCorrectionTurn =
  | { kind: 'continue' }
  | { kind: 'blocked' }
  | { kind: 'reply'; speech: string; act: 'acknowledge' | 'clarify' };

export async function considerCurrentTurnDiscourseCorrection(
  utterance: string,
  discourse: DiscourseContinuityHolder,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  opts?: { timeoutMs?: number },
): Promise<DiscourseCorrectionTurn> {
  const currentTurn = discourse.snapshot().turnIndex;
  const candidates = priorActiveDiscourseCandidates(
    discourse.peekDiscourseMentions(),
    discourse.peekDiscourseEpisodes(),
    currentTurn,
  );
  if (candidates.length === 0 || !ctx) return { kind: 'continue' };
  const prompt = buildDiscourseCorrectionPrompt(utterance, candidates);
  if (!prompt) return { kind: 'continue' };
  let parsed: DiscourseCorrectionPayload | null = null;
  try {
    parsed = await proposeDiscourseCorrection(prompt, ctx, opts);
  } catch {
    return { kind: 'continue' };
  }
  if (!parsed || !parsed.correctionTurn) return { kind: 'continue' };
  const accepted = acceptDiscourseSpanProposals(utterance, parsed.newSpans);
  const groundingFailed = accepted.rejected.some((item) => (
    item.reason === 'absent'
    || item.reason === 'ambiguous'
    || item.reason === 'empty_span'
    || item.reason === 'invalid_kind'
  ));
  const decision = admitDiscourseCorrection({
    candidates,
    targetMarks: parsed.targetMarks,
    replacementMarks: parsed.replacementMarks,
    groundedNew: accepted.ready,
    groundingFailed,
    admittedThisTurn: discourse.peekDiscourseMentions().filter((mention) => mention.sourceTurnId === currentTurn).length,
    structuralAllowedHandles: null,
  });
  if (decision.outcome === 'clarify_target' || decision.outcome === 'clarify_replacement') {
    return { kind: 'reply', speech: decision.speech, act: 'clarify' };
  }
  // Admission refused the hypothesis. It writes nothing and does not own the turn.
  if (decision.outcome === 'no_correction') {
    return { kind: 'continue' };
  }
  const applied = discourse.applyDiscourseCorrection({
    targetMentionId: decision.targetMentionId,
    replacement: decision.replacement,
    utterance,
  });
  if (!applied.applied) return { kind: 'blocked' };
  return { kind: 'reply', speech: decision.speech, act: 'acknowledge' };
}

export function activeMention(mentions: readonly DiscourseMention[], surface: string): DiscourseMention | undefined {
  return mentions.find((mention) => mention.status === 'active' && mention.surfaceSpan === surface);
}
