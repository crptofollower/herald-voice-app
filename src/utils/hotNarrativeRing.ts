// src/utils/hotNarrativeRing.ts
// Step 5a: bounded RAM-only HOT narrative ring. Written ONLY from the three
// authorized Step 4 sites in ChatScreen (ephemeral success ×2, chit_chat read).
// NOT Memory, NOT authority, NOT durable. Peek semantics — never take-on-read.

export const HOT_RING_TTL_MS = 60 * 60 * 1000; // 1 hour per entry
export const HOT_RING_MAX_PAIRS = 3;
export const HOT_RING_MAX_INCLUDED_CHARS = 2400;

export type HotAssistantPolicy = 'include' | 'omit';

export type HotRingEntry = {
  /** Monotonic per sendMessage turn — proves adjacency; gaps break contiguity. */
  turnIndex: number;
  user: string;
  assistant: string;
  establishedAt: number;
  assistantHotPolicy: HotAssistantPolicy;
};

/** Reuse RouteDecision / tierRouter trust-critical classification — no new domain list. */
export function hotAssistantPolicyForDeviceRead(
  reason: string,
  isMedical?: boolean,
): HotAssistantPolicy {
  if (isMedical) return 'omit';
  if (reason.startsWith('chit_chat:')) return 'include';
  return 'omit';
}

function includedCharCount(entry: HotRingEntry): number {
  let n = entry.user.length;
  if (entry.assistantHotPolicy === 'include') n += entry.assistant.length;
  return n;
}

/**
 * Step 5a turn-entry authorization: true when peek holds an authorized entry for
 * the literal immediately preceding turnIndex. NOT ring-non-empty; gaps fail closed.
 */
export function hasImmediatelyAdjacentHotAuthorization(
  peekedEntries: HotRingEntry[],
  currentTurnIndex: number,
): boolean {
  return peekedEntries.some((e) => e.turnIndex === currentTurnIndex - 1);
}

/** Contiguous suffix from the highest turnIndex — stops at first missing turnIndex. */
export function selectContiguousHotSuffix(entries: HotRingEntry[]): HotRingEntry[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => a.turnIndex - b.turnIndex);
  const suffix: HotRingEntry[] = [];
  let expected = sorted[sorted.length - 1]!.turnIndex;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const e = sorted[i]!;
    if (e.turnIndex === expected) {
      suffix.unshift(e);
      expected--;
    } else if (e.turnIndex < expected) {
      break;
    }
  }
  return suffix;
}

function applyCharBound(entries: HotRingEntry[]): HotRingEntry[] {
  let trimmed = [...entries];
  while (trimmed.length > 0) {
    let total = 0;
    for (const e of trimmed) total += includedCharCount(e);
    if (total <= HOT_RING_MAX_INCLUDED_CHARS) break;
    trimmed.shift();
  }
  return trimmed;
}

export type HotNarrativeRing = {
  push: (entry: HotRingEntry) => void;
  /** Peek — does not clear. Applies TTL, contiguity, count, and char bounds. */
  peek: (nowMs: number) => HotRingEntry[];
  clear: () => void;
  /** Test-only visibility into raw buffer after TTL/count storage eviction. */
  _rawEntries: () => HotRingEntry[];
};

export function createHotNarrativeRing(): HotNarrativeRing {
  let entries: HotRingEntry[] = [];

  function evictStorage(nowMs: number): void {
    entries = entries.filter((e) => nowMs - e.establishedAt <= HOT_RING_TTL_MS);
    entries.sort((a, b) => a.turnIndex - b.turnIndex);
    while (entries.length > HOT_RING_MAX_PAIRS) {
      entries.shift();
    }
  }

  return {
    push(entry: HotRingEntry) {
      entries.push(entry);
      evictStorage(entry.establishedAt);
    },
    peek(nowMs: number) {
      evictStorage(nowMs);
      const contiguous = selectContiguousHotSuffix(entries);
      const bounded = contiguous.slice(-HOT_RING_MAX_PAIRS);
      return applyCharBound(bounded);
    },
    clear() {
      entries = [];
    },
    _rawEntries() {
      return [...entries];
    },
  };
}
