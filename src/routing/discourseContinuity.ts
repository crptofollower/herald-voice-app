// RAM-only Smooth MVP discourse continuity.
// Two independent slots. Never persisted. Never action/write authority.
// No entity IDs, phones, addresses, or mutation targets.

import { extractTitleCaseNameTokens, isClosedClassNameToken } from '../utils/ephemeralSeam';
import {
  IMPERATIVE_ACTION_RE,
  LIST_ADD_SIGNALS,
  THIRD_PERSON_REFERENT_RE,
  TODO_ADD_SIGNALS,
} from '../utils/instructionSignals';
import { OPERATIONAL_ACQUISITION_SHAPE, extractNarrativeOperationalCandidates } from './operationalListContinuity';
import type { AdmittedMultiFactCandidate } from './naturalMultiFactInterpretation';

export const DISCOURSE_TURN_TTL = 4;
export const DISCOURSE_WALL_MS = 10 * 60 * 1000;
export const TOPIC_EVIDENCE_MAX_LINES = 3;
export const TOPIC_EVIDENCE_MAX_CHARS = 160;
export const DISCOURSE_MENTION_ACTIVE_MAX = 8;
export const DISCOURSE_MENTION_PER_TURN_MAX = 4;
export const DISCOURSE_EPISODE_MAX = 4;

export type TopicEvidenceLine = {
  text: string;
  atTurn: number;
};

export type DiscourseTopicSlot = {
  kind: 'person_mention';
  displayName: string;
  evidence: TopicEvidenceLine[];
  establishedAtTurn: number;
  refreshedAtTurn: number;
};

export type DiscourseDomainSlot = {
  kind: 'operational_list';
  domain: 'grocery' | 'todo';
  establishedAtTurn: number;
  refreshedAtTurn: number;
};

export type CandidateSetSlot = {
  domain: 'grocery' | 'todo' | null;
  items: string[];
  sourceTurn: number;
  refreshedAtTurn: number;
};

/** RAM-only Natural Multi-Fact V1 holds. Never write/Call/pending authority. */
export type InterpretationHoldSlot = {
  episodeId: string;
  candidates: AdmittedMultiFactCandidate[];
  sourceTurn: number;
  refreshedAtTurn: number;
};

export type DiscourseMentionKind = 'person' | 'place' | 'event_or_topic';
export type DiscourseMentionStatus = 'active' | 'corrected_away' | 'superseded';

/** Current-conversation mention. Source span and provenance stay immutable. */
export type DiscourseMention = {
  mentionId: string;
  kind: DiscourseMentionKind;
  surfaceSpan: string;
  start: number;
  end: number;
  sourceTurnId: number;
  sourceUtteranceRef: string;
  epistemic: 'current_conversation';
  durable: false;
  status: DiscourseMentionStatus;
};

/** Co-membership only. No relation, predicate, or role. */
export type DiscourseEpisode = {
  episodeId: string;
  memberMentionIds: string[];
  sourceTurnIds: number[];
};

export type DiscourseMentionProposal = {
  kind: string;
  surfaceSpan: string;
  start: number;
  end: number;
};

export type DiscourseAdmitReason =
  | 'span_mismatch'
  | 'invalid_kind'
  | 'person_unsupported'
  | 'mention_capacity'
  | 'turn_capacity'
  | 'episode_capacity'
  | 'overlap_conflict'
  | 'contained_span'
  | 'episode_unresolved';

export type DiscourseAdmitRejection = {
  kind: string;
  surfaceSpan: string;
  reason: DiscourseAdmitReason;
};

export type DiscourseAdmitBatch = {
  admitted: DiscourseMention[];
  reused: DiscourseMention[];
  superseded: DiscourseMention[];
  rejected: DiscourseAdmitRejection[];
};

export type WcsSnapshot = {
  turnIndex: number;
  focus: {
    displayName: string;
    establishedAtTurn: number;
    refreshedAtTurn: number;
    evidenceCount: number;
  } | null;
  candidateSet: {
    domain: 'grocery' | 'todo' | null;
    items: string[];
    sourceTurn: number;
    refreshedAtTurn: number;
  } | null;
};

const CONTRACTION_SUFFIX_RE = /'(?:s|re|d|ll|ve|m|t)$/i;

