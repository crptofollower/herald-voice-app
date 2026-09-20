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

function sameItemLists(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.toLowerCase() === (b[i] ?? '').toLowerCase());
}

export class WorkingConversationState {
  private topic: (DiscourseTopicSlot & { refreshedAtMs: number }) | null = null;
  private domain: (DiscourseDomainSlot & { refreshedAtMs: number }) | null = null;
  private candidateSet: (CandidateSetSlot & { refreshedAtMs: number }) | null = null;
  private interpretationHold: (InterpretationHoldSlot & { refreshedAtMs: number }) | null = null;
  private turn = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  beginUserTurn(): void {
    this.turn += 1;
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
    if (!episodeId.trim() || candidates.length < 2) return;
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

  /**
   * `exactlyOneNarrativePerson` is set only when this turn's local
   * qualifying name list has length 1 at the extraction site — never
   * inferred from peekTopic() (last-of-many also stores a single topic).
   * Orchestration may publish that name as conversational ledger focus.
   * This holder does not write the ledger.
   */
  noteNarrativeUtterance(text: string): { exactlyOneNarrativePerson: string | null } {
    const live = this.peekTopic();
    if (live && hasLiveTopicContinuation(text, live.displayName)) {
      if (isReferenceQuestion(text)) {
        this.refreshTopic();
        return { exactlyOneNarrativePerson: null };
      }
      this.appendTopicEvidence(text);
      return { exactlyOneNarrativePerson: null };
    }
    const items = extractNarrativeOperationalCandidates(text);
    if (items) {
      const liveSet = this.peekCandidateSet();
      if (liveSet && sameItemLists(liveSet.items, items)) this.refreshCandidateSet();
      else this.establishCandidateSet(null, items);
    }
    const names = qualifyingNarrativePersonNames(text);
    if (names.length === 1) {
      this.establishTopic(names[0], text);
      return { exactlyOneNarrativePerson: names[0] };
    }
    if (names.length > 0) {
      this.establishTopic(names[names.length - 1], text);
    }
    return { exactlyOneNarrativePerson: null };
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
