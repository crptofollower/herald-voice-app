// Correction Continuity V1. Closed repair marker, typed slot or one-span
// alignment, append-only read-time supersession. No model, no durable write.

import {
  CANCEL_RE,
  CONFIRM_NO_RE,
  CONFIRM_YES_RE,
  ConversationSession,
  extractCorrection,
  matchCandidateToken,
} from './conversationSession';
import type { ConversationTurnFocusEntry, ConversationTurnLedger, ConversationTurnRecord } from './conversationTurnLedger';
import { conversationalCorrectionRecord } from './conversationTurnLedgerWrite';
import { clarifySpeech, correctionSpeech } from './discourseCorrection';
import type { DiscourseMention } from './discourseContinuity';
import { establishHardPending } from './hardPendingBoundary';
import { breaksConversationalSegment, isTopicSuppressed } from './immediateSemanticRecap';
import { acknowledgeAct, clarifyReferenceAct, requestConfirmationAct, type ResponseAct } from './responseAct';
import { MONTHS, parseTimeFromText } from '../utils/parseTime';

export const CORRECTION_CONFIRM_KEY = 'correction:confirm';
export const CORRECTION_CLARIFY_KEY = 'correction:clarify';

const MARKER_LEAD_RE = /^(?:sorry|wait|no),\s+(.+)$/i;
const LEADING_COPULA_RE = /^(?:it'?s|i\s+meant)\s+/i;
const MAX_REMAINDER_WORDS = 12;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const RELATIVE_DAYS = ['today', 'tomorrow', 'yesterday', 'tonight'];
const HOUR_WORDS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'noon', 'midnight',
]);
const PRONOUNS = new Set([
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'we', 'us', 'our', 'ours', 'they', 'them', 'their', 'theirs', 'it', 'its',
]);

type TopicRef = { turnIndex: number; focusIndex: number };

type CorrectionPlan = {
  userText: string;
  speech: string;
  focus: ConversationTurnFocusEntry[];
  supersedes: TopicRef[];
  targetTurnIndex: number;
};

type CorrectionHold =
  | { kind: 'confirm'; plan: CorrectionPlan }
  | { kind: 'clarify'; options: { label: string; ref: string; plan: CorrectionPlan }[] };

const holds = new WeakMap<ConversationSession, CorrectionHold>();

export type CorrectionContinuityOutcome = {
  handled: true;
  source: 'correction_continuity';
  responseText: string;
  commits: [];
  responseAct?: ResponseAct;
  correctionHot?: { user: string; assistant: string };
};

