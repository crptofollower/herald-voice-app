// src/routing/conversationalSubject.ts
// Flow C — one-turn conversational subject (identity/reference only).
//
// Sibling to ConversationSession, NOT a PendingSlot. PendingSlot remains
// unresolved-turn authority. This holder stores a stable entity id after a
// completed deterministic identity read so the next user turn may ask for
// that entity's phone with a third-person singular pronoun.
//
// RAM only. Same mounted-chat lifecycle as ConversationSession.
// TTL: exactly one following user turn per act, EXCEPT the three medical
// referent acts (visit-date, visit-outcome, upcoming-visit), which RENEW
// the subject on a successful resolve so a chain of related follow-up
// questions about the same doctor keeps working without re-naming him
// (Continuity Step 4). Renewal reuses this file's own establishMedical()
// with the SAME identity -- no new topic stack, no persistence. Unused next
// turn still clears, as does any domain mismatch, explicit new subject,
// pending, or emergency. Process death/restart: gone. No SQLite persistence.
//
// Phone is NEVER cached. Previous ACK/prose is NEVER cached as truth.
// displayName / relationship / category are convenience context only —
// they must not be spoken as authoritative truth without a fresh row.
//
// Herald has no gender/pronoun field in this capability. Do NOT infer
// gender. Do NOT store gender. A supported pronoun may refer to the ONE
// active subject regardless of pronoun form; the subject was established
// deterministically before the pronoun arrived.
//
// PARKED Flow C coverage gaps (do not hook):
//   - LLM dispatchLocalIntent household_read
//   - residual compound household action

import { THIRD_PERSON_REFERENT } from '../utils/instructionSignals';
import { findContactById } from '../db/contactsDB';
import { getServiceProviderById } from '../utils/householdRead';
import { formatPhoneForSpeech } from '../utils/phoneConfirm';

export type FamilyConversationalSubject = {
  domain: 'family_contact';
  entityId: string;
  displayName: string;
  relationship: string | null;
  establishedAtTurn: number;
};

export type HouseholdConversationalSubject = {
  domain: 'household_provider';
  entityId: string;
  displayName: string;
  category: string;
  establishedAtTurn: number;
};

// Doctors carry no opaque entity id in this schema — every doctor read
// identifies by name and getLastVisit matches on normalizeDoctorNameForMatch.
// `entityId` therefore holds the doctor name, which IS the stable identity here.
// It remains identity, never a cached factual answer: consume re-reads.
export type MedicalConversationalSubject = {
  domain: 'medical_doctor';
  entityId: string;
  displayName: string;
  establishedAtTurn: number;
};

export type ConversationalSubject =
  | FamilyConversationalSubject
  | HouseholdConversationalSubject
  | MedicalConversationalSubject;

// Closed first-slice speech act: phone-number question about a third-person
// singular pronoun. Pronoun form is eligibility only — never a selector.
const REFERENT_PHONE_RE = new RegExp(
  `^\\s*(?:what(?:'s|s|\\s+is))\\s+(${THIRD_PERSON_REFERENT})\\s+(?:phone\\s+)?number\\s*[?.!]?\\s*$`,
  'i',
);

// Second closed speech act: when-did-I-see against the live subject. Fully
// anchored, same discipline as the phone act. Captured pronoun is discarded.
const REFERENT_VISIT_DATE_RE = new RegExp(
  `^\\s*when\\s+(?:did\\s+i\\s+(?:last\\s+)?see|was\\s+i\\s+(?:last\\s+)?seeing)\\s+(${THIRD_PERSON_REFERENT})\\s*[?.!]?\\s*$`,
  'i',
);

export function isReferentVisitDateQuestion(text: string): boolean {
  const m = text.match(REFERENT_VISIT_DATE_RE);
  if (!m) return false;
  void m[1]; // pronoun discarded — not a selector, no gender inference
  return true;
}

