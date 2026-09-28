// Cross-turn discourse applicability. Compatibility marks are not a winner.
// Deterministic 0 / 1 / many owns the eligible set.

import type {
  DiscourseContinuityHolder,
  DiscourseEpisode,
  DiscourseMention,
  DiscourseMentionKind,
} from './discourseContinuity';
import { TOPIC_EVIDENCE_MAX_CHARS } from './discourseContinuity';
import {
  DISCOURSE_APPLICABILITY_PROMPT,
  proposeDiscourseApplicability,
  type DiscourseApplicabilityPayload,
} from './semanticProvider';

export const DISCOURSE_APPLICABILITY_COMEMBER_MAX = 3;
export const DISCOURSE_APPLICABILITY_CARD_MAX = 8;

export type DiscourseApplicabilityCard = {
  handle: string;
  kind: DiscourseMentionKind;
  surfaceSpan: string;
  episodeHandle: string;
  coMembers: string[];
  sourceWording?: string;
};

export type DiscourseApplicabilityCandidate = DiscourseApplicabilityCard & {
  status: DiscourseMention['status'];
  sourceTurnId: number;
};

export type DiscourseApplicabilityAdmission =
  | { outcome: 'zero' }
  | {
      outcome: 'one';
      handle: string;
      surfaceSpan: string;
      kind: DiscourseMentionKind;
      coMembers: string[];
      sourceWording?: string;
      speech: string;
    }
  | { outcome: 'many'; surfaces: string[]; speech: string };

const CARD_KEYS = ['handle', 'kind', 'surfaceSpan', 'episodeHandle', 'coMembers', 'sourceWording'] as const;

function occurrenceCount(utterance: string, surface: string): number {
  if (!surface) return 0;
  let count = 0;
  let from = 0;
  while (from <= utterance.length) {
    const at = utterance.indexOf(surface, from);
    if (at < 0) break;
    count += 1;
    if (count > 1) return count;
    from = at + surface.length;
  }
  return count;
}

function episodeByMention(episodes: readonly DiscourseEpisode[]): Map<string, DiscourseEpisode> {
  const map = new Map<string, DiscourseEpisode>();
  for (const episode of episodes) {
    for (const id of episode.memberMentionIds) map.set(id, episode);
  }
  return map;
}

function coMemberSurfaces(
  mention: DiscourseMention,
  episode: DiscourseEpisode | undefined,
  mentions: readonly DiscourseMention[],
): string[] {
  if (!episode) return [];
  const byId = new Map(mentions.map((item) => [item.mentionId, item]));
  const surfaces: string[] = [];
  for (const id of episode.memberMentionIds) {
    if (id === mention.mentionId) continue;
    const member = byId.get(id);
    if (!member || member.status !== 'active') continue;
    if (!member.surfaceSpan) continue;
    surfaces.push(member.surfaceSpan);
    if (surfaces.length >= DISCOURSE_APPLICABILITY_COMEMBER_MAX) break;
  }
  return surfaces;
}

export function priorActiveDiscourseCandidates(
  mentions: readonly DiscourseMention[],
  episodes: readonly DiscourseEpisode[],
  currentTurn: number,
): DiscourseApplicabilityCandidate[] {
  const episodesByMention = episodeByMention(episodes);
  const prior = mentions.filter((mention) => (
    mention.status === 'active'
    && mention.sourceTurnId < currentTurn
    && mention.durable === false
  ));
  return prior.slice(0, DISCOURSE_APPLICABILITY_CARD_MAX).map((mention) => {
    const episode = episodesByMention.get(mention.mentionId);
    const wording = mention.sourceWording?.slice(0, TOPIC_EVIDENCE_MAX_CHARS);
    return {
      handle: mention.mentionId,
      kind: mention.kind,
      surfaceSpan: mention.surfaceSpan,
      episodeHandle: episode?.episodeId ?? '',
      coMembers: coMemberSurfaces(mention, episode, mentions),
      status: mention.status,
      sourceTurnId: mention.sourceTurnId,
      ...(wording ? { sourceWording: wording } : {}),
    };
  });
}

export function discourseApplicabilityCards(
  candidates: readonly DiscourseApplicabilityCandidate[],
): DiscourseApplicabilityCard[] {
  return candidates.map((candidate) => ({
    handle: candidate.handle,
    kind: candidate.kind,
    surfaceSpan: candidate.surfaceSpan,
    episodeHandle: candidate.episodeHandle,
    coMembers: candidate.coMembers.slice(0, DISCOURSE_APPLICABILITY_COMEMBER_MAX),
    ...(candidate.sourceWording
      ? { sourceWording: candidate.sourceWording.slice(0, TOPIC_EVIDENCE_MAX_CHARS) }
      : {}),
  }));
}

/** Exact unique surface hits. Two candidates that share one surface both count. */
export function exactActiveSurfaceHandles(
  utterance: string,
  candidates: readonly DiscourseApplicabilityCandidate[],
): string[] {
  return candidates
    .filter((candidate) => occurrenceCount(utterance, candidate.surfaceSpan) === 1)
    .map((candidate) => candidate.handle);
}

