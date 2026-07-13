// DD-3 (PENDING_UNIFICATION spec): the calendar write core + collect-slot
// builder, extracted from ChatScreen so the D-2 fence (cancel during collect
// never writes) is contract-testable headless. Write function is injectable
// for tests. UI (ChatScreen) adapts: speaks prompts, arms the session.
import * as Calendar from 'expo-calendar';
import type { CommitResult } from './routeIntent';
import type { ConversationSession } from './conversationSession';
import { parseTimeFromText } from '../utils/parseTime';
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

// Pure decision logic: null = nothing missing, write directly. Otherwise the
// prompt to speak + the slot to arm. `write` is injectable so tests can
// assert the D-2 fence: cancel/ambiguity during collect NEVER calls it.
export function buildCalendarCollectSlot(
  title: string,
  dateStr: string,
  timeStr: string,
  write: CalendarWriteFn = writeCalendarCore,
): CalendarCollectPlan {
  const needsTitle = !title || title === 'Appointment';
  const needsTime = !timeStr || !TIME_RE.test(timeStr);
  if (!needsTitle && !needsTime) return null;

  const timePendingSlot = (knownTitle: string): SetPendingSlot => ({
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
      return await write(knownTitle, dateStr, `${hh}:${mm}`);
    },
  });

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
          const timePart = timeStr && TIME_RE.test(timeStr) ? timeStr : '';
          if (timePart) return await write(newTitle, dateStr, timePart);
          const t = timePendingSlot(newTitle);
          return {
            status: 'pending',
            pendingKey: 'calendar_collect_time',
            prompt: `What time should I put "${newTitle}" on your calendar?`,
            reaskPrompt: t.reaskPrompt,
            resume: t.resume,
          };
        },
      },
    };
  }

  return {
    prompt: `What time should I put "${title}" on your calendar?`,
    slot: timePendingSlot(title),
  };
}
