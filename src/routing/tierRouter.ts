// src/routing/tierRouter.ts
// Herald — query tier classifier and context loader.
// Session L — Device-First Intelligence Layer
// Build 20 fix: additional calendar phrase coverage (Bug 2 from Session L).

import { getCachedEvents, formatCachedEventsForSpeech } from "../db/calendarCacheDB";
import { getFactsSummary } from "../db/factDB";
import { getProfileSummary } from "../db/profileDB";
import { getMedicalSummary } from "../db/medicalDB";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tier = 1 | 2 | 3;

export interface TierDecision {
  tier: Tier;
  tier1Response?: string;
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
  ],
  calendar_tomorrow: [
    /tomorrow/i,
    /what do i have tomorrow/i,
    /any (appointments|meetings|events) tomorrow/i,
    /schedule (for )?tomorrow/i,
  ],
  calendar_week: [
    /this (coming )?week/i,
    /coming week/i,
    /next seven days/i,
    /next 7 days/i,
    /what do i have this week/i,
    /week('s| is) schedule/i,
    /what('s| is) (on|scheduled) this week/i,
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

// ─── classifyQuery ────────────────────────────────────────────────────────────

export function classifyQuery(message: string): TierDecision {
  const msg = message.trim();

  // Tier 1: calendar today — exclude if tomorrow or week is present
  if (
    TIER1_SIGNALS.calendar_today.some((p) => p.test(msg)) &&
    !TIER1_SIGNALS.calendar_tomorrow[0].test(msg) &&
    !TIER1_SIGNALS.calendar_week[0].test(msg)
  ) {
    const events = getCachedEvents("today");
    const response = formatCachedEventsForSpeech(events, "today");
    return { tier: 1, tier1Response: response, reason: "calendar:today" };
  }

  // Tier 1: calendar tomorrow
  if (TIER1_SIGNALS.calendar_tomorrow.some((p) => p.test(msg))) {
    const events = getCachedEvents("tomorrow");
    const response = formatCachedEventsForSpeech(events, "tomorrow");
    return { tier: 1, tier1Response: response, reason: "calendar:tomorrow" };
  }

  // Tier 1: calendar this week
  if (TIER1_SIGNALS.calendar_week.some((p) => p.test(msg))) {
    const events = getCachedEvents("this week");
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