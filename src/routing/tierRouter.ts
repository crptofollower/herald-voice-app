// src/routing/tierRouter.ts
// Herald — query tier classifier and context loader.
// Session L — Device-First Intelligence Layer
// Build 20 fix: additional calendar phrase coverage (Bug 2 from Session L).

import { getCachedEvents, formatCachedEventsForSpeech, refreshCalendarCache, getCacheAge, getCachedEventsForDate, formatEventsForSpecificDay } from "../db/calendarCacheDB";
import { getAppointmentsForLocalDate, formatAppointmentsForSpecificDay } from "../db/appointmentsDB";
import { calendarWriteIsRecent } from "../db/calendarState";
import { getFactsSummary } from "../db/factDB";
import { normalizeInput } from "../utils/normalizeInput";
import { getProfileSummary, getProfileField } from "../db/profileDB";
import { getMedicalSummary, composeMedicalSummary, getMedicalRecords, getDiagnosisSummary, getDoctorsSummary } from "../db/medicalDB";
import { getRecentMentions, formatRecentMentions } from "../db/recallDB";
import { detectMedicalEvent, extractDoctorName } from "../utils/detectMedicalEvent";
import type { MedicalEvent } from "../utils/detectMedicalEvent";
import { MONTHS, CALENDAR_WRITE_TRIGGER, CALENDAR_WRITE_NAMED_APPOINTMENT, parseDatePhrase } from "../utils/parseTime";
import { PERSON_RELATIONSHIP_ALTERNATION, normalizePersonTarget, liftRelationshipName } from "../utils/personReference";
import { detectHouseholdRead, type HouseholdReadIntent } from "../utils/householdRead";
import { detectServiceRemove, detectPhoneCapture } from "../utils/householdCapture";
import { detectFamilyRead, answerFamilyRead } from "../utils/familyRead";
import {
  REMINDER_SIGNALS,
  NOTE_CAPTURE_SIGNALS,
  LIST_ADD_SIGNALS,
  TODO_ADD_SIGNALS,
  TODO_ADD_PREFIX,
  extractTodoAdd,
  extractResidualTodoAdd,
  boundCapturedTail,
  splitResidualClauses,
  COMPLETED_PAST_FIRST_PERSON_RE,
  THIRD_PERSON_REFERENT_RE,
} from "../utils/instructionSignals";
import { isReferentVisitOutcomeQuestion, isReferentUpcomingVisitQuestion, isReferentYearBoundedVisitQuestion, answerUpcomingCalendarEvidence, answerUpcomingGenericDoctorCalendarEvidence } from "./conversationalSubject";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tier = 1 | 2 | 3;

export interface TierDecision {
  tier: Tier;
  tier1Response?: string;
  isMedical?: boolean;   // tier-1 medical reads — deterministic template only; no generative path exists (Spine §3)
  actionIntent?:
    | { type: 'alarm';    time: string;  label: string }
    | { type: 'timer'; minutes: number; label: string }
    | { type: 'sms';     contact: string; message: string }
    | { type: 'time' }
    | { type: 'date' }
    | { type: 'call';    contact: string }
    | { type: 'navigation'; destination: string }
    | { type: 'reminder'; body: string; time: string }
    | { type: 'note_capture'; body: string }
    | { type: 'note_read' }
    | { type: 'list_add'; items: string[]; listName: string }
    | { type: 'list_remove'; item: string; listName: string }
    | { type: 'list_read'; listName: string }
    | { type: 'list_clear'; listName: string }
    | { type: 'list_update'; oldItem: string; newItem: string; listName: string }
    | { type: 'todo_add'; body: string }
    | { type: 'todo_read' }
    | { type: 'todo_complete'; raw: string }
    | { type: 'calendar_write'; value: string }
    | { type: 'medical_capture'; event: MedicalEvent }
    | { type: 'medical_remove'; name: string }
    | { type: 'medical_clear' }
    | { type: 'household_read'; intent: HouseholdReadIntent }
    | { type: 'household_remove'; categories: string[]; spoken: string }
    | { type: 'photo_open' }
    | { type: 'app_open'; appName: string }
    | { type: 'profile_update'; field: string; value: string };
  localContext?: LocalContext;
  reason: string;
  /** Ordered IDs from the same getActiveMedications() array that produced medical:summary speech. IDs only. */
  presentedMedicationIds?: string[];
}

export interface LocalContext {
  facts?: string;
  profile?: string;
  medical?: string;
  intent?: string;
}

// ─── Calendar composable authorities ─────────────────────────────────────────
// Free contiguous cores: calendar-specific AND self-contained request shape →
//   substring OK (the fragment itself is the calendar request).
// Whole-utterance shapes: everything else that can authorize a read — weak NPs,
//   shape-less calendar NPs, and topic-generic request openers — must be the
//   utterance's own request shape (^…$), not an embedded fragment.
// C = positive calendar-write evidence
// Auth: calendar read = (free ∨ whole-utterance ∨ travel) AND scope/today-default.
// Bare temporal ≠ auth. Embedded narrative/reported-speech fragments ≠ auth.

/**
 * Free contiguous request cores — both calendar-domain and self-contained
 * interrogative in one fragment. Safe as substrings.
 * Only "on my calendar" / "my schedule" pass both axes; generics are TERSE-only.
 */