type Token = { raw: string; norm: string; start: number; end: number };
type Slot = { entry: ConversationTurnFocusEntry; focusIndex: number; start: number; end: number; text: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\b[A-Za-z0-9]+(?:[:'][A-Za-z0-9]+)*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    tokens.push({
      raw: match[0],
      norm: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function cleanValue(raw: string): string | null {
  const value = raw.replace(LEADING_COPULA_RE, '').trim().replace(/[.?!]+$/u, '').trim();
  if (!value) return null;
  if (value.split(/\s+/).length > MAX_REMAINDER_WORDS) return null;
  if (CONFIRM_YES_RE.test(value) || CONFIRM_NO_RE.test(value) || CANCEL_RE.test(value)) return null;
  return value;
}

/** Closed self-repair marker. No marker means this turn is not a correction. */
export function extractSelfRepair(text: string): string | null {
  const trimmed = text.trim();
  const extracted = extractCorrection(trimmed);
  if (extracted) return cleanValue(extracted);
  const lead = MARKER_LEAD_RE.exec(trimmed);
  if (!lead) return null;
  return cleanValue(lead[1] ?? '');
}

function closedClass(raw: string): string | null {
  const norm = raw.toLowerCase();
  if ((MONTHS as readonly string[]).includes(norm)) return 'month';
  if (WEEKDAYS.includes(norm)) return 'weekday';
  if (RELATIVE_DAYS.includes(norm)) return 'relative_day';
  if (/^\d{1,2}(?:st|nd|rd|th)$/i.test(raw)) return 'ordinal';
  const clockShaped = (/[:\d]/.test(raw) && /am|pm|:/i.test(raw)) || HOUR_WORDS.has(norm);
  if (clockShaped && parseTimeFromText(raw)) return 'clock';
  if (/^\d+$/.test(raw)) return 'number';
  return null;
}

function closedTokens(value: string): Token[] {
  return tokenize(value).filter((token) => closedClass(token.raw));
}

function originalIdentity(entry: ConversationTurnFocusEntry, live: readonly ConversationTurnRecord[], fallback: TopicRef): TopicRef {
  for (const record of live) {
    const focusIndex = record.focus.indexOf(entry);
    if (focusIndex >= 0) return { turnIndex: record.turnIndex, focusIndex };
  }
  return fallback;
}

function overlapsMention(displayValue: string, span: [number, number], mention: DiscourseMention): boolean {
  const surface = mention.surfaceSpan;
  const at = displayValue.toLowerCase().indexOf(surface.toLowerCase());
  if (at >= 0 && at < span[1] && at + surface.length > span[0]) return true;
  if (mention.start < span[1] && mention.end > span[0] && mention.start < displayValue.length) {
    return displayValue.slice(mention.start, mention.end).toLowerCase() === surface.toLowerCase();
  }
  return false;
}

function slotIsIdentity(
  slotText: string,
  span: [number, number],
  displayValue: string,
  mentions: readonly DiscourseMention[],
  contacts: readonly string[],
): boolean {
  if (tokenize(slotText).some((token) => PRONOUNS.has(token.norm))) return true;
  const lower = slotText.trim().toLowerCase();
  if (contacts.some((contact) => contact.trim().toLowerCase() === lower)) return true;
  return mentions.some((mention) =>
    mention.kind === 'person'
    && mention.status !== 'corrected_away'
    && overlapsMention(displayValue, span, mention));
}

function valueIsIdentity(value: string, mentions: readonly DiscourseMention[], contacts: readonly string[]): boolean {
  if (tokenize(value).some((token) => PRONOUNS.has(token.norm))) return true;
  const lower = value.trim().toLowerCase();
  if (contacts.some((contact) => contact.trim().toLowerCase() === lower)) return true;
  return mentions.some((mention) =>
    mention.kind === 'person'
    && mention.status !== 'corrected_away'
    && mention.surfaceSpan.toLowerCase() === lower);
}

function keptMentionIds(
  entry: ConversationTurnFocusEntry,
  span: [number, number],
  mentions: readonly DiscourseMention[],
): string[] | undefined {
  const ids = entry.discourseMentionIds;
  if (!ids?.length) return undefined;
  const kept = ids.filter((id) => {
    const mention = mentions.find((item) => item.mentionId === id);
    if (!mention) return true;
    return !overlapsMention(entry.displayValue, span, mention);
  });
  return kept.length > 0 ? kept : undefined;
}

function alignSpan(target: string, value: string): { start: number; end: number; replacement: string } | null {
  const left = tokenize(target);
  const right = tokenize(value);
  if (left.length === 0 || right.length === 0) return null;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix]!.norm === right[prefix]!.norm) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix]!.norm === right[right.length - 1 - suffix]!.norm
  ) suffix += 1;
  const leftMid = left.length - prefix - suffix;
  const rightMid = right.length - prefix - suffix;
  if (leftMid < 1 || rightMid < 1 || prefix + suffix < 1) return null;
  const start = left[prefix]!.start;
  const end = left[left.length - suffix - 1]!.end;
  const replacement = value.slice(right[prefix]!.start, right[right.length - suffix - 1]!.end);
  if (!replacement.trim()) return null;
  return { start, end, replacement };
}

