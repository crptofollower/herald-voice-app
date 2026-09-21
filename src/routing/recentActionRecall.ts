// Recent Action Recall V1.
// Semantic request for the most recent successfully committed list-add.
// Item names come exclusively from ledger committed-item evidence.

import type { ConversationTurnFocusEntry, ConversationTurnRecord } from './conversationTurnLedger';
import { realizeRecentAddRecallAct } from '../conversation/recentAddRecallRealization';

function normalizeRecallUtterance(text: string): string {
  return text
    .replace(/\b(what|which)'d\b/gi, '$1 did')
    .trim()
    .replace(/[?!.,]+$/g, '')
    .trim();
}

// Add-act class: first-person interrogative whose object is an add/put
// operation. The addressee-commission slot is optional — "I added" and
// "I asked/told/wanted/needed/had you (to) add" are the same act
// (recalling a recently commissioned add), not separate phrase lists.
// Recap without an add/put verb ("what did I tell you") is not this class;
// "what is on my list" is current-state list read.
const COMMISSIONED_ADDRESSEE =
  '(?:(?:ask(?:ed)?|t(?:ell|old)|want(?:ed)?|need(?:ed)?|have|had)\\s+you\\s+(?:to\\s+)?)';
const ADD_OR_PUT =
  '(?:add(?:ed)?|put(?:ting)?(?:\\s+on(?:\\s+(?:the|my)(?:\\s+\\S+){0,2}?\\s+list)?)?)';
const DISCOURSE_PREFIX =
  '^(?:so[,]?\\s+)?(?:um+[,]?\\s+|uh+[,]?\\s+)?(?:can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+)?(?:please\\s+)?';

const RECENT_ADD_RE = new RegExp(
  DISCOURSE_PREFIX +
    '(?:what|which)(?:\\s+\\S+){0,3}?\\s+(?:did|was)\\s+i\\s+(?:just\\s+)?' +
    COMMISSIONED_ADDRESSEE + '?' +
    ADD_OR_PUT +
    '\\b',
  'i',
);

const LAST_ADDED_RE = new RegExp(
  DISCOURSE_PREFIX +
    'what\\s+was\\s+the\\s+last\\s+thing\\s+i\\s+(?:just\\s+)?' +
    COMMISSIONED_ADDRESSEE + '?' +
    'add(?:ed)?\\b',
  'i',
);

export function classifyRecentCommittedAddRecall(text: string): boolean {
  const t = normalizeRecallUtterance(text);
  if (!t) return false;
  return RECENT_ADD_RE.test(t) || LAST_ADDED_RE.test(t);
}

export type RecentCommittedAddEvidence = {
  record: ConversationTurnRecord;
  items: string[];
};

function committedItemNames(focus: ConversationTurnFocusEntry[]): string[] {
  return focus
    .filter((entry) => entry.kind === 'item' && entry.displayValue.trim().length > 0)
    .map((entry) => entry.displayValue);
}

export function isQualifyingCommittedAdd(record: ConversationTurnRecord): boolean {
  return record.outcome === 'committed' && committedItemNames(record.focus).length > 0;
}

export function findMostRecentCommittedAdd(
  entries: ConversationTurnRecord[],
): RecentCommittedAddEvidence | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const record = entries[i]!;
    if (!isQualifyingCommittedAdd(record)) continue;
    return { record, items: committedItemNames(record.focus) };
  }
  return null;
}

export type RecentAddRecallOutcome =
  | { handled: true; responseText: string; evidence: RecentCommittedAddEvidence }
  | { handled: false };

export function answerRecentCommittedAddRecall(
  text: string,
  entries: ConversationTurnRecord[],
): RecentAddRecallOutcome {
  if (!classifyRecentCommittedAddRecall(text)) return { handled: false };
  const evidence = findMostRecentCommittedAdd(entries);
  if (!evidence) return { handled: false };
  const responseText = realizeRecentAddRecallAct({ kind: 'added', items: evidence.items });
  if (!responseText) return { handled: false };
  return { handled: true, responseText, evidence };
}