// Third closed speech act: visit-outcome against the live subject. Subject-
// position pronouns only — not the full THIRD_PERSON_REFERENT union (object/
// possessive forms are invalid here). Pronoun is eligibility only; discarded.
const REFERENT_SUBJECT_PRONOUN = 'he|she|they';
const REFERENT_VISIT_OUTCOME_RE = new RegExp(
  `^\\s*what\\s+did\\s+(${REFERENT_SUBJECT_PRONOUN})\\s+tell\\s+me\\s*[?.!]?\\s*$`,
  'i',
);

export function isReferentVisitOutcomeQuestion(text: string): boolean {
  const m = text.match(REFERENT_VISIT_OUTCOME_RE);
  if (!m) return false;
  void m[1]; // pronoun discarded — not a selector, no gender inference
  return true;
}

export function isReferentPhoneQuestion(text: string): boolean {
  const m = text.match(REFERENT_PHONE_RE);
  if (!m) return false;
  // Captured pronoun is discarded. It does not select among entities,
  // infer gender, or consult any gender field (none exists).
  void m[1];
  return true;
}

export class ConversationalSubjectHolder {
  private subject: ConversationalSubject | null = null;
  private turn = 0;
  private referentEvaluated = false;

  beginUserTurn(): void {
    this.turn += 1;
    this.referentEvaluated = false;
  }

  currentTurn(): number {
    return this.turn;
  }

  peek(): ConversationalSubject | null {
    return this.subject;
  }

  hasLive(): boolean {
    return this.subject !== null;
  }

  didEvaluateReferent(): boolean {
    return this.referentEvaluated;
  }

  markReferentEvaluated(): void {
    this.referentEvaluated = true;
  }

  clear(): void {
    this.subject = null;
  }

  establishFamily(match: {
    entityId: string;
    displayName: string;
    relationship: string | null;
  }): void {
    this.subject = {
      domain: 'family_contact',
      entityId: match.entityId,
      displayName: match.displayName,
      relationship: match.relationship,
      establishedAtTurn: this.turn,
    };
  }

  establishMedical(match: { entityId: string; displayName: string }): void {
    this.subject = {
      domain: 'medical_doctor',
      entityId: match.entityId,
      displayName: match.displayName,
      establishedAtTurn: this.turn,
    };
  }

  establishHousehold(match: {
    entityId: string;
    displayName: string;
    category: string;
  }): void {
    this.subject = {
      domain: 'household_provider',
      entityId: match.entityId,
      displayName: match.displayName,
      category: match.category,
      establishedAtTurn: this.turn,
    };
  }
}

function namedPhoneCopy(name: string, phone: string): string {
  return `${name}'s number is ${formatPhoneForSpeech(phone)}.`;
}

function namedMissCopy(name: string): string {
  return `I don't have a number for ${name} yet.`;
}

const NEUTRAL_MISS = `I don't have a number for them yet.`;

/**
 * Authoritative re-read by stable id. Subject metadata is not truth.
 * Pronoun form is not passed in — gender is not a selector.
 */
export function answerReferentPhone(subject: ConversationalSubject): string {
  if (subject.domain === 'family_contact') {
    const row = findContactById(subject.entityId);
    if (!row) return NEUTRAL_MISS;
    const name = row.name?.trim();
    if (!name || name.length < 2) return NEUTRAL_MISS;
    const phone = row.phone?.trim();
    if (!phone) return namedMissCopy(name);
    return namedPhoneCopy(name, phone);
  }

  if (subject.domain !== 'household_provider') return NEUTRAL_MISS;

  const row = getServiceProviderById(subject.entityId);
  if (!row) return NEUTRAL_MISS;
  const name = row.name?.trim();
  if (!name || name.length < 2) return NEUTRAL_MISS;
  const phone = row.phone?.trim();
  if (!phone) return namedMissCopy(name);
  return namedPhoneCopy(name, phone);
}

/**
 * Authoritative re-read for the visit-date referent. Flow C supplies IDENTITY
 * ONLY — getLastVisit is the deterministic reader and owns every factual value
 * in the returned sentence. Nothing is cached, nothing is phrased by a model.
 * Returns null when this subject cannot answer, so the caller falls through
 * rather than fabricating.
 *
 * Dynamic imports mirror tierRouter's VISIT_HISTORY_READ branch, which loads
 * these same two modules the same way. Static imports from a routing module
 * into db/ and utils/ are a cycle risk this pattern removes outright.
 */
