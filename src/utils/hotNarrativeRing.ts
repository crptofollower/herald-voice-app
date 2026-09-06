// src/utils/hotNarrativeRing.ts
// Step 5a: bounded RAM-only HOT narrative ring. Written ONLY from the three
// authorized Step 4 sites in ChatScreen (ephemeral success ×2, chit_chat read).
// NOT Memory, NOT authority, NOT durable. Peek semantics — never take-on-read.

export const HOT_RING_TTL_MS = 60 * 60 * 1000; // 1 hour per entry
export const HOT_RING_MAX_PAIRS = 3;
export const HOT_RING_MAX_INCLUDED_CHARS = 2400;

export type HotAssistantPolicy = 'include' | 'omit';

export type HotRingEntry = {
  /**
   * Monotonic per sendMessage turn. Used for ordering and for
   * hasImmediatelyAdjacentHotAuthorization's own strict single-step check.
   * A gap here (from a legitimate non-HOT-producing turn) does NOT invalidate
   * earlier bounded-recent entries at peek — see selectBoundedRecentHotSuffix.
   */
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

/**
 * Bounded-recent HOT suffix. Invariant: eligible HOT history is bounded by the
 * ring's own TTL (HOT_RING_TTL_MS) and count cap (HOT_RING_MAX_PAIRS) — both
 * already enforced upstream by evictStorage before this runs — NOT by whether
 * every intervening global conversation turn happened to also write a HOT
 * entry.
 *
 * A prior version required stored entries to be perfectly sequential by
 * turnIndex, stopping at the first missing index. That conflated two
 * different things: global turn adjacency (every turn in the whole
 * conversation, including ones that intentionally never write HOT — clarify,
 * capability/action turns) versus valid bounded HOT conversational-history
 * continuity (are these entries recent and few enough to still represent
 * "the recent conversation"). Since ordinary turns routinely do not push a
 * HOT entry by design, that rule silently discarded still-fresh, still
 * in-bounds history the instant one such turn occurred — proven in
 * HERALD_HOT_LIFECYCLE_REACHABILITY_DIAGNOSTIC_2026-09-05.md.
 *
 * Entries arrive here already TTL/count-bounded and turnIndex-ascending from
 * evictStorage, so returning them unchanged is already correct and bounded —
 * no additional index-adjacency requirement is needed or applied. This does
 * not make HOT unbounded or authoritative: it remains bounded by TTL and
 * count exactly as before, and admission (what gets pushed at all) is
 * completely untouched by this function.
 */
export function selectBoundedRecentHotSuffix(entries: HotRingEntry[]): HotRingEntry[] {
  return [...entries];
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
  /**
   * Peek — does not clear. Applies TTL, count, and char bounds. Does NOT
   * require global-turn-index adjacency — see selectBoundedRecentHotSuffix.
   */
  peek: (nowMs: number) => HotRingEntry[];
  clear: () => void;
  /**
   * Visibility into raw buffer after TTL/count storage eviction. Originally
   * test-only; also read by the bounded Gate A runtime diagnostic (ChatScreen)
   * to report a count-only rawEntryCount alongside peek's own count — never
   * entry content. Still no durable storage, no new write path.
   */
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
      const bounded = selectBoundedRecentHotSuffix(entries).slice(-HOT_RING_MAX_PAIRS);
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
