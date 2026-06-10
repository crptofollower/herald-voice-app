// src/routing/tierRouter.ts
// Herald — query tier classifier and context loader.
// Session L — Device-First Intelligence Layer
// Build 20 fix: additional calendar phrase coverage (Bug 2 from Session L).

import { getCachedEvents, formatCachedEventsForSpeech, refreshCalendarCache, getCacheAge } from "../db/calendarCacheDB";
import { calendarWriteIsRecent } from "../db/calendarState";
import { getFactsSummary } from "../db/factDB";
import { getProfileSummary } from "../db/profileDB";
import { getMedicalSummary } from "../db/medicalDB";
import { detectMedicalEvent } from "../utils/detectMedicalEvent";
import type { MedicalEvent } from "../utils/detectMedicalEvent";

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
    | { type: 'list_read'; listName: string }
    | { type: 'calendar_write'; value: string }
    | { type: 'medical_capture'; event: MedicalEvent };
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
  calendar_next_week: [
    /next week/i,
    /do i have (anything|something).*(on my calendar|on my schedule|scheduled)/i,
  ],
  medical: [
    /what (medication|medications|meds|pills) am i (on|taking)/i,
    /my (medication|medications|meds|prescriptions)/i,
    /what did (my|the) doctor/i,
    /who is my (doctor|physician|specialist)/i,
    /my doctor('s name)?/i,
    /medical (history|records|info)/i,
    /what do you (have|know) about my (health|medical|medications|meds)/i,
    /\bwhat do i take\b/i,
    /\bwhat am i (taking|on)\b/i,
    /\bwhat (should i|do i) take\b/i,
    /\bmy (meds|medications|pills|prescriptions)\b/i,
    /\bdo i take (any )?(medication|meds|pills)\b/i,
  ],
  profile: [
    /what('s| is) my name/i,
    /where do i live/i,
    /what city (am i in|do i live in)/i,
    /what('s| is) my (location|address|city|town)/i,
    /who am i/i,
    /\bwhere are we\b/i,
    /\bwhere am i\b/i,
    /\bdo you know my name\b/i,
    /\byou don't remember\b/i,
    /\bdo you know my \w+('s)? name\b/i,
    /\bwhat('s| is) my \w+('s)? name\b/i,
    /\bwhat('s| is) my age\b/i,
    /\bhow old am i\b/i,
    /\bdo you know (how old i am|my age)\b/i,
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
  /\b(set|create|put)?\s*(an?\s+)?(?:\d+\s*(?:minute|min|hour|hr)s?\s+)?alarm\b/i,
  /\bwake\s+me\s+(up\s+)?(at|in)\b/i,
  /\bwake\s+me\s+up\b/i,
];
const TIMER_SIGNALS = [
  /\b(set|create|put)?\s*(an?\s+)?(?:\d+\s*(?:minute|min|hour|hr)s?\s+)?timer\b/i,
  /\bcountdown\b/i,
];

const SMS_SIGNALS = [
  /\b(text|message|msg)\s+\w+/i,
  /\bsend\s+(a\s+)?(text|message)\s+to\b/i,
  /\btell\s+\w+\s+that\b/i,
  /\bcan you (text|message)\s+\w+/i,
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

/** Phone-number statement — let ChatScreen phone-capture handle, not call intent. */
const CALL_NUMBER_STATEMENT = /(?:number|phone|cell|mobile)\s+(?:is\s+)?[\d\s\-\(\)\+\.]{7,}/i;

const REMINDER_SIGNALS = [
  /\bremind me\b/i,
  /\bdon't let me forget\b/i,
  /\bremember to\b/i,
  /\bdon't forget to\b/i,
  /\bcan you set a reminder\b/i,
  /\bset a reminder\b/i,
];

const NOTE_CAPTURE_SIGNALS = [
  /\b(note|jot|write down|record) (this|that)\b/i,
  /\bnote that\b/i,
  /\bjot this down\b/i,
  /^remember that\b/i,
  /\bcan you make a note\b/i,
  /\bmake a note (to|that|about)\b/i,
  /\bcan you note\b/i,
];

const NOTE_READ_SIGNALS = [
  /\bwhat are my notes\b/i,
  /\bshow (me )?my notes\b/i,
  /\bread (me )?my notes\b/i,
  /\bwhat (have|did) i (note|jot|write)\b/i,
  /\bwhat('s| is) on my notes\b/i,
  /\bmy notes\b/i,
  /\bare there any notes\b/i,
  /\bis there anything (in my |on my )?notes\b/i,
  /\bany notes\b/i,
];

const LIST_ADD_SIGNALS = [
  /\badd (.+) to (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
  /\bput (.+) on (my |the )?(grocery |shopping |to.?do |)\blist\b/i,
];

const LIST_READ_SIGNALS = [
  /\bwhat('s| is) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bwhat('s| is) on (the )?(grocery |shopping |to.?do )?\blist\b/i,
  /\bshow (me )?my (grocery |shopping |to.?do |)\blist\b/i,
  /\bread (me )?my (grocery |shopping |to.?do |)\blist\b/i,
  /\bis there (anything|something) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bcheck my (grocery |shopping |to.?do )?\blist\b/i,
  /\bdo i have (anything|something) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bdo i have a (grocery |shopping |to.?do )?\blist\b/i,
];

// ─── classifyQuery ────────────────────────────────────────────────────────────

async function getTier1CalendarEvents(
  window: "today" | "tomorrow" | "this week" | "next week"
): Promise<ReturnType<typeof getCachedEvents>> {
  if (calendarWriteIsRecent()) {
    await refreshCalendarCache();
  }
  if (getCacheAge() === null) {
    await refreshCalendarCache();
  }
  return getCachedEvents(window);
}

function calendarSpeech(
  window: "today" | "tomorrow" | "this week" | "next week",
  events: ReturnType<typeof getCachedEvents>
): string {
  if (getCacheAge() === null) {
    return "I don't have your calendar loaded yet. Connect once with calendar access granted, then try again offline.";
  }
  return formatCachedEventsForSpeech(events, window);
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
    const minuteMatch = msg.match(/\b(\d+)\s*(?:minute|min)s?\b/i);
    const hourMatch = msg.match(/\b(\d+)\s*(?:hour|hr)s?\b/i);
    const fallbackMinutes = minuteMatch
      ? parseInt(minuteMatch[1], 10)
      : hourMatch ? parseInt(hourMatch[1], 10) * 60 : null;
    if (fallbackMinutes) {
      return {
        tier: 1,
        actionIntent: { type: 'timer', minutes: fallbackMinutes, label: `${fallbackMinutes} minute timer` },
        reason: 'action:timer:fallback',
      };
    }
  }

  // Device action: alarm — parse on device, zero network
  if (ALARM_SIGNALS.some((p) => p.test(msg))) {
    const { parseAlarmIntent } = await import('../utils/parseTime');
    const hasDuration = /\b(\d+)\s*(minute|min|hour|hr)s?\b/i.test(msg);
    const hasClockTime = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(msg) || /\bat\s+\d{1,2}\b/i.test(msg);
    if (hasDuration && !hasClockTime) {
      const dur = msg.match(/\b(\d+)\s*(minute|min|hour|hr)s?\b/i);
      if (dur) {
        const n = parseInt(dur[1], 10);
        const minutes = /^h/i.test(dur[2]) ? n * 60 : n;
        if (minutes > 0) {
          return { tier: 1, actionIntent: { type: 'timer', minutes, label: `${minutes} minute timer` }, reason: 'action:timer:rerouted' };
        }
      }
    }
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
    const contactOnly =
      msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+to\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1] ??
      msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1];
    const SMS_EXCLUDE = /^(me|you|us|them|it|myself|yourself)$/i;
    if (contactOnly && !SMS_EXCLUDE.test(contactOnly.trim())) {
      return {
        tier: 1,
        actionIntent: { type: 'sms', contact: contactOnly.trim(), message: '' },
        reason: 'action:sms:no_body',
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

  // Device: note capture — write to SQLite, zero network
  if (NOTE_CAPTURE_SIGNALS.some((p) => p.test(msg))) {
    const bodyMatch =
      msg.match(/note that (.+)/i)?.[1] ??
      msg.match(/make a note to (.+)/i)?.[1] ??
      msg.match(/make a note (that|about) (.+)/i)?.[2] ??
      msg.match(/can you make a note to (.+)/i)?.[1] ??
      msg.match(/can you note (.+)/i)?.[1] ??
      msg.match(/(?:note|jot|record|remember that) (.+)/i)?.[1] ??
      msg.replace(/^(can you )?(note|jot|write down|record|remember|make a note)\s+(this|that|to|about)?\s*/i, '').trim();
    if (bodyMatch && bodyMatch.length > 2) {
      return { tier: 1, actionIntent: { type: 'note_capture', body: bodyMatch.trim() }, reason: 'action:note_capture' };
    }
  }

  // Device: call — resolves contact on device, fires tel: intent
  if (CALL_SIGNALS.some((p) => p.test(msg)) && !REMINDER_SIGNALS.some((p) => p.test(msg)) && !CALL_NUMBER_STATEMENT.test(msg)) {
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

  // Device: calendar write — local CalendarProvider, works offline (Bug 3)
  if (/\b(calendar|schedule)\b/i.test(msg) && /\b(put|add|schedule|create|book|make)\b/i.test(msg)) {
    const isRead =
      /\b(what('s| is)|what do i have|do i have anything|anything on my|show me my)\b/i.test(msg) &&
      !/\b(put|add|schedule|create|book|make)\b/i.test(msg);
    if (!isRead) {
      const { parseCalendarWriteIntent } = await import('../utils/parseTime');
      const value = parseCalendarWriteIntent(msg);
      if (value) {
        return { tier: 1, actionIntent: { type: 'calendar_write', value }, reason: 'action:calendar_write' };
      }
    }
  }

  // Device: medical capture — past-tense medical events only
  const medEvent = detectMedicalEvent(msg);
  if (medEvent && medEvent.tense === 'past') {
    return {
      tier: 1,
      actionIntent: { type: 'medical_capture', event: medEvent },
      reason: 'action:medical_capture',
    };
  }

  // Tier 1: calendar today — exclude if tomorrow, this week, or next week is present
  const hasNextWeek = /\bnext week\b/i.test(msg);
  if (
    TIER1_SIGNALS.calendar_today.some((p) => p.test(msg)) &&
    !TIER1_SIGNALS.calendar_tomorrow.some((p) => p.test(msg)) &&
    !TIER1_SIGNALS.calendar_week.some((p) => p.test(msg)) &&
    !hasNextWeek
  ) {
    const events = await getTier1CalendarEvents("today");
    const response = calendarSpeech("today", events);
    return { tier: 1, tier1Response: response, reason: "calendar:today" };
  }

  // Tier 1: calendar tomorrow
  const hasWeatherTomorrow = /\bweather\b/i.test(msg);
  if (TIER1_SIGNALS.calendar_tomorrow.some((p) => p.test(msg)) && !hasWeatherTomorrow && !hasNextWeek) {
    const events = await getTier1CalendarEvents("tomorrow");
    const response = calendarSpeech("tomorrow", events);
    return { tier: 1, tier1Response: response, reason: "calendar:tomorrow" };
  }

  // Tier 1: calendar next week (before this week — "next week" must not fall through to today)
  const hasNearMe = /\b(near me|near here|nearest|closest|close to me)\b/i.test(msg);
  if (
    (hasNextWeek || TIER1_SIGNALS.calendar_next_week.some((p) => p.test(msg))) &&
    !hasNearMe &&
    !/\btoday\b/i.test(msg) &&
    !/\btomorrow\b/i.test(msg)
  ) {
    const events = await getTier1CalendarEvents("next week");
    const response = calendarSpeech("next week", events);
    return { tier: 1, tier1Response: response, reason: "calendar:next_week" };
  }

  // Tier 1: calendar this week
  if (TIER1_SIGNALS.calendar_week.some((p) => p.test(msg)) && !hasNearMe && !hasNextWeek) {
    const events = await getTier1CalendarEvents("this week");
    const response = calendarSpeech("this week", events);
    return { tier: 1, tier1Response: response, reason: "calendar:week" };
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