export function buildDiscourseApplicabilityPrompt(
  utterance: string,
  cards: readonly DiscourseApplicabilityCard[],
): string | null {
  if (!utterance.trim() || cards.length === 0) return null;
  if (cards.length > DISCOURSE_APPLICABILITY_CARD_MAX) return null;
  for (const card of cards) {
    const keys = Object.keys(card);
    if (keys.some((key) => !CARD_KEYS.includes(key as typeof CARD_KEYS[number]))) return null;
    if (card.coMembers.length > DISCOURSE_APPLICABILITY_COMEMBER_MAX) return null;
    if (card.sourceWording && card.sourceWording.length > TOPIC_EVIDENCE_MAX_CHARS) return null;
    if (!card.handle || !card.surfaceSpan) return null;
  }
  const packet = {
    utterance,
    candidates: cards.map((card) => ({
      handle: card.handle,
      kind: card.kind,
      surfaceSpan: card.surfaceSpan,
      episodeHandle: card.episodeHandle,
      coMembers: card.coMembers,
      ...(card.sourceWording ? { sourceWording: card.sourceWording } : {}),
    })),
  };
  return `${DISCOURSE_APPLICABILITY_PROMPT}\n${JSON.stringify(packet)}`;
}

function membershipSpeech(
  surface: string,
  coMembers: readonly string[],
  sourceWording?: string,
): string {
  const others = coMembers.slice(0, DISCOURSE_APPLICABILITY_COMEMBER_MAX);
  const body = others.length > 0
    ? `We were talking about ${surface}. Also in this conversation: ${others.join(', ')}.`
    : `We were talking about ${surface}.`;
  if (!sourceWording) return body;
  return `${body} You said: ${sourceWording}`;
}

function clarifySpeech(surfaces: readonly string[]): string {
  return `Which of these should I continue: ${surfaces.join(', ')}?`;
}

function oneResult(candidate: DiscourseApplicabilityCandidate): DiscourseApplicabilityAdmission {
  return {
    outcome: 'one',
    handle: candidate.handle,
    surfaceSpan: candidate.surfaceSpan,
    kind: candidate.kind,
    coMembers: candidate.coMembers.slice(0, DISCOURSE_APPLICABILITY_COMEMBER_MAX),
    ...(candidate.sourceWording ? { sourceWording: candidate.sourceWording } : {}),
    speech: membershipSpeech(candidate.surfaceSpan, candidate.coMembers, candidate.sourceWording),
  };
}

/**
 * Final eligible set. Exact handles, when supplied, skip compatibility marks.
 * A null structural allowlist does not narrow. Uncertain and missing marks
 * are not eligible. Unknown handles are dropped.
 */
export function admitDiscourseApplicability(input: {
  candidates: readonly DiscourseApplicabilityCandidate[];
  disclosedHandles: readonly string[];
  marks: DiscourseApplicabilityPayload['marks'] | null;
  utteranceApplicable: boolean;
  structuralAllowedHandles?: readonly string[] | null;
  exactHandles?: readonly string[] | null;
}): DiscourseApplicabilityAdmission {
  const disclosed = new Set(input.disclosedHandles);
  const allowed = input.structuralAllowedHandles ?? null;
  const universe = input.candidates.filter((candidate) => {
    if (candidate.status !== 'active') return false;
    if (!disclosed.has(candidate.handle)) return false;
    if (allowed && !allowed.includes(candidate.handle)) return false;
    return true;
  });
  if (input.exactHandles) {
    const exact = new Set(input.exactHandles);
    const hits = universe.filter((candidate) => exact.has(candidate.handle));
    if (hits.length === 1) return oneResult(hits[0]);
    if (hits.length > 1) {
      return { outcome: 'many', surfaces: hits.map((item) => item.surfaceSpan), speech: clarifySpeech(hits.map((item) => item.surfaceSpan)) };
    }
    return { outcome: 'zero' };
  }
  if (!input.utteranceApplicable || !input.marks) return { outcome: 'zero' };
  const marked = new Map<string, string>();
  for (const mark of input.marks) {
    if (!disclosed.has(mark.handle)) continue;
    if (mark.mark !== 'compatible' && mark.mark !== 'incompatible' && mark.mark !== 'uncertain') continue;
    marked.set(mark.handle, mark.mark);
  }
  const eligible = universe.filter((candidate) => marked.get(candidate.handle) === 'compatible');
  if (eligible.length === 1) return oneResult(eligible[0]);
  if (eligible.length > 1) {
    const surfaces = eligible.map((item) => item.surfaceSpan);
    return { outcome: 'many', surfaces, speech: clarifySpeech(surfaces) };
  }
  return { outcome: 'zero' };
}

export async function applyCurrentTurnDiscourseApplicability(
  utterance: string,
  discourse: DiscourseContinuityHolder,
  ctx: { completion: (params: any) => Promise<unknown> } | null,
  opts?: { timeoutMs?: number },
): Promise<DiscourseApplicabilityAdmission | null> {
  const currentTurn = discourse.snapshot().turnIndex;
  const candidates = priorActiveDiscourseCandidates(
    discourse.peekDiscourseMentions(),
    discourse.peekDiscourseEpisodes(),
    currentTurn,
  );
  if (candidates.length === 0) return null;
  const exactHandles = exactActiveSurfaceHandles(utterance, candidates);
  const disclosedHandles = candidates.map((candidate) => candidate.handle);
  if (exactHandles.length > 0) {
    const exact = admitDiscourseApplicability({
      candidates,
      disclosedHandles,
      marks: null,
      utteranceApplicable: false,
      structuralAllowedHandles: null,
      exactHandles,
    });
    return exact.outcome === 'zero' ? null : exact;
  }
  const cards = discourseApplicabilityCards(candidates);
  const prompt = buildDiscourseApplicabilityPrompt(utterance, cards);
  if (!prompt || !ctx) return null;
  let parsed: DiscourseApplicabilityPayload | null = null;
  try {
    parsed = await proposeDiscourseApplicability(prompt, ctx, opts);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const marked = admitDiscourseApplicability({
    candidates,
    disclosedHandles,
    marks: parsed.marks,
    utteranceApplicable: parsed.utteranceApplicable,
    structuralAllowedHandles: null,
    exactHandles: null,
  });
  return marked.outcome === 'zero' ? null : marked;
}