export const HISTORICAL_CALENDAR_VISIT_EVIDENCE_MONTHS = 12;

/** Bounded past-calendar fallback after a medical getLastVisit miss.
 *  Shared by Flow C pronoun visit-date and named visit-history.
 *  Calendar evidence only — never writes medical_records, never "You last saw". */
export async function answerHistoricalCalendarVisitEvidence(
  doctorTerm: string,
  displayName: string,
): Promise<string> {
  const BACK_MONTHS = HISTORICAL_CALENDAR_VISIT_EVIDENCE_MONTHS;
  const { normalizeDoctorNameForMatch } = await import('../db/medicalDB');
  const {
    queryCalendarEvidence,
    formatCalendarEvidenceForSpeech,
    titleMatchesDoctorCalendarTerm,
    doctorCalendarIdentityKey,
  } = await import('../db/calendarCacheDB');
  const now = new Date();
  const backStart = new Date(now);
  backStart.setMonth(backStart.getMonth() - BACK_MONTHS);
  const matchTitle = (title: string) =>
    titleMatchesDoctorCalendarTerm(title, doctorTerm, normalizeDoctorNameForMatch);
  const rangeResult = await queryCalendarEvidence(
    doctorTerm,
    normalizeDoctorNameForMatch,
    backStart,
    now,
    { matchTitle },
  );
  if (rangeResult.status === 'unavailable') {
    return "I couldn't check your calendar right now.";
  }
  if (rangeResult.events.length > 0) {
    return speakDoctorCalendarHits(
      displayName,
      doctorTerm,
      rangeResult.events,
      'date',
      normalizeDoctorNameForMatch,
      doctorCalendarIdentityKey,
      formatCalendarEvidenceForSpeech,
      `in the past ${BACK_MONTHS} months`,
      'last',
    );
  }
  return `I don't see anything with ${displayName} on your calendar in the past ${BACK_MONTHS} months.`;
}

export async function answerReferentVisitDate(
  subject: ConversationalSubject,
): Promise<string | null> {
  if (subject.domain !== 'medical_doctor') return null;
  const { getLastVisit } = await import('../db/medicalDB');
  const { formatSpokenDate } = await import('../utils/parseTime');
  const visit = getLastVisit(subject.entityId);
  if (!visit) {
    return answerHistoricalCalendarVisitEvidence(subject.entityId, subject.displayName);
  }
  const who = visit.doctorName ?? subject.displayName;
  const spoken = formatSpokenDate(visit.visitDate);
  const details: string[] = [];
  if (visit.reason) details.push(`for ${visit.reason}`);
  if (visit.diagnosis) details.push(`diagnosed with ${visit.diagnosis}`);
  if (visit.notes) details.push(visit.notes);
  if (visit.follow_up) details.push(`follow-up: ${visit.follow_up}`);
  const detailPart = details.length > 0 ? ` — ${details.join('; ')}` : '';
  // Sentence shape is duplicated with tierRouter VISIT_HISTORY_READ.
  // Do not factor (Continuity Step 3 / Rule 11).
  return `You last saw ${who} on ${spoken}${detailPart}.`;
}

/**
 * Authoritative re-read for the visit-outcome referent. Flow C supplies IDENTITY
 * ONLY — getLastVisitOutcomeSummary is the deterministic reader and owns every
 * factual value in the returned sentence. Returns null when this subject cannot
 * answer, so the caller falls through rather than fabricating.
 */
export async function answerReferentVisitOutcome(
  subject: ConversationalSubject,
): Promise<string | null> {
  if (subject.domain !== 'medical_doctor') return null;
  const { getLastVisitOutcomeSummary } = await import('../db/medicalDB');
  return getLastVisitOutcomeSummary(subject.entityId);
}

