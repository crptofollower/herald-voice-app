/**
 * Call/Text authority-readiness helpers for the minimum graceful-recovery slice.
 * Not a completeness engine. Gaps: missing person, ambiguous person, missing
 * content, missing phone (SMS reachability). Structural genitive recovery and
 * relationship capture are out of scope.
 */

import type { PersonIdentityResolution } from '../db/contactsDB';
import { matchingCandidates, CONFIRM_YES_RE, CONFIRM_NO_RE } from './conversationSession';
import { proposeConstrainedCandidate } from './candidateConstrainedMatch';
import type { CommitResult } from './routeIntent';
import type { TierDecision } from './tierRouter';
import { normalizePhone } from '../utils/phone';
import { refineOsNameQuery, osNameFullyCovered } from '../utils/osContactDestination';
import { distinctiveNameTokens } from '../db/contactsDB';

export const CALL_TEXT_RECOVERY_KEY = 'call_text_recovery';
/** OS finite-candidate SMS pending. Not Herald identity. */
export const SMS_OS_DISAMBIGUATE_KEY = 'sms_disambiguate';
/** After first miss + chip offer, one more unresolved capture stops. OS path only. */
const OS_CAPTURE_STOP_AFTER = 3;
/**
 * ConversationSession empty-noop re-ask budget for Call/Text pending slots.
 * Not a clarification-turn cap and not the monotonic stop. Domain resume must
 * return pending/ready/ack — empty noop would still release after this many
 * unparsed turns. Keep at 1 so a true empty-noop cannot loop.
 */
export const RECOVERY_BUDGET = 1;
/** Initial pending: same session empty-noop budget as later recovery stages. */
const DEFAULT_RECOVERY_ASK_BUDGET = 1;

export type CallTextGap = 'missing_person' | 'ambiguous_person' | 'missing_content' | 'missing_phone';

export type CallTextTask = {
  action: 'sms' | 'call';
  /** Resolved display name, empty until identity is known. */
  contactName: string;
  message: string;
  candidateNames: string[];
  /** Spoken token that produced an ambiguous candidate set (e.g. "Mickey"). */
  spokenQuery?: string;
  /** Non-authoritative proposal from constrained repair; requires yes/no or a pick. */
  proposedNames?: string[];
  /** Consecutive candidate-set replies that did not narrow. */
  failedMatchTurns?: number;
  /** SMS only: Herald resolved this person but lacks phone reachability. */
  recipientKnown?: boolean;
  gap: CallTextGap;
  turnsAsked: number;
  /** SMS only: phone resolved during missing_phone repair (not Herald identity). */
  directPhone?: string;
};

const UNRESOLVED_PERSON_RE = /^(him|her|he|she|they|them|his|hers)$/i;

export function isUnresolvedPersonRef(token: string): boolean {
  return UNRESOLVED_PERSON_RE.test(token.trim());
}

export function missingPersonPrompt(action: 'sms' | 'call'): string {
  return action === 'sms' ? 'Who would you like me to text?' : 'Who do you mean?';
}

export function missingContentPrompt(person: string): string {
  return `What would you like me to tell ${person}?`;
}

export function missingPhonePrompt(name: string, knownPerson?: boolean): string {
  const who = name.trim() || 'them';
  if (knownPerson) {
    return `I know ${who} but I don't have a phone number for them. What's their number?`;
  }
  return `I don't have a number for ${who}. What's their number?`;
}

const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function pluralizeSpokenQuery(query: string): string {
  const q = query.trim();
  if (!q) return 'people';
  if (/s$/i.test(q)) return q;
  return `${q}s`;
}

export function ambiguousPersonPrompt(names: string[], spokenQuery?: string): string {
  const clean = names.map(n => n.trim()).filter(Boolean);
  if (clean.length === 2) return `Do you mean ${clean[0]} or ${clean[1]}?`;
  if (clean.length > 2) {
    const label = pluralizeSpokenQuery(spokenQuery ?? '');
    return `I found ${countWord(clean.length)} ${label}. Which one do you mean?`;
  }
  return 'Who do you mean?';
}

export const GRACEFUL_STOP_WHO =
  "I've lost who you mean. Want to start that one over?";

export const CAPTURE_FIRST_MISS =
  "I didn't catch that name clearly. Which one do you mean?";

export const CAPTURE_SECOND_MISS =
  "You can say it again, type the name, or tap the person below.";

