// DD-3 (PENDING_UNIFICATION spec): the calendar write core + collect-slot
// builder, extracted from ChatScreen so the D-2 fence (cancel during collect
// never writes) is contract-testable headless. Write function is injectable
// for tests. UI (ChatScreen) adapts: speaks prompts, arms the session.
import * as Calendar from 'expo-calendar';
import type { CommitResult } from './routeIntent';
import type { ConversationSession } from './conversationSession';
import { parseTimeFromText, parseDatePhrase } from '../utils/parseTime';
import { refreshCalendarCache } from '../db/calendarCacheDB';
import { markCalendarWrite } from '../db/calendarState';
import { addAppointment } from '../db/appointmentsDB';

const TIME_RE = /^\d{1,2}:\d{2}$/;

// Leading-anchored cancel for the collect stages ONLY. The title stage
// accepts arbitrary text verbatim, so trailing-word cancels ("never mind,
// cancel that") must be caught here or they become committed event titles
// (D-2). Scoped here deliberately — the global CANCEL_RE stays fully
// anchored (C-J lesson). Bare "stop" excluded so titles like "Stop & Shop
// run" survive; standalone "stop" is still caught by the global anchor.
const COLLECT_CANCEL_RE = /^\s*(never\s*mind|nevermind|cancel|forget\s+it|scratch\s+that)\b/i;
const COLLECT_CANCEL_ACK = "No problem — I won't put anything on your calendar.";

// Never throws through the conversation pipeline — permission/no-calendar/
// bad-date all return {status:'failed'} for the caller to speak.
export async function writeCalendarCore(title: string, dateStr: string, timeStr: string): Promise<CommitResult> {
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') {
    return {
      status: 'failed',
      ack: "I need calendar access to do that. Open your phone Settings, find Herald, and turn on Calendar. Then ask me again.",
    };
  }
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const writable = calendars.filter((c) => c.allowsModifications);
  if (!writable.length) {
    return {
      status: 'failed',
      ack: "I couldn't find a calendar I can write to. Make sure Google Calendar or Samsung Calendar is set up, then try again.",
    };
  }
  const targetCal =
    writable.find((c) => c.isPrimary) ||
    writable.find((c) => c.source?.type === 'com.google') ||
    writable[0];
  let startDate: Date;
  try {
    const [h, m] = timeStr.split(':').map(Number);
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      startDate = new Date();
      startDate.setFullYear(year, month - 1, day);
      startDate.setHours(h, m, 0, 0);
    } else {
      return {
        status: 'failed',
        ack: "I'm not sure I'm following you — can you help me understand?",
      };
    }
    if (isNaN(startDate.getTime())) throw new Error('invalid date');
  } catch {
    startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(9, 0, 0, 0);
  }
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  await Calendar.createEventAsync(targetCal.id, {
    title,
    startDate,
    endDate,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notes: 'Added by Herald',
  });
  try {
    addAppointment({
      title,
      apptDateISO: startDate.toISOString(),
      apptDatePrecision: 'exact',
      endDateISO: endDate.toISOString(),
      source: 'user_told',
      rawPhrase: `${title}|${dateStr}|${timeStr}`,
    });
    console.log('[HERALD] appointment saved (user_told):', title);
  } catch {
    // Non-fatal — OS calendar write already succeeded.
  }
  const timeDisplay = startDate.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const dateDisplay = startDate.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  markCalendarWrite();
  await refreshCalendarCache().catch(() => {});
  return {
    status: 'committed',
    ack: `Okay, I've added ${title} for ${dateDisplay} at ${timeDisplay}.`,
  };
}

export type CalendarWriteFn = typeof writeCalendarCore;
type SetPendingSlot = Parameters<ConversationSession['setPending']>[0];