// Fourth closed speech act (Continuity Step 4): upcoming-visit against the
// live doctor subject. Branches 1–2 reuse THIRD_PERSON_REFERENT (object
// forms after seeing/see, same as visit-date). Branch 3 adds "them" for
// "next appointment with them". Pronoun is eligibility only; discarded.
const REFERENT_UPCOMING_VISIT_RE = new RegExp(
  `^\\s*when(?:` +
    `\\s+am\\s+i\\s+seeing\\s+(${THIRD_PERSON_REFERENT})\\s+again` +
    `|\\s+do\\s+i\\s+see\\s+(${THIRD_PERSON_REFERENT})\\s+again` +
    `|(?:'s|\\s+is)\\s+my\\s+next\\s+appointment\\s+with\\s+(${REFERENT_SUBJECT_PRONOUN}|them)` +
  `)\\s*[?.!]?\\s*$`,
  'i',
);

export function isReferentUpcomingVisitQuestion(text: string): boolean {
  const m = text.match(REFERENT_UPCOMING_VISIT_RE);
  if (!m) return false;
  void (m[1] ?? m[2] ?? m[3]); // pronoun discarded -- not a selector, no gender inference
  return true;
}

// Bounded doctor-calendar identity fence: same surname with distinct
// doctor-shaped titles (Dr. Estil Vance vs Dr. Robert Vance) must not
// auto-pick one identity. Upcoming same-key hits take the soonest event;
// historical same-key hits take the most recent past event.
function speakDoctorCalendarHits(
  displayName: string,
  doctorTerm: string,
  events: { title: string; start_ms: number }[],
  mode: 'weekday' | 'date',
  normalize: (s: string) => string,
  identityKey: (title: string, rawTerm: string, normalize: (s: string) => string) => string,
  formatSpeech: (displayName: string, event: any, mode?: 'weekday' | 'date') => string,
  windowPhrase: string,
  singlePick: 'first' | 'last',
): string {
  const keys = new Set(events.map((e) => identityKey(e.title, doctorTerm, normalize)));
  if (keys.size > 1) {
    const dates = events.map((h) => {
      const dateLabel = new Date(h.start_ms).toLocaleDateString([], {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      return `${h.title} on ${dateLabel}`;
    });
    return `Your calendar shows ${events.length} things with ${displayName} ${windowPhrase} — ${dates.join(', ')}. Which one did you mean?`;
  }
  const event = singlePick === 'last' ? events[events.length - 1] : events[0];
  return formatSpeech(displayName, event, mode);
}

/**
 * Calendar fallback after medical upcoming-authority miss.
 * Same chain as the referent upcoming-visit reader: 14-day cache, then
 * on-demand 6-month range. Never writes medical_records.
 */
export async function answerUpcomingCalendarEvidence(
  doctorTerm: string,
  displayName: string,
): Promise<string> {
  const { normalizeDoctorNameForMatch } = await import('../db/medicalDB');
  const {
    findUpcomingEventsMatchingTerm,
    formatCalendarEvidenceForSpeech,
    queryCalendarEvidence,
    titleMatchesDoctorCalendarTerm,
    doctorCalendarIdentityKey,
  } = await import('../db/calendarCacheDB');
  const matchTitle = (title: string) =>
    titleMatchesDoctorCalendarTerm(title, doctorTerm, normalizeDoctorNameForMatch);
  const calMatches = findUpcomingEventsMatchingTerm(doctorTerm, normalizeDoctorNameForMatch, matchTitle);
  if (calMatches.length > 0) {
    return speakDoctorCalendarHits(
      displayName,
      doctorTerm,
      calMatches,
      'weekday',
      normalizeDoctorNameForMatch,
      doctorCalendarIdentityKey,
      formatCalendarEvidenceForSpeech,
      'in the next 6 months',
      'first',
    );
  }
  const FORWARD_MONTHS = 6;
  const now = new Date();
  const forwardEnd = new Date(now);
  forwardEnd.setMonth(forwardEnd.getMonth() + FORWARD_MONTHS);
  const wideResult = await queryCalendarEvidence(
    doctorTerm,
    normalizeDoctorNameForMatch,
    now,
    forwardEnd,
    { matchTitle },
  );
  if (wideResult.status === 'unavailable') {
    return "I couldn't check your calendar right now.";
  }
  if (wideResult.events.length > 0) {
    return speakDoctorCalendarHits(
      displayName,
      doctorTerm,
      wideResult.events,
      'date',
      normalizeDoctorNameForMatch,
      doctorCalendarIdentityKey,
      formatCalendarEvidenceForSpeech,
      'in the next 6 months',
      'first',
    );
  }
  return `I don't see anything with ${displayName} on your calendar in the next ${FORWARD_MONTHS} months.`;
}

const GENERIC_DOCTOR_CAL_FORWARD_MONTHS = 6;
const GENERIC_DOCTOR_CAL_ABSENCE =
  "I don't have any upcoming doctor appointments saved, and I don't see any doctor appointments on your calendar in the next 6 months.";

function isDrShapedMatchTerm(term: string, normalize: (s: string) => string): boolean {
  const n = normalize(term).split(/\s+/).filter(Boolean);
  return n.length >= 2 && n[0] === 'dr';
}

function titleQualifiesGenericDoctorEvidence(
  title: string,
  normalize: (s: string) => string,
  knownTerms: string[],
  hasStrongSpan: (title: string, normalize: (s: string) => string) => boolean,
  matchesTerm: (title: string, rawTerm: string, normalize: (s: string) => string) => boolean,
): boolean {
  if (hasStrongSpan(title, normalize)) return true;
  for (const term of knownTerms) {
    if (!isDrShapedMatchTerm(term, normalize)) continue;
    if (matchesTerm(title, term, normalize)) return true;
  }
  return false;
}

function speakGenericDoctorCalendarHits(
  events: { title: string; start_ms: number }[],
  mode: 'next' | 'inventory',
  dateMode: 'weekday' | 'date',
  labels: string[],
  formatSpeech: (displayName: string, event: any, mode?: 'weekday' | 'date') => string,
): string {
  if (mode === 'next' || events.length === 1) {
    return formatSpeech(labels[0], events[0], dateMode);
  }
  const CAP = 3;
  const shown = events.slice(0, CAP);
  const remaining = events.length - shown.length;
  const whenOf = (startMs: number) => {
    const d = new Date(startMs);
    return dateMode === 'date'
      ? d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
      : d.toLocaleDateString([], { weekday: 'long' });
  };
  let sentence = `Your calendar shows ${labels[0]} on ${whenOf(shown[0].start_ms)}`;
  for (let i = 1; i < shown.length; i++) {
    sentence += `, then ${labels[i]} on ${whenOf(shown[i].start_ms)}`;
  }
  sentence += remaining > 0 ? `, plus ${remaining} more.` : '.';
  return sentence;
}

/**
 * Generic upcoming-doctor Calendar evidence after medical_records upcoming miss.
 * Strong multi-token doctor spans OR correlation with confirmed Dr-shaped
 * Herald medical identities. Never writes medical_records.
 */
export async function answerUpcomingGenericDoctorCalendarEvidence(
  mode: 'next' | 'inventory',
): Promise<string> {
  const { normalizeDoctorNameForMatch, getConfirmedDoctorMatchTerms } = await import('../db/medicalDB');
  const {
    findUpcomingCachedEvents,
    formatCalendarEvidenceForSpeech,
    queryCalendarRange,
    titleHasStrongDoctorNameSpan,
    titleMatchesDoctorCalendarTerm,
    genericDoctorCalendarLabel,
  } = await import('../db/calendarCacheDB');
  const knownTerms = getConfirmedDoctorMatchTerms();
  const qualifies = (title: string) =>
    titleQualifiesGenericDoctorEvidence(
      title,
      normalizeDoctorNameForMatch,
      knownTerms,
      titleHasStrongDoctorNameSpan,
      titleMatchesDoctorCalendarTerm,
    );
  const labelOf = (title: string) =>
    genericDoctorCalendarLabel(title, normalizeDoctorNameForMatch, knownTerms.filter(
      (t) => isDrShapedMatchTerm(t, normalizeDoctorNameForMatch),
    ));

  const cacheHits = findUpcomingCachedEvents().filter((e) => e.title && qualifies(e.title));
  if (cacheHits.length > 0) {
    const chosen = mode === 'next' ? cacheHits.slice(0, 1) : cacheHits;
    return speakGenericDoctorCalendarHits(
      chosen,
      mode,
      'weekday',
      chosen.map((e) => labelOf(e.title)),
      formatCalendarEvidenceForSpeech,
    );
  }

  const now = new Date();
  const forwardEnd = new Date(now);
  forwardEnd.setMonth(forwardEnd.getMonth() + GENERIC_DOCTOR_CAL_FORWARD_MONTHS);
  const wideResult = await queryCalendarRange(now, forwardEnd);
  if (wideResult.status === 'unavailable') {
    return "I couldn't check your calendar right now.";
  }
  const rangeHits = wideResult.events.filter((e) => e.title && qualifies(e.title));
  if (rangeHits.length > 0) {
    const chosen = mode === 'next' ? rangeHits.slice(0, 1) : rangeHits;
    return speakGenericDoctorCalendarHits(
      chosen,
      mode,
      'date',
      chosen.map((e) => labelOf(e.title)),
      formatCalendarEvidenceForSpeech,
    );
  }
  return GENERIC_DOCTOR_CAL_ABSENCE;
}

/**
 * Authoritative re-read for the upcoming-visit referent (Continuity Step 4).
 * Flow C supplies IDENTITY ONLY -- getUpcomingAppointments is the
 * deterministic reader and owns every factual value in the returned
 * sentence. Exact-match on the normalized stored doctor name (the subject's
 * entityId is itself a stored doctor name from getLastVisit) -- no
 * fuzzy/substring matching, so this cannot select an ambiguous or wrong
 * doctor's appointments. Returns null when this subject cannot answer
 * (non-medical domain), so the caller falls through rather than
 * fabricating. Sentence shape mirrors tierRouter's phraseNamedDoctorUpcoming
 * -- not factored, same discipline as answerReferentVisitDate above
 * (Continuity Step 3 / Rule 11).
 */
export async function answerReferentUpcomingVisit(
  subject: ConversationalSubject,
): Promise<string | null> {
  if (subject.domain !== 'medical_doctor') return null;
  const { getUpcomingAppointments, normalizeDoctorNameForMatch } = await import('../db/medicalDB');
  const { formatSpokenDate } = await import('../utils/parseTime');
  const all = getUpcomingAppointments();
  const target = normalizeDoctorNameForMatch(subject.entityId);
  const matches = all.filter(
    (r) => r.doctorName && normalizeDoctorNameForMatch(r.doctorName) === target,
  );
  if (matches.length === 0) {
    return answerUpcomingCalendarEvidence(subject.entityId, subject.displayName);
  }
  const sorted = [...matches].sort((a, b) =>
    (a.visitDate < b.visitDate ? -1 : a.visitDate > b.visitDate ? 1 : 0),
  );
  const CAP = 3;
  const shown = sorted.slice(0, CAP);
  const remaining = sorted.length - shown.length;
  let sentence = `You see ${subject.displayName} on ${formatSpokenDate(shown[0].visitDate)}`;
  for (let i = 1; i < shown.length; i++) {
    const isLastShown = i === shown.length - 1;
    const connector = isLastShown && remaining === 0 ? 'and again' : 'then again';
    sentence += `, ${connector} ${formatSpokenDate(shown[i].visitDate)}`;
  }
  sentence += remaining > 0 ? `, and ${remaining} more after that.` : '.';
  return sentence;
}

// Fifth closed speech act (Android Calendar Range V1): year-bounded query
// against the live doctor subject. Unlike the other referent predicates,
// this one returns the extracted year (not a bare boolean) because the
// caller needs it -- subject supplies identity, this supplies the temporal
// bound. Deliberately narrow, closed phrasing family (mirrors the discipline
// every other referent act in this file follows): "I thought I saw him in
// 2024", "did I see him in 2024", "when did I see him in 2024". Requires
// BOTH an OBJECT-position third-person pronoun AND an explicit 4-digit year
// -- no bare "in 2024" alone (that has no subject-referent shape and isn't
// this act). Pronoun grammar note: "saw HIM" / "see HER" is the OBJECT of
// the verb, the same grammatical slot as REFERENT_VISIT_DATE_RE's "did I
// (last) see him/her" above -- this reuses THIRD_PERSON_REFERENT (object
// forms), NOT REFERENT_SUBJECT_PRONOUN (he|she|they, used only where the
// pronoun is the SUBJECT of its own clause, e.g. "what did HE tell me").
// Consistent with THIRD_PERSON_REFERENT's own established scope, this does
// not cover "them" (no existing object-position act in this file does).
const REFERENT_YEAR_RE = new RegExp(
  `^\\s*(?:i\\s+thought\\s+i\\s+saw|did\\s+i\\s+see|when\\s+did\\s+i\\s+see)\\s+(${THIRD_PERSON_REFERENT})\\s+in\\s+(19\\d{2}|20\\d{2})\\s*[?.!]?\\s*$`,
  'i',
);

export function isReferentYearBoundedVisitQuestion(text: string): { year: number } | null {
  const m = text.match(REFERENT_YEAR_RE);
  if (!m) return null;
  void m[1]; // pronoun discarded -- not a selector, no gender inference
  return { year: parseInt(m[2], 10) };
}

/**
 * Authoritative bounded-year re-read (Android Calendar Range V1). No
 * year-scoped medical authority exists (getLastVisit has no year filter and
 * always returns the single latest visit regardless of year, so it cannot
 * correctly answer a year-scoped question) -- this act goes straight to
 * calendar evidence, which is the only source capable of answering it. Never
 * auto-selects among multiple matches within the year: returns a bounded,
 * deterministic clarification naming the dates instead of guessing. Local
 * year bounds are HALF-OPEN to match queryCalendarEvidence's [start, end)
 * contract: start = local Jan 1 of `year`, end = local Jan 1 of `year + 1`
 * (NOT Dec 31 23:59:59.999 -- that mixes an inclusive-end value with an
 * exclusive filter; numerically harmless here but the wrong convention to
 * compose against a half-open contract, and the source of a real class of
 * off-by-one bugs elsewhere if copied). Matches this codebase's existing
 * local-date-window convention otherwise (see getAppointmentsForLocalDate /
 * getCachedEventsForDate). Returns null only for a non-medical-domain
 * subject, so the caller falls through rather than fabricating.
 */
export async function answerReferentYearBoundedVisit(
  subject: ConversationalSubject,
  year: number,
): Promise<string | null> {
  if (subject.domain !== 'medical_doctor') return null;
  const { normalizeDoctorNameForMatch } = await import('../db/medicalDB');
  const { queryCalendarEvidence, formatCalendarEvidenceForSpeech } = await import('../db/calendarCacheDB');
  const yearStart = new Date(year, 0, 1, 0, 0, 0, 0);
  const yearEnd = new Date(year + 1, 0, 1, 0, 0, 0, 0);
  const rangeResult = await queryCalendarEvidence(subject.entityId, normalizeDoctorNameForMatch, yearStart, yearEnd);
  if (rangeResult.status === 'unavailable') {
    // Not evidence of absence -- must never be spoken as "I don't have
    // anything...". Source-honest, distinct third voice.
    return "I couldn't check your calendar right now.";
  }
  const hits = rangeResult.events;
  if (hits.length === 0) {
    return `I don't have anything with ${subject.displayName} on your calendar in ${year}.`;
  }
  if (hits.length === 1) {
    return formatCalendarEvidenceForSpeech(subject.displayName, hits[0], 'date');
  }
  // Multiple matches in the same year -- never auto-select (Test E). Bounded
  // deterministic clarification naming every date. Carries the SAME
  // provenance prefix as every other calendar-sourced sentence in this file
  // -- a clarification is still a calendar-sourced utterance and must not
  // silently drop the "Your calendar shows" marker just because it asks a
  // question instead of stating a single fact.
  const dates = hits.map((h) => new Date(h.start_ms).toLocaleDateString([], { month: 'long', day: 'numeric' }));
  return `Your calendar shows ${hits.length} things with ${subject.displayName} in ${year} — ${dates.join(', ')}. Which one did you mean?`;
}