/** Type-the-name escape when the retained task has no chip set. */
export const RECOVERY_TYPE_NAME_ESCAPE = 'You can type the name.';

export function promptForGap(task: CallTextTask): string {
  const proposed = (task.proposedNames ?? []).map(n => n.trim()).filter(Boolean);
  if (proposed.length === 1) return `Did you mean ${proposed[0]}?`;
  if (proposed.length === 2) return `Did you mean ${proposed[0]} or ${proposed[1]}?`;
  if (task.gap === 'missing_person') return missingPersonPrompt(task.action);
  if (task.gap === 'ambiguous_person') return ambiguousPersonPrompt(task.candidateNames, task.spokenQuery);
  if (task.gap === 'missing_phone') {
    return missingPhonePrompt(
      task.contactName || task.spokenQuery || '',
      task.recipientKnown === true,
    );
  }
  return missingContentPrompt(task.contactName || 'them');
}

/**
 * True when existing routing already claims this utterance as its own turn
 * (device action, device read, or live-data). Not a capability allowlist.
 */
export function routeClaimsSupersedingIntent(
  decision: Pick<TierDecision, 'actionIntent' | 'tier' | 'tier1Response' | 'reason'>,
): boolean {
  if (decision.actionIntent) return true;
  if (decision.tier === 1 && typeof decision.tier1Response === 'string') return true;
  if (decision.reason === 'live:data') return true;
  return false;
}

export function shouldPreemptCallTextRecovery(
  decision: Pick<TierDecision, 'actionIntent' | 'tier' | 'tier1Response' | 'reason'>,
  replyText: string,
  ownsReply: boolean,
): boolean {
  return routeClaimsSupersedingIntent(decision) && !ownsReply;
}

export type AdvanceResult =
  | { kind: 'ready'; task: CallTextTask }
  | { kind: 'pending'; task: CallTextTask; prompt: string; recoveryChoices?: string[] }
  | { kind: 'non_advance' }
  | { kind: 'stop'; ack: string };

type PersonProgress =
  | { kind: 'none' }
  | { kind: 'set'; names: string[] }
  | { kind: 'one'; name: string };

function personProgress(task: CallTextTask): PersonProgress {
  if (task.contactName.trim()) return { kind: 'one', name: task.contactName.trim() };
  const names = task.candidateNames.map(n => n.trim()).filter(Boolean);
  if (names.length >= 2) return { kind: 'set', names };
  return { kind: 'none' };
}

/**
 * True iff `next` is a deterministic strict improvement of `prev` on the
 * retained task: person evidence may only narrow (none → finite set → unique
 * name; a candidate set may only become a strict subset), and message may
 * only go from empty to supplied. Never widen, replace, or stay put.
 */
export function isMonotonicAdvance(prev: CallTextTask, next: CallTextTask): boolean {
  const prevMsg = prev.message.trim();
  const nextMsg = next.message.trim();
  if (prevMsg && nextMsg !== prevMsg) return false;
  const contentFilled = !prevMsg && !!nextMsg;

  const p = personProgress(prev);
  const n = personProgress(next);

  let personAdvanced = false;
  if (p.kind === 'none') {
    personAdvanced = n.kind === 'set' || n.kind === 'one';
  } else if (p.kind === 'set') {
    const prevSet = new Set(p.names);
    if (n.kind === 'one') personAdvanced = prevSet.has(n.name);
    else if (n.kind === 'set') {
      personAdvanced =
        n.names.length < p.names.length && n.names.every(name => prevSet.has(name));
    }
  } else {
    personAdvanced = false;
  }

  if (p.kind === 'one' && (n.kind !== 'one' || n.name !== p.name)) {
    const prevPhone = prev.directPhone?.trim();
    const nextPhone = next.directPhone?.trim();
    if (!prevPhone && nextPhone) personAdvanced = true;
    else return false;
  }
  if (p.kind === 'set' && n.kind === 'none') return false;

  const prevPhone = prev.directPhone?.trim();
  const nextPhone = next.directPhone?.trim();
  if (!prevPhone && nextPhone) personAdvanced = true;

  const prevProp = (prev.proposedNames ?? []).map(x => x.trim()).filter(Boolean);
  const nextProp = (next.proposedNames ?? []).map(x => x.trim()).filter(Boolean);
  const srcSet = new Set(
    (p.kind === 'set' ? p.names : prev.candidateNames).map(x => x.trim()),
  );
  if (
    nextProp.length >= 1 &&
    nextProp.length <= 2 &&
    nextProp.every(name => srcSet.has(name)) &&
    (prevProp.length === 0 || nextProp.length < prevProp.length || nextProp.join() !== prevProp.join())
  ) {
    personAdvanced = true;
  }

  return personAdvanced || contentFilled;
}