/** who/what + be + I/we + talking about/saying — not a phrase catalog. */
const TOPIC_LOOKUP_RE =
  /\b(?:who|what)\s+(?:was|were|am|are)\s+(?:i|we)\s+(?:talking\s+about|saying)\b/i;

export function stripGrammaticalContractionSuffix(token: string): string {
  return token.replace(CONTRACTION_SUFFIX_RE, '');
}

export function qualifyingNarrativePersonNames(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (IMPERATIVE_ACTION_RE.test(t)) return [];
  if (TODO_ADD_SIGNALS.some((p) => p.test(t))) return [];
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return [];
  if (OPERATIONAL_ACQUISITION_SHAPE.test(t)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of extractTitleCaseNameTokens(t)) {
    const normalized = stripGrammaticalContractionSuffix(raw).trim();
    if (!normalized) continue;
    if (isClosedClassNameToken(normalized)) continue;
    if (isUnsafeTopicLabel(normalized)) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(normalized);
  }
  return names;
}

function isUnsafeTopicLabel(name: string): boolean {
  const n = name.trim();
  if (!n || n.length > 80) return true;
  if (/\d{5,}/.test(n)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(n)) return true;
  if (/@/.test(n)) return true;
  return false;
}

function isUnsafeEvidenceLine(text: string): boolean {
  if (/\d{5,}/.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) return true;
  if (/@/.test(text)) return true;
  return false;
}

function boundEvidenceText(text: string): string {
  return text.trim().slice(0, TOPIC_EVIDENCE_MAX_CHARS);
}

function isTopicLookup(text: string): boolean {
  return TOPIC_LOOKUP_RE.test(text);
}

function isReferenceQuestion(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  if (/^(?:what|who|when|where|why|how)\b/i.test(t)) return true;
  return isTopicLookup(t);
}

function mentionsDisplayName(text: string, displayName: string): boolean {
  const n = displayName.trim();
  if (!n) return false;
  const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(text);
}

function hasLiveTopicContinuation(text: string, displayName: string): boolean {
  return THIRD_PERSON_REFERENT_RE.test(text)
    || mentionsDisplayName(text, displayName)
    || isTopicLookup(text);
}

function isDiscourseMentionKind(kind: string): kind is DiscourseMentionKind {
  return kind === 'person' || kind === 'place' || kind === 'event_or_topic';
}

function spanIsExact(utterance: string, start: number, end: number, surfaceSpan: string): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end > utterance.length || start >= end) return false;
  return utterance.slice(start, end) === surfaceSpan;
}

function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

function rangeContains(outerStart: number, outerEnd: number, innerStart: number, innerEnd: number): boolean {
  return outerStart <= innerStart
    && innerEnd <= outerEnd
    && (outerEnd - outerStart) > (innerEnd - innerStart);
}

function sameItemLists(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.toLowerCase() === (b[i] ?? '').toLowerCase());
}

export class WorkingConversationState {
  private topic: (DiscourseTopicSlot & { refreshedAtMs: number }) | null = null;
  private domain: (DiscourseDomainSlot & { refreshedAtMs: number }) | null = null;
  private candidateSet: (CandidateSetSlot & { refreshedAtMs: number }) | null = null;
  private interpretationHold: (InterpretationHoldSlot & { refreshedAtMs: number }) | null = null;
  private referentsInPlay: import('./canonicalConversationState').ReferentsInPlay | null = null;
  private mentions: DiscourseMention[] = [];
  private episodes: DiscourseEpisode[] = [];
  private mentionSeq = 0;
  private episodeSeq = 0;
  private admittedThisTurn = 0;
  private turn = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  beginUserTurn(): void {
    this.turn += 1;
    this.admittedThisTurn = 0;
    this.expireStale();
  }

  currentTurn(): number {
    return this.turn;
  }

  clear(): void {
    this.topic = null;
    this.domain = null;
    this.candidateSet = null;
    this.interpretationHold = null;
    this.referentsInPlay = null;
    this.mentions = [];
    this.episodes = [];
    this.mentionSeq = 0;
    this.episodeSeq = 0;
    this.admittedThisTurn = 0;
  }