export type CalendarCollectPlan = {
  prompt: string;
  slot: SetPendingSlot;
} | null;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure decision logic: null = nothing missing, write directly. Otherwise the
 * prompt to speak + the slot to arm. `write` is injectable so tests can
 * assert the D-2 fence: cancel/ambiguity during collect NEVER calls it.
 *
 * Chains forward through whichever fields are still missing — title, then
 * date, then time — until all three are known, then writes exactly once.
 * A date is NEVER defaulted or inferred silently (Trust First / no
 * fabrication): if the original utterance carried no date phrase, this asks
 * for one explicitly, the same way it already asks for a missing title or
 * time. Previously, a missing date was never collected at all and
 * writeCalendarCore failed silently at write time with a generic-sounding
 * message that misrepresented a specific, knowable gap as confusion.
 */
export function buildCalendarCollectSlot(
  title: string,
  dateStr: string,
  timeStr: string,
  write: CalendarWriteFn = writeCalendarCore,
): CalendarCollectPlan {
  return nextCalendarStage(title, dateStr, timeStr, write);
}

function nextCalendarStage(
  knownTitle: string,
  knownDate: string,
  knownTimeStr: string,
  write: CalendarWriteFn,
): CalendarCollectPlan {
  const needsTitle = !knownTitle || knownTitle === 'Appointment';
  const needsDate = !knownDate || !ISO_DATE_RE.test(knownDate);
  const needsTime = !knownTimeStr || !TIME_RE.test(knownTimeStr);
  if (!needsTitle && !needsDate && !needsTime) return null;

  // Advances to whatever's still missing after this reply, or writes once
  // nothing is. Shared by every stage below so the chain never duplicates
  // the write-vs-advance decision.
  const advance = async (
    resolvedTitle: string,
    resolvedDate: string,
    resolvedTimeStr: string,
  ): Promise<CommitResult> => {
    const next = nextCalendarStage(resolvedTitle, resolvedDate, resolvedTimeStr, write);
    if (!next) return await write(resolvedTitle, resolvedDate, resolvedTimeStr);
    return {
      status: 'pending',
      pendingKey: next.slot.pendingKey,
      prompt: next.prompt,
      reaskPrompt: next.slot.reaskPrompt,
      resume: next.slot.resume,
    };
  };

  if (needsTitle) {
    return {
      prompt: 'What would you like me to call this?',
      slot: {
        pendingKey: 'calendar_collect_title',
        kind: 'standard',
        reaskPrompt: 'Sorry — what would you like me to call this?',
        resume: async (reply: string): Promise<CommitResult> => {
          const newTitle = reply.trim();
          if (COLLECT_CANCEL_RE.test(newTitle)) {
            return { status: 'noop', ack: COLLECT_CANCEL_ACK };
          }
          if (!newTitle) return { status: 'noop', ack: '' };
          return await advance(newTitle, knownDate, knownTimeStr);
        },
      },
    };
  }

  if (needsDate) {
    return {
      prompt: `What day should I put "${knownTitle}" on your calendar?`,
      slot: {
        pendingKey: 'calendar_collect_date',
        kind: 'standard',
        reaskPrompt: `I didn't catch a day — what day should I put "${knownTitle}" on your calendar?`,
        resume: async (reply: string): Promise<CommitResult> => {
          if (COLLECT_CANCEL_RE.test(reply.trim())) {
            return { status: 'noop', ack: COLLECT_CANCEL_ACK };
          }
          const parsedDate = parseDatePhrase(reply);
          if (!parsedDate) return { status: 'noop', ack: '' };
          return await advance(knownTitle, parsedDate, knownTimeStr);
        },
      },
    };
  }

  // needsTime only
  return {
    prompt: `What time should I put "${knownTitle}" on your calendar?`,
    slot: {
      pendingKey: 'calendar_collect_time',
      kind: 'standard',
      reaskPrompt: `I didn't catch a time — what time should I put "${knownTitle}" on your calendar?`,
      resume: async (reply: string): Promise<CommitResult> => {
        if (COLLECT_CANCEL_RE.test(reply.trim())) {
          return { status: 'noop', ack: COLLECT_CANCEL_ACK };
        }
        const parsed = parseTimeFromText(reply);
        if (!parsed) return { status: 'noop', ack: '' };
        const hh = String(parsed.hour).padStart(2, '0');
        const mm = String(parsed.minute).padStart(2, '0');
        return await advance(knownTitle, knownDate, `${hh}:${mm}`);
      },
    },
  };
}