export function isPlausibleRecoveryReply(
  task: CallTextTask,
  userText: string,
  resolveIdentity: (raw: string) => PersonIdentityResolution,
): boolean {
  const trimmed = userText.trim();
  if (!trimmed) return false;
  if (task.gap === 'missing_content') return false;
  if ((task.proposedNames ?? []).length > 0) {
    if (CONFIRM_YES_RE.test(trimmed) || CONFIRM_NO_RE.test(trimmed)) return true;
  }
  const pool = (task.proposedNames?.length ? task.proposedNames : task.candidateNames) ?? [];
  if (task.gap === 'ambiguous_person' || pool.length >= 2) {
    if (candidateHits(trimmed, task.candidateNames).length > 0) return true;
  }
  if (task.gap === 'missing_person') {
    if (isUnresolvedPersonRef(trimmed)) return true;
    const identity = resolveIdentity(trimmed.replace(/[.,!?]+$/g, ''));
    return identity.status !== 'none';
  }
  if (task.gap === 'missing_phone') {
    const phoneMatch = trimmed.match(/([\d\s\-\(\)\+\.]{7,})/);
    if (phoneMatch && normalizePhone(phoneMatch[1]).valid) return true;
    const prior = task.spokenQuery?.trim() || task.contactName.trim();
    if (plausibleOsNameRefinement(prior, trimmed)) return true;
    const identity = resolveIdentity(trimmed.replace(/[.,!?]+$/g, ''));
    return identity.status !== 'none';
  }
  return false;
}

/** Clarification looks like a person-name refinement, not an unrelated command. */
function plausibleOsNameRefinement(prior: string, clarification: string): boolean {
  if (/\b(timer|alarm|minute|minutes|hour|hours|weather|calendar|remind|grocery|todo)\b/i.test(clarification)) {
    return false;
  }
  const osQuery = refineOsNameQuery(prior, clarification);
  if (!osQuery || osQuery === prior.trim()) return false;
  const priorTokens = distinctiveNameTokens(prior) ?? [];
  const queryTokens = distinctiveNameTokens(osQuery) ?? [];
  if (queryTokens.length === 0) return false;
  return priorTokens.length === 0 || priorTokens.every(t => queryTokens.includes(t));
}

function proposeOrReask(task: CallTextTask, trimmed: string): AdvanceResult {
  const proposal = proposeConstrainedCandidate(trimmed, task.candidateNames);
  if (proposal.kind === 'one') {
    return stopOrPending(task, 'ambiguous_person', {
      proposedNames: [proposal.name],
      failedMatchTurns: 0,
    });
  }
  if (proposal.kind === 'two') {
    return stopOrPending(task, 'ambiguous_person', {
      proposedNames: [...proposal.names],
      failedMatchTurns: 0,
    });
  }
  return captureRepairMiss(task);
}

/**
 * Genuine non-advance: keep the retained task and grounded fields.
 * Offer type/tap (or type-the-name) instead of destroying the slot or
 * asking the user to start over. Repeated holds stay on the same escape
 * prompt — two miss states, not an unbounded new-question ladder.
 */
export function holdUnresolvedRecovery(task: CallTextTask): AdvanceResult {
  const names = task.candidateNames.map(n => n.trim()).filter(Boolean);
  if (names.length >= 1) {
    return captureRepairMiss(task);
  }
  const fails = (task.failedMatchTurns ?? 0) + 1;
  const next: CallTextTask = {
    ...task,
    proposedNames: [],
    failedMatchTurns: fails,
    turnsAsked: task.turnsAsked + 1,
  };
  if (task.gap === 'missing_content') {
    return { kind: 'pending', task: next, prompt: promptForGap(next) };
  }
  return {
    kind: 'pending',
    task: next,
    prompt: fails >= 2 ? RECOVERY_TYPE_NAME_ESCAPE : promptForGap(next),
  };
}