const CALENDAR_READ_FREE: RegExp[] = [
  /\bwhat(?:'s| is) (?:on my calendar|my schedule)\b/i,
];

/** Shared weekday-name source — used by the calendar request-shape
 * temporal tail below and by NAMED_WEEKDAY inside classifyQuery. One
 * definition, two consumers in this file — a second, independent list
 * already exists in parseDatePhrase (parseTime.ts); unifying across
 * files is a separate, larger move and not needed for this fix. */
const WEEKDAY_NAMES =
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday';

/** Temporal tail allowed in a whole-utterance calendar read shape.
 * Fixed-window enum (today/tomorrow/this week/next week) plus a
 * resolvable-weekday shape (optional next/this/last/on qualifier +
 * weekday name) — SHAPE only, mirrors the grammar parseDatePhrase()
 * actually resolves downstream. Does not call parseDatePhrase() and
 * does not itself establish calendar intent: every pattern below
 * already anchors on its own calendar-noun-phrase prefix (^what's
 * scheduled, ^on my calendar, ^do i have anything, etc) — this only
 * lets that already-proven shape recognize a broader trailing date
 * phrase than the four original windows, using the exact same
 * connector-plus-temporal slot every pattern already reserves. */
const CALENDAR_TERSE_TEMPORAL =
  '(?:today|tomorrow|this(?:\\s+coming)?\\s+week|coming\\s+week|next\\s+week|next\\s+(?:7|seven)\\s+days' +
  `|(?:next|this|last|on)?\\s*(?:${WEEKDAY_NAMES}))`;

/**
 * Whole-utterance calendar-read shapes (same anchoring technique throughout).
 * Covers weak NPs, shape-less calendar vocabulary, and topic-generic openers
 * that only become calendar requests when the utterance is that request.
 * "what's happening/going on" deliberately omitted — not calendar-specific.
 */
const CALENDAR_READ_TERSE: RegExp[] = [
  // "My schedule next week." / "What's my schedule for tomorrow?"
  new RegExp(
    `^(?:what(?:'s| is)\\s+)?my\\s+schedule(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // "On my calendar next week." / "On my schedule for this week."
  new RegExp(
    `^(?:what(?:'s| is)\\s+)?on\\s+my\\s+(?:calendar|schedule)(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // "Week's schedule?" / "My week's schedule." / "What's my week's schedule?"
  /^(?:what(?:'s| is)\s+)?(?:my\s+)?week(?:'s| is)\s+schedule\s*[?.!]*$/i,
  // "Calendar next week."
  new RegExp(
    `^calendar(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // "What do I have next week?" / "What do I have scheduled next week?"
  // Not: "What do I have to pack for the trip next week?"
  new RegExp(
    `^what\\s+do\\s+i\\s+have(?:\\s+scheduled)?(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // "Do I have anything scheduled next week?" / "Do I have anything on my calendar?"
  // Not: "Do I have anything else to bring before next week?"
  new RegExp(
    `^do\\s+i\\s+have\\s+(?:anything|something)(?:\\s+scheduled)?(?:\\s+on\\s+(?:my\\s+)?(?:calendar|schedule))?(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // "What's scheduled next week?" / "What's planned for tomorrow?"
  new RegExp(
    `^what(?:'s| is)\\s+(?:scheduled|planned)(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // Shape-less calendar NP: "Any appointments next week?" / "Any meetings today?"
  new RegExp(
    `^any\\s+(?:appointments|meetings|events)(?:\\s+(?:on\\s+my\\s+(?:calendar|schedule))?(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?|\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // Shape-less: "Anything on my calendar today or this week?" / "Anything scheduled?"
  new RegExp(
    `^anything\\s+(?:on|scheduled)(?:\\s+my\\s+(?:calendar|schedule))?(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?(?:\\s+or\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // Topic-generic opener + calendar object/scope: "Is there anything on my calendar for next week?"
  new RegExp(
    `^is\\s+there\\s+anything(?:\\s+(?:on|scheduled)(?:\\s+(?:on\\s+)?my\\s+(?:calendar|schedule))?|\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
  // Topic-generic opener + calendar object/scope: "Show me this week." / "Show me my schedule…"
  new RegExp(
    `^show\\s+me\\s+(?:(?:my\\s+)?(?:schedule|calendar)|(?:my\\s+)?week(?:'s| is)\\s+schedule|(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})(?:\\s+(?:for\\s+)?${CALENDAR_TERSE_TEMPORAL})?\\s*[?.!]*$`,
    'i',
  ),
];

// Travel/agenda probes historically route to the week window (unchanged behavior).
const CALENDAR_TRAVEL_READ: RegExp[] = [
  /\bany (flights?|hotels?|stays?|trips?|travel|reservations?)\b/i,
  /\bdo i have any (flights?|hotels?|stays?|trips?|travel|appointments?|meetings?|events?|reservations?)\b/i,
  /\bam i (traveling|flying|staying|booked)\b/i,
  /\bwhat (flights?|hotels?|trips?|reservations?) do i have\b/i,
  /\bis there (a |any )?.*(hotel|flight|stay|trip|reservation)/i,
  /\bany (upcoming|scheduled) (travel|trips?|flights?)\b/i,
];

/** Phrases that default to the today window when no other temporal scope is present. */
const CALENDAR_TODAY_DEFAULT_READ: RegExp[] = [
  /\bwhat(?:'s| is) on my calendar\b/i,
  /\banything on my calendar\b/i,
  /\bdo i have anything scheduled\b/i,
];

function hasCalendarReadEvidence(msg: string): boolean {
  const trimmed = msg.trim();
  return (
    CALENDAR_READ_FREE.some((p) => p.test(trimmed)) ||
    CALENDAR_READ_TERSE.some((p) => p.test(trimmed))
  );
}

function hasCalendarTravelRead(msg: string): boolean {
  return CALENDAR_TRAVEL_READ.some((p) => p.test(msg));
}

function hasTodayScope(msg: string): boolean {
  return /\btoday\b/i.test(msg);
}
function hasTomorrowScope(msg: string): boolean {
  return /\btomorrow\b/i.test(msg);
}
/**
 * Bare this-week / coming-week / next-7-days — exclusion + scope, never sole auth.
 * Approved "week's schedule" / "week is schedule" also establishes week scope
 * (no separate "this week" token required).
 */
function hasThisWeekScope(msg: string): boolean {
  return (
    /\bthis(?:\s+coming)?\s+week\b/i.test(msg) ||
    /\bcoming week\b/i.test(msg) ||
    /\bnext seven days\b/i.test(msg) ||
    /\bnext 7 days\b/i.test(msg) ||
    /\b(?:my\s+)?week(?:'s| is)\s+schedule\b/i.test(msg)
  );
}
function hasNextWeekScope(msg: string): boolean {
  return /\bnext week\b/i.test(msg);
}

/**
 * Positive write evidence only. Clear write verbs always count.
 * "schedule" counts as a verb only when the utterance is not read-shaped and
 * not the noun phrase "my schedule" — never via broad "schedule for" negation.
 */
function hasPositiveCalendarWriteEvidence(msg: string): boolean {
  if (/\b(put|add|create|book|make)\b/i.test(msg)) return true;
  if (/\bmy schedule\b/i.test(msg)) return false;
  if (hasCalendarReadEvidence(msg)) return false;
  // Transitive / article forms: "schedule lunch", "schedule a dentist"
  return /\bschedule\s+(?:a|an|[a-z])/i.test(msg);
}

function isCalendarReadIntent(msg: string): boolean {
  return hasCalendarReadEvidence(msg) || hasCalendarTravelRead(msg);
}

// ─── Signal groups ────────────────────────────────────────────────────────────

const TIER1_SIGNALS = {
  medical: [
    /what (medication|medications|meds|pills) am i (on|taking)/i,
    /my (medication|medications|meds|prescriptions)/i,
    /medical (history|records|info)/i,
    /what do you (have|know) about my (health|medical|medications|meds)/i,
    /what (medication|medications|meds|pills|prescriptions) do you (have|know)/i,
    /do you (have|know) (my|any of my) (medication|medications|meds|pills|prescriptions)/i,
    /\bwhat do i take\b/i,
    /\bwhat am i (taking|on)\b/i,
    /\bwhat (should i|do i) take\b/i,
    /\bmy (meds|medications|pills|prescriptions)\b/i,
    /\bdo i take (any )?(medication|meds|pills)\b/i,
    /\bwhat (medication|medications|medicine|meds|pills|prescriptions) do i take\b/i,
    /\bam i (on|taking) (any )?(medication|medications|meds|pills|prescriptions)\b/i,
  ],
  visit_read: [
    /\bwho (did|have) i seen?\b/i,
    /\bwho did i see\b/i,
    /\bwho have i seen\b/i,
    /\bwhich doctors? (did|have) i\b/i,
    /\bwhat doctors? (did|have) i\b/i,
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
    /\bdo you know my (first|last|middle|full|maiden|legal) name\b/i,
    /\bwhat('s| is) my (first|last|middle|full|maiden|legal) name\b/i,
    /\bwhat('s| is) my age\b/i,
    /\bhow old am i\b/i,
    /\bdo you know (how old i am|my age)\b/i,
  ],
};

// ─── Greeting ──────────────────────────────────────────────────────────────
// Deterministic, no LLM. Matches a bare greeting, or a greeting addressed to
// whatever ai_name is CURRENTLY configured — read fresh at call time, never
// hardcoded, so any future companion name works with zero code changes.
// A greeting addressed to any OTHER name (e.g. "Hello Herald" when
// ai_name = "Kit") is deliberately left unmatched — whether the product
// brand name is a permanent greeting alias is a separate product decision,
// not established here (2026-07-30).
const GREETING_WORDS = /^(hello|hi|hey)$/i;

export function isGreeting(text: string, aiName: string | null): boolean {
  const cleaned = text.trim().replace(/[!.,?]+$/, '');
  if (!cleaned) return false;
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) {
    return GREETING_WORDS.test(parts[0]);
  }
  if (parts.length === 2 && aiName) {
    return GREETING_WORDS.test(parts[0]) && parts[1].toLowerCase() === aiName.trim().toLowerCase();
  }
  return false;
}

// Diagnosis reads — "what's my diagnosis", "what was I diagnosed with", "what
// conditions do I have". Own branch + reader (getDiagnoses) so a diagnosis question
// never falls to the meds/doctor summary or drops to tier 3.
const DIAGNOSIS_READ_SIGNALS = [
  /\bwhat('?s| is| are)\s+my\s+(diagnosis|diagnoses|condition|conditions)\b/i,
  /\bwhat\s+(?:was|were|have)\s+i\s+diagnosed\s+with\b/i,
  /\bwhat\s+(?:medical\s+)?conditions?\s+do\s+i\s+have\b/i,
  /\bdo\s+i\s+have\s+(?:any\s+)?(?:diagnos\w+|medical\s+conditions?)\b/i,
];

// Doctor reads — own reader (§4a one-reader). "Who is/are my doctor(s)" must
// never resolve to the medication summary. Answers from medical_records
// doctor_name rows; empty → honest miss, never a confident wrong read.
const DOCTOR_READ_SIGNALS = [
  /\bwho\s+(?:is|are)\s+my\s+(?:doctor|doctors|physician|physicians|specialist|specialists)\b/i,
  /\bwho'?s\s+my\s+(?:doctor|doctors|physician|physicians|specialist|specialists)\b/i,
  /\bwhat(?:'s| is)\s+my\s+doctor'?s?\s+name\b/i,
  /\bdo\s+(?:i|you)\s+(?:have|know)\s+(?:a\s+|my\s+)?(?:doctor|physician|gp|general practitioner)\b/i,
  /\bmy\s+doctors?\b.*\bname/i,
];

// Doctor summary composer — "tell me about Dr X" and close paraphrases only.
// Deliberately NOT widened to specialty references ("my cardiologist") — a
// separate vocabulary expansion, out of scope for this session.
const DOCTOR_SUMMARY_READ: RegExp[] = [
  /\btell me about\s+dr\.?\s/i,
  /\bwhat do you know about\s+dr\.?\s/i,
  /\bgive me (?:a )?(?:summary|rundown|update) on\s+dr\.?\s/i,
];

const VISIT_HISTORY_READ = [
  /\bwhen did i (?:last )?see\b/i,
  /\b(?:when|what) was the last time i (?:saw|see)\b/i,
  /\bwhen was my (?:last )?(?:appointment|visit)\b/i,
  /\bwhat was (?:it|that) for\b/i,
  // 2026-08-20 (Continuity audit v2 §3.1): subject-complement "who was the
  // last doctor" forms. Answered here rather than by visit_read because
  // getVisitSummary enumerates every doctor ever seen, which does not answer
  // "the last one." getLastVisit names the doctor AND the date.
  /\bwho was (?:the|my) last (?:doctor|physician)\b/i,
];

// Upcoming medical appointment recall — explicit medical/doctor FUTURE
// queries + named-doctor future queries only. Deliberately excludes generic
// "what appointments do I have" (no medical token) and timeframe-scoped
// medical queries ("this week"/"tomorrow"/"next week" — those stay with the
// calendar reader this build does not touch). Each pattern requires BOTH a
// medical token (doctor/medical/Dr.) AND a forward marker (coming up / next /
// do I have / when do I see / with Dr X), so it cannot steal the past-tense
// visit_read / VISIT_HISTORY_READ phrases or the calendar branches.
// "next" list-vs-single is disambiguated at dispatch, not here.
const UPCOMING_MEDICAL_READ = [
  /\b(?:doctor|medical)\s+appointments?\b[\s\S]*\b(?:coming up|do i have|upcoming)\b/i,
  /\b(?:do i have|have i got)\b[\s\S]*\b(?:doctor|medical)\s+(?:appointments?|visits?)\b/i,
  /\b(?:doctor|medical)\s+(?:appointments?|visits?)\b[\s\S]*\bcoming up\b/i,
  /\bwhen(?:'s| is)?\s+my\s+next\s+(?:doctor|medical)\s+appointment\b/i,
  /\bwhen(?:'s| is)?\s+my\s+next\s+appointment\s+with\s+dr\.?\s/i,
  /\bwhen do i see\s+dr\.?\s/i,
  /\bwhen am i seeing\s+dr\.?\s/i,
  /\bwhen(?:'s| is)?\s+my\s+appointment\s+with\s+dr\.?\s/i,
  /\bdo i have\b[\s\S]*\b(?:coming up|upcoming)\b[\s\S]*\bwith\s+dr\.?\s/i,
];

// Requests that want only the SINGLE nearest upcoming appointment, not the
// list ("when is my next doctor appointment", "when do I see Dr X",
// "appointment with Dr X"). Everything else in UPCOMING_MEDICAL_READ lists.
const UPCOMING_MEDICAL_SINGLE = [
  /\bnext\s+(?:doctor|medical)\s+appointment\b/i,
  /\bnext\s+appointment\s+with\s+dr\.?\s/i,
  /\bwhen do i see\s+dr\.?\s/i,
  /\bwhen am i seeing\s+dr\.?\s/i,
  /\bappointment\s+with\s+dr\.?\s/i,
];

// Visit OUTCOME read — two speech-act paths, OR'd. Distinct §4a reader from
// visit_read (who) and VISIT_HISTORY_READ (when/why); reads
// medical_records.visit_outcome via getLastVisitOutcomeSummary. Deterministic,
// offline, never the LLM (Spine §3).
//
// 2026-08-16 (doctor-communication ownership): one AND-formula cannot govern
// both speech acts. Communication ("what did the doctor say/tell") does not
// require an appointment noun; retrospective ("how did/was / what happened")
// still does. The existing `what did … say|tell` and `how did|how was|what
// happened` alternatives are split, not expanded. DOCTOR_REFERENCE on the
// communication path is tested against the matched cue SPAN so the doctor is
// the speaker ("What did my doctor say?") and "What did I tell my doctor?"
// does not steal visit-outcome.
//
// Fix 1 history, kept:
// - communication cue recognizes "tell" alongside "say"
// - APPOINTMENT_CONTEXT: visits? ; tell me / told me (retrospective path only)
const DOCTOR_COMMUNICATION_CUE = /\bwhat did\b[\s\S]*?\b(?:say|tell)\b/i;
const APPOINTMENT_RETROSPECTIVE_CUE = /\b(?:how did|how was|what happened)\b/i;
const APPOINTMENT_CONTEXT = /\b(?:appointment|visits?|check-?up|last time|tell\s+me|told\s+me)\b/i;
const DOCTOR_REFERENCE = /\b(?:dr\.?\s*\w+|(?:the|my) doctor)\b/i;

// Fix 1 Part B -- explicit-name guard (source-confirmed facts this guard
// depends on: extractDoctorName() resolves only "Dr"/"Dr." forms and
// returns undefined for spelled-out "doctor <name>"; getLastVisitOutcomeSummary
// intentionally returns the latest outcome globally when called with an
// undefined hint -- correct for a genuinely unhinted "my/the doctor" ask).
// The gap: an utterance can explicitly name a doctor in a form
// extractDoctorName doesn't parse ("my doctor Smith"), producing the same
// falsy doctorHint as a genuinely unhinted ask -- silently calling the
// unhinted reader in that case can return a DIFFERENT doctor's outcome.
// This is a SHAPE check only, never a name resolver: "(my|the) doctor
// <token>" where <token> is not one of a small closed set of reporting/
// function words that legitimately follow "doctor" without naming anyone.
// Anything not in that excluded set is treated, conservatively, as a
// possible name -- biased toward failing closed, never toward guessing.
const DOCTOR_NAME_CONTINUATION_EXCLUSIONS =
  '(?:said|says|say|tell|tells|told|mentioned|thinks|thought|wants|wanted|recommended|prescribed|is|was|has|had|will|would)';
const NAMED_BUT_UNRESOLVED_DOCTOR_RE = new RegExp(
  `\\b(?:my|the)\\s+doctor\\s+(?!${DOCTOR_NAME_CONTINUATION_EXCLUSIONS}\\b)[a-z']+\\b`,
  'i'
);

function isDoctorCommunicationRead(msg: string): boolean {
  const cue = msg.match(DOCTOR_COMMUNICATION_CUE);
  if (!cue?.[0]) return false;
  return DOCTOR_REFERENCE.test(cue[0]);
}

function isAppointmentRetrospectiveRead(msg: string): boolean {
  return (
    APPOINTMENT_RETROSPECTIVE_CUE.test(msg) &&
    APPOINTMENT_CONTEXT.test(msg) &&
    DOCTOR_REFERENCE.test(msg)
  );
}

function isVisitOutcomeRead(msg: string): boolean {
  return isDoctorCommunicationRead(msg) || isAppointmentRetrospectiveRead(msg);
}

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

// Temporal recall (Rung 4) — requires BOTH a temporal marker AND a speech verb, so
// timeless "what have I told you" falls through to TIER2 unchanged. "just now" only —
// bare conversational "what were we just talking about" is thread-recall (Zustand
// store, not SQLite rows) and is a separate future item, deliberately not caught here.
const TEMPORAL_RECALL_MARKER =
  /\b(earlier|recently|today|this (?:morning|afternoon|evening)|just now|a (?:minute|moment|little while|bit) ago|lately)\b/i;
// SESSION 2026-08-14: narrowed from bare reported-speech verbs (which matched
// third-person narrative like "he said", "she told me") to require the verb
// be anchored to the USER as speaker (first-person "I said/told/mentioned")
// or phrased as an explicit question to Herald ("what did I say", "did I
// mention"). Bare third-person reported speech inside an ordinary personal
// narrative must never satisfy this gate — see Rung-4 false-positive fix,
// mechanism-tier per Engineering Principles Rule 11 (routing is in scope).
const TEMPORAL_RECALL_VERB =
  /\b(?:i\s+(?:mention(?:ed)?|told\s+you|brought\s+up|was\s+saying|said)|did\s+i\s+(?:mention|say|tell\s+you|bring\s+up)|what\s+did\s+i\s+(?:say|mention|tell\s+you|bring\s+up)|remind\s+me\s+what\s+i(?:'ve| have)?\s+(?:said|told|mentioned))\b/i;

// Pure predicate, exported for unit testing. Encapsulates the exact
// three-part gate previously inlined at the temporal-recall tier-1 check.
export function isTemporalRecallRequest(msg: string): boolean {
  return (
    TEMPORAL_RECALL_MARKER.test(msg) &&
    TEMPORAL_RECALL_VERB.test(msg) &&
    !RECALL_UNCOVERED_DOMAIN.test(msg)
  );
}
// Domains recall can't yet see — if named, bail so that domain's reader answers.
const RECALL_UNCOVERED_DOMAIN =
  /\b(medication|medications|meds|pills?|prescriptions?|doctor|physician|insurance|policy|appointment|calendar|plumber|hvac|electrician|roofer|lawn|mechanic)\b/i;

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

const CHIT_CHAT_SOCIAL_CHECKIN: RegExp[] = [
  /^how(?:'s| is) it going\s*[?.!]*$/i,
  /^how are you\s*[?.!]*$/i,
  /^how (?:are you|you) doing\s*[?.!]*$/i,
];

const CHIT_CHAT_AVAILABILITY: RegExp[] = [
  /^i just wanted to (?:chat|talk)\s*[?.!]*$/i,
  /^i'?m just talking\s*[?.!]*$/i,
  /^i was just talking to you\s*[?.!]*$/i,
  /^i thought i'?d have a conversation with you\s*[?.!]*$/i,
];

const CHIT_CHAT_IDENTITY: RegExp[] = [
  /^who are you\s*[?.!]*$/i,
  /^what are you\s*[?.!]*$/i,
  /^tell me about yourself\s*[?.!]*$/i,
  /^what do you know about yourself\s*[?.!]*$/i,
  /^what(?:'s| is) your purpose\s*[?.!]*$/i,
];

const CHIT_CHAT_RESPONSES = {
  social_checkin: "I'm here and ready. How are you doing?",
  availability: "That's okay. We can just talk.",
  identity: "I'm Kit, your personal memory companion. I help you remember what matters and find it when you need it.",
  capability: "You can just talk to me. I can remember useful things you tell me about your family, doctors, and medications, help with lists, and call or text people for you. If you're not sure where to start, just tell me what's going on.",
} as const;

const CHIT_CHAT_CAPABILITY: RegExp[] = [
  /^what can you do\s*[?.!]*$/i,
  /^what can i ask you\s*[?.!]*$/i,
  /^can you help me\s*[?.!]*$/i,
  /^can you help me with my phone\s*[?.!]*$/i,
  /^i don'?t know what to ask\s*[?.!]*$/i,
  /^i don'?t know what to do\s*[?.!]*$/i,
  /^i don'?t know what to do with this\s*[?.!]*$/i,
];

const WHATS_UP_PATTERN = /^what(?:'s| is) up\s*[?.!]*$/i;

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
  // Short natural commands — "Call Paul", "Please call David", "Can you call Mom"
  /^\s*(?:please\s+)?(?:can you\s+)?(?:call|phone|dial|ring)[,:]?\s+[A-Za-z]/i,
  /\b(?:please\s+)?(?:call|phone|dial|ring)[,:]?\s+(?:to\s+)?[A-Za-z]/i,
  /\bcan you (?:please\s+)?(call|phone)\s+[A-Za-z]/i,
  /\bgive\s+[A-Za-z][A-Za-z'-]*\s+a (call|ring)\b/i,
  // grandson/granddaughter added via shared PERSON_RELATIONSHIP_ALTERNATION (was missing here)
  new RegExp(String.raw`\b(call|ring|phone|dial)\s+(my\s+)?(${PERSON_RELATIONSHIP_ALTERNATION})\b`, 'i'),
];

const DIRECTIONS_SIGNALS = [
  /\b(directions?|navigate|navigation)\s+to\b/i,
  /\btake me to\b/i,
  /\bhow do i get to\b/i,
  /\bget me to\b/i,
  /\bdrive to\b/i,
];

/** Phone-number statement — let ChatScreen phone-capture handle, not call intent. */
const CALL_NUMBER_STATEMENT = /(?:number|phone|cell|mobile)\s+(?:is\s+)?[\d\s\-\(\)\+\.]{7,}/i;
/** Possessive contact-info statement ("Hunter's phone number is...", "Mike's cell ...") — a statement of fact, never a call command. */
const POSSESSIVE_CONTACT_STATEMENT = /\b\w+'s\s+(?:phone|cell|mobile|number)/i;
/** Read-query prefix — utterances beginning with these words are reads, never call commands.
 *  Robust to STT omitting apostrophes (Samsung on-device engine). */
const READ_QUERY_PREFIX = /^\s*(what|who|where|when|do you|can you tell|have you|is there|how|which|tell me|do i)\b/i;

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

const LIST_READ_SIGNALS = [
  /\b(tell|read\s+me|show)\s+(me\s+)?(my|the)\s+(\w+\s+)?list\b/i,
  /\bwhat('s| is) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bwhat('s| is) on (the )?(grocery |shopping |to.?do )?\blist\b/i,
  /\bshow (me )?my (grocery |shopping |to.?do |)\blist\b/i,
  /\bread (me )?my (grocery |shopping |to.?do |)\blist\b/i,
  /\bis there (anything|something) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bcheck my (grocery |shopping |to.?do )?\blist\b/i,
  /\bdo i have (anything|something) on my (grocery |shopping |to.?do )?\blist\b/i,
  /\bdo i have a (grocery |shopping |to.?do )?\blist\b/i,
];

// Dates that route to reminder/calendar instead of todo
const TODO_DATE_SIGNALS = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|at \d|by \d|\d+am|\d+pm|tonight|morning|afternoon|evening)\b/i;

// ── Acquisition-shape disambiguation (todo vs grocery) ──────────────────────
// "I need to pick up X" is ambiguous between an errand (todo) and a grocery item;
// syntax ALONE cannot separate "pick up rib eyes" from "pick up my dry cleaning".
// The deterministic floor disambiguates ONLY when the utterance NAMES grocery
// context — it never guesses which. Marker present → grocery (handled below).
// Marker absent → left to the todo_add default unchanged.
const ACQUISITION_SHAPE =
  /\b(?:need\s+to|have\s+to|gotta|got\s+to|going\s+to|gonna|want\s+to|wanna)\s+(?:go\s+to\s+(?:the\s+)?(?:grocery\s+store|supermarket|grocery|store|shop|market)\s+(?:and\s+)?)?(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\b/i;
const GROCERY_CONTEXT_MARKER =
  /\b(?:grocery|groceries|grocery\s+store|supermarket|shopping\s+list)\b/i;

const TODO_READ_SIGNALS = [
  /\bwhat('s| is) on my (to.?do|todo) list\b/i,
  /\bshow (me )?my (to.?do|todo)s?\b/i,
  /\bwhat do I (need to|have to) do\b/i,
  /\bany (open |pending )?(to.?do|todo)s?\b/i,
  /\bwhat (tasks|things) do I have\b/i,
  /\bdo I have (anything |something )?on my (to.?do|todo) list\b/i,
  /\bis there (anything |something )?on my (to.?do|todo) list\b/i,
];

const TODO_COMPLETE_SIGNALS = [
  COMPLETED_PAST_FIRST_PERSON_RE,
  /\bcross (off|that off)\b/i,
  /\bmark (that |it )?done\b/i,
  /\bthat('s| is) done\b/i,
];

const PHOTO_SIGNALS = [
  /\b(open|show|view|see)\s+(my\s+)?(photos?|pictures?|gallery|images?|album)\b/i,
  /\bphoto\s+(album|library|roll)\b/i,
  /\b(go\s+to|take\s+me\s+to)\s+(my\s+)?(photos?|gallery)\b/i,
];

function escapeAppOpenRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Closed, bounded set of conversational openers. Not a wildcard skip —
// only these exact words (plus the live ai_name) may precede the verb.
const APP_OPEN_DISCOURSE_WORDS = ['hey', 'okay', 'ok', 'um', 'uh', 'so', 'alright', 'please', 'yeah', 'like'];

function buildAppOpenPrefix(): string {
  const words = [...APP_OPEN_DISCOURSE_WORDS];
  const aiName = getProfileField('ai_name'); // read fresh at call time — never hardcoded, same pattern as isGreeting
  if (aiName && aiName.trim()) {
    words.push(escapeAppOpenRegex(aiName.trim()));
  }
  // Up to 3 reps — covers "opener + wake-name" (e.g. "Yeah Kit, ..."). Each
  // rep must be an exact member of this closed list or the exact live
  // ai_name — nothing else can be consumed here.
  return `(?:(?:${words.join('|')})[,]?\\s+){0,3}`;
}

// Continuation/filler words that mark the end of a spoken app name.
const APP_OPEN_STOP_WORDS = new Set([
  'for', 'please', 'and', 'so', 'cause', 'because', 'since', 'when',
  'while', 'that', 'which', 'who', 'before', 'after', 'until', 'though',
  'but', 'or', 'if', 'i', "i've", 'ive', "i'm", 'im', "i'd", 'id',
  'we', "we've", 'weve', 'you', 'can', 'could', 'would', 'will', 'to', 'me',
]);
const APP_OPEN_MAX_WORDS = 4; // safety ceiling only — real boundary is stop-words.

function extractAppOpenName(msg: string): string | null {
  const prefix = buildAppOpenPrefix();
  const imperative = new RegExp(`^${prefix}(?:open|launch|start|pull\\s+up)\\s+(.+)$`, 'i');
  const requestFrame = new RegExp(
    `^${prefix}(?:can|could|would|will)\\s+you\\s+(?:open|launch|start|pull\\s+up)\\s+(.+)$`, 'i'
  );
  const m = imperative.exec(msg) ?? requestFrame.exec(msg);
  if (!m) return null;

  const rest = m[1].replace(/^(?:my|the|an?)\s+/i, ''); // strip one leading determiner

  const words = rest.trim().split(/\s+/);
  const nameWords: string[] = [];
  for (const raw of words) {
    if (nameWords.length >= APP_OPEN_MAX_WORDS) break;
    const bare = raw.replace(/[.,!?;:]+$/, '').toLowerCase();
    if (bare === 'app') break;
    if (APP_OPEN_STOP_WORDS.has(bare)) break;
    nameWords.push(raw.replace(/[.,!?;:]+$/, ''));
  }
  return nameWords.length > 0 ? nameWords.join(' ') : null;
}

const APP_OPEN_SIGNALS = [
  /\b(open|launch|start|pull\s+up)\s+(my\s+)?(banking|bank)\s*(app)?\b/i,
  /\b(open|launch)\s+(my\s+)?(camera)\b/i,
  /\btake\s+a?\s*selfie\b/i,
  // Camera-photo verb coverage (state doc: camera-intent routing gap fix).
  // Unifies "take a picture" / "take a photo" / "snap a picture" /
  // "take a photograph" / "capture a photo" with the existing selfie/camera
  // mechanism, so these never fall through to the medication-capture tier.
  /\b(take|snap|grab)\s+a\s+(picture|photo|photograph|pic)\b/i,
  /\bcapture\s+a\s+(picture|photo|photograph|pic)\b/i,
  // Generic app-open gate (state doc: app_open routing-gap class fix).
  // Must stay LAST in this array — every more specific action (household,
  // calendar, contacts, lists, photos) is already checked earlier in
  // classifyQuery and wins first. This only recognizes the explicit
  // open/launch/start/pull-up <name> shape and hands appName straight to
  // the existing handleLaunchAction registry — it adds zero new app support.
  { test: (m: string) => extractAppOpenName(m) !== null },
];

const LIST_REMOVE_SIGNALS = [
  /\b(take|took|taking|get|got|pull|pulled|knock|knocked|cross|crossed|scratch|scratched|mark|marked)\s+(.+?)\s+(off|from|out\s+of)\s+(?:my\s+|the\s+)?(\w+\s+)?lists?\b/i,
  /\b(remove|take\s+off|delete|cross\s+off)\s+(.+?)\s+(from|off)\s+(my\s+)?(\w+\s+)?list\b/i,
  /\b(?:take|get|knock|pull)\s+(.+?)\s+off\s+(?:my\s+|the\s+)?(?:\w+\s+)?lists?\b/i,
  /\b(i('?ve?)?|we)\s+(got|picked\s+up|grabbed|bought|already\s+have)\s+(?:the\s+)?(.+?)\s*$/i,
  /\b(scratch|cross|mark)\s+off\s+(?:the\s+)?(.+?)\s+(from|on|off)?\s*(my|the)?\s*list\b/i,
];

const LIST_CLEAR_SIGNALS = [
  /\b(clear|empty|reset|wipe)\s+(my\s+)?(\w+\s+)?list\b/i,
  /\bmy\s+list\s+is\s+(done|empty|finished|complete)\b/i,
  /\bwe\s+got\s+everything\b/i,
];

const LIST_UPDATE_SIGNALS = [
  /\b(change|update|replace)\s+(.+?)\s+(to|with)\s+(.+?)(?:\s+on\s+(my\s+)?(\w+\s+)?list)?\s*$/i,
];

const LIST_ADD_CONTEXTUAL_SIGNALS = [
  /\bwe'?re?\s+(out\s+of|running\s+(low|out)\s+on?|almost\s+out\s+of)\s+(.+)/i,
  /\b(need\s+to\s+(pick\s+up|get|buy)|gotta\s+get)\s+(.+)/i,
  /\bdon'?t\s+forget\s+(the\s+)?(.+)/i,
];

function extractContextualGroceryItem(msg: string): string | null {
  if (
    !LIST_ADD_CONTEXTUAL_SIGNALS.some((p) => p.test(msg)) ||
    LIST_ADD_SIGNALS.some((p) => p.test(msg)) ||
    /\bdon'?t\s+forget\s+to\b/i.test(msg)
  ) {
    return null;
  }
  const m =
    msg.match(/\b(?:running\s+(?:low|out)\s+on?|out\s+of|almost\s+out\s+of)\s+(.+)/i) ??
    msg.match(/\b(?:need\s+to\s+(?:pick\s+up|get|buy)|gotta\s+get)\s+(.+)/i) ??
    msg.match(/\bdon'?t\s+forget\s+(?:the\s+)?(.+)/i);
  const item = boundCapturedTail((m?.[1] ?? '').trim());
  return item.length > 0 ? item : null;
}

function extractResidualContextualGroceryItem(msg: string): string | null {
  for (const clause of splitResidualClauses(msg)) {
    const item = extractContextualGroceryItem(clause);
    if (item) return item;
  }
  return extractContextualGroceryItem(msg);
}

const PROFILE_UPDATE_SIGNALS = [
  /\b(change|update|my\s+new)\s+(my\s+)?(insurance|doctor|pharmacy|dentist|specialist|provider)\s+(is\s+|to\s+)(.+)/i,
  /\bI\s+(changed|switched|updated)\s+my\s+(insurance|doctor|pharmacy|dentist)\s+(to\s+)?(.+)/i,
  /\bmy\s+(insurance|doctor|pharmacy|dentist|specialist|provider)\s+(is\s+now|changed\s+to|is)\s+(.+)/i,
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

// ─── Visit read authority (§4a one-reader for the medical_visit domain) ───────
// Deterministic, offline, NEVER the LLM (Spine §3: medical reads never route
// through generative phrasing). Reads the same rows DOMAIN_WRITERS.medical_visit writes.
// NOTE: visit_date is stamped at CAPTURE time (writer uses today's date), so this
// scopes "recently" by when the user TOLD Herald, not the true visit date. Honest
// for the current write path; tighten when the writer captures real visit dates.
// NOTE: no removed_at filter — medical_records gains soft-delete in the v17
// migration; until then nothing can be removed, so there are no rows to exclude.
function getVisitSummary(): string {
  const records = getMedicalRecords().filter((r) => r.doctor_name && r.doctor_name.trim() && r.status !== 'upcoming');
  if (records.length === 0) {
    return "I don't have anyone you've told me you've seen yet.";
  }
  const names: string[] = [];
  for (const r of records) {
    const name = r.doctor_name!.trim();
    if (!names.includes(name)) names.push(name); // de-dupe, keep most-recent-first order
  }
  if (names.length === 1) return `You've seen ${names[0]}.`;
  if (names.length === 2) return `You've seen ${names[0]} and ${names[1]}.`;
  const last = names.pop();
  return `You've seen ${names.join(', ')}, and ${last}.`;
}

// Comparison-only: is the COMPLETE stored doctor name supported by the raw
// utterance? Normalizes both sides (lowercase, strip periods, collapse
// whitespace) and tests the whole stored name as a substring of the whole
// utterance. Never extracts or truncates a name from the utterance — the
// stored name is the thing tested, so a partial capture can never select a
// row. (Founder correction 2026-08-09: no bounded-token doctor extractor in
// this capability.)
function storedNameSupportedByUtterance(storedName: string, utterance: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const n = norm(storedName);
  if (!n) return false;
  return norm(utterance).includes(n);
}

// Deterministic spoken phrasing for upcoming medical appointments. Verbatim
// stored doctor names (Spine §3), existing formatSpokenDate, no LLM. List
// caps at three then "plus N more"; single-nearest and named-doctor variants
// handled by the caller selecting which rows to pass.
function phraseUpcomingAppointments(
  rows: { doctorName?: string; visitDate: string }[],
  formatSpokenDate: (d: string) => string,
): string {
  const capped = rows.slice(0, 3);
  const parts = capped.map((r, i) => {
    const who = r.doctorName?.trim() || 'your doctor';
    const when = formatSpokenDate(r.visitDate);
    return i === 0 ? `${who} on ${when}` : `then ${who} on ${when}`;
  });
  let sentence: string;
  if (parts.length === 1) {
    sentence = `You see ${parts[0]}.`;
  } else {
    sentence = `You have ${parts.join(', ')}.`;
  }
  const remaining = rows.length - capped.length;
  if (remaining > 0) {
    sentence = sentence.replace(/\.$/, `, plus ${remaining} more.`);
  }
  return sentence;
}

// Deterministic spoken phrasing for a named-doctor upcoming-visit read when
// more than one future visit with that doctor already exists (2026-08-10,
// multi-visit named-recall presentation). Sibling to phraseUpcomingAppointments
// (the multi-doctor list) — this one holds the doctor name constant across the
// sentence instead of repeating it per row, since every row here is already
// known to be the same doctor. Verbatim doctor name (Spine §3), existing
// formatSpokenDate, no LLM — presentation only, the caller has already done
// all matching/filtering/sorting. Caps at three spoken visits then "and N more
// after that" — same cap value as phraseUpcomingAppointments, deliberately not
// a second display-limit constant. Exported for direct unit testing (pure
// function, no DB required).
export function phraseNamedDoctorUpcoming(
  who: string,
  rows: { doctorName?: string; visitDate: string }[],
  formatSpokenDate: (d: string) => string,
): string {
  const CAP = 3;
  const shown = rows.slice(0, CAP);
  const remaining = rows.length - shown.length;
  let sentence = `You see ${who} on ${formatSpokenDate(shown[0].visitDate)}`;
  for (let i = 1; i < shown.length; i++) {
    const isLastShown = i === shown.length - 1;
    const connector = isLastShown && remaining === 0 ? 'and again' : 'then again';
    sentence += `, ${connector} ${formatSpokenDate(shown[i].visitDate)}`;
  }
  sentence += remaining > 0 ? `, and ${remaining} more after that.` : '.';
  return sentence;
}

// Doctor summary composer — "tell me about Dr X" and close paraphrases.
// Phrasing wrapper ONLY: composes already-authoritative single-purpose reads
// (medical_contacts identity/specialty; medical_records visit/outcome/upcoming)
// into one conversational answer. Introduces no new database authority — §4a
// one-reader-per-question is unaffected, each existing reader still owns its
// own table/question; this only sequences and phrases their outputs. Sections
// are omitted, never fabricated, when the underlying reader returns nothing
// (Spine §3 — deterministic string assembly over already-verbatim values).
//
// Outcome/visit-date guard: getLastVisit and getLastVisitOutcome are each
// independently correct but can point at different rows (most recent visit
// vs. most recent visit WITH an outcome). Showing both together without this
// guard could juxtapose two different dates in one answer — an Elder Safety
// failure the individual readers never had a chance to cause on their own.
// Outcome is only spoken when it belongs to the SAME visit already being
// described; otherwise it's simply not available for THIS visit and omitted.
function composeDoctorSummary(
  who: string,
  contact: { name?: string; specialty?: string } | undefined,
  visit: { doctorName?: string; visitDate: string; notes?: string; reason?: string; diagnosis?: string; follow_up?: string } | null,
  outcome: { doctorName?: string; visitDate: string; outcome: string } | null,
  upcoming: { doctorName?: string; visitDate: string }[],
  formatSpokenDate: (d: string) => string,
): string {
  if (!contact && !visit && upcoming.length === 0) {
    return `I don't have anything on ${who} yet — tell me and I'll remember.`;
  }

  const parts: string[] = [];
  parts.push(contact?.specialty ? `${who} is your ${contact.specialty}.` : `${who}.`);

  if (visit) {
    const spoken = formatSpokenDate(visit.visitDate);
    const details: string[] = [];
    if (visit.reason) details.push(`for ${visit.reason}`);
    if (visit.diagnosis) details.push(`diagnosed with ${visit.diagnosis}`);
    if (visit.notes) details.push(visit.notes);
    if (visit.follow_up) details.push(`follow-up: ${visit.follow_up}`);
    const detailPart = details.length > 0 ? ` — ${details.join('; ')}` : '';
    parts.push(`You last saw them on ${spoken}${detailPart}.`);

    if (outcome && outcome.visitDate === visit.visitDate) {
      parts.push(`You mentioned: ${outcome.outcome}`);
    }
  }

  if (upcoming.length > 0) {
    parts.push(phraseNamedDoctorUpcoming(who, upcoming, formatSpokenDate));
  }

  return parts.join(' ');
}

function getDoctorSummary(): string {
  const records = getMedicalRecords().filter((r) => r.doctor_name && r.doctor_name.trim());
  if (records.length === 0) {
    return "I don't have a doctor for you yet — you can tell me anytime.";
  }
  const names: string[] = [];
  for (const r of records) {
    const name = r.doctor_name!.trim();
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 1) return `You've mentioned ${names[0]}.`;
  if (names.length === 2) return `You've mentioned ${names[0]} and ${names[1]}.`;
  const last = names.pop();
  return `You've mentioned ${names.join(', ')}, and ${last}.`;
}

export async function classifyQuery(message: string): Promise<TierDecision> {
  const msg = normalizeInput(message);

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
      msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+to\s+(?:my\s+)?((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1] ??
      msg.match(new RegExp(`\\b(?:can\\s+you\\s+)?(?:text|message|msg)\\s+my\\s+(${PERSON_RELATIONSHIP_ALTERNATION})\\b`, 'i'))?.[1] ??
      msg.match(/\b(?:can\s+you\s+)?(?:text|message|msg)\s+((?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?\w+)/i)?.[1];
    const SMS_EXCLUDE = /^(me|you|us|them|it|myself|yourself)$/i;
    const SMS_POSSESSIVE_EXCLUDE = /^(my|our|his|her|their|the|a|an)$/i;
    // Normalize before exclude checks so "my wife"-shaped captures become "wife"
    // and possessive/filler tokens still fail SMS_POSSESSIVE_EXCLUDE when bare.
    const contactOnlyNorm = contactOnly ? normalizePersonTarget(contactOnly.trim()) : '';
    if (contactOnlyNorm && !SMS_EXCLUDE.test(contactOnlyNorm) && !SMS_POSSESSIVE_EXCLUDE.test(contactOnlyNorm)) {
      return {
        tier: 1,
        actionIntent: { type: 'sms', contact: contactOnlyNorm, message: '' },
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

  // Device: photo open — before navigation so "take me to my photos" isn't directions
  if (PHOTO_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, actionIntent: { type: 'photo_open' }, reason: 'action:photo_open' };
  }

  // Device: navigation — resolve contact/address on device, fire maps intent
  if (DIRECTIONS_SIGNALS.some((p) => p.test(msg))) {
    const destMatch =
      msg.match(/\b(?:directions?|navigate|navigation)\s+to\s+(.+)/i)?.[1] ??
      msg.match(/\btake me to\s+(.+)/i)?.[1] ??
      msg.match(/\bhow do i get to\s+(.+)/i)?.[1] ??
      msg.match(/\bget me to\s+(.+)/i)?.[1] ??
      msg.match(/\bdrive to\s+(.+)/i)?.[1];
    const destination = destMatch?.trim() ?? '';
    const DIRECTIONS_EXCLUDE = /^(me|here|my location|where i am)$/i;
    if (destination.length > 1 && !DIRECTIONS_EXCLUDE.test(destination)) {
      return {
        tier: 1,
        actionIntent: { type: 'navigation', destination },
        reason: 'action:navigation',
      };
    }
  }

  // Device: call — resolves contact on device, fires tel: intent
  if (CALL_SIGNALS.some((p) => p.test(msg)) && !REMINDER_SIGNALS.some((p) => p.test(msg)) && !CALL_NUMBER_STATEMENT.test(msg) && !POSSESSIVE_CONTACT_STATEMENT.test(msg) && !TODO_ADD_PREFIX.test(msg) && !READ_QUERY_PREFIX.test(msg)) {
    const CALL_EXCLUDE = /^(me|you|back|again|later|now|soon|ahead|us|them|it|that|help|ambulance|backup|someone|anyone|911|emergency)$/i;
    // Name token: letters + optional hyphen/apostrophe (O'Brien, Anne-Marie).
    const NAME = String.raw`(?:Dr\.?\s+|Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)?`;
    // "call for [the] X" — try BEFORE bare "call <name>" so filler "for"/"for the"
    // is never captured as the name. Then whole-utterance bare names ("Call Paul"),
    // then mid-sentence / relationship / "give X a call" forms.
    const contactMatch =
      msg.match(new RegExp(String.raw`\b(?:call|phone|dial|ring)\s+for\s+(?:the\s+)?(${NAME})`, 'i')) ??
      msg.match(new RegExp(String.raw`^\s*(?:please\s+)?(?:can you\s+)?(?:call|phone|dial|ring)[,:]?\s+(?:to\s+)?(?:my\s+)?(${NAME})\s*[.!]?\s*$`, 'i')) ??
      msg.match(new RegExp(String.raw`\b(?:call|phone|dial|ring)[,:]?\s+(?:to\s+)?(?:my\s+(?:${PERSON_RELATIONSHIP_ALTERNATION})\s+)?(${NAME})`, 'i')) ??
      msg.match(new RegExp(String.raw`\bgive\s+(?:my\s+(?:${PERSON_RELATIONSHIP_ALTERNATION})\s+)?(${NAME})\s+a\s+(?:call|ring)\b`, 'i'));
    const rawContact = contactMatch?.[1]?.trim() ?? '';
    const strippedContact = rawContact
      .replace(/^(a\s+)?number\s+for\s+/i, '')
      .replace(/^the\s+number\s+for\s+/i, '')
      .replace(/\s+(please|now|thanks|thank you)$/i, '')
      .trim();
    // Drop leading a/an/the so "an ambulance" excludes on "ambulance", not "an".
    const excludeHead = strippedContact.replace(/^(a|an|the)\s+/i, '').split(/\s+/)[0] ?? '';
    const contact = CALL_EXCLUDE.test(excludeHead) ? '' : liftRelationshipName(normalizePersonTarget(strippedContact));
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

  // Device: list remove — before todo_complete so "I got X" doesn't become todo_complete
  if (LIST_REMOVE_SIGNALS.some((p) => p.test(msg))) {
    const m =
      msg.match(
        /\b(?:remove|take\s+off|delete|cross\s+off)\s+(.+?)\s+(?:from|off)\s+(?:my\s+)?(?:(\w+)\s+)?list\b/i,
      ) ??
      msg.match(
        /\b(?:take|get|knock|pull)\s+(.+?)\s+off\s+(?:my\s+|the\s+)?(?:(\w+)\s+)?lists?\b/i,
      ) ??
      msg.match(
        /\b(?:i(?:'?ve?)?|we)\s+(?:got|picked\s+up|grabbed|bought|already\s+have)\s+(?:the\s+)?(.+?)\s*$/i,
      ) ??
      msg.match(
        /\b(?:scratch|cross|mark)\s+off\s+(?:the\s+)?(.+?)\s+(?:from|on|off)?\s*(?:my|the)?\s*list\b/i,
      );
    const item = (m?.[1] ?? '').trim();
    const listName = (m?.[2] ?? 'grocery').toLowerCase();
    if (item) {
      return {
        tier: 1,
        actionIntent: { type: 'list_remove', item, listName },
        reason: 'action:list_remove',
      };
    }
  }

  // Device: todo complete — fuzzy match against open items, confirm before write
  if (TODO_COMPLETE_SIGNALS.some((p) => p.test(msg))) {
    return {
      tier: 1,
      actionIntent: { type: 'todo_complete', raw: msg },
      reason: 'action:todo_complete',
    };
  }

  // Device: todo read
  if (TODO_READ_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, actionIntent: { type: 'todo_read' }, reason: 'action:todo_read' };
  }

  // Device: grocery acquisition — "I need to pick up X from the grocery store".
  // Runs BEFORE todo_add so an utterance that NAMES grocery context resolves to a
  // grocery add instead of being swallowed as a todo. Fires ONLY when BOTH the
  // acquisition shape AND an explicit grocery marker are present. No marker → this
  // block does nothing and the utterance falls through to todo_add unchanged.
  if (
    ACQUISITION_SHAPE.test(msg) &&
    GROCERY_CONTEXT_MARKER.test(msg) &&
    !detectMedicalEvent(msg)
  ) {
    const m = msg.match(
      /\b(?:need\s+to|have\s+to|gotta|got\s+to|going\s+to|gonna|want\s+to|wanna)\s+(?:go\s+to\s+(?:the\s+)?(?:grocery\s+store|supermarket|grocery|store|shop|market)\s+(?:and\s+)?)?(?:pick(?:\s+\w+)?\s+up|get|buy|grab)\s+(.+)/i,
    );
    let raw = (m?.[1] ?? '').trim();
    raw = raw
      .replace(/\s+(?:from|at)\s+(?:the\s+)?(?:grocery\s+store|grocery|groceries|supermarket|store|market|shopping)\b.*$/i, '')
      .replace(/\s+(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|week)|next\s+week|at\s+\d.*|by\s+\d.*|\d+\s*(?:am|pm))\b.*$/i, '')
      .trim();
    const items = raw
      .split(/\s*,\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length > 0) {
      return {
        tier: 1,
        actionIntent: { type: 'list_add', items, listName: 'grocery' },
        reason: 'action:list_add:acquisition_grocery',
      };
    }
  }

  // Device: todo add — trigger phrases WITHOUT a resolvable date (date = reminder, not todo)
  if (TODO_ADD_SIGNALS.some((p) => p.test(msg)) && !TODO_DATE_SIGNALS.test(msg) && !detectMedicalEvent(msg)) {
    const extracted = extractTodoAdd(msg);
    if (extracted?.kind === 'clarify') {
      return {
        tier: 1,
        tier1Response: "I'm not sure which task to add. Say just the to-do and I'll put it on the list.",
        reason: 'action:todo_add_compound',
      };
    }
    if (extracted?.kind === 'add' && extracted.body.length > 2) {
      return { tier: 1, actionIntent: { type: 'todo_add', body: extracted.body }, reason: 'action:todo_add' };
    }
  }

  // Device: list add — write to SQLite, zero network
  if (LIST_ADD_SIGNALS.some((p) => p.test(msg))) {
    const addMatch = msg.match(/\badd (.+?) to (?:my |the )?(\w+)?\s*list/i) ??
                     msg.match(/\bput (.+?) on (?:my |the )?(\w+)?\s*list/i) ??
                     msg.match(/\badd to (?:my |the )?(\w+)?\s*list\s+(.+)/i);
    if (addMatch) {
      const isInverted = /\badd to (?:my |the )?\w*\s*list\s+/i.test(msg);
      const raw = isInverted ? (addMatch[2]?.trim() ?? '') : (addMatch[1]?.trim() ?? '');
      const listNameRaw = isInverted ? (addMatch[1]?.trim() ?? '') : (addMatch[2]?.trim() ?? '');
      const listName = (listNameRaw || 'grocery').toLowerCase();
      const items = raw
        .split(/\s*,\s*|\s+and\s+/i)
        .map(s => s.trim())
        .filter(s => s.length > 0);
      if (items.length > 0) {
        return { tier: 1, actionIntent: { type: 'list_add', items, listName }, reason: 'action:list_add' };
      }
    }
  }

  // Device: list read — read from SQLite, zero network
  if (LIST_READ_SIGNALS.some((p) => p.test(msg))) {
    const nameMatch = msg.match(/my (\w+) list/i);
    const listName = (nameMatch?.[1]?.trim() ?? 'grocery').toLowerCase();
    return { tier: 1, actionIntent: { type: 'list_read', listName }, reason: 'action:list_read' };
  }

  // Device: calendar write — local CalendarProvider, works offline (Bug 3)
  // Enter only on positive write evidence. Read evidence wins for ambiguous "schedule".
  if (
    (CALENDAR_WRITE_TRIGGER.test(msg) || CALENDAR_WRITE_NAMED_APPOINTMENT.test(msg)) &&
    hasPositiveCalendarWriteEvidence(msg)
  ) {
    const { parseCalendarWriteIntent } = await import('../utils/parseTime');
    const value = parseCalendarWriteIntent(msg);
    if (value) {
      return { tier: 1, actionIntent: { type: 'calendar_write', value }, reason: 'action:calendar_write' };
    }
  }

  // Device: household remove — "delete/remove my plumber", zero network.
  // Runs BEFORE household_read so removal utterances never reach the LLM
  // classifier (which would misread "delete" as a provider name).
  const serviceRemove = detectServiceRemove(msg);
  if (serviceRemove) {
    return {
      tier: 1,
      actionIntent: {
        type: 'household_remove',
        categories: serviceRemove.categories,
        spoken: serviceRemove.spoken,
      },
      reason: 'action:household_remove',
    };
  }

  // Device: household read-back — "who's my plumber", zero network
  const householdRead = detectHouseholdRead(msg);
  if (householdRead) {
    return {
      tier: 1,
      actionIntent: { type: 'household_read', intent: householdRead },
      reason: 'action:household_read',
    };
  }

  // Device: app open
  if (APP_OPEN_SIGNALS.some((p) => p.test(msg))) {
    const appName = extractAppOpenName(msg) ?? 'app';
    return { tier: 1, actionIntent: { type: 'app_open', appName }, reason: 'action:app_open' };
  }

  // Device: list clear
  if (LIST_CLEAR_SIGNALS.some((p) => p.test(msg))) {
    const nm = msg.match(/(?:my\s+)?(\w+)\s+list\b/i);
    const listName = (nm?.[1] ?? 'grocery').toLowerCase();
    return { tier: 1, actionIntent: { type: 'list_clear', listName }, reason: 'action:list_clear' };
  }

  // Device: list update
  if (LIST_UPDATE_SIGNALS.some((p) => p.test(msg))) {
    const m = msg.match(
      /\b(?:change|update|replace)\s+(.+?)\s+(?:to|with)\s+(.+?)(?:\s+on\s+(?:my\s+)?(?:(\w+)\s+)?list)?\s*$/i,
    );
    const oldItem = (m?.[1] ?? '').trim();
    const newItem = (m?.[2] ?? '').trim();
    const listName = (m?.[3] ?? 'grocery').toLowerCase();
    if (oldItem && newItem) {
      return {
        tier: 1,
        actionIntent: { type: 'list_update', oldItem, newItem, listName },
        reason: 'action:list_update',
      };
    }
  }

  // Bare "I need X" grocery shorthand — NOT "I need to …" (todo) and not help cries.
  {
    const bareNeed = msg.match(/^\s*I\s+need\s+(?!to\b)(.+?)\s*$/i);
    const needTail = bareNeed?.[1]?.trim() ?? '';
    if (
      needTail.length > 0 &&
      !/\b(help|assistance|ambulance|doctor|911)\b/i.test(needTail)
    ) {
      const items = needTail
        .split(/\s*,\s*|\s+and\s+/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length > 0) {
        return {
          tier: 1,
          actionIntent: { type: 'list_add', items, listName: 'grocery' },
          reason: 'action:list_add:bare_need',
        };
      }
    }
  }

  // Device: contextual list add
  {
    const item = extractContextualGroceryItem(msg);
    if (item) {
      return {
        tier: 1,
        actionIntent: { type: 'list_add', items: [item], listName: 'grocery' },
        reason: 'action:list_add:contextual',
      };
    }
  }

  // Device: profile update
  if (
    PROFILE_UPDATE_SIGNALS.some((p) => p.test(msg)) &&
    !/^\s*(do|does|did|who|what|which|is|are|can|could|would|where|when)\b/i.test(msg) &&
    !/\bdo you (know|have)\b/i.test(msg)
  ) {
    const m =
      msg.match(
        /\b(?:change|update|my\s+new)\s+(?:my\s+)?(insurance|doctor|pharmacy|dentist|specialist|provider)\s+(?:is\s+|to\s+)(.+)/i,
      ) ??
      msg.match(
        /\bI\s+(?:changed|switched|updated)\s+my\s+(insurance|doctor|pharmacy|dentist)\s+(?:to\s+)?(.+)/i,
      ) ??
      msg.match(
        /\bmy\s+(insurance|doctor|pharmacy|dentist|specialist|provider)\s+(?:is\s+now|changed\s+to|is)\s+(.+)/i,
      );
    const field = (m?.[1] ?? '').trim().toLowerCase();
    const value = (m?.[2] ?? '').trim();
    if (field && value) {
      return {
        tier: 1,
        actionIntent: { type: 'profile_update', field, value },
        reason: 'action:profile_update',
      };
    }
  }

  // Device: medical clear (wipe all) — BEFORE capture/read so it isn't swallowed.
  if (
    /\b(clear|wipe|reset|empty|delete|delete all|remove all|start (over|fresh))\b/i.test(msg) &&
    /\b(medication|medications|meds|prescriptions?|medical)\b/i.test(msg)
  ) {
    return { tier: 1, actionIntent: { type: 'medical_clear' }, reason: 'action:medical_clear' };
  }

  // Device: medical remove one — "stop taking X", "remove X from my meds", "no longer on X".
  {
    const medRemoveMatch =
      msg.match(/\b(?:stop|stopped|quit|no longer)\s+(?:taking|on|using)\s+(.+?)[.!?]*$/i) ??
      msg.match(/\b(?:remove|delete|take\s+off|drop)\s+(.+?)\s+(?:from|off)\s+(?:my\s+)?(?:medication|medications|meds|prescriptions?)(?:\s+list)?\b/i) ??
      msg.match(/\bi'?m\s+off\s+(.+?)[.!?]*$/i);
    if (medRemoveMatch) {
      const name = (medRemoveMatch[1] ?? '').trim();
      if (name && name.length >= 2) {
        return { tier: 1, actionIntent: { type: 'medical_remove', name }, reason: 'action:medical_remove' };
      }
    }
  }

  // Tier 1: doctor summary composer — "tell me about Dr X" and close
  // paraphrases. Composes already-authoritative single-purpose reads
  // (medical_contacts identity/specialty; medical_records visit, outcome,
  // upcoming) into one conversational answer. No new database authority —
  // §4a one-reader-per-question unaffected, each existing reader still owns
  // its own table/question; this only sequences and phrases outputs. MUST
  // precede medical capture / visit outcome / visit history / diagnosis /
  // doctor-read so a composite "tell me about" ask resolves here, not to a
  // narrower single-purpose reader.
  if (DOCTOR_SUMMARY_READ.some((p) => p.test(msg))) {
    const { extractDoctorName } = await import('../utils/detectMedicalEvent');
    const doctorHint = extractDoctorName(msg);
    if (!doctorHint) {
      return {
        tier: 1,
        tier1Response: "Help me out — which doctor do you mean? Tell me their name and I'll look it up.",
        isMedical: true,
        reason: "medical:doctor_summary_unresolved",
      };
    }
    const {
      getMedicalContacts,
      getLastVisit,
      getLastVisitOutcome,
      getUpcomingAppointments,
      normalizeDoctorNameForMatch,
    } = await import('../db/medicalDB');
    const { formatSpokenDate } = await import('../utils/parseTime');

    const contact = getMedicalContacts().find(
      (c) => normalizeDoctorNameForMatch(c.name).includes(normalizeDoctorNameForMatch(doctorHint))
    );
    const visit = getLastVisit(doctorHint);
    const outcome = getLastVisitOutcome(doctorHint);
    const upcomingAll = getUpcomingAppointments()
      .filter((r) => r.doctorName && normalizeDoctorNameForMatch(r.doctorName).includes(normalizeDoctorNameForMatch(doctorHint)))
      .sort((a, b) => (a.visitDate < b.visitDate ? -1 : a.visitDate > b.visitDate ? 1 : 0));

    const who = contact?.name ?? visit?.doctorName ?? upcomingAll[0]?.doctorName ?? doctorHint;
    const response = composeDoctorSummary(who, contact, visit, outcome, upcomingAll, formatSpokenDate);
    return { tier: 1, tier1Response: response, isMedical: true, reason: "medical:doctor_summary" };
  }

  // Tier 1: visit outcome read — BEFORE medical capture so "how did my
  // appointment with Dr X go" cannot be claimed as FUTURE_VISIT /
  // medical_visit_upcoming. Same §4a reader as the prior later placement;
  // doctor hint still via extractDoctorName (unchanged for existing patterns).
  if (isVisitOutcomeRead(msg)) {
    const { extractDoctorName } = await import('../utils/detectMedicalEvent');
    const doctorHint = extractDoctorName(msg);

    // Explicit-name guard: doctorHint can be falsy for two structurally
    // different reasons -- a genuinely unhinted "my/the doctor" ask (fine,
    // the unhinted-latest reader is correct for this) or an utterance that
    // named a doctor in a form extractDoctorName can't parse (must NOT
    // silently fall back to latest-globally). NAMED_BUT_UNRESOLVED_DOCTOR_RE
    // distinguishes the two by shape only -- see its definition above.
    if (!doctorHint && NAMED_BUT_UNRESOLVED_DOCTOR_RE.test(msg)) {
      return {
        tier: 1,
        tier1Response: "I'm not sure which doctor you mean — can you say their name again?",
        isMedical: true,
        reason: "medical:visit_outcome_unresolved_doctor",
      };
    }

    // NEW: unhinted-ambiguity check (2026-08-15 multi-doctor mechanism).
    // Only runs when doctorHint is falsy; hinted/explicit asks are
    // unaffected and fall through below unchanged.
    if (!doctorHint) {
      const { isUnhintedVisitOutcomeAmbiguous } = await import('../db/medicalDB');
      if (isUnhintedVisitOutcomeAmbiguous()) {
        return {
          tier: 1,
          tier1Response: "Which doctor do you mean?",
          isMedical: true,
          reason: "medical:visit_outcome_multiple_doctors",
        };
      }
    }

    const { getLastVisitOutcomeSummary } = await import('../db/medicalDB');
    const response = getLastVisitOutcomeSummary(doctorHint);
    return { tier: 1, tier1Response: response, isMedical: true, reason: "medical:visit_outcome_read" };
  }

  // Continuity: unresolved third-person visit-outcome referent — no live Flow C
  // subject consumed upstream at processUtterance step 1b. Must not fall through
  // to the unhinted global latest reader (Spine §5 fabrication class).
  // Subject-position he|she|they only; canonical THIRD_PERSON_REFERENT_RE excludes
  // "they" and object/possessive forms are invalid here — reuse conversationalSubject act.
  if (isReferentVisitOutcomeQuestion(msg)) {
    return {
      tier: 1,
      tier1Response: "I'm not sure who you mean — which doctor?",
      isMedical: true,
      reason: "medical:visit_outcome_unresolved_referent",
    };
  }

  // Continuity Step 4: unresolved third-person upcoming-visit referent -- no
  // live Flow C subject consumed upstream at processUtterance step 1b. Must
  // not fall through to a broad/unhinted upcoming-appointments list (Spine
  // §5 fabrication class) -- mirrors the visit-outcome guard immediately
  // above; same closed pronoun set, same fail-closed shape.
  if (isReferentUpcomingVisitQuestion(msg)) {
    return {
      tier: 1,
      tier1Response: "I'm not sure who you mean — which doctor?",
      isMedical: true,
      reason: "medical:visit_upcoming_unresolved_referent",
    };
  }

  // Android Calendar Range V1: unresolved third-person year-bounded
  // referent -- no live Flow C subject consumed upstream. Mirrors the
  // visit-outcome / upcoming-visit guards above; same closed pronoun shape,
  // same fail-closed clarification, same reason it must not fall through to
  // any broad/unhinted result (Spine §5 fabrication class).
  if (isReferentYearBoundedVisitQuestion(msg)) {
    return {
      tier: 1,
      tier1Response: "I'm not sure who you mean — which doctor?",
      isMedical: true,
      reason: "medical:visit_year_unresolved_referent",
    };
  }

  // Device: medical capture — past-tense medical events only
  const medEvent = detectMedicalEvent(msg);
  if (medEvent && (medEvent.tense === 'past' || (medEvent.type === 'visit' && medEvent.tense === 'future'))) {
    return {
      tier: 1,
      actionIntent: { type: 'medical_capture', event: medEvent },
      reason: 'action:medical_capture',
    };
  }

  const NAMED_WEEKDAY = new RegExp(`\\b(?:${WEEKDAY_NAMES})\\b`, 'i');
  const MONTH_DAY = new RegExp(
    `\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
    'i',
  );
  const FUZZY_FUTURE =
    /\b(couple weeks|few weeks|next month|a month|couple months)\b/i;
  const hasNamedWeekday = NAMED_WEEKDAY.test(msg);
  const hasUnresolvableDate =
    hasNamedWeekday ||
    MONTH_DAY.test(msg) ||
    FUZZY_FUTURE.test(msg);
  const isCalendarIntent = isCalendarReadIntent(msg);

  if (hasNamedWeekday && isCalendarIntent) {
    const resolvedDate = parseDatePhrase(msg);
    if (resolvedDate) {
      const [y, mo, d] = resolvedDate.split("-").map(Number);
      const resolved = new Date(y, mo - 1, d);
      resolved.setHours(0, 0, 0, 0);
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const weekdayName = resolved.toLocaleDateString([], { weekday: "long" });

      if (resolved.getTime() >= todayStart.getTime()) {
        const dayLabel =
          resolved.getTime() === todayStart.getTime() ? "today" : `next ${weekdayName}`;
        const events = getCachedEventsForDate(resolvedDate);
        return {
          tier: 1,
          tier1Response: formatEventsForSpecificDay(events, dayLabel),
          reason: "calendar:specific_day",
        };
      }

      const dayLabel = `last ${weekdayName}`;
      const pastAppointments = getAppointmentsForLocalDate(resolvedDate);
      return {
        tier: 1,
        tier1Response: formatAppointmentsForSpecificDay(pastAppointments, dayLabel),
        reason: "calendar:specific_day_past",
      };
    }
  }

  if (hasUnresolvableDate && isCalendarIntent) {
    return {
      tier: 1,
      tier1Response: "I can only tell you about today, tomorrow, this week, or next week right now.",
      reason: "calendar:unresolved_weekday",
    };
  }

  // Temporal scope markers — exclusion + window selection. Never sole auth.
  const hasNextWeek = hasNextWeekScope(msg);
  const hasThisWeek = hasThisWeekScope(msg);
  const hasTomorrow = hasTomorrowScope(msg);
  const hasToday = hasTodayScope(msg);
  const calendarRead = hasCalendarReadEvidence(msg);
  const calendarTravel = hasCalendarTravelRead(msg);
  const hasNearMe = /\b(near me|near here|nearest|closest|close to me)\b/i.test(msg);
  const hasWeatherTomorrow = /\bweather\b/i.test(msg);
  const todayDefault =
    CALENDAR_TODAY_DEFAULT_READ.some((p) => p.test(msg)) &&
    !hasToday && !hasTomorrow && !hasThisWeek && !hasNextWeek;

  // Tier 1: calendar today — bare this-week/next-week markers exclude (not only
  // authorized week-read phrases), so "today … this week is packed" cannot
  // silently collapse to today-only.
  if (
    calendarRead &&
    (hasToday || todayDefault) &&
    !hasTomorrow &&
    !hasThisWeek &&
    !hasNextWeek
  ) {
    const events = await getTier1CalendarEvents("today");
    const response = calendarSpeech("today", events);
    return { tier: 1, tier1Response: response, reason: "calendar:today" };
  }

  // Tier 1: calendar tomorrow
  if (calendarRead && hasTomorrow && !hasWeatherTomorrow && !hasNextWeek) {
    const events = await getTier1CalendarEvents("tomorrow");
    const response = calendarSpeech("tomorrow", events);
    return { tier: 1, tier1Response: response, reason: "calendar:tomorrow" };
  }

  // Tier 1: calendar next week (before this week — "next week" must not fall through).
  // Requires read evidence — bare hasNextWeek is never an independent grant.
  if (
    calendarRead &&
    hasNextWeek &&
    !hasNearMe &&
    !hasToday &&
    !hasTomorrow
  ) {
    const events = await getTier1CalendarEvents("next week");
    const response = calendarSpeech("next week", events);
    return { tier: 1, tier1Response: response, reason: "calendar:next_week" };
  }

  // Tier 1: upcoming medical appointment recall (forward-looking). MUST precede
  // visit_read / VISIT_HISTORY_READ (both past-tense) so "do I have any doctor
  // visits coming up" resolves here, not to the past readers. Excludes generic
  // and timeframe-scoped queries by construction (see UPCOMING_MEDICAL_READ).
  if (UPCOMING_MEDICAL_READ.some((p) => p.test(msg))) {
    const { getUpcomingAppointments, normalizeDoctorNameForMatch } = await import('../db/medicalDB');
    const { formatSpokenDate } = await import('../utils/parseTime');
    const all = getUpcomingAppointments();
    const isNamed = /\bdr\.?\s/i.test(msg);

    if (isNamed) {
      // Select by testing each COMPLETE stored name against the utterance;
      // longest complete match wins; fail closed on none. No extracted hint.
      const matches = all
        .filter((r) => r.doctorName && storedNameSupportedByUtterance(r.doctorName, msg))
        .sort((a, b) => (b.doctorName!.length - a.doctorName!.length));
      if (matches.length === 0) {
        const hint = extractDoctorName(msg);
        if (!hint) {
          return {
            tier: 1,
            tier1Response: "I don't have another upcoming visit with that doctor saved yet.",
            isMedical: true,
            reason: "medical:upcoming_read_named_miss",
          };
        }
        const calReply = await answerUpcomingCalendarEvidence(hint, hint);
        const calendarReason = calReply.startsWith('Your calendar shows')
          ? 'medical:upcoming_read_named_calendar'
          : /couldn't check your calendar/i.test(calReply)
            ? 'medical:upcoming_read_named_calendar_unavailable'
            : 'medical:upcoming_read_named_calendar_miss';
        return {
          tier: 1,
          tier1Response: calReply,
          isMedical: true,
          reason: calendarReason,
        };
      }
      // Named query surfaces every upcoming visit with that doctor, soonest
      // first — not just the nearest (2026-08-10, multi-visit presentation
      // fix; see phraseNamedDoctorUpcoming). Re-sort the matched set
      // soonest-first (getUpcomingAppointments already date-ASC, but the
      // longest-name sort above reordered it).
      const sorted = [...matches].sort((a, b) =>
        (a.visitDate < b.visitDate ? -1 : a.visitDate > b.visitDate ? 1 : 0)
      );
      const who = sorted[0].doctorName!.trim();
      // Guard: phraseNamedDoctorUpcoming speaks `who` once and groups every
      // subsequent row under it, so every row passed in must genuinely be
      // that doctor. matches was filtered by "utterance supports this
      // stored name," not "utterance names exactly one doctor" — a
      // compound utterance naming two doctors could in principle pass rows
      // for both through the filter above. This was harmless when only one
      // row was ever spoken; it is not harmless now, so it's enforced here
      // rather than assumed.
      const sameDoctor = sorted.filter(
        (r) => r.doctorName && normalizeDoctorNameForMatch(r.doctorName) === normalizeDoctorNameForMatch(who)
      );
      return {
        tier: 1,
        tier1Response: phraseNamedDoctorUpcoming(who, sameDoctor, formatSpokenDate),
        isMedical: true,
        reason: "medical:upcoming_read_named",
      };
    }

    if (all.length === 0) {
      const wantsSingle = UPCOMING_MEDICAL_SINGLE.some((p) => p.test(msg));
      const calReply = await answerUpcomingGenericDoctorCalendarEvidence(
        wantsSingle ? 'next' : 'inventory',
      );
      const calendarReason = calReply.startsWith('Your calendar shows')
        ? 'medical:upcoming_read_generic_calendar'
        : /couldn't check your calendar/i.test(calReply)
          ? 'medical:upcoming_read_generic_calendar_unavailable'
          : 'medical:upcoming_read_generic_calendar_miss';
      return {
        tier: 1,
        tier1Response: calReply,
        isMedical: true,
        reason: calendarReason,
      };
    }

    // Single-nearest vs list.
    const wantsSingle = UPCOMING_MEDICAL_SINGLE.some((p) => p.test(msg));
    const rows = wantsSingle ? all.slice(0, 1) : all;
    return {
      tier: 1,
      tier1Response: phraseUpcomingAppointments(rows, formatSpokenDate),
      isMedical: true,
      reason: wantsSingle ? "medical:upcoming_read_next" : "medical:upcoming_read_list",
    };
  }

  // Tier 1: visit read — MUST precede calendar-week so "who did I see this week"
  // resolves to visits, not an incidental "this week" calendar match (§4a one-reader).
  if (TIER1_SIGNALS.visit_read.some((p) => p.test(msg))) {
    const response = getVisitSummary();
    return { tier: 1, tier1Response: response, isMedical: true, reason: "medical:visit_read" };
  }

  if (VISIT_HISTORY_READ.some((p) => p.test(msg))) {
    const { getLastVisit } = await import('../db/medicalDB');
    const { formatSpokenDate } = await import('../utils/parseTime');
    const { extractDoctorName } = await import('../utils/detectMedicalEvent');
    const doctorHint = extractDoctorName(msg);
    const SPECIALTY_REFERENCE = /\bmy\s+(dentist|cardiologist|neurologist|oncologist|psychiatrist|therapist|specialist)\b/i;
    const specialtyMatch = msg.match(SPECIALTY_REFERENCE);
    if (!doctorHint && specialtyMatch) {
      return {
        tier: 1,
        tier1Response: `Help me out — when you say "${specialtyMatch[1]}," who do you mean? Tell me their name and I'll look it up.`,
        isMedical: true,
        reason: "medical:visit_history_unresolved_specialty",
      };
    }
    // Continuity Step 3 fail-closed: an unresolved third-person referent must
    // never be answered from the unhinted global read. getLastVisit(undefined)
    // returns whatever visit is newest, so "when did I see him" with no
    // established subject would name an arbitrary doctor — a fabrication-class
    // wrong answer (Spine §5). Gated on PRONOUN PRESENCE, not on !doctorHint:
    // "when was my last appointment" / "what was it for" are legitimately
    // unhinted and must keep the global read.
    // A live Flow C subject is consumed upstream at processUtterance step 1b,
    // so this guard only ever sees the no-subject case.
    if (!doctorHint && THIRD_PERSON_REFERENT_RE.test(msg)) {
      return {
        tier: 1,
        tier1Response: "I'm not sure who you mean — which doctor?",
        isMedical: true,
        reason: "medical:visit_history_unresolved_referent",
      };
    }
    const visit = getLastVisit(doctorHint);
    let response: string;
    if (!visit) {
      response = doctorHint
        ? `I don't have a visit with ${doctorHint} yet — tell me and I'll remember.`
        : "I don't have any visits yet — tell me and I'll remember.";
    } else {
      const who = visit.doctorName ?? 'your doctor';
      const spoken = formatSpokenDate(visit.visitDate);
      const details: string[] = [];
      if (visit.reason) details.push(`for ${visit.reason}`);
      if (visit.diagnosis) details.push(`diagnosed with ${visit.diagnosis}`);
      if (visit.notes) details.push(visit.notes);
      if (visit.follow_up) details.push(`follow-up: ${visit.follow_up}`);
      const reasonPart = details.length > 0 ? ` — ${details.join('; ')}` : '';
      // Sentence shape is duplicated with answerReferentVisitDate
      // (conversationalSubject.ts). Do not factor (Continuity Step 3 / Rule 11).
      response = `You last saw ${who} on ${spoken}${reasonPart}.`;
    }
    return { tier: 1, tier1Response: response, isMedical: true, reason: "medical:visit_history_read" };
  }

  // Tier 1: calendar this week — read evidence + this-week scope, or travel probe.
  if (((calendarRead && hasThisWeek) || calendarTravel) && !hasNearMe && !hasNextWeek) {
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

  // Tier 1: temporal recall (Rung 4) — domain-generic "what did I bring up earlier".
  // BEFORE medical/family/profile/TIER2 so a recall phrasing naming a domain resolves
  // correctly; uncovered-domain guard bails to the real reader (recall must never say
  // "nothing" for a domain it can't see). Grocery-scoped phrasing = honest single-domain.
  if (isTemporalRecallRequest(msg)) {
    const n = new Date();
    const startOfDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    return { tier: 1, tier1Response: formatRecentMentions(getRecentMentions(startOfDay)), reason: 'recall:temporal' };
  }

  // Tier 1: diagnosis read — BEFORE the general medical summary so a diagnosis
  // question resolves to the diagnosis reader, not the meds/doctor summary. Medical
  // read fence: isMedical=true, never routed through generative phrasing (CLAUDE.md).
  if (DIAGNOSIS_READ_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: getDiagnosisSummary(), isMedical: true, reason: "medical:diagnosis" };
  }

  // Tier 1: doctor read — BEFORE the general medical summary (§4a one-reader).
  if (DOCTOR_READ_SIGNALS.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: getDoctorsSummary(), isMedical: true, reason: "medical:doctor_read" };
  }

  // Tier 1: medical
  if (TIER1_SIGNALS.medical.some((p) => p.test(msg))) {
    const summary = composeMedicalSummary();
    return {
      tier: 1,
      tier1Response: summary.response,
      isMedical: true,
      reason: "medical:summary",
      presentedMedicationIds: summary.medicationIds,
    };
  }

  // Tier 1: family read — single reader authority (familyRead.ts). All members per
  // relation (no LIMIT 1), location-aware, de-duped, contacts-only. Statement guard
  // lives in detectFamilyRead so "my son is X" falls through to capture. §4a one-reader.
  {
    const famRead = detectFamilyRead(msg);
    if (famRead) {
      return {
        tier: 1,
        tier1Response: answerFamilyRead(famRead),
        reason: 'family:read',
      };
    }
  }

  // Tier 1: contact phone lookup by name — "what's Linda's number", "Linda's phone number"
  // Device-first, offline. Extracts the name from possessive phrasing, calls findContactByName.
  // Never fabricates — honest miss if not found.
  // Declarative guard: an utterance carrying a VALID phone capture is a write, not a
  // question, and defers to DETERMINISTIC_CAPTURERS. detectPhoneCapture is the single
  // authority for that judgment — no second phone-validity rule lives here. Mirrors the
  // statement guard in detectFamilyRead and CALL_NUMBER_STATEMENT's guard at the call
  // path (line 1039). §4a one-reader.
  if (POSSESSIVE_CONTACT_STATEMENT.test(msg) && detectPhoneCapture(msg).kind === 'no_match') {
    const nameMatch = msg.match(/\b(\w+)'s\s+(?:phone|cell|mobile|number)/i);
    const lookupName = nameMatch?.[1]?.trim() ?? '';
    if (lookupName.length >= 2) {
      try {
        const { findContactByName } = await import('../db/contactsDB');
        const contact = findContactByName(lookupName);
        if (contact?.phone) {
          const formatted = /^\d{10}$/.test(contact.phone.replace(/\D/g, ''))
            ? `(${contact.phone.replace(/\D/g,'').slice(0,3)}) ${contact.phone.replace(/\D/g,'').slice(3,6)}-${contact.phone.replace(/\D/g,'').slice(6)}`
            : contact.phone;
          return {
            tier: 1,
            tier1Response: `${contact.name}'s number is ${formatted}.`,
            reason: 'contact:phone_lookup',
          };
        }
      } catch { /* contactsDB unavailable — fall through */ }
      return {
        tier: 1,
        tier1Response: `I don't have a number for ${lookupName} yet. You can tell me anytime.`,
        reason: 'contact:phone_lookup:miss',
      };
    }
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

  // Tier 1: greeting
  if (isGreeting(msg, getProfileField('ai_name')) || WHATS_UP_PATTERN.test(msg)) {
    const rawName = getProfileField('name');
    const firstName = rawName ? rawName.trim().split(/\s+/)[0] : '';
    const response = firstName ? `Hi ${firstName} — I'm here.` : `Hi — I'm here.`;
    return { tier: 1, tier1Response: response, reason: 'greeting' };
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
  if (CHIT_CHAT_SOCIAL_CHECKIN.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: CHIT_CHAT_RESPONSES.social_checkin, reason: 'chit_chat:social_checkin' };
  }
  if (CHIT_CHAT_AVAILABILITY.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: CHIT_CHAT_RESPONSES.availability, reason: 'chit_chat:availability' };
  }
  if (CHIT_CHAT_IDENTITY.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: CHIT_CHAT_RESPONSES.identity, reason: 'chit_chat:identity' };
  }
  if (CHIT_CHAT_CAPABILITY.some((p) => p.test(msg))) {
    return { tier: 1, tier1Response: CHIT_CHAT_RESPONSES.capability, reason: 'chit_chat:capability' };
  }

  return { tier: 3, reason: "default" };
}

export async function scanResidualIntent(
  text: string,
  primaryType: string,
): Promise<TierDecision | null> {
  const msg = normalizeInput(text);

  // Medical capture — only if primary wasn't medical
  if (primaryType !== 'medical_capture' && primaryType !== 'medical_remove') {
    const medEvent = detectMedicalEvent(msg);
    if (medEvent && medEvent.tense === 'past') {
      return {
        tier: 1,
        actionIntent: { type: 'medical_capture', event: medEvent },
        reason: 'residual:medical_capture',
      };
    }
  }

  // Contextual list add — only if primary wasn't list_add
  if (primaryType !== 'list_add') {
    const item = extractResidualContextualGroceryItem(msg);
    if (item) {
      return {
        tier: 1,
        actionIntent: { type: 'list_add', items: [item], listName: 'grocery' },
        reason: 'residual:list_add:contextual',
      };
    }
  }

  // Todo add — only if primary wasn't todo_add
  if (primaryType !== 'todo_add') {
    if (
      TODO_ADD_SIGNALS.some((p) => p.test(msg)) &&
      !TODO_DATE_SIGNALS.test(msg) &&
      !detectMedicalEvent(msg)
    ) {
      const extracted = extractResidualTodoAdd(msg);
      if (extracted?.kind === 'add' && extracted.body.length > 2) {
        return {
          tier: 1,
          actionIntent: { type: 'todo_add', body: extracted.body },
          reason: 'residual:todo_add',
        };
      }
    }
  }

  return null;
}

// ─── buildTier2Payload ────────────────────────────────────────────────────────

export function buildTier2Payload(context: LocalContext): string {
  const parts: string[] = [];
  if (context.profile) parts.push(`Profile:\n${context.profile}`);
  if (context.facts) parts.push(`Known facts:\n${context.facts}`);
  if (context.medical) parts.push(`Medical context:\n${context.medical}`);
  return parts.join("\n\n");
}