  peekReferentsInPlay(): import('./canonicalConversationState').ReferentsInPlay | null {
    if (!this.referentsInPlay) return null;
    return { ...this.referentsInPlay, candidateIds: [...this.referentsInPlay.candidateIds] };
  }

  establishReferentsInPlay(
    candidateIds: readonly string[],
    purposeKind: 'read_phone' | 'presented_people' = 'read_phone',
  ): import('./canonicalConversationState').ReferentsInPlay | null {
    const ids = [...new Set(candidateIds.map((id) => id.trim()).filter(Boolean))].sort();
    if (ids.length < 2) return null;
    const set = {
      setId: `contacts:${purposeKind}:${ids.join('|')}`,
      kind: 'person' as const,
      domain: 'contacts' as const,
      candidateIds: ids,
      purpose: { kind: purposeKind },
      establishedAtTurn: this.turn,
    };
    this.referentsInPlay = set;
    return { ...set, candidateIds: [...ids] };
  }

  /** Same membership. The blocked phone read replaces a completed presentation. */
  transitionReferentsToReadPhone(): import('./canonicalConversationState').ReferentsInPlay | null {
    const current = this.referentsInPlay;
    if (!current || current.candidateIds.length < 2) return null;
    const ids = [...current.candidateIds];
    const set = {
      ...current,
      setId: `contacts:read_phone:${ids.join('|')}`,
      purpose: { kind: 'read_phone' as const },
    };
    this.referentsInPlay = set;
    return { ...set, candidateIds: [...ids] };
  }

  clearReferentsInPlay(): void {
    this.referentsInPlay = null;
  }

  peekTopic(): DiscourseTopicSlot | null {
    this.expireStale();
    if (!this.topic) return null;
    const { refreshedAtMs: _ms, ...slot } = this.topic;
    return {
      ...slot,
      evidence: slot.evidence.map((e) => ({ ...e })),
    };
  }

  peekDomain(): DiscourseDomainSlot | null {
    this.expireStale();
    if (!this.domain) return null;
    const { refreshedAtMs: _ms, ...slot } = this.domain;
    return slot;
  }

  establishTopic(displayName: string, evidenceText?: string): void {
    const name = displayName.trim();
    if (isUnsafeTopicLabel(name)) return;
    const at = this.now();
    const evidence: TopicEvidenceLine[] = [];
    if (evidenceText && !isUnsafeEvidenceLine(evidenceText)) {
      const bounded = boundEvidenceText(evidenceText);
      if (bounded) evidence.push({ text: bounded, atTurn: this.turn });
    }
    this.topic = {
      kind: 'person_mention',
      displayName: name,
      evidence,
      establishedAtTurn: this.turn,
      refreshedAtTurn: this.turn,
      refreshedAtMs: at,
    };
  }

  refreshTopic(): void {
    if (!this.peekTopic() || !this.topic) return;
    this.topic = {
      ...this.topic,
      refreshedAtTurn: this.turn,
      refreshedAtMs: this.now(),
    };
  }

  appendTopicEvidence(evidenceText: string): void {
    if (!this.peekTopic() || !this.topic) return;
    if (isUnsafeEvidenceLine(evidenceText)) {
      this.refreshTopic();
      return;
    }
    const bounded = boundEvidenceText(evidenceText);
    if (!bounded) {
      this.refreshTopic();
      return;
    }
    const evidence = [...this.topic.evidence, { text: bounded, atTurn: this.turn }];
    while (evidence.length > TOPIC_EVIDENCE_MAX_LINES) evidence.shift();
    this.topic = {
      ...this.topic,
      evidence,
      refreshedAtTurn: this.turn,
      refreshedAtMs: this.now(),
    };
  }

  establishDomain(domain: 'grocery' | 'todo'): void {
    const at = this.now();
    this.domain = {
      kind: 'operational_list',
      domain,
      establishedAtTurn: this.turn,
      refreshedAtTurn: this.turn,
      refreshedAtMs: at,
    };
    this.candidateSet = null;
  }

  peekCandidateSet(): CandidateSetSlot | null {
    this.expireStale();
    if (!this.candidateSet) return null;
    const { refreshedAtMs: _ms, ...slot } = this.candidateSet;
    return { ...slot, items: [...slot.items] };
  }