function isCapitalized(raw: string): boolean {
  return /^[A-Z][A-Za-z'’-]*$/.test(raw);
}

function capitalizedRuns(display: string): { text: string; start: number; end: number }[] {
  const tokens = tokenize(display);
  const runs: { text: string; start: number; end: number }[] = [];
  let index = 0;
  while (index < tokens.length) {
    if (!isCapitalized(tokens[index]!.raw)) {
      index += 1;
      continue;
    }
    const startIndex = index;
    while (index < tokens.length && isCapitalized(tokens[index]!.raw)) index += 1;
    const run = tokens.slice(startIndex, index);
    if (run.length < 1 || run.length > 3) continue;
    if (run.some((token) => closedClass(token.raw) || PRONOUNS.has(token.norm))) continue;
    const start = run[0]!.start;
    if (/^\s*$/.test(display.slice(0, start))) continue;
    const end = run[run.length - 1]!.end;
    runs.push({ text: display.slice(start, end), start, end });
  }
  return runs;
}

function isOpenValue(value: string): boolean {
  const tokens = tokenize(value);
  if (tokens.length < 1 || tokens.length > 3) return false;
  if (value.trim() !== tokens.map((token) => token.raw).join(' ')) return false;
  return tokens.every((token) => isCapitalized(token.raw) && !PRONOUNS.has(token.norm) && !closedClass(token.raw));
}

type Eligible = {
  record: ConversationTurnRecord;
  topics: { entry: ConversationTurnFocusEntry; focusIndex: number }[];
};

function eligibleTarget(
  live: readonly ConversationTurnRecord[],
  mentions: readonly DiscourseMention[],
): Eligible | null {
  const record = live[live.length - 1];
  if (!record) return null;
  if (record.operation !== 'conversational') return null;
  if (breaksConversationalSegment(record)) return null;
  const mentionStatus = mentions.map((mention) => ({ mentionId: mention.mentionId, status: mention.status }));
  const topics = record.focus
    .map((entry, focusIndex) => ({ entry, focusIndex }))
    .filter(({ entry }) =>
      entry.kind === 'topic'
      && entry.tier === 'conversational'
      && entry.referable
      && !isTopicSuppressed(entry, mentionStatus, live));
  if (topics.length === 0) return null;
  return { record, topics };
}

function buildPlan(
  eligible: Eligible,
  live: readonly ConversationTurnRecord[],
  slot: Slot,
  replacement: string,
  userText: string,
  mentions: readonly DiscourseMention[],
  contacts: readonly string[],
): CorrectionPlan | null {
  const span: [number, number] = [slot.start, slot.end];
  if (slotIsIdentity(slot.text, span, slot.entry.displayValue, mentions, contacts)) return null;
  const revisedText = `${slot.entry.displayValue.slice(0, slot.start)}${replacement}${slot.entry.displayValue.slice(slot.end)}`;
  if (revisedText === slot.entry.displayValue) return null;
  const identity = originalIdentity(slot.entry, live, { turnIndex: eligible.record.turnIndex, focusIndex: slot.focusIndex });
  const mentionIds = keptMentionIds(slot.entry, span, mentions);
  const carried: ConversationTurnFocusEntry = { ...slot.entry };
  delete carried.discourseMentionIds;
  const revised: ConversationTurnFocusEntry = {
    ...carried,
    displayValue: revisedText,
    ...(mentionIds ? { discourseMentionIds: mentionIds } : {}),
    derivedFrom: {
      turnIndex: identity.turnIndex,
      focusIndex: identity.focusIndex,
      span,
      replacement,
    },
  };
  const focus = eligible.record.focus.map((entry, index) => index === slot.focusIndex ? revised : entry);
  return {
    userText,
    speech: correctionSpeech('event_or_topic', replacement),
    focus,
    supersedes: [identity],
    targetTurnIndex: eligible.record.turnIndex,
  };
}

function classSlots(eligible: Eligible, valueClass: string): Slot[] {
  const slots: Slot[] = [];
  for (const topic of eligible.topics) {
    for (const token of tokenize(topic.entry.displayValue)) {
      if (closedClass(token.raw) !== valueClass) continue;
      slots.push({
        entry: topic.entry,
        focusIndex: topic.focusIndex,
        start: token.start,
        end: token.end,
        text: token.raw,
      });
    }
  }
  return slots;
}

function openSlots(eligible: Eligible, mentions: readonly DiscourseMention[], contacts: readonly string[]): Slot[] {
  const slots: Slot[] = [];
  for (const topic of eligible.topics) {
    for (const run of capitalizedRuns(topic.entry.displayValue)) {
      const span: [number, number] = [run.start, run.end];
      if (slotIsIdentity(run.text, span, topic.entry.displayValue, mentions, contacts)) continue;
      slots.push({
        entry: topic.entry,
        focusIndex: topic.focusIndex,
        start: run.start,
        end: run.end,
        text: run.text,
      });
    }
  }
  return slots;
}

function alignSlots(eligible: Eligible, value: string): Slot[] {
  const slots: Slot[] = [];
  for (const topic of eligible.topics) {
    const aligned = alignSpan(topic.entry.displayValue, value);
    if (!aligned) continue;
    slots.push({
      entry: topic.entry,
      focusIndex: topic.focusIndex,
      start: aligned.start,
      end: aligned.end,
      text: topic.entry.displayValue.slice(aligned.start, aligned.end),
      });
  }
  return slots;
}

type Planned =
  | { kind: 'apply'; plan: CorrectionPlan }
  | { kind: 'confirm'; plan: CorrectionPlan; prompt: string }
  | { kind: 'clarify'; options: { label: string; plan: CorrectionPlan }[]; prompt: string }
  | { kind: 'decline' };

function planCorrection(
  text: string,
  live: readonly ConversationTurnRecord[],
  mentions: readonly DiscourseMention[],
  contacts: readonly string[],
): Planned {
  const utterance = text.trim();
  const value = extractSelfRepair(utterance);
  if (!value) return { kind: 'decline' };
  const eligible = eligibleTarget(live, mentions);
  if (!eligible) return { kind: 'decline' };

  const aligned = alignSlots(eligible, value);
  if (aligned.length === 1) {
    const slot = aligned[0]!;
    if (slotIsIdentity(slot.text, [slot.start, slot.end], slot.entry.displayValue, mentions, contacts)) return { kind: 'decline' };
    const replacement = alignSpan(slot.entry.displayValue, value)?.replacement;
    if (!replacement) return { kind: 'decline' };
    const direct = buildPlan(eligible, live, slot, replacement, utterance, mentions, contacts);
    if (!direct) return { kind: 'decline' };
    return { kind: 'apply', plan: direct };
  }
  if (aligned.length > 1) return { kind: 'decline' };
  if (closedTokens(value).length >= 2) return { kind: 'decline' };

  const valueTokens = tokenize(value);
  const valueClass = valueTokens.length === 1 ? closedClass(valueTokens[0]!.raw) : null;
  if (valueClass) {
    const slots = classSlots(eligible, valueClass).filter((slot) =>
      !slotIsIdentity(slot.text, [slot.start, slot.end], slot.entry.displayValue, mentions, contacts));
    if (slots.length === 1) {
      const plan = buildPlan(eligible, live, slots[0]!, valueTokens[0]!.raw, utterance, mentions, contacts);
      return plan ? { kind: 'apply', plan } : { kind: 'decline' };
    }
    if (slots.length > 1) {
      const options = slots.flatMap((slot) => {
        const plan = buildPlan(eligible, live, slot, valueTokens[0]!.raw, utterance, mentions, contacts);
        return plan ? [{ label: slot.text, plan }] : [];
      });
      if (options.length <= 1) return { kind: 'decline' };
      return {
        kind: 'clarify',
        options,
        prompt: clarifySpeech('Which one should I correct:', options.map((option) => option.label)),
      };
    }
    return { kind: 'decline' };
  }

  if (!isOpenValue(value) || valueIsIdentity(value, mentions, contacts)) return { kind: 'decline' };
  const slots = openSlots(eligible, mentions, contacts);
  if (slots.length === 1) {
    const plan = buildPlan(eligible, live, slots[0]!, value, utterance, mentions, contacts);
    if (!plan) return { kind: 'decline' };
    return { kind: 'confirm', plan, prompt: `${value} instead of ${slots[0]!.text}?` };
  }
  if (slots.length > 1) {
    const options = slots.flatMap((slot) => {
      const plan = buildPlan(eligible, live, slot, value, utterance, mentions, contacts);
      return plan ? [{ label: slot.text, plan }] : [];
    });
    if (options.length <= 1) return { kind: 'decline' };
    return {
      kind: 'clarify',
      options,
      prompt: clarifySpeech('Which one should I correct:', options.map((option) => option.label)),
    };
  }
  return { kind: 'decline' };
}

function targetStillCurrent(ledger: ConversationTurnLedger, plan: CorrectionPlan): boolean {
  const live = ledger.peek(Date.now());
  return live[live.length - 1]?.turnIndex === plan.targetTurnIndex;
}

function applyPlan(ledger: ConversationTurnLedger, plan: CorrectionPlan, turnText: string): CorrectionContinuityOutcome | null {
  if (!targetStillCurrent(ledger, plan)) return null;
  ledger.push(conversationalCorrectionRecord({
    utterance: turnText,
    assistantReply: plan.speech,
    focus: plan.focus,
    supersedes: plan.supersedes,
  }));
  return {
    handled: true,
    source: 'correction_continuity',
    responseText: plan.speech,
    commits: [],
    responseAct: acknowledgeAct(plan.speech),
    correctionHot: { user: plan.userText, assistant: plan.speech },
  };
}

function releaseHold(session: ConversationSession): void {
  holds.delete(session);
  const key = session.peekPendingKey();
  if (key === CORRECTION_CONFIRM_KEY || key === CORRECTION_CLARIFY_KEY) session.clearPending();
}

function armHold(session: ConversationSession, key: string, hold: CorrectionHold, prompt: string): CorrectionContinuityOutcome {
  holds.set(session, hold);
  establishHardPending(session, {
    pendingKey: key,
    budget: 1,
    resume: async () => ({ status: 'noop', ack: '' }),
  });
  const responseAct = key === CORRECTION_CONFIRM_KEY
    ? requestConfirmationAct(prompt, key)
    : clarifyReferenceAct(prompt);
  return {
    handled: true,
    source: 'correction_continuity',
    responseText: prompt,
    commits: [],
    responseAct,
  };
}

/** Confirm and clarify yields. A non-matching reply releases and returns null. */
export function resolveCorrectionHold(
  text: string,
  session: ConversationSession,
  ledger: ConversationTurnLedger | null | undefined,
): CorrectionContinuityOutcome | null {
  const key = session.peekPendingKey();
  if (key !== CORRECTION_CONFIRM_KEY && key !== CORRECTION_CLARIFY_KEY) return null;
  const hold = holds.get(session);
  releaseHold(session);
  if (!hold || !ledger) return null;
  const trimmed = text.trim();
  if (hold.kind === 'confirm') {
    if (CONFIRM_NO_RE.test(trimmed)) {
      return {
        handled: true,
        source: 'correction_continuity',
        responseText: 'Okay.',
        commits: [],
        responseAct: acknowledgeAct('Okay.'),
      };
    }
    if (!CONFIRM_YES_RE.test(trimmed)) return null;
    return applyPlan(ledger, hold.plan, trimmed);
  }
  const matched = matchCandidateToken(trimmed, hold.options.map((option) => ({ label: option.label, ref: option.ref })));
  if (matched === 'none' || matched === 'ambiguous') return null;
  const chosen = hold.options.find((option) => option.ref === matched.ref);
  if (!chosen) return null;
  return applyPlan(ledger, chosen.plan, trimmed);
}

/** Runs only when nothing is pending. Decline returns null and leaves the turn on its existing path. */
export function admitCorrectionContinuity(input: {
  text: string;
  session: ConversationSession;
  ledger: ConversationTurnLedger;
  discourseMentions?: readonly DiscourseMention[];
  knownContacts?: readonly string[];
}): CorrectionContinuityOutcome | null {
  if (input.session.hasPending()) return null;
  const mentions = input.discourseMentions ?? [];
  const contacts = input.knownContacts ?? [];
  const planned = planCorrection(input.text, input.ledger.peek(Date.now()), mentions, contacts);
  if (planned.kind === 'decline') return null;
  if (planned.kind === 'apply') return applyPlan(input.ledger, planned.plan, input.text.trim());
  if (planned.kind === 'confirm') {
    return armHold(input.session, CORRECTION_CONFIRM_KEY, { kind: 'confirm', plan: planned.plan }, planned.prompt);
  }
  return armHold(
    input.session,
    CORRECTION_CLARIFY_KEY,
    {
      kind: 'clarify',
      options: planned.options.map((option, index) => ({
        label: option.label,
        ref: String(index),
        plan: option.plan,
      })),
    },
    planned.prompt,
  );
}
