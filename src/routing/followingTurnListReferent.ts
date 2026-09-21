// Following-turn List Referent Mutation V1.
// Mutation-scoped bare referents resolve against existing RAR committed-add
// evidence, then hand resolved bodies to existing list_update / list_remove.
// Not a writer. Not a second recent-action store. Not a global that/those binder.

import type { ConversationTurnRecord } from './conversationTurnLedger';
import {
  isAddShapedOperationalDemonstrative,
  isBareUnresolvedListReferent,
} from './operationalListContinuity';
import { findMostRecentCommittedAdd } from './recentActionRecall';
import { LIST_ADD_SIGNALS } from '../utils/instructionSignals';

const SINGULAR_REFERENT_RE = /^(?:that|it|this)$/i;
const PLURAL_REFERENT_RE = /^(?:those|them|these)$/i;

function referentNumber(token: string): 'singular' | 'plural' | null {
  if (SINGULAR_REFERENT_RE.test(token)) return 'singular';
  if (PLURAL_REFERENT_RE.test(token)) return 'plural';
  return null;
}

export type FollowingTurnListReferent =
  | { kind: 'not_this_act' }
  | {
      kind: 'fail_closed';
      reason:
        | 'no_qualifying_add'
        | 'ambiguous_singular'
        | 'unresolved_replacement'
        | 'no_unique_replace';
    }
  | { kind: 'replace'; oldItem: string; newItem: string; listName: string }
  | { kind: 'remove'; item: string; listName: string };

type MutationScopedReferent =
  | { kind: 'replace'; number: 'singular' | 'plural'; newItem: string }
  | { kind: 'remove'; number: 'singular' | 'plural' };

function normalizeMutationUtterance(text: string): string {
  return text
    .trim()
    .replace(/[?!.,]+$/g, '')
    .trim();
}

function stripDiscoursePrefix(text: string): string {
  return text
    .replace(/^(?:(?:so|um+|uh+|actually)[,]?\s+)+/i, '')
    .replace(/^(?:can\s+you|could\s+you)\s+/i, '')
    .replace(/^please\s+/i, '')
    .trim();
}

function stripOptionalListTail(item: string): string {
  return item
    .trim()
    .replace(/\s+on\s+(?:my\s+|the\s+)?(?:\w+\s+)?list$/i, '')
    .replace(/[?!.,]+$/g, '')
    .trim();
}

function classifyMutationScopedReferent(text: string): MutationScopedReferent | null {
  const t = stripDiscoursePrefix(normalizeMutationUtterance(text));
  if (!t) return null;
  if (LIST_ADD_SIGNALS.some((p) => p.test(t)) || isAddShapedOperationalDemonstrative(t)) {
    return null;
  }

  const change = t.match(
    /^(?:change|update|replace)\s+(that|it|this|those|them|these)\s+(?:to|with)\s+(.+)$/i,
  );
  if (change) {
    const referent = change[1] ?? '';
    const newItem = stripOptionalListTail(change[2] ?? '');
    if (!newItem) return null;
    const number = referentNumber(referent);
    if (!number) return null;
    return {
      kind: 'replace',
      number,
      newItem,
    };
  }

  const make = t.match(/^make\s+(that|it|this)\s+(.+)$/i);
  if (make) {
    const newItem = stripOptionalListTail(make[2] ?? '');
    if (!newItem) return null;
    return { kind: 'replace', number: 'singular', newItem };
  }

  const takeOff = t.match(
    /^(?:take|remove)\s+(that|it|this|those|them|these)\s+(?:off|from)(?:\s+(?:of\s+)?(?:my\s+|the\s+)?(?:\w+\s+)?list)?$/i,
  );
  if (takeOff) {
    const referent = takeOff[1] ?? '';
    const number = referentNumber(referent);
    if (!number) return null;
    return { kind: 'remove', number };
  }

  const deleteBare = t.match(
    /^(?:delete|cross\s+off)\s+(that|it|this|those|them|these)(?:\s+(?:from|off)\s+(?:my\s+|the\s+)?(?:\w+\s+)?list)?$/i,
  );
  if (deleteBare) {
    const number = referentNumber(deleteBare[1] ?? '');
    if (!number) return null;
    return { kind: 'remove', number };
  }

  return null;
}

function listNameFromAddRecord(record: ConversationTurnRecord): string {
  const collection = record.focus.find((entry) => entry.kind === 'collection');
  const raw = collection?.displayValue.trim().toLowerCase() ?? '';
  const name = raw.replace(/\s+list$/i, '').trim();
  if (name === 'todo' || name === 'todos' || name === 'to-do') return 'todos';
  if (name) return name;
  if ((record.intentType ?? '').toLowerCase() === 'todo_add') return 'todos';
  return 'grocery';
}

function joinCommittedItems(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function followingTurnListReferentFailClosedSpeech(
  reason: Extract<FollowingTurnListReferent, { kind: 'fail_closed' }>['reason'],
): string {
  if (reason === 'ambiguous_singular' || reason === 'no_unique_replace') {
    return "I couldn't tell which item you meant.";
  }
  return "I don't see that on your grocery list.";
}

/**
 * Resolve a following-turn replace/remove bare referent against the newest
 * qualifying committed list-add. Named mutations are not this act.
 */
export function bindFollowingTurnListReferent(
  text: string,
  entries: ConversationTurnRecord[],
): FollowingTurnListReferent {
  const scoped = classifyMutationScopedReferent(text);
  if (!scoped) return { kind: 'not_this_act' };

  const evidence = findMostRecentCommittedAdd(entries);
  if (!evidence) return { kind: 'fail_closed', reason: 'no_qualifying_add' };

  const listName = listNameFromAddRecord(evidence.record);
  const items = evidence.items.filter((item) => item.trim().length > 0);
  if (items.length === 0) return { kind: 'fail_closed', reason: 'no_qualifying_add' };

  if (scoped.kind === 'replace') {
    if (isBareUnresolvedListReferent(scoped.newItem)) {
      return { kind: 'fail_closed', reason: 'unresolved_replacement' };
    }
    if (scoped.number === 'plural') {
      return { kind: 'fail_closed', reason: 'no_unique_replace' };
    }
    if (items.length !== 1) {
      return { kind: 'fail_closed', reason: 'ambiguous_singular' };
    }
    return {
      kind: 'replace',
      oldItem: items[0]!,
      newItem: scoped.newItem,
      listName,
    };
  }

  if (scoped.number === 'singular') {
    if (items.length !== 1) {
      return { kind: 'fail_closed', reason: 'ambiguous_singular' };
    }
    return { kind: 'remove', item: items[0]!, listName };
  }

  // Plural remove: the committed set is the unique mapping. No subset guess.
  return { kind: 'remove', item: joinCommittedItems(items), listName };
}
