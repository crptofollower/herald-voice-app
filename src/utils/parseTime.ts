// src/utils/parseTime.ts
// Device-side natural language time and intent parser.
// No LLM. No network. Runs entirely on device.
// Used by tierRouter.ts for alarm and SMS intents.

export function parseTimeFromText(text: string): { hour: number; minute: number } | null {
  const t = text.toLowerCase().replace(/\b(a)\.(m)\./gi, 'am').replace(/\b(p)\.(m)\./gi, 'pm');

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
  // Heuristic: 6-11 = AM, 12 = noon, 1-5 = PM, default PM for ambiguous
  const plainHour = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*[ap]m)/i);
  if (plainHour) {
    let h = parseInt(plainHour[1]);
    const m = parseInt(plainHour[2] ?? '0');
    // Smart AM/PM inference
    if (h === 12) { /* noon — leave as 12 */ }
    else if (h >= 1 && h <= 5) h += 12; // 1-5 → PM
    else if (h >= 6 && h <= 11) { /* AM — leave as is */ }
    else if (h === 0) h = 0; // midnight
    return { hour: h, minute: m };
  }

  // "in 30 minutes", "in 2 hours", "in an hour"
  const relative = t.match(/\bin\s+(?:an?\s+)?(\d+)?\s*(minute|min|hour|hr)/i);
  if (relative) {
    const amount = parseInt(relative[1] ?? '1');
    const unit = relative[2].toLowerCase();
    const now = new Date();
    const minutes = unit.startsWith('h') ? amount * 60 : amount;
    const target = new Date(now.getTime() + minutes * 60000);
    return { hour: target.getHours(), minute: target.getMinutes() };
  }

  // Named times
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
    if (t.includes(word)) return { hour: h, minute: m };
  }

  return null;
}

export function parseAlarmIntent(text: string): { time: string; label: string } | null {
  const isAlarm = /\b(alarm|wake me|wake up)\b/i.test(text);
  if (!isAlarm) return null;
  const parsed = parseTimeFromText(text);
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
           ?? t.match(/\b(\d+)\s*(minute|min|hour|hr|second|sec)\b/i);
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

export function parseSmsIntent(text: string): { contact: string; message: string } | null {
  const patterns: RegExp[] = [
    /\b(?:text|message|msg)\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+\w+)?)\s+(.+)/i,
    /\bsend\s+(?:a\s+)?(?:text|message)\s+to\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+\w+)?)\s+(?:that\s+|saying\s+)?(.+)/i,
    /\btell\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+(?:\s+\w+)?)\s+(?:that\s+)?(.+)/i,
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
  const isReminder = /\b(remind me|don't let me forget|remember to|don't forget)\b/i.test(text);
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
    text.match(/remind me at .+? to (.+)/i)?.[1] ??
    text.match(/don't (?:let me )?forget to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1] ??
    text.match(/remember to (.+?)(?:\s+at\s+|\s+in\s+|$)/i)?.[1];

  if (!bodyMatch) return null;

  return { body: bodyMatch.trim(), time: `${hh}:${mm}` };
}
