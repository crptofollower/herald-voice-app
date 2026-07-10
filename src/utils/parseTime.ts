// src/utils/parseTime.ts
// Device-side natural language time and intent parser.
// No LLM. No network. Runs entirely on device.
// Used by tierRouter.ts for alarm and SMS intents.

export function parseTimeFromText(text: string): { hour: number; minute: number } | null {
  let t = text.toLowerCase().replace(/\b(a)\.(m)\./gi, 'am').replace(/\b(p)\.(m)\./gi, 'pm');

  // Voice-first: normalize spelled-out hours to digits before digit patterns.
  // Longest-first so "twelve" is not partially eaten by shorter tokens.
  const HOUR_WORDS: [string, string][] = [
    ['twelve', '12'], ['eleven', '11'], ['ten', '10'],
    ['nine', '9'], ['eight', '8'], ['seven', '7'],
    ['six', '6'], ['five', '5'], ['four', '4'],
    ['three', '3'], ['two', '2'], ['one', '1'],
  ];
  for (const [word, digit] of HOUR_WORDS) {
    t = t.replace(new RegExp(`\\b${word}\\b`, 'gi'), digit);
  }

  // Default smart AM/PM when no period-of-day word is present.
  // noon stays 12, 1-5 → PM, 6-11 → AM, 0 → midnight.
  const applySmartAmPm = (h: number): number => {
    if (h === 12) return 12;
    if (h >= 1 && h <= 5) return h + 12;
    if (h >= 6 && h <= 11) return h;
    if (h === 0) return 0;
    return h;
  };

  // Explicit period word beats the generic 1-5→PM / 6-11→AM guess.
  // Bucket words only influence AM/PM here — never flatten minutes.
  const applyPeriodOrSmartAmPm = (h: number): number => {
    if (/\bmorning\b/.test(t)) {
      return h === 12 ? 0 : h;
    }
    if (/\b(afternoon|evening|tonight|night)\b/.test(t)) {
      if (h === 12) return 12;
      if (h >= 1 && h <= 11) return h + 12;
      return h;
    }
    return applySmartAmPm(h);
  };

  // "7am", "7 am", "7:00am", "7:00 am", "7:30 pm"
  const absolute = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (absolute) {
    let h = parseInt(absolute[1]);
    const m = parseInt(absolute[2] ?? '0');
    const period = absolute[3].toLowerCase();
    if (period === 'pm' && h !== 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
    return { hour: h, minute: m };
  }

  // "at 7", "at 9", "wake me at 10" — no AM/PM
  const plainHour = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*[ap]m)/i);
  if (plainHour) {
    const h = applyPeriodOrSmartAmPm(parseInt(plainHour[1]));
    const m = parseInt(plainHour[2] ?? '0');
    return { hour: h, minute: m };
  }

  // "in 30 minutes", "in 2 hours", "in an hour"
  const relative = t.match(/\b(?:in|for)\s+(?:an?\s+)?(\d+)?\s*(minute|min|hour|hr)/i);
  if (relative) {
    const amount = parseInt(relative[1] ?? '1');
    const unit = relative[2].toLowerCase();
    const now = new Date();
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    const target = new Date(now.getTime() + minutes * 60000);
    return { hour: target.getHours(), minute: target.getMinutes() };
  }

  // Bare "HH:MM" or "HH" — before named buckets so an explicit number always wins.
  // Period-of-day word (if any) resolves AM/PM; minutes are always preserved.
  const bare = t.match(/\b(\d{1,2})(?::(\d{2}))?\b(?!\s*[ap]m)/i);
  if (bare) {
    const h = applyPeriodOrSmartAmPm(parseInt(bare[1]));
    const m = parseInt(bare[2] ?? '0');
    return { hour: h, minute: m };
  }

  // Named bucket defaults — only when NO number is present in the text.
  // Word-boundary match so "afternoon" ≠ "noon", "midnight" ≠ "night".
  const named: Record<string, [number, number]> = {
    'morning':   [7,  0],
    'noon':      [12, 0],
    'lunch':     [12, 0],
    'afternoon': [15, 0],
    'evening':   [18, 0],
    'tonight':   [21, 0],
    'night':     [21, 0],
    'midnight':  [0,  0],
  };
  for (const [word, [h, m]] of Object.entries(named)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return { hour: h, minute: m };
  }

  return null;
}

