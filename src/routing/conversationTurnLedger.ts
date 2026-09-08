// src/routing/conversationTurnLedger.ts
// Conversation Continuity Contract V1 — Slice 1 (foundation) + Slice 3
// (domain semantic envelope carrier). Bounded RAM-only ledger of
// completed-turn evidence. NOT memory, NOT authority, NOT persistence.
// Mirrors hotNarrativeRing.ts's discipline exactly: append/peek/clear, TTL +
// count bounded, no durable storage API, no DB import, no write-authority
// type anywhere in this file.
//
// This module still has no READ consumer (that remains an unauthorized
// future slice). Slice 3 changes what this module is willing to STORE: it
// now accepts a caller-supplied `focus` array on push(), instead of always
// forcing it to []. This module remains domain-agnostic on purpose — it has
// no knowledge of IntentRecord, CommitResult, or any domain field name, and
// never computes `tier` itself. The authority-classification amendment
// (2026-09-xx, CTO ARCHITECTURAL AMENDMENT — AUTHORITY HAS ONE OWNER) puts
// that responsibility exclusively in conversationTurnLedgerWrite.ts's
// classifyFocusAuthority()/buildFocusEntry() — this module just stores
// whatever ConversationTurnFocusEntry[] it's given, append-only, same as it
// already stores utterance/operation/outcome without interpreting them.
//
// The structural guarantee that a domain cannot "supply" its own authority
// tier is a TYPE-LEVEL one, not a runtime-forcing one (unlike Slice 1/2's
// focus:[] forcing, which is no longer needed once tier has nowhere for a
// domain to smuggle it in from): DomainFocusEnvelope (conversationTurnLedgerWrite.ts)
// has no tier field at all. There is nothing to trust or distrust from the
// domain; buildFocusEntry() is the only function in the codebase that
// constructs a ConversationTurnFocusEntry's `tier`.

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
 * Semantic-focus authority tier. Assigned EXCLUSIVELY by
 * conversationTurnLedgerWrite.ts's classifyFocusAuthority() from objective
 * lifecycle facts (commit status, deterministic-vs-LLM source, presence of
 * a verified resolver key). A domain-produced DomainFocusEnvelope has no
 * field of this shape — there is no channel for a domain to supply, claim,
 * or influence its own tier. 'conversational' is reserved for the ephemeral/
 * chit-chat lifecycle path (Hook 4), which carries no domain envelope at
 * all and is unchanged by Slice 3/4.
 */
export type ConversationTurnFocusTier =
  | 'authoritative'
  | 'deterministic_unconfirmed'
  | 'llm_proposal'
  | 'conversational';

/**
 * What a completed/attempted turn was about, normalized. Mirrors
 * DomainFocusEnvelope's identity fields exactly (kind/displayValue/
 * resolverKey/referable/role — domain-owned) plus `tier` (glue-owned, see
 * above). `sourceIntentType` is deliberately NOT duplicated here — it's
 * already on the enclosing ConversationTurnRecord.intentType, one level up,
 * and every FocusEntry in a record's `focus` array belongs to that same
 * record's intent.
 */
export type ConversationTurnFocusEntry = {
  kind: 'person' | 'thing' | 'event' | 'collection' | 'item';
  displayValue: string;
  resolverKey?: string;
  referable: boolean;
  role?: 'primary' | 'secondary';
  tier: ConversationTurnFocusTier;
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
  /** 0 or more, per the record's own writer/read-dispatch call. Empty when
   *  the domain attached no envelope (legal — see conversationTurnLedgerWrite.ts) —
   *  same "missing focus stays legal" behavior Slice 2 already proved. */
  focus: ConversationTurnFocusEntry[];
};

/** Write sites supply `focus` as an already-built ConversationTurnFocusEntry[]
 *  (via conversationTurnLedgerWrite.ts's buildFocusEntry() — the only
 *  function that constructs one) or omit it, defaulting to []. This module
 *  does not interpret, validate, or compute `tier` — see module doc. */
export type NewConversationTurnRecord = Omit<ConversationTurnRecord, 'turnIndex' | 'focus'> & {
  focus?: ConversationTurnFocusEntry[];
};

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
        focus: record.focus ?? [],
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