function pendingHoldCommit(
  held: Extract<AdvanceResult, { kind: 'pending' }>,
  pendingKey: string,
  resume: (userText: string) => Promise<CommitResult>,
): CommitResult {
  return {
    status: 'pending',
    prompt: held.prompt,
    pendingKey,
    resume,
    reaskPrompt: held.prompt,
    budget: RECOVERY_BUDGET,
    releasePrompt: CAPTURE_SECOND_MISS,
    recoveryChoices: held.recoveryChoices,
  };
}

/** Capture Repair miss policy: keep the finite set, do not guess. */
export function captureRepairMiss(
  task: Pick<CallTextTask, 'candidateNames' | 'failedMatchTurns' | 'turnsAsked'> & Partial<CallTextTask>,
  stopAfter?: number,
): AdvanceResult {
  const fails = (task.failedMatchTurns ?? 0) + 1;
  const next: CallTextTask = {
    action: task.action ?? 'sms',
    contactName: task.contactName ?? '',
    message: task.message ?? '',
    candidateNames: task.candidateNames,
    spokenQuery: task.spokenQuery,
    proposedNames: [],
    failedMatchTurns: fails,
    gap: task.gap ?? 'ambiguous_person',
    turnsAsked: task.turnsAsked + 1,
  };
  const recoveryChoices = next.candidateNames.map(n => n.trim()).filter(Boolean);
  // stopAfter used to destroy the task (GRACEFUL_STOP_WHO). Continuity V1
  // keeps the resumable task and offers type/tap once misses reach 2.
  if (fails >= 2 || (stopAfter != null && fails >= stopAfter)) {
    return {
      kind: 'pending',
      task: next,
      prompt: recoveryChoices.length ? CAPTURE_SECOND_MISS : CAPTURE_FIRST_MISS,
      recoveryChoices: recoveryChoices.length ? recoveryChoices : undefined,
    };
  }
  return {
    kind: 'pending',
    task: next,
    prompt: CAPTURE_FIRST_MISS,
  };
}
function candidateHits(reply: string, names: string[]): string[] {
  return matchingCandidates(
    reply,
    names.map(n => ({ label: n, ref: n })),
  ).map(c => c.label);
}

function stopOrPending(task: CallTextTask, nextGap: CallTextGap, extra: Partial<CallTextTask>): AdvanceResult {
  const next: CallTextTask = {
    ...task,
    ...extra,
    gap: nextGap,
    turnsAsked: task.turnsAsked + 1,
  };
  // Continue only on monotonic deterministic progress. turnsAsked is
  // incremented for metrics; it does not cap the chain.
  if (!isMonotonicAdvance(task, next)) {
    return holdUnresolvedRecovery(task);
  }
  return { kind: 'pending', task: next, prompt: promptForGap(next) };
}

function afterPersonKnown(task: CallTextTask, contactName: string): AdvanceResult {
  if (task.action === 'sms' && !task.message.trim()) {
    return stopOrPending(task, 'missing_content', { contactName, candidateNames: [], proposedNames: [] });
  }
  const ready: CallTextTask = { ...task, contactName, candidateNames: [], proposedNames: [], gap: 'missing_content' };
  if (!isMonotonicAdvance(task, ready)) {
    return holdUnresolvedRecovery(task);
  }
  return { kind: 'ready', task: ready };
}

export type CallTextRecoveryOpts = {
  resolveOsPhone?: (query: string) => Promise<{ name: string; phone: string } | null>;
};

export async function tryOsRefinementAdvance(
  task: CallTextTask,
  userText: string,
  resolveOsPhone: (query: string) => Promise<{ name: string; phone: string } | null>,
): Promise<AdvanceResult | null> {
  if (task.gap !== 'missing_person' && task.gap !== 'missing_phone') return null;
  const trimmed = userText.trim();
  const prior = task.spokenQuery?.trim() || task.contactName.trim();
  const osQuery = refineOsNameQuery(prior, trimmed);
  if (!osQuery) return null;
  const device = await resolveOsPhone(osQuery);
  if (!device?.phone?.trim()) return null;
  if (!osNameFullyCovered(osQuery, device.name)) return null;
  const ready: CallTextTask = {
    ...task,
    contactName: device.name,
    directPhone: device.phone.replace(/\D/g, ''),
    candidateNames: [],
    proposedNames: [],
  };
  if (!isMonotonicAdvance(task, ready)) {
    return holdUnresolvedRecovery(task);
  }
  return { kind: 'ready', task: ready };
}

