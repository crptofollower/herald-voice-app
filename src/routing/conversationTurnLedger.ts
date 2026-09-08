// src/routing/conversationTurnLedger.ts
// Conversation Continuity Contract V1 — Slice 1 (foundation only).
// Bounded RAM-only ledger of completed-turn evidence. NOT memory, NOT
// authority, NOT persistence. Mirrors hotNarrativeRing.ts's discipline
// exactly: append/peek/clear, TTL + count bounded, no durable storage API,
// no DB import, no write-authority type anywhere in this file.
//
// This module has no consumers yet (Slice 3+ only, not authorized this
// session). Slice 2 wires additive writes into it from existing lifecycle
// seams; nothing reads from it yet, and nothing existing changes behavior
// because of its presence.
//
// Scope note (see HERALD session report for full detail): `focus` and
// `committedRef` are part of the schema — per explicit CTO direction to
// preserve the ledger representation for a later bounded-semantic-fallback
// read side — but are NEVER populated by Slice 2's write hooks. Generic
// *lifecycle* coverage (did a meaningful turn happen, and how did it
// resolve) is a materially different, and materially easier, problem than
// generic *semantic focus extraction* (what/who was this turn about). This
// module and Slice 2's hooks solve only the former. Solving the latter
// would require a per-IntentRecord-variant field mapping (drug vs
// doctor_name vs name vs condition vs body vs items[] — there is no shared
// field across the 15 IntentRecord variants), which is exactly the "switch
// moved into a helper" anti-pattern the CTO's critical requirement forbids
// building silently. It is not implemented here.

export const CONVERSATION_TURN_LEDGER_MAX_RECORDS = 12;
export const CONVERSATION_TURN_LEDGER_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const CONVERSATION_TURN_UTTERANCE_MAX_CHARS = 400;
export const CONVERSATION_TURN_REPLY_SUMMARY_MAX_CHARS = 200;

export type ConversationTurnOperation =
  | 'capture'
  | 'read'
  | 'action'
  | 'clarify_request'
  | 'clarify_resolution'
  | 'conversational';

export type ConversationTurnOutcome =
  | 'committed'
  | 'pending'
  | 'presented'
  | 'declined'
  | 'failed'
  | 'clarified'
  | 'generated';

export type ConversationTurnAuthorityTier =
  | 'deterministic'
  | 'llm_proposal'
  | 'conversational';

/**
 * Reserved for a later, not-yet-authorized read-side slice. Never populated
 * by Slice 2. Kept in the schema only because the CTO's architectural
 * amendment explicitly requires the ledger representation to be able to
 * carry bounded-semantic-fallback evidence later without a breaking schema
 * change.
 */
export type ConversationTurnFocusEntry = {
  kind: string;
  displayName: string;
  resolverKey?: string;
};

export type ConversationTurnRecord = {
  /** Ledger's own monotonic push sequence. NOT the UI's turnIndexRef in
   *  ChatScreen.tsx — no existing call site threads a UI turn index into
   *  processUtterance/applyIntents, and adding one is out of Slice 2's
   *  additive-only scope. See report for detail. */
  turnIndex: number;
  establishedAt: number;
  /** Bounded, verbatim user text. Evidence only — never replayed as fact. */
  utterance: string;
  /** Raw IntentRecord['type'] passthrough when known (e.g. 'medical_capture',
   *  'list_add'), else null. Deliberately NOT a grouped domain taxonomy —
   *  see module doc. Zero enumeration: this is a straight field copy. */
  intentType: string | null;
  operation: ConversationTurnOperation;
  outcome: ConversationTurnOutcome;
  authorityTier: ConversationTurnAuthorityTier;
  /** Bounded assistant-facing text (ack/response/reply), when available at
   *  the write site. Evidence only — never authoritative. */
  assistantReplySummary: string | null;
  /** ALWAYS [] at Slice 1/2. See module doc. */
  focus: ConversationTurnFocusEntry[];
  /** NEVER populated at Slice 1/2. See module doc. */
  committedRef?: { table: string; id: string };
};

/** Slice 2 write sites may not supply `focus` or `committedRef` — push()
 *  always sets them to their Slice-1/2 fixed values ([] and undefined) so
 *  it is structurally impossible for a call site to smuggle either in. */
export type NewConversationTurnRecord = Omit<
  ConversationTurnRecord,
  'turnIndex' | 'focus' | 'committedRef'
>;

function boundText(text: string, maxChars: number): string {
  const t = text.trim();
  return t.length > maxChars ? t.slice(0, maxChars) : t;
}

export type ConversationTurnLedger = {
  /** Append-only. Assigns turnIndex, applies TTL/count eviction. */
  push: (record: NewConversationTurnRecord) => ConversationTurnRecord;
  /** Peek — evicts stale entries as a side effect (matches
   *  hotNarrativeRing's push/peek-driven eviction discipline exactly), does
   *  not otherwise mutate. */
  peek: (nowMs: number) => ConversationTurnRecord[];
  /** Deterministic full reset. Not wired to any production clear-on-emergency
   *  call site yet (Slice 2 does not touch Law 0 handling) — available and
   *  independently tested per the Slice 1 requirement. */
  clear: () => void;
  /** Visibility into the raw buffer after TTL/count eviction — count/shape
   *  only, mirrors hotNarrativeRing's _rawEntries. */
  _rawEntries: () => ConversationTurnRecord[];
};

export function createConversationTurnLedger(): ConversationTurnLedger {
  let entries: ConversationTurnRecord[] = [];
  let sequence = 0;

  function evictStorage(nowMs: number): void {
    entries = entries.filter((e) => nowMs - e.establishedAt <= CONVERSATION_TURN_LEDGER_TTL_MS);
    while (entries.length > CONVERSATION_TURN_LEDGER_MAX_RECORDS) {
      entries.shift();
    }
  }

  return {
    push(record: NewConversationTurnRecord): ConversationTurnRecord {
      sequence += 1;
      const full: ConversationTurnRecord = {
        ...record,
        turnIndex: sequence,
        utterance: boundText(record.utterance, CONVERSATION_TURN_UTTERANCE_MAX_CHARS),
        assistantReplySummary:
          record.assistantReplySummary != null
            ? boundText(record.assistantReplySummary, CONVERSATION_TURN_REPLY_SUMMARY_MAX_CHARS)
            : null,
        focus: [],
        committedRef: undefined,
      };
      entries.push(full);
      evictStorage(full.establishedAt);
      return full;
    },
    peek(nowMs: number): ConversationTurnRecord[] {
      evictStorage(nowMs);
      return [...entries];
    },
    clear(): void {
      entries = [];
    },
    _rawEntries(): ConversationTurnRecord[] {
      return [...entries];
    },
  };
}