  establishCandidateSet(
    domain: 'grocery' | 'todo' | null,
    items: readonly string[],
    sourceTurn?: number,
  ): void {
    const bounded = items.map((i) => i.trim()).filter(Boolean).slice(0, 5);
    if (bounded.length === 0) return;
    const at = this.now();
    const src = sourceTurn ?? this.turn;
    this.candidateSet = {
      domain,
      items: bounded,
      sourceTurn: src,
      refreshedAtTurn: this.turn,
      refreshedAtMs: at,
    };
  }

  refreshCandidateSet(): void {
    if (!this.peekCandidateSet() || !this.candidateSet) return;
    this.candidateSet = {
      ...this.candidateSet,
      refreshedAtTurn: this.turn,
      refreshedAtMs: this.now(),
    };
  }

  clearCandidateSet(): void {
    this.candidateSet = null;
  }

  peekInterpretationHold(): InterpretationHoldSlot | null {
    this.expireStale();
    if (!this.interpretationHold) return null;
    const { refreshedAtMs: _ms, ...slot } = this.interpretationHold;
    return { ...slot, candidates: slot.candidates.map((c) => ({ ...c })) };
  }

  establishInterpretationHold(
    episodeId: string,
    candidates: InterpretationHoldSlot['candidates'],
  ): void {
    // Structural only: a live hold must contain a non-empty already-admitted
    // array. Semantic singleton policy is owned by admitNaturalMultiFactProposal.
    // Production caller is processUtterance after interpretation_hold ADMIT.
    if (!episodeId.trim() || candidates.length === 0) return;
    const at = this.now();
    this.interpretationHold = {
      episodeId: episodeId.trim(),
      candidates: candidates.map((c) => ({ ...c })),
      sourceTurn: this.turn,
      refreshedAtTurn: this.turn,
      refreshedAtMs: at,
    };
  }

  clearInterpretationHold(): void {
    this.interpretationHold = null;
  }

  snapshot(): WcsSnapshot {
    this.expireStale();
    const focus = this.topic
      ? {
          displayName: this.topic.displayName,
          establishedAtTurn: this.topic.establishedAtTurn,
          refreshedAtTurn: this.topic.refreshedAtTurn,
          evidenceCount: this.topic.evidence.length,
        }
      : null;
    const candidateSet = this.candidateSet
      ? {
          domain: this.candidateSet.domain,
          items: [...this.candidateSet.items],
          sourceTurn: this.candidateSet.sourceTurn,
          refreshedAtTurn: this.candidateSet.refreshedAtTurn,
        }
      : null;
    return { turnIndex: this.turn, focus, candidateSet };
  }

  peekDiscourseMentions(): DiscourseMention[] {
    return this.mentions.map((mention) => ({ ...mention }));
  }

  peekDiscourseEpisodes(): DiscourseEpisode[] {
    return this.episodes.map((episode) => ({
      episodeId: episode.episodeId,
      memberMentionIds: [...episode.memberMentionIds],
      sourceTurnIds: [...episode.sourceTurnIds],
    }));
  }