export function parseAlarmIntent(text: string): { time: string; label: string } | null {
  const isAlarm = /\b(alarm|wake me|wake up)\b/i.test(text);
  if (!isAlarm) return null;

  const t = text.toLowerCase();
  const duration =
    t.match(/\b(?:in|for)\s+(?:an?\s+)?(\d+)?\s*(minute|min|hour|hr|second|sec)\b/i)
    ?? t.match(/\b(\d+)[\s-]*(minute|min|hour|hr|second|sec)\s+alarm\b/i);

  let parsed: { hour: number; minute: number } | null = null;
  if (duration) {
    const amount = parseInt(duration[1] ?? '1', 10);
    const unit = (duration[2] ?? 'minute').toLowerCase();
    let minutes = amount;
    if (unit.startsWith('h')) minutes = amount * 60;
    else if (unit.startsWith('s')) minutes = Math.max(1, Math.ceil(amount / 60));
    if (minutes > 0) {
      const target = new Date(Date.now() + minutes * 60000);
      parsed = { hour: target.getHours(), minute: target.getMinutes() };
    }
  }

  if (!parsed) parsed = parseTimeFromText(text);
  if (!parsed) return null;
  const hh = String(parsed.hour).padStart(2, '0');
  const mm = String(parsed.minute).padStart(2, '0');
  // Extract optional label — "alarm for the gym", "alarm called standup"
  const labelMatch = text.match(/(?:for|called|label(?:ed)?)\s+(?:the\s+)?(.+?)(?:\s+at\s+|\s+in\s+|$)/i);
  const DATE_WORDS = /^(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|noon|midnight)$/i;
  const rawLabel = labelMatch?.[1]?.trim() ?? '';
  const label = (!rawLabel || DATE_WORDS.test(rawLabel)) ? 'Herald Alarm' : rawLabel;
  return { time: `${hh}:${mm}`, label };
}

export function parseTimerIntent(text: string): { minutes: number; label: string } | null {
  const isTimer = /\b(timer|countdown)\b/i.test(text);
  if (!isTimer) return null;
  // "20 minutes", "2 hours", "90 seconds"
  const t = text.toLowerCase();
  const rel = t.match(/\bin\s+(?:an?\s+)?(\d+)?\s*(minute|min|hour|hr|second|sec)\b/i)
           ?? t.match(/\bfor\s+(?:an?\s+)?(\d+)?\s*(minute|min|hour|hr|second|sec)\b/i)
           ?? t.match(/\b(\d+)[\s-]*(minute|min|hour|hr|second|sec)\b/i);
  if (!rel) return null;
  const amount = parseInt(rel[1] ?? '1');
  const unit = rel[2].toLowerCase();
  let minutes = 0;
  if (unit.startsWith('h')) minutes = amount * 60;
  else if (unit.startsWith('s')) minutes = Math.ceil(amount / 60);
  else minutes = amount;
  if (minutes <= 0) return null;
  return { minutes, label: 'Herald Timer' };
}