export function bindCallTextRecovery(
  initial: CallTextTask,
  resolveIdentity: (raw: string) => PersonIdentityResolution,
  onReady: (task: CallTextTask) => Promise<CommitResult>,
  opts?: CallTextRecoveryOpts,
): {
  prompt: string;
  pendingKey: string;
  budget: number;
  reaskPrompt: string;
  releasePrompt: string;
  resume: (userText: string) => Promise<CommitResult>;
  ownsReply: (userText: string) => boolean;
} {
  let task = { ...initial };
  const ownsReply = (userText: string) => isPlausibleRecoveryReply(task, userText, resolveIdentity);
  const resume = async (userText: string): Promise<CommitResult> => {
    let r = advanceCallTextTask(task, userText, resolveIdentity);
    if (r.kind === 'non_advance' && opts?.resolveOsPhone) {
      const os = await tryOsRefinementAdvance(task, userText, opts.resolveOsPhone);
      if (os) r = os;
    }
    // Non-advance is not a new clarification question. Hold the retained
    // task and offer type/tap (or type-the-name) instead of start-over.
    if (r.kind === 'non_advance' || r.kind === 'stop') {
      if (r.kind === 'non_advance'
        && task.gap === 'missing_phone'
        && task.action === 'sms'
        && task.message.trim()) {
        const reask = promptForGap(task);
        return {
          status: 'pending',
          prompt: reask,
          pendingKey: CALL_TEXT_RECOVERY_KEY,
          resume,
          reaskPrompt: reask,
          budget: RECOVERY_BUDGET,
          releasePrompt: CAPTURE_SECOND_MISS,
        };
      }
      r = holdUnresolvedRecovery(task);
    }
    if (r.kind === 'pending') {
      task = r.task;
      return pendingHoldCommit(r, CALL_TEXT_RECOVERY_KEY, resume);
    }
    return onReady(r.task);
  };
  const prompt = promptForGap(task);
  return {
    prompt,
    pendingKey: CALL_TEXT_RECOVERY_KEY,
    budget: DEFAULT_RECOVERY_ASK_BUDGET,
    reaskPrompt: prompt,
    releasePrompt: CAPTURE_SECOND_MISS,
    resume,
    ownsReply,
  };
}

export function advanceCallTextTask(
  task: CallTextTask,
  userText: string,
  resolveIdentity: (raw: string) => PersonIdentityResolution,
): AdvanceResult {
  const trimmed = userText.trim();
  if (!trimmed) return { kind: 'non_advance' };

  if (task.gap === 'missing_content') {
    if (isUnresolvedPersonRef(trimmed)) return { kind: 'non_advance' };
    const ready: CallTextTask = { ...task, message: trimmed };
    if (!isMonotonicAdvance(task, ready)) return { kind: 'non_advance' };
    return { kind: 'ready', task: ready };
  }

  if (task.gap === 'missing_phone') {
    const phoneMatch = trimmed.match(/([\d\s\-\(\)\+\.]{7,})/);
    if (phoneMatch) {
      const reCheck = normalizePhone(phoneMatch[1]);
      if (reCheck.valid) {
        const ready: CallTextTask = {
          ...task,
          directPhone: reCheck.normalized,
          contactName: task.contactName.trim() || task.spokenQuery?.trim() || 'them',
        };
        if (!isMonotonicAdvance(task, ready)) return { kind: 'non_advance' };
        return { kind: 'ready', task: ready };
      }
    }
    const identity = resolveIdentity(trimmed.replace(/[.,!?]+$/g, ''));
    if (identity.status === 'single') {
      return afterPersonKnown(task, identity.contact.name);
    }
    if (identity.status === 'ambiguous') {
      const names = identity.candidates.map(c => c.name).filter(Boolean);
      if (names.length >= 2) {
        return stopOrPending(task, 'ambiguous_person', { candidateNames: names, spokenQuery: trimmed });
      }
    }
    return { kind: 'non_advance' };
  }

  const proposed = (task.proposedNames ?? []).map(n => n.trim()).filter(Boolean);
  if (task.gap === 'ambiguous_person' && proposed.length > 0) {
    if (proposed.length === 1 && CONFIRM_YES_RE.test(trimmed)) {
      return afterPersonKnown({ ...task, proposedNames: [] }, proposed[0]);
    }
    if (CONFIRM_NO_RE.test(trimmed)) {
      return {
        kind: 'pending',
        task: { ...task, proposedNames: [], turnsAsked: task.turnsAsked + 1 },
        prompt: ambiguousPersonPrompt(task.candidateNames, task.spokenQuery),
      };
    }
    const proposedHits = candidateHits(trimmed, proposed);
    if (proposedHits.length === 1) return afterPersonKnown({ ...task, proposedNames: [] }, proposedHits[0]);
    const allHits = candidateHits(trimmed, task.candidateNames);
    if (allHits.length === 1) return afterPersonKnown({ ...task, proposedNames: [] }, allHits[0]);
    if (allHits.length >= 2 && allHits.length < task.candidateNames.length) {
      return stopOrPending(task, 'ambiguous_person', { candidateNames: allHits, proposedNames: [] });
    }
    return proposeOrReask({ ...task, proposedNames: [] }, trimmed);
  }

  if (task.gap === 'ambiguous_person') {
    const hits = candidateHits(trimmed, task.candidateNames);
    if (hits.length === 1) return afterPersonKnown(task, hits[0]);
    if (hits.length >= 2 && hits.length < task.candidateNames.length) {
      return stopOrPending(task, 'ambiguous_person', { candidateNames: hits, proposedNames: [] });
    }
    if (hits.length >= 2) return holdUnresolvedRecovery(task);
    return proposeOrReask(task, trimmed);
  }

  // missing_person
  if (isUnresolvedPersonRef(trimmed)) return { kind: 'non_advance' };
  const identity = resolveIdentity(trimmed.replace(/[.,!?]+$/g, ''));
  if (identity.status === 'none') return { kind: 'non_advance' };
  if (identity.status === 'ambiguous') {
    const names = identity.candidates.map(c => c.name).filter(Boolean);
    if (names.length < 2) return { kind: 'non_advance' };
    const spokenQuery = trimmed.replace(/[.,!?]+$/g, '');
    return stopOrPending(task, 'ambiguous_person', { candidateNames: names, spokenQuery });
  }
  return afterPersonKnown(task, identity.contact.name);
}

export type OsSmsCandidate = { name: string; phone: string };

function afterFiniteCandidatePicked(task: CallTextTask, contactName: string): AdvanceResult {
  const ready: CallTextTask = {
    ...task,
    contactName,
    candidateNames: [],
    proposedNames: [],
    failedMatchTurns: 0,
    gap: 'missing_content',
  };
  if (!isMonotonicAdvance(task, ready)) {
    return holdUnresolvedRecovery(task);
  }
  return { kind: 'ready', task: ready };
}

/**
 * Progressive recovery against a closed candidate-name list.
 * Unique pick / propose / miss copy only. Does not look up contacts.
 * `fullSetTokenHit: 'retain'` keeps the set when a shared token hits everyone
 * (CALL). SMS OS keeps `'stop'` (existing).
 */
export function advanceFiniteCandidateRecovery(
  task: CallTextTask,
  userText: string,
  opts?: {
    stopAfter?: number;
    fullSetTokenHit?: 'stop' | 'retain';
    /** CALL: unique any-token hit is not authority if exact matchCandidate already declined. */
    uniqueTokenHit?: 'authorize' | 'defer_miss';
  },
): AdvanceResult {
  const stopAfter = opts?.stopAfter;
  const fullSetTokenHit = opts?.fullSetTokenHit ?? 'stop';
  const uniqueTokenHit = opts?.uniqueTokenHit ?? 'authorize';
  const trimmed = userText.trim();
  if (!trimmed) return captureRepairMiss(task, stopAfter);

  const proposeOrReask = (from: CallTextTask): AdvanceResult => {
    const proposal = proposeConstrainedCandidate(trimmed, from.candidateNames);
    if (proposal.kind === 'one') {
      return stopOrPending(from, 'ambiguous_person', {
        proposedNames: [proposal.name],
        failedMatchTurns: 0,
      });
    }
    if (proposal.kind === 'two') {
      return stopOrPending(from, 'ambiguous_person', {
        proposedNames: [...proposal.names],
        failedMatchTurns: 0,
      });
    }
    return captureRepairMiss(from, stopAfter);
  };

  const takeUnique = (from: CallTextTask, name: string): AdvanceResult => {
    if (uniqueTokenHit === 'defer_miss') return proposeOrReask(from);
    return afterFiniteCandidatePicked(from, name);
  };

  const proposed = (task.proposedNames ?? []).map(n => n.trim()).filter(Boolean);
  if (proposed.length > 0) {
    if (proposed.length === 1 && CONFIRM_YES_RE.test(trimmed)) {
      return afterFiniteCandidatePicked({ ...task, proposedNames: [] }, proposed[0]);
    }
    if (CONFIRM_NO_RE.test(trimmed)) {
      return {
        kind: 'pending',
        task: { ...task, proposedNames: [], turnsAsked: task.turnsAsked + 1 },
        prompt: ambiguousPersonPrompt(task.candidateNames, task.spokenQuery),
      };
    }
    const proposedHits = candidateHits(trimmed, proposed);
    if (proposedHits.length === 1) {
      return afterFiniteCandidatePicked({ ...task, proposedNames: [] }, proposedHits[0]);
    }
    const allHits = candidateHits(trimmed, task.candidateNames);
    if (allHits.length === 1) return takeUnique({ ...task, proposedNames: [] }, allHits[0]);
    if (allHits.length >= 2 && allHits.length < task.candidateNames.length) {
      return stopOrPending(task, 'ambiguous_person', { candidateNames: allHits, proposedNames: [] });
    }
    return proposeOrReask({ ...task, proposedNames: [] });
  }

  if (CONFIRM_YES_RE.test(trimmed)) {
    const fails = task.failedMatchTurns ?? 0;
    if (fails >= 2) {
      return {
        kind: 'pending',
        task,
        prompt: CAPTURE_SECOND_MISS,
        recoveryChoices: task.candidateNames.map(n => n.trim()).filter(Boolean),
      };
    }
    return { kind: 'pending', task, prompt: promptForGap(task) };
  }

  const hits = candidateHits(trimmed, task.candidateNames);
  if (hits.length === 1) return takeUnique(task, hits[0]);
  if (hits.length >= 2 && hits.length < task.candidateNames.length) {
    return stopOrPending(task, 'ambiguous_person', { candidateNames: hits, proposedNames: [] });
  }
  if (hits.length >= 2) {
    if (fullSetTokenHit === 'retain') {
      return { kind: 'pending', task, prompt: promptForGap(task) };
    }
    return holdUnresolvedRecovery(task);
  }
  return proposeOrReask(task);
}

function advanceOsSmsDisambiguate(task: CallTextTask, userText: string): AdvanceResult {
  return advanceFiniteCandidateRecovery(task, userText, {
    stopAfter: OS_CAPTURE_STOP_AFTER,
    fullSetTokenHit: 'stop',
  });
}

/**
 * Capture Repair for a finite OS/device SMS candidate set.
 * Does not call Herald identity or completeReadySms. Unique pick uses
 * the phone already held for that listed row.
 */
export function bindOsFiniteSmsDisambiguate(
  initialCandidates: OsSmsCandidate[],
  message: string,
  spokenQuery: string,
  onPick: (person: OsSmsCandidate) => Promise<CommitResult>,
): {
  pendingKey: string;
  budget: number;
  reaskPrompt: string;
  releasePrompt: string;
  resume: (userText: string) => Promise<CommitResult>;
} {
  const phones = new Map<string, string>();
  for (const c of initialCandidates) {
    const name = c.name.trim();
    const phone = c.phone.replace(/\D/g, '');
    if (name && phone && !phones.has(name)) phones.set(name, phone);
  }
  let task: CallTextTask = {
    action: 'sms',
    contactName: '',
    message,
    candidateNames: [...phones.keys()],
    spokenQuery,
    gap: 'ambiguous_person',
    turnsAsked: 1,
    failedMatchTurns: 0,
  };

  const resume = async (userText: string): Promise<CommitResult> => {
    let r = advanceOsSmsDisambiguate(task, userText);
    if (r.kind === 'non_advance' || r.kind === 'stop') {
      r = holdUnresolvedRecovery(task);
    }
    if (r.kind === 'pending') {
      task = r.task;
      return pendingHoldCommit(r, SMS_OS_DISAMBIGUATE_KEY, resume);
    }
    const name = r.task.contactName.trim();
    const phone = phones.get(name);
    if (!phone) {
      return { status: 'failed', ack: `I don't have a number for ${name}. What's their number?` };
    }
    return onPick({ name, phone });
  };

  const names = [...phones.keys()].join(', ');
  return {
    pendingKey: SMS_OS_DISAMBIGUATE_KEY,
    budget: RECOVERY_BUDGET,
    reaskPrompt: `I'm not sure I caught that — which one did you mean: ${names}?`,
    releasePrompt: CAPTURE_SECOND_MISS,
    resume,
  };
}