  /**
   * Structural admission for place and event_or_topic proposals, and for a
   * person proposal only when qualifyingNarrativePersonNames already accepts
   * that exact surface. Does not choose cross-turn applicability.
   */
  admitDiscourseProposals(
    utterance: string,
    proposals: readonly DiscourseMentionProposal[],
    association: 'new_episode' | 'continue' = 'new_episode',
  ): DiscourseAdmitBatch {
    const admitted: DiscourseMention[] = [];
    const reused: DiscourseMention[] = [];
    const superseded: DiscourseMention[] = [];
    const rejected: DiscourseAdmitRejection[] = [];
    const supportedPersons = new Set(
      qualifyingNarrativePersonNames(utterance).map((name) => name.toLowerCase()),
    );
    const utteranceRef = `turn:${this.turn}`;
    let episode = association === 'continue' ? this.episodeContinuedByLiveTopic() : null;
    if (association === 'continue' && !episode) {
      for (const proposal of proposals) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'episode_unresolved' });
      }
      return { admitted, reused, superseded, rejected };
    }
    let createdEpisode = false;
    for (const proposal of proposals) {
      if (!isDiscourseMentionKind(proposal.kind)) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'invalid_kind' });
        continue;
      }
      if (!spanIsExact(utterance, proposal.start, proposal.end, proposal.surfaceSpan)) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'span_mismatch' });
        continue;
      }
      if (proposal.kind === 'person' && !supportedPersons.has(proposal.surfaceSpan.toLowerCase())) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'person_unsupported' });
        continue;
      }
      if (!episode && !createdEpisode) {
        if (this.episodes.length >= DISCOURSE_EPISODE_MAX) {
          rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'episode_capacity' });
          continue;
        }
        episode = {
          episodeId: `de${++this.episodeSeq}`,
          memberMentionIds: [],
          sourceTurnIds: [],
        };
        this.episodes.push(episode);
        createdEpisode = true;
      }
      if (!episode) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'episode_capacity' });
        continue;
      }
      const duplicate = this.activeMembers(episode).find((mention) => (
        mention.kind === proposal.kind
        && mention.surfaceSpan.toLowerCase() === proposal.surfaceSpan.toLowerCase()
      ));
      if (duplicate) {
        reused.push({ ...duplicate });
        this.noteEpisodeTurn(episode);
        continue;
      }
      const overlap = this.overlapAgainst(episode, utteranceRef, proposal);
      if (overlap.kind === 'conflict' || overlap.kind === 'contained') {
        rejected.push({
          kind: proposal.kind,
          surfaceSpan: proposal.surfaceSpan,
          reason: overlap.kind === 'contained' ? 'contained_span' : 'overlap_conflict',
        });
        continue;
      }
      if (this.admittedThisTurn >= DISCOURSE_MENTION_PER_TURN_MAX) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'turn_capacity' });
        continue;
      }
      const activeAfterSupersede = this.mentions.filter((mention) => mention.status === 'active').length
        - (overlap.kind === 'longer' ? 1 : 0);
      if (activeAfterSupersede >= DISCOURSE_MENTION_ACTIVE_MAX) {
        rejected.push({ kind: proposal.kind, surfaceSpan: proposal.surfaceSpan, reason: 'mention_capacity' });
        continue;
      }
      if (overlap.kind === 'longer') {
        overlap.shorter.status = 'superseded';
        superseded.push({ ...overlap.shorter });
      }
      const mention: DiscourseMention = {
        mentionId: `dm${++this.mentionSeq}`,
        kind: proposal.kind,
        surfaceSpan: proposal.surfaceSpan,
        start: proposal.start,
        end: proposal.end,
        sourceTurnId: this.turn,
        sourceUtteranceRef: utteranceRef,
        epistemic: 'current_conversation',
        durable: false,
        status: 'active',
      };
      this.mentions.push(mention);
      this.admittedThisTurn += 1;
      if (!episode.memberMentionIds.includes(mention.mentionId)) {
        episode.memberMentionIds.push(mention.mentionId);
      }
      this.noteEpisodeTurn(episode);
      admitted.push({ ...mention });
    }
    if (createdEpisode && episode && episode.memberMentionIds.length === 0) {
      this.episodes = this.episodes.filter((item) => item.episodeId !== episode!.episodeId);
    }
    return { admitted, reused, superseded, rejected };
  }

  /**
   * `exactlyOneNarrativePerson` is set only when this turn's local
   * qualifying name list has length 1 and that mention is admitted.
   * Several qualifying names stay as separate mentions. This holder does
   * not write the ledger.
   */
  noteNarrativeUtterance(
    text: string,
    proposals: readonly DiscourseMentionProposal[] = [],
  ): { exactlyOneNarrativePerson: string | null } {
    const live = this.peekTopic();
    if (live && hasLiveTopicContinuation(text, live.displayName)) {
      if (isReferenceQuestion(text)) this.refreshTopic();
      else this.appendTopicEvidence(text);
      this.admitDiscourseProposals(text, proposals, 'continue');
      return { exactlyOneNarrativePerson: null };
    }
    const items = extractNarrativeOperationalCandidates(text);
    if (items) {
      const liveSet = this.peekCandidateSet();
      if (liveSet && sameItemLists(liveSet.items, items)) this.refreshCandidateSet();
      else this.establishCandidateSet(null, items);
    }
    const names = qualifyingNarrativePersonNames(text);
    const personProposals: DiscourseMentionProposal[] = [];
    for (const name of names) {
      const start = text.indexOf(name);
      if (start < 0) continue;
      personProposals.push({
        kind: 'person',
        surfaceSpan: text.slice(start, start + name.length),
        start,
        end: start + name.length,
      });
    }
    const batch = this.admitDiscourseProposals(text, [...personProposals, ...proposals], 'new_episode');
    const kept = new Set(
      [...batch.admitted, ...batch.reused]
        .filter((mention) => mention.kind === 'person')
        .map((mention) => mention.surfaceSpan),
    );
    if (names.length === 1 && kept.has(names[0])) {
      this.establishTopic(names[0], text);
      return { exactlyOneNarrativePerson: names[0] };
    }
    return { exactlyOneNarrativePerson: null };
  }

  private activeMembers(episode: DiscourseEpisode): DiscourseMention[] {
    const ids = new Set(episode.memberMentionIds);
    return this.mentions.filter((mention) => mention.status === 'active' && ids.has(mention.mentionId));
  }

  private noteEpisodeTurn(episode: DiscourseEpisode): void {
    if (!episode.sourceTurnIds.includes(this.turn)) episode.sourceTurnIds.push(this.turn);
  }

  private episodeContinuedByLiveTopic(): DiscourseEpisode | null {
    const topic = this.topic;
    if (!topic) return null;
    const name = topic.displayName.toLowerCase();
    const hits = this.episodes.filter((episode) => this.activeMembers(episode).some((mention) => (
      mention.kind === 'person' && mention.surfaceSpan.toLowerCase() === name
    )));
    return hits.length === 1 ? hits[0] : null;
  }

  private overlapAgainst(
    episode: DiscourseEpisode,
    utteranceRef: string,
    proposal: DiscourseMentionProposal & { kind: DiscourseMentionKind },
  ): { kind: 'none' } | { kind: 'conflict' } | { kind: 'contained' } | { kind: 'longer'; shorter: DiscourseMention } {
    const sameUtterance = this.activeMembers(episode).filter((mention) => mention.sourceUtteranceRef === utteranceRef);
    let containedByLonger = false;
    let shorter: DiscourseMention | null = null;
    for (const mention of sameUtterance) {
      if (!rangesOverlap(mention.start, mention.end, proposal.start, proposal.end)) continue;
      const sameKind = mention.kind === proposal.kind;
      if (sameKind && rangeContains(proposal.start, proposal.end, mention.start, mention.end)) {
        if (shorter) return { kind: 'conflict' };
        shorter = mention;
        continue;
      }
      if (sameKind && rangeContains(mention.start, mention.end, proposal.start, proposal.end)) {
        containedByLonger = true;
        continue;
      }
      return { kind: 'conflict' };
    }
    if (shorter && containedByLonger) return { kind: 'conflict' };
    if (shorter) return { kind: 'longer', shorter };
    if (containedByLonger) return { kind: 'contained' };
    return { kind: 'none' };
  }

  private expireStale(): void {
    const now = this.now();
    if (this.topic && this.isExpired(this.topic.refreshedAtTurn, this.topic.refreshedAtMs, now)) {
      this.topic = null;
    }
    if (this.domain && this.isExpired(this.domain.refreshedAtTurn, this.domain.refreshedAtMs, now)) {
      this.domain = null;
    }
    if (this.candidateSet && this.isExpired(this.candidateSet.refreshedAtTurn, this.candidateSet.refreshedAtMs, now)) {
      this.candidateSet = null;
    }
    if (this.interpretationHold && this.isExpired(this.interpretationHold.refreshedAtTurn, this.interpretationHold.refreshedAtMs, now)) {
      this.interpretationHold = null;
    }
  }

  private isExpired(refreshedAtTurn: number, refreshedAtMs: number, now: number): boolean {
    return (this.turn - refreshedAtTurn) > DISCOURSE_TURN_TTL
      || (now - refreshedAtMs) > DISCOURSE_WALL_MS;
  }
}

export { WorkingConversationState as DiscourseContinuityHolder };
