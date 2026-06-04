// src/routing/tierRouter.ts
// Herald — query tier classifier and context loader.
// Session L — Device-First Intelligence Layer
// Build 20 fix: additional calendar phrase coverage (Bug 2 from Session L).

import { getCachedEvents, formatCachedEventsForSpeech, refreshCalendarCache } from "../db/calendarCacheDB";
import { calendarWriteIsRecent } from "../db/calendarState";
import { getFactsSummary } from "../db/factDB";
import { getProfileSummary } from "../db/profileDB";
import { getMedicalSummary } from "../db/medicalDB";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tier = 1 | 2 | 3;

export interface TierDecision {
  tier: Tier;
  tier1Response?: string;
  actionIntent?:
    | { type: 'alarm';    time: string;  label: string }
    | { type: 'timer'; minutes: number; label: string }
    | { type: 'sms';     contact: string; message: string }
    | { type: 'time' }
    | { type: 'date' }
    | { type: 'call';    contact: string }
    | { type: 'reminder'; body: string; time: string }
    | { type: 'note_capture'; body: string }
    | { type: 'note_read' }
    | { type: 'list_add'; item: string; listName: string }
    | { type: 'list_read'; listName: string };
  localContext?: LocalContext;
  reason: string;
}

export interface LocalContext {
  facts?: string;
  profile?: string;
  medical?: string;
  intent?: string;
}

// ─── Signal groups ────────────────────────────────────────────────────────────

const TIER1_SIGNALS = {
  calendar_today: [
    /what('s| is) on my calendar/i,
    /do i have (anything|something) today/i,
    /what do i have today/i,
    /any (appointments|meetings|events) today/i,
    /my schedule today/i,
    /what('s| is) (scheduled|planned) today/i,
    /anything (on|scheduled) today/i,
    /is there anything on my calendar (for )?today/i,
    /anything on my calendar/i,
    /what('s| is) (happening|going on) today/i,
    /do i have anything (today|scheduled)/i,
  ],
  calendar_tomorrow: [
    /tomorrow/i,
    /what do i have tomorrow/i,
    /any (appointments|meetings|events) tomorrow/i,
    /schedule (for )?tomorrow/i,
    /do i have anything tomorrow/i,
    /is there anything tomorrow/i,
  ],
  calendar_week: [
    /this (coming )?week/i,
    /coming week/i,
    /next seven days/i,
    /next 7 days/i,
    /what do i have this week/i,
    /week('s| is) schedule/i,
    /what('s| is) (on|scheduled) this week/i,
    /any (flights?|hotels?|stays?|trips?|travel|reservations?)/i,
    /do i have any (flights?|hotels?|stays?|trips?|travel|appointments?|meetings?|events?|reservations?)/i,
    /am i (traveling|flying|staying|booked)/i,
    /what (flights?|hotels?|trips?|reservations?) do i have/i,
    /is there (a |any )?.*(hotel|flight|stay|trip|reservation)/i,
    /any (upcoming|scheduled) (travel|trips?|flights?)/i,
  ],
  medical: [
    /what (medication|medications|meds|pills) am i (on|taking)/i,
    /my (medication|medications|meds|prescriptions)/i,
    /what did (my|the) doctor/i,
    /who is my (doctor|physician|specialist)/i,
    /my doctor('s name)?/i,
    /medical (history|records|info)/i,
    /what do you (have|know) about my (health|medical|medications|meds)/i,
  ],
  profile: [
    /what('s| is) my name/i,
    /where do i live/i,
    /what city (am i in|do i live in)/i,
    /what('s| is) my (location|address|city|town)/i,
    /who am i/i,
  ],
};

const TIER2_SIGNALS = [
  /what do you know (about me|about my life)/i,
  /what have i told you/i,
  /do you remember (me|what i said|what i told)/i,
  /how well do you know me/i,
  /what do you have on me/i,
  /what did i tell you/i,
  /tell me what you know/i,
  /what('s| is) in my (memory|profile|history)/i,
  /remind me what you know/i,
];

const TIER3_SIGNALS = [
  /weather/i,
  /news/i,
  /stock|market|crypto|bitcoin|price of/i,
  /sports|score|game|nfl|nba|mlb|nhl|espn/i,
  /search (for )?/i,
  /find me/i,
  /near me/i,
  /flight|restaurant|hotel/i,
  /what('s| is) happening/i,
  /latest|recent|today('s)? (news|headlines)/i,
];

const ALARM_SIGNALS = [
  /\b(set|create|put)?\s*(an?\s+)?alarm\b/i,
  /\bwake\s+me\s+(up\s+)?(at|in)\b/i,
  /\bwake\s+me\s+up\b/i,
];
const TIMER_SIGNALS = [
  /\b(set|create|put)?\s*(an?\s+)?timer\b/i,
  /\bcountdown\b/i,
];

const SMS_SIGNALS = [
  /\b(text|message|msg)\s+\w+/i,
  /\bsend\s+(a\s+)?(text|message)\s+to\b/i,
  /\btell\s+\w+\s+that\b/i,
];

const TIME_SIGNALS = [
  /\bwhat (time|hour) is it\b/i,
  /\bwhat's the time\b/i,
  /\bdo you know the time\b/i,
  /\bwhat time is it\b/i,
];

const DATE_SIGNALS = [
  /\bwhat (day|date) is (it|today)\b/i,
  /\bwhat's today\b/i,
  /\bwhat('s| is) the date\b/i,
  /\bwhat day is it\b/i,
  /\btoday's date\b/i,
];

const CALL_SIGNALS = [
  /\b(call|phone|dial|ring)\s+\w+/i,
  /\bcan you (call|phone)\s+\w+/i,
  /\bgive\s+\w+\s+a (call|ring)\b/i,
];

const REMINDER_SIGNALS = [
  /\bremind me\b/i,
  /\bdon't let me forget\b/i,
  /\bremember to\b/i,
  /\bdon't forget to\b/i,
];

const NOTE_CAPTURE_SIGNALS = [
  /\b(note|jot|write down|record) (this|that)\b/i,
  /\bnote that\b/i,
  /\bjot this down\b/i,
  /^remember that\b/i,
];

const NOTE_READ_SIGNALS = [
  /\bwhat are my notes\b/i,
  /\bshow (me )?my notes\b/i,
  /\bread (me )?my notes\b/i,
  /\bwhat (have|did) i (note|jot|write)\b/i,
  /\bwhat('s| is) on my notes\b/i,
  /\bmy notes\b/i,
];

const LIST_ADD_SIGNALS = [
  /\badd (.+) to (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
  /\bput (.+) on (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
];

const LIST_READ_SIGNALS = [
  /\bwhat('s| is) on my (grocery |shopping |to.?do |)\blist\b/i,
  /\bshow (me )?my (grocery |shopping |to.?do |)\blist\b/i,
  /\bread (me )?my (grocery |shopping |to.?do |)\blist\b/i,
];

// ─── classifyQuery ────────────────────────────────────────────────────────────

async function getTier1CalendarEvents(
  window: "today" | "tomorrow" | "this week"
): Promise<ReturnType<typeof getCachedEvents>> {
  if (calendarWriteIsRecent()) {
    await refreshCalendarCache();
  }
  return getCachedEvents(window);
}

export async function classifyQuery(message: string): Promise<TierDecision> {
  const msg = message.trim();

  // Device action: timer — duration-based, separate from alarm
  if (TIMER_SIGNALS.some((p) => p.test(msg))) {
    const { parseTimerIntent } = await import('../utils/parseTime');
    const parsed = parseTimerIntent(msg);
    if (parsed) {
      return {
        tier: 1,
        actionIntent: { type: 'timer', minutes: parsed.minutes, label: parsed.label },
        reason: 'action:timer',
      };
    }
  }

  // Device action: alarm — parse on device, zero network
  if (ALARM_SIGNALS.some((p) => p.test(msg))) {
    const { parseAlarmIntent } = await import('../utils/parseTime');
    const parsed = parseAlarmIntent(msg);
    if (parsed) {
      return {
        tier: 1,
        actionIntent: { type: 'alarm', time: parsed.time, label: parsed.label },
        reason: 'action:alarm',
      };
    }
  }

  // Device action: SMS — parse on device, zero network
  if (SMS_SIGNALS.some((p) => p.test(msg))) {
    const { parseSmsIntent } = await import('../utils/parseTime');
    const parsed = parseSmsIntent(msg);
    if (parsed) {
      return {
        tier: 1,
        actionIntent: { type: 'sms', contact: parsed.contact, message: parsed.message },
        reason: 'action:sms',
      };
    }
  }

  // Device: time — pure device clock, zero network
  if (TIME_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, actionIntent: { type: 'time' }, reason: 'action:time' };
  }

  // Device: date — pure device clock, zero network
  const hasWeather = /\bweather\b/i.test(msg);
  if (DATE_SIGNALS.some((p) => p.test(msg)) && !hasWeather) {
    return { tier: 1, actionIntent: { type: 'date' }, reason: 'action:date' };
  }

  // Device: call — resolves contact on device, fires tel: intent
  if (CALL_SIGNALS.some((p) => p.test(msg))) {
    const CALL_EXCLUDE = /^(me|you|back|again|later|now|soon|ahead|us|them|it|that)$/i;
    const contactMatch =
      msg.match(/\b(?:call|phone|dial|ring)\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+)?\w+(?:\s+\w+)?)/i) ??
      msg.match(/\bgive\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+)?\w+(?:\s+\w+)?)\s+a\s+(?:call|ring)\b/i);
    const rawContact = contactMatch?.[1]?.trim() ?? '';
    const contact = CALL_EXCLUDE.test(rawContact.split(' ')[0]) ? '' : rawContact;
    if (contact) {
      return {
        tier: 1,
        actionIntent: { type: 'call', contact },
        reason: 'action:call',
      };
    }
  }

  // Device: reminder — parse on device, schedule local notification
  if (REMINDER_SIGNALS.some((p) => p.test(msg))) {
    const { parseReminderIntent } = await import('../utils/parseTime');
    const parsed = parseReminderIntent(msg);
    if (parsed) {
      return {
        tier: 1,
        actionIntent: { type: 'reminder', body: parsed.body, time: parsed.time },
        reason: 'action:reminder',
      };
    }
  }

  // Device: note capture — write to SQLite, zero network
  if (NOTE_CAPTURE_SIGNALS.some((p) => p.test(msg))) {
    const bodyMatch = msg.match(/note that (.+)/i)?.[1] ??
                      msg.match(/(?:note|jot|record|remember that) (.+)/i)?.[1] ??
                      msg.replace(/^(note|jot|write down|record|remember)\s+(this|that)?\s*/i, '').trim();
    if (bodyMatch && bodyMatch.length > 2) {
      return { tier: 1, actionIntent: { type: 'note_capture', body: bodyMatch.trim() }, reason: 'action:note_capture' };
    }
  }

  // Device: note read — read from SQLite, zero network
  if (NOTE_READ_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, actionIntent: { type: 'note_read' }, reason: 'action:note_read' };
  }

  // Device: list add — write to SQLite, zero network
  if (LIST_ADD_SIGNALS.some((p) => p.test(msg))) {
    const addMatch = msg.match(/\badd (.+?) to (?:my |the )?(\w+)?\s*list/i) ??
                     msg.match(/\bput (.+?) on (?:my |the )?(\w+)?\s*list/i);
    if (addMatch) {
      const item = addMatch[1]?.trim() ?? '';
      const listName = (addMatch[2]?.trim() ?? 'grocery').toLowerCase();
      if (item) return { tier: 1, actionIntent: { type: 'list_add', item, listName }, reason: 'action:list_add' };
    }
  }

  // Device: list read — read from SQLite, zero network
  if (LIST_READ_SIGNALS.some((p) => p.test(msg))) {
    const nameMatch = msg.match(/my (\w+) list/i);
    const listName = (nameMatch?.[1]?.trim() ?? 'grocery').toLowerCase();
    return { tier: 1, actionIntent: { type: 'list_read', listName }, reason: 'action:list_read' };
  }

  // Tier 1: calendar today — exclude if tomorrow or week is present
  if (
    TIER1_SIGNALS.calendar_today.some((p) => p.test(msg)) &&
    !TIER1_SIGNALS.calendar_tomorrow.some((p) => p.test(msg)) &&
    !TIER1_SIGNALS.calendar_week.some((p) => p.test(msg))
  ) {
    const events = await getTier1CalendarEvents("today");
    const response = formatCachedEventsForSpeech(events, "today");
    return { tier: 1, tier1Response: response, reason: "calendar:today" };
  }

  // Tier 1: calendar tomorrow
  const hasWeatherTomorrow = /\bweather\b/i.test(msg);
  if (TIER1_SIGNALS.calendar_tomorrow.some((p) => p.test(msg)) && !hasWeatherTomorrow) {
    const events = await getTier1CalendarEvents("tomorrow");
    const response = formatCachedEventsForSpeech(events, "tomorrow");
    return { tier: 1, tier1Response: response, reason: "calendar:tomorrow" };
  }

  // Tier 1: calendar this week
  const hasNearMe = /\b(near me|near here|nearest|closest|close to me)\b/i.test(msg);
  if (TIER1_SIGNALS.calendar_week.some((p) => p.test(msg)) && !hasNearMe) {
    const events = await getTier1CalendarEvents("this week");
    const response = formatCachedEventsForSpeech(events, "this week");
    return { tier: 1, tier1Response: response, reason: "calendar:week" };
  }

  // Tier 1: medical
  if (TIER1_SIGNALS.medical.some((p) => p.test(msg))) {
    const response = getMedicalSummary();
    return { tier: 1, tier1Response: response, reason: "medical:summary" };
  }

  // Tier 1: profile
  if (TIER1_SIGNALS.profile.some((p) => p.test(msg))) {
    const response = getProfileSummary();
    return {
      tier: 1,
      tier1Response: response || "I don't have your profile details stored on device yet.",
      reason: "profile:lookup",
    };
  }

  // Tier 2: memory probe
  if (TIER2_SIGNALS.some((p) => p.test(msg))) {
    const localContext: LocalContext = {
      facts: getFactsSummary(),
      profile: getProfileSummary(),
      medical: getMedicalSummary(),
      intent: "memory_probe",
    };
    return { tier: 2, localContext, reason: "memory:probe" };
  }

  // Tier 3: explicit live data
  if (TIER3_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 3, reason: "live:data" };
  }

  // Default: Tier 3
  return { tier: 3, reason: "default" };
}

// ─── buildTier2Payload ────────────────────────────────────────────────────────

export function buildTier2Payload(context: LocalContext): string {
  const parts: string[] = [];
  if (context.profile) parts.push(`Profile:\n${context.profile}`);
  if (context.facts) parts.push(`Known facts:\n${context.facts}`);
  if (context.medical) parts.push(`Medical context:\n${context.medical}`);
  return parts.join("\n\n");
}