/** Returns handleCalendarAction value string: title|YYYY-MM-DD|HH:MM */
export function parseCalendarWriteIntent(text: string): string | null {
  const hasCalendar = /\b(calendar|schedule)\b/i.test(text);
  const hasWriteVerb = /\b(put|add|schedule|create|book|make)\b/i.test(text);
  if (!hasCalendar || !hasWriteVerb) return null;

  const isRead =
    /\b(what('s| is)|what do i have|do i have anything|anything on my|show me my)\b/i.test(text) &&
    !hasWriteVerb;
  if (isRead) return null;

  // Empty when no frame matches — never invent a title (Trust First / verbatim).
  let title = '';
  const titleMatch =
    text.match(/\bput (.+?) on my calendar/i) ??
    text.match(/\badd (.+?) to (?:my )?calendar/i) ??
    text.match(/\bschedule (.+?) on (?:my )?calendar/i) ??
    // Inverted order: verb + calendar first, title after
    text.match(/\badd (?:to|on) (?:my )?calendar\s+(.+)/i) ??
    text.match(/\bput (?:to|on) (?:my )?calendar\s+(.+)/i) ??
    text.match(/\bschedule (?:to|on) (?:my )?calendar\s+(.+)/i);
  if (titleMatch?.[1]) {
    const raw = titleMatch[1].trim();
    if (raw && !/^(that|this|it)$/i.test(raw)) {
      title = raw.replace(/\s+(at|on|for)\s+[\d:.apm\s]+.*$/i, '').trim() || raw;
    }
  }

  const parsed = parseTimeFromText(text);
  const time = parsed
    ? `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`
    : '';

  let date = '';
  if (/\btomorrow\b/i.test(text)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    date = d.toLocaleDateString('en-CA');
  } else if (/\btoday\b/i.test(text)) {
    date = new Date().toLocaleDateString('en-CA');
  }

  return `${title}|${date}|${time}`;
}

// Common message-opener words — never the second word of a contact name.
// Bounded stopgap for greedy name capture; durable fix is contact-anchored
// splitting in the C-4 contact_text arc.
const SMS_BODY_OPENERS = /^(?:how|what|when|where|why|that|to|about|i|i'm|im|hi|hey|hello|please|can|could|will|would|are|is|do|don't|dont|good|thanks|thank|the|a|your|you're|youre|happy|call|come|meet|see|be|we|let's|lets)$/i;

export function parseSmsIntent(text: string): { contact: string; message: string } | null {
  const patterns: RegExp[] = [
    /\b(?:text|message|msg)\s+(?:my\s+(?:son|daughter|wife|husband|mom|dad|mother|father|brother|sister|grandson|granddaughter)\s+)?((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+(?!(?:how|what|when|where|why|that|to|about|i|i'm|im|hi|hey|hello|please|can|could|will|would|are|is|do|don't|dont|good|thanks|thank|the|a|your|you're|youre|happy|call|come|meet|see|be|we|let's|lets)\b)\w+)?)\s+(.+)/i,
    /\bsend\s+(?:a\s+)?(?:text|message)\s+to\s+(?:my\s+(?:son|daughter|wife|husband|mom|dad|mother|father|brother|sister|grandson|granddaughter)\s+)?((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+(?!(?:how|what|when|where|why|that|to|about|i|i'm|im|hi|hey|hello|please|can|could|will|would|are|is|do|don't|dont|good|thanks|thank|the|a|your|you're|youre|happy|call|come|meet|see|be|we|let's|lets)\b)\w+)?)\s+(?:that\s+|saying\s+)?(.+)/i,
    /\btell\s+(?:my\s+(?:son|daughter|wife|husband|mom|dad|mother|father|brother|sister|grandson|granddaughter)\s+)?((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+(?!(?:how|what|when|where|why|that|to|about|i|i'm|im|hi|hey|hello|please|can|could|will|would|are|is|do|don't|dont|good|thanks|thank|the|a|your|you're|youre|happy|call|come|meet|see|be|we|let's|lets)\b)\w+)?)\s+(?:that\s+)?(.+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const EXCLUDE = /^(me|you|us|them|it|myself|yourself)$/i;
    if (m?.[1] && m?.[2] && !EXCLUDE.test(m[1].trim())) {
      return { contact: m[1].trim(), message: m[2].trim() };
    }
  }
  return null;
}

export function parseReminderIntent(
  text: string
): { body: string; time: string } | null {
  const isReminder = /\b(remind me|don't let me forget|remember to|don't forget|set a reminder|reminder to)\b/i.test(text);
  if (!isReminder) return null;

  const parsed = parseTimeFromText(text);
  if (!parsed) return null;

  const hh = String(parsed.hour).padStart(2, '0');
  const mm = String(parsed.minute).padStart(2, '0');

  // Extract what to be reminded about
  // "remind me to take my pill at 8pm" → "take my pill"
  // "remind me at 3pm to call the doctor" → "call the doctor"
  const bodyMatch =
    text.match(/remind me to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1] ??
    text.match(/(?:set a |a )?reminder to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1] ??
    text.match(/remind me at .+? to (.+)/i)?.[1] ??
    text.match(/don't (?:let me )?forget to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1] ??
    text.match(/remember to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1];

  if (!bodyMatch) return null;

  return { body: bodyMatch.trim(), time: `${hh}:${mm}` };
}
