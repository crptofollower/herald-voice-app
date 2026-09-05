// RAM-only Smooth MVP discourse continuity.
// Two independent slots. Never persisted. Never action/write authority.
// No entity IDs, phones, addresses, or mutation targets.

import { extractTitleCaseNameTokens } from '../utils/ephemeralSeam';
import {
  IMPERATIVE_ACTION_RE,
  LIST_ADD_SIGNALS,
  THIRD_PERSON_REFERENT_RE,
  TODO_ADD_SIGNALS,
} from '../utils/instructionSignals';
import { OPERATIONAL_ACQUISITION_SHAPE } from './operationalListContinuity';

export const DISCOURSE_TURN_TTL = 4;
export const DISCOURSE_WALL_MS = 10 * 60 * 1000;

export type DiscourseTopicSlot = {
  kind: 'person_mention';
  displayName: string;
  establishedAtTurn: number;
  refreshedAtTurn: number;
};

export type DiscourseDomainSlot = {
  kind: 'operational_list';
  domain: 'grocery' | 'todo';
  establishedAtTurn: number;
  refreshedAtTurn: number;
};

const TOPIC_LOOKUP_RE = /\bwho\s+(?:was|am|are)\s+i\s+talking\s+about\b/i;

export function qualifyingNarrativePersonNames(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (IMPERATIVE_ACTION_RE.test(t)) return [];
  if (TODO_ADD_SIGNALS.some((p) => p.test(t))) return [];
  if (LIST_ADD_SIGNALS.some((p) => p.test(t))) return [];
  if (OPERATIONAL_ACQUISITION_SHAPE.test(t)) return [];
  return extractTitleCaseNameTokens(t);
}

function isUnsafeTopicLabel(name: string): boolean {
  const n = name.trim();
  if (!n || n.length > 80) return true;
  if (/\d{5,}/.test(n)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(n)) return true;
  if (/@/.test(n)) return true;
  return false;
}

export class DiscourseContinuityHolder {
  private topic: (DiscourseTopicSlot & { refreshedAtMs: number }) | null = null;
  private domain: (DiscourseDomainSlot & { refreshedAtMs: number }) | null = null;
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
  }

  peekTopic(): DiscourseTopicSlot | null {
    this.expireStale();
    if (!this.topic) return null;
    const { refreshedAtMs: _ms, ...slot } = this.topic;
    return slot;
  }

  peekDomain(): DiscourseDomainSlot | null {
    this.expireStale();
    if (!this.domain) return null;
    const { refreshedAtMs: _ms, ...slot } = this.domain;
    return slot;
  }

  establishTopic(displayName: string): void {
    const name = displayName.trim();
    if (isUnsafeTopicLabel(name)) return;
    const at = this.now();
    this.topic = {
      kind: 'person_mention',
      displayName: name,
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

  establishDomain(domain: 'grocery' | 'todo'): void {
    const at = this.now();
    this.domain = {
      kind: 'operational_list',
      domain,
      establishedAtTurn: this.turn,
      refreshedAtTurn: this.turn,
      refreshedAtMs: at,
    };
  }

  noteNarrativeUtterance(text: string): void {
    const names = qualifyingNarrativePersonNames(text);
    if (names.length > 0) {
      this.establishTopic(names[names.length - 1]);
      return;
    }
    if (this.peekTopic() && (THIRD_PERSON_REFERENT_RE.test(text) || TOPIC_LOOKUP_RE.test(text))) {
      this.refreshTopic();
    }
  }

  private expireStale(): void {
    const now = this.now();
    if (this.topic && this.isExpired(this.topic.refreshedAtTurn, this.topic.refreshedAtMs, now)) {
      this.topic = null;
    }
    if (this.domain && this.isExpired(this.domain.refreshedAtTurn, this.domain.refreshedAtMs, now)) {
      this.domain = null;
    }
  }

  private isExpired(refreshedAtTurn: number, refreshedAtMs: number, now: number): boolean {
    return (this.turn - refreshedAtTurn) > DISCOURSE_TURN_TTL
      || (now - refreshedAtMs) > DISCOURSE_WALL_MS;
  }
}
