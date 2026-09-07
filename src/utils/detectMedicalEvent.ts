// src/utils/detectMedicalEvent.ts
// On-device medical event detection — no LLM, no network.
//
// Build A guardrail: this is the deterministic FLOOR for medical capture.
// It must never misfire — a false medical event corrupts the medications
// table (the trust-critical store). The LLM router (later build) refines
// intent, but device-first, offline, this layer must fail toward NOT capturing.

import type { IntentRecord } from '../hooks/llmLayers';

export type MedicalEvent = {
  type: 'medication' | 'visit' | 'advice';
  tense: 'past' | 'future';
  doctor_name?: string;
  specialty?: string;
  drug_name?: string;
  dosage?: string;
  frequency?: string;
  advice?: string;
  raw: string;
};

const PAST_VISIT = /\b(saw|visited|visiting|went to|met with|meeting with|had an appointment with|was seeing|were seeing|'ve been seeing|have been seeing|had been seeing)\b/i;
// Positive forward-looking visit evidence. Bare "see Dr" is NOT sufficient —
// it collides with historical/interrogative "when did I see Dr X".
const FUTURE_VISIT = /\b(have (?:a |an )?(?:doctor'?s?|dentist|dental|follow-?up)?\s?appointment|appointment with|going to see|gonna see|will see|scheduled with|seeing my|seeing (?:dr\.?|the doctor))\b/i;
const FUTURE_SEE_DR = /\bsee (?:dr\.?|the doctor)\b/i;
const FORWARD_VISIT_EVIDENCE = /\b(?:tomorrow|tonight|soon|coming up|next(?:\s+\w+)?|this (?:afternoon|evening|week|month)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at \d)\b/i;
const MEDICATION = /\b(take|taking|i'm on|prescribed|started|using|use)\b/i;
const ADVICE = /\b(says i need to|told me to|advised me to|wants me to)\b/i;
// Question/read-shape guard: a question is never a medical capture. `who` added
// 2026-08-20 (Continuity audit v2 §3.1) — "Who was the last Doctor I saw" passed
// this guard and then tripped PAST_VISIT on the word "saw", becoming a capture
// that armed a write pending against a read question. Note the asymmetry this
// closes: PAST_VISIT contains "saw" but not "see", which is why "Who did I see"
// was already safe and "…I saw" was not. Floor backfill per Spine §3a Law-1
// corollary — extend the deterministic pattern, never make the fallback smarter.
const READ_INTERROGATIVE = /^(what|when|who|do i have|show me)\b/i;
const CALENDAR_READ_START = /^\s*\b(what|when|who|do i have|show me)\b/i;
// Closed discourse openers only — not arbitrary leading text. A single name
// token is consumed only when the remainder is immediately read-shaped
// ("Kit, when…" / "Kit when…") and the token is not a temporal starter.
const READ_DISCOURSE_OPENER = /^(?:hey|okay|ok|yeah|so|um|uh|please|alright)[,:]?\s+/i;
const NON_VOCATIVE_READ_TOKEN = /^(yesterday|today|tomorrow|tonight|this|last|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const REMINDER_START = /\b(remind me|don't let me forget|set a reminder|reminder to)\b/i;

function afterLeadingReadVocative(text: string): string {
  let s = text.trim();
  for (let i = 0; i < 2; i++) {
    const opener = s.match(READ_DISCOURSE_OPENER);
    if (!opener) break;
    s = s.slice(opener[0].length);
  }
  const vocative = s.match(/^([A-Za-z]{2,16})[,:]?\s+/);
  if (
    vocative &&
    !NON_VOCATIVE_READ_TOKEN.test(vocative[1]) &&
    READ_INTERROGATIVE.test(s.slice(vocative[0].length))
  ) {
    return s.slice(vocative[0].length);
  }
  return text.trim();
}

// Closed, domain-general set of conversational request/report wrappers that
// relay or reference a question rather than answering one -- "can/could/
// would you tell me", "do you know", "I was asking (you) (if you can tell
// me)", "I wanted to know", "I was wondering" -- optionally preceded by a
// bare "no" discourse correction (2026-09-06, Samsung last-doctor device
// evidence: "No I was asking you if you can tell me who my last doctor
// was..."). Recognizing the wrapper never by itself makes an utterance
// read-shaped -- exactly like afterLeadingReadVocative above, the clause
// immediately after it must still independently satisfy
// CALENDAR_READ_START/READ_INTERROGATIVE (checked by the caller). This is
// why "I was telling you I saw Dr. Smith" and "I wanted to tell you I saw
// Dr. Smith" stay unaffected: neither "telling" nor "wanted to tell" is in
// this closed verb set, and even if a wrapper here matched, their remainder
// ("I saw Dr. Smith") does not itself start with what/when/who/etc. Not
// medical/doctor-specific -- the same closed verb set applies regardless of
// domain, per the read-shape guard's own existing discipline.
const READ_REQUEST_WRAPPER_RE =
  /^(?:no,?\s+)?(?:(?:can|could|would)\s+you\s+tell\s+me|do\s+you\s+know|i\s+was\s+asking(?:\s+you)?(?:\s+if\s+you\s+(?:can|could|would)\s+tell\s+me)?|i\s+wanted\s+to\s+know|i\s+was\s+wondering)\b[,:]?\s*/i;

export function afterLeadingReadRequestWrapper(text: string): string {
  const s = text.trim();
  const m = s.match(READ_REQUEST_WRAPPER_RE);
  if (!m) return s;
  return s.slice(m[0].length).trim();
}

// ─── List-context guard (Build A) ─────────────────────────────────────────────
// List edits collide with medical triggers because "take ... off my list" and
// "I'm on ..." share verbs with medication phrasing. Any sentence that refers to
// a grocery / shopping / to-do list — or "off/from/on my list" — is a LIST
// operation and must NEVER be read as a medical event. This is the deterministic
// guard that stops "take chocolate milk off my grocery list" from becoming a
// medication. Erring toward "not medical" here is correct: a missed capture is
// recoverable; a corrupted medications table is a trust failure.
const LIST_CONTEXT =
  /\b(grocery|shopping|to-?do|todo)\s+lists?\b|\b(off|from|on|to)\s+(my|the)\s+lists?\b|\bmy\s+lists?\b/i;

/** Medication discontinuation — not list-removal operator shape. */
const MEDICATION_DISCONTINUATION_TAKE_OFF =
  /\btake\s+(?:me|us|him|her|them)\s+off(?:\s+of)?\b/i;

/**
 * List-removal operator shape without an explicit "list" token.
 * Blocks "take eggs off" / "take off eggs" from becoming medication capture.
 * Medication discontinuation ("take me off Eliquis") is excluded.
 */
export function isListRemovalOperatorShape(text: string): boolean {
  const raw = text.trim();
  if (!raw || LIST_CONTEXT.test(raw)) return false;
  if (MEDICATION_DISCONTINUATION_TAKE_OFF.test(raw)) return false;
  if (/\b(?:take|get|knock|pull)\s+(?!me\b|us\b|him\b|her\b|them\b)(?:the\s+)?(.+?)\s+off\b/i.test(raw)) {
    return true;
  }
  if (/\b(?:take|get|knock|pull)\s+off\s+(?:the\s+)?\S/i.test(raw)) return true;
  if (/\b(?:cross|scratch|mark)\s+off\s+(?:the\s+)?\S/i.test(raw)) return true;
  return false;
}

/** Structural list operators — never a medication name. */
const STRUCTURAL_LIST_OPERATORS = new Set(['off', 'out', 'from']);
const FREQUENCY_INQUIRY = /\bhow\s+often\b|\bhow\s+many\s+times\b/i;
const TIMING_INQUIRY = /\bwhen\s+do\s+i\s+take\b/i;
const DO_I_TAKE_INQUIRY = /\bdo\s+i\s+take\b/i;
const DOSE_INQUIRY = /\b(?:dose|dosage)\b/i;
const CATALOG_MED_READ =
  /\bdo i take (any )?(medication|meds|pills)\b|\bwhat (medication|medications|meds|pills) am i (on|taking)\b|\bwhat do i take\b|\bwhat am i (taking|on)\b/i;

/** Medication taking/dose/frequency questions are reads, never capture. */
export function isMedicationInquirySpeechAct(text: string): boolean {
  const raw = text.trim();
  if (!raw || LIST_CONTEXT.test(raw)) return false;
  if (CATALOG_MED_READ.test(raw)) return false;
  if (FREQUENCY_INQUIRY.test(raw) && /\btake\b/i.test(raw)) return true;
  if (TIMING_INQUIRY.test(raw)) return true;
  if (DO_I_TAKE_INQUIRY.test(raw)) return true;
  if (DOSE_INQUIRY.test(raw) && (/\bmy\b/i.test(raw) || /\btake\b/i.test(raw) || /\b(?:of|for)\b/i.test(raw))) {
    return true;
  }
  return false;
}

const DR_NAME = /Dr\.?\s+(\w+)/i;
const SPECIALTY =
  /my (cardiologist|doctor|physician|specialist|therapist|dentist|neurologist|oncologist|psychiatrist)/i;
const DOSAGE = /(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|milligrams?|micrograms?)|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:-?five)?|thirty|forty|fifty|seventy-five|(?:one|two|five)\s+hundred(?:\s+(?:fifty|twenty-five))?)\s+(?:mg|mcg|ml|milligrams?|micrograms?))/i;

// Single owner for "is this utterance question/read-shaped." Same regex the
// capture guard below uses — exported rather than copy-pasted so the capture
// decline and the provenance suppression can never drift apart.
export function isReadShapedUtterance(text: string): boolean {
  const raw = text.trim();
  return CALENDAR_READ_START.test(raw)
    || CALENDAR_READ_START.test(afterLeadingReadVocative(raw))
    || CALENDAR_READ_START.test(afterLeadingReadRequestWrapper(raw));
}

export function extractDoctorName(text: string): string | undefined {
  const dr = text.match(DR_NAME);
  if (dr?.[1]) {
    const hasPeriod = /^dr\./i.test(dr[0]);
    return `Dr${hasPeriod ? '.' : ''} ${dr[1]}`;
  }
  return undefined;
}

function extractSpecialty(text: string): string | undefined {
  return text.match(SPECIALTY)?.[1];
}

// Merged trigger set — covers both this file's original phrasing and the
// separate set medicalDB.ts's guessMedicationName used to use on its own
// before this consolidation. One trigger list, shared by both extractors.
const DRUG_TRIGGER = /\b(?:take|taking|i'm on|i am on|am on|is on|on|prescribed|started|using|use)\b/i;

// Words that can sit between the trigger verb and the real drug name in real
// speech ("started TAKING MY BLOOD PRESSURE medication") but are never
// themselves a drug name. Skipped, never captured. Generic body/condition
// nouns are included deliberately — "blood pressure medication" names no
// drug; better to ask than to write "blood" into the medications table.
// Extend this list as real mis-captures surface — it will never be complete,
// and that's fine: a missed capture is recoverable, a wrong one is not.
const DRUG_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'my', 'your', 'some', 'it', 'that', 'this', 'one', 'of', 'with', 'for',
  'daily', 'twice', 'once', 'new', 'old', 'low', 'high', 'small', 'big',
  'morning', 'evening', 'night', 'nightly',
  'take', 'taking', 'on', 'prescribed', 'started', 'using', 'use', 'me', 'called', 'named',
  'something', 'anything', 'stuff',
  'medication', 'medications', 'meds', 'med', 'pill', 'pills',
  'tablet', 'tablets', 'capsule', 'capsules', 'prescription', 'prescriptions',
  'medicine', 'medicines', 'dose', 'dosage',
  'blood', 'pressure', 'sugar', 'heart', 'thyroid', 'cholesterol', 'pain',
  'off', 'out', 'from',
]);

/**
 * Bounded lookahead — walk up to 6 tokens past the trigger, skip fillers,
 * stop at the first real candidate. Returns not just the candidate but the
 * fillers skipped en route and whatever remains after it (both within the
 * same 6-token window) — shared by extractDrugName (candidate only) and
 * hasMedicationDomainEvidence's residual-floor guard below (2026-09-06
 * floor repair: the skipped/trailing shape is exactly what that guard needs
 * to see; duplicating this walk a second time would let the two drift).
 */
function walkDrugCandidate(afterTrigger: string): { candidate: string | undefined; skipped: string[]; trailing: string[] } {
  const tokens = afterTrigger.split(/\s+/).filter(Boolean).slice(0, 6);
  const skipped: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/[.,;:!?]+$/, "");
    if (!token) continue;
    const lower = token.toLowerCase();
    if (
      DRUG_FILLER_WORDS.has(lower) ||
      STRUCTURAL_LIST_OPERATORS.has(lower) ||
      /^\d+$/.test(token) ||
      (token.length < 3 && !/^[A-Z]/.test(token))
    ) {
      skipped.push(token);
      continue;
    }
    return { candidate: token, skipped, trailing: tokens.slice(i + 1) };
  }
  return { candidate: undefined, skipped, trailing: [] };
}

export function extractDrugName(text: string): string | undefined {
  const discontinuation = text.match(
    /\btake\s+(?:me|us|him|her|them)\s+off(?:\s+of)?\s+(.+)/i,
  );
  if (discontinuation?.[1]) {
    const token = discontinuation[1].trim().split(/\s+/)[0]?.replace(/[.,;:!?]+$/, '');
    if (token && !DRUG_FILLER_WORDS.has(token.toLowerCase()) && !STRUCTURAL_LIST_OPERATORS.has(token.toLowerCase())) {
      return token;
    }
  }

  const triggerMatch = text.match(DRUG_TRIGGER);
  if (!triggerMatch) return undefined;

  const afterTrigger = text.slice(triggerMatch.index! + triggerMatch[0].length);
  return walkDrugCandidate(afterTrigger).candidate;
}

// Matches a dosage mention anywhere in the sentence: "500mg", "10 mg",
// "2 units", "50 micrograms". Independent of DRUG_TRIGGER — dosage can
// appear before or after the drug name ("10mg of lisinopril" / "lisinopril 10mg").
const MED_DOSAGE_PATTERN = /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|units?|milligrams?|micrograms?))\b/i;

const SPOKEN_NUMBERS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', fifteen: '15', twenty: '20',
  'twenty-five': '25', thirty: '30', forty: '40', fifty: '50',
  'seventy-five': '75', hundred: '100', 'one hundred': '100',
  'two hundred': '200', 'two hundred fifty': '250',
  'five hundred': '500',
};

const SPOKEN_DOSAGE_PATTERN = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:-?five)?|thirty|forty|fifty|seventy-five|(?:one|two|five)\s+hundred(?:\s+(?:fifty|twenty-five))?)\s+(mg|mcg|ml|milligrams?|micrograms?|units?)\b/i;

export function extractDosage(text: string): string | undefined {
  // Numeric form: "10 mg", "500mg", "2.5 ml"
  const numeric = text.match(MED_DOSAGE_PATTERN);
  if (numeric?.[1]) return numeric[1].replace(/\s+/g, '');
  // Spoken form: "ten milligrams", "five hundred mg"
  const spoken = text.match(SPOKEN_DOSAGE_PATTERN);
  if (!spoken) return undefined;
  const word = spoken[1].toLowerCase().trim();
  const unitRaw = spoken[2].toLowerCase();
  const UNIT_ABBREVIATIONS: Record<string, string> = {
    milligram: 'mg', milligrams: 'mg',
    microgram: 'mcg', micrograms: 'mcg',
  };
  const unit = UNIT_ABBREVIATIONS[unitRaw] ?? unitRaw;
  const digit = SPOKEN_NUMBERS[word] ?? SPOKEN_NUMBERS[word.replace(/\s+/g,'-')] ?? word;
  return `${digit}${unit}`;
}

// Closed explicit-frequency families only. Match the spoken span verbatim.
// Multiple distinct hits → ambiguous; do not pick a structured value.
const FREQUENCY_SPANS: RegExp[] = [
  /\bmorning and night\b/i,
  /\bevery morning\b/i,
  /\bevery night\b/i,
  /\b(?:once|twice|thrice|(?:one|two|three)\s+times)\s+a\s+day\b/i,
  /\b(?:once|twice|three times)\s+daily\b/i,
  /\bnightly\b/i,
];

export function extractFrequency(text: string): string | undefined {
  const hits: string[] = [];
  for (const re of FREQUENCY_SPANS) {
    const m = text.match(re);
    if (m?.[0]) hits.push(m[0]);
  }
  if (hits.length === 0) return undefined;
  if (hits.length === 1) return hits[0];
  const unique = [...new Set(hits.map((h) => h.toLowerCase()))];
  if (unique.length === 1) return hits[0];
  const longest = hits.reduce((a, b) => (a.length >= b.length ? a : b));
  const restDistinct = hits.some(
    (h) => h.toLowerCase() !== longest.toLowerCase() && !longest.toLowerCase().includes(h.toLowerCase()),
  );
  if (restDistinct) return undefined;
  return longest;
}

function extractAdvice(text: string): string | undefined {
  const m =
    text.match(/\b(?:says i need to|told me to|advised me to|wants me to)\s+(.+)/i);
  return m?.[1]?.trim().replace(/[.,;:!?]+$/, "");
}

// Reportative doctor-attributed speech (said / told me that), not the
// imperative advice family (told me to / wants me to). Complement is the
// exact clause span — never paraphrased. Imperative "to …" is declined so
// this path cannot steal extractAdvice's grounded instruction.
const DOCTOR_ATTRIBUTED_OUTCOME =
  /\b(?:(?:he|she|they|the doctor|my doctor)|(?:dr\.?\s+\w+))\s+(?:said|says|told me|tells me)(?:\s+that)?\s+([^.!?]+)/i;

export function extractDoctorAttributedOutcome(text: string): string | undefined {
  const m = text.match(DOCTOR_ATTRIBUTED_OUTCOME);
  const span = m?.[1]?.trim().replace(/[.,;:!?]+$/, "").trim();
  if (!span) return undefined;
  if (/^to\b/i.test(span)) return undefined;
  return span;
}

/** Past/future visit claims require domain evidence — generic "saw/visited" alone is not authority. */
const MEDICAL_VISIT_DOMAIN_EVIDENCE =
  /\b(?:doctor|dentist|physician|therapist|cardiologist|neurologist|oncologist|psychiatrist|specialist|appointment|dr\.?\s+\w+)\b/i;

export function hasMedicalVisitDomainEvidence(text: string): boolean {
  if (extractDoctorName(text)) return true;
  if (extractSpecialty(text)) return true;
  return MEDICAL_VISIT_DOMAIN_EVIDENCE.test(text);
}

// ─── Medication domain evidence (2026-09-06 medication admission repair) ──
// Generic trigger verbs alone ("taking", "using", "on", "started") are not
// sufficient to promote an arbitrary following noun into medication capture
// -- proven by device evidence: "We're taking a vacation next month" / "a
// trip to the mountains" / "a class this semester", "I'm using a new
// router", "I'm on vacation next week", "I'm taking my car to the shop",
// "I started a new job", "I take the train to work" all satisfied the bare
// MEDICATION trigger with zero medication-specific evidence
// (HERALD_SEP6_DEVICE_ROUTE_DIAGNOSTIC_2026-09-06.md). Mirrors
// hasMedicalVisitDomainEvidence's architectural role but with vocabulary
// specific to genuine medication-taking -- doctor/appointment vocabulary is
// semantically wrong here.
//
// Composed entirely from already-existing signals, no exhaustive drug-name
// dictionary: dosage evidence (extractDosage), explicit medication/
// pharmacological terminology (the same words DRUG_FILLER_WORDS already
// treats as "about medication in general, never itself a drug name" --
// reused here for their complementary positive-evidence role, plus
// "prescribed", already one of MEDICATION's own trigger verbs and
// inherently medical), doctor/specialty attribution (extractDoctorName/
// extractSpecialty, already used by hasMedicalVisitDomainEvidence), and the
// existing discontinuation shape ("take me off X" -- already a narrow,
// specific, separately-gated pattern, distinct from ordinary noun objects).
//
// A candidate with none of the above is still admitted if (a) it is
// capitalized -- the shape a recognized brand name typically takes in
// transcribed speech -- or (b) the admitting trigger is one of the
// historically-sufficient-alone bare verbs: every existing Herald regression
// test for a bare, lowercase, otherwise-unevidenced medication name uses
// "taking"/"take"/"started"/"using" (e.g. "I'm taking metformin", "I take
// Eliquis"); none uses bare "on". A determiner (a/an/the/my/your/his/her/
// our/their/some/this/that/one) immediately following the trigger overrides
// all of the above and always requires real evidence -- every device-
// observed false positive had exactly this shape ("taking A vacation",
// "using A new router", "on A plane") and no genuine medication statement in
// Herald's existing test suite is phrased this way.
const MEDICATION_TERMINOLOGY_RE =
  /\b(?:medication|medications|meds|med|pill|pills|tablet|tablets|capsule|capsules|prescription|prescriptions|prescribed|medicine|medicines|dose|dosage)\b/i;

const DRUG_CANDIDATE_DETERMINER_RE =
  /^(?:a|an|the|my|your|his|her|our|their|some|this|that|one)\b/i;

const DISCONTINUATION_SHAPE_RE = /\btake\s+(?:me|us|him|her|them)\s+off(?:\s+of)?\s+/i;

// Historically-sufficient-alone bare trigger verbs -- see comment above.
// Deliberately excludes "on"/"i'm on"/"prescribed" (the latter is already
// covered by MEDICATION_TERMINOLOGY_RE above, so omitting it here changes
// nothing observable).
const LENIENT_BARE_MEDICATION_TRIGGER = /\b(?:take|taking|started|using|use)\b/i;

// ─── Residual floor repair (2026-09-06, follow-up) ─────────────────────────
// HERALD_MEDICATION_FLOOR_ACCEPTANCE_CONTRADICTION_DIAGNOSTIC_2026-09-06.md.
// The determiner override above only ever inspected the literal token
// immediately after the FIRST trigger match in raw text. Two device/device-
// adjacent-proven gaps in that scope, both closed here without any new
// drug-name dictionary, both reusing vocabulary already in this file:
//
// 1) Repeated/stacked trigger verbs hide a later determiner ("started USING
//    my new camera" — "using" itself was never filtered as filler, so the
//    walk stopped on "using" before ever reaching "my"). Fix: "using"/"use"
//    now join the other three lenient trigger-verb forms already in
//    DRUG_FILLER_WORDS, and the override now scans every token
//    walkDrugCandidate actually skipped en route to the candidate — not just
//    the literal first one — for a determiner.
// 2) Determiner-less narrative continuations ("take LONG walks" — no
//    determiner anywhere, so the override never engaged at all). Fix: the
//    lenient bare-trigger fallback now additionally requires the candidate
//    to terminate its clause — trailing content is allowed only when it is
//    itself already-recognized medication modifier material (a dosage span
//    via extractDosage, a frequency span via extractFrequency, or a bare
//    temporal token via the existing NON_VOCATIVE_READ_TOKEN set already
//    used elsewhere in this file for an unrelated read-shape purpose) —
//    exactly the shape every genuine bare-lowercase positive in the locked
//    suite already has (e.g. "started metformin YESTERDAY").
export function hasMedicationDomainEvidence(text: string, drugName?: string): boolean {
  if (extractDosage(text)) return true;
  if (MEDICATION_TERMINOLOGY_RE.test(text)) return true;
  if (extractDoctorName(text)) return true;
  if (extractSpecialty(text)) return true;
  if (DISCONTINUATION_SHAPE_RE.test(text)) return true;

  const triggerMatch = text.match(DRUG_TRIGGER);
  const walk = triggerMatch
    ? walkDrugCandidate(text.slice(triggerMatch.index! + triggerMatch[0].length))
    : { candidate: undefined, skipped: [] as string[], trailing: [] as string[] };

  if (walk.skipped.some((tok) => DRUG_CANDIDATE_DETERMINER_RE.test(tok))) return false;
  if (!isAllowedTrailingMedicationContent(walk.trailing)) return false;

  if (drugName && /^[A-Z]/.test(drugName)) return true;
  return LENIENT_BARE_MEDICATION_TRIGGER.test(text);
}

/** Trailing tokens after a bare lenient-trigger candidate are permitted only
 *  when they are themselves already-recognized medication modifier material
 *  — never an arbitrary continuation of the object noun phrase. Reuses
 *  extractDosage/extractFrequency (dosage/frequency spans anywhere in the
 *  trailing text) and NON_VOCATIVE_READ_TOKEN (a closed temporal-token set
 *  already defined above for afterLeadingReadVocative's unrelated purpose)
 *  — no new vocabulary. */
function isAllowedTrailingMedicationContent(trailing: string[]): boolean {
  if (trailing.length === 0) return true;
  const trailingText = trailing.join(' ');
  if (extractDosage(trailingText)) return true;
  if (extractFrequency(trailingText)) return true;
  return trailing.every((rawTok) => NON_VOCATIVE_READ_TOKEN.test(rawTok.replace(/[.,;:!?]+$/, '')));
}

// ─── Independent medication evidence (Semantic Interpretation V1 seam) ────
// Additive sibling to hasMedicationDomainEvidence. Does not replace that
// function or change detectMedicalEvent's extraction role. The residual
// floor repair above does modify hasMedicationDomainEvidence (shared walk,
// skipped-token determiner scan, trailing-clause terminator); those
// positional floor heuristics stay on the regex/token-walk path. This
// function is only consulted after a SemanticProposal focus has already
// been identified and provenance-verified.
//
// hasMedicationDomainEvidence's determiner / trailing-clause guards
// (DRUG_CANDIDATE_DETERMINER_RE and isAllowedTrailingMedicationContent
// above) are not themselves domain evidence — they compensate for
// extractDrugName's blind, position-based token walk being unable to tell
// "taking A vacation" from "taking AN Advil." That precondition (an
// unverified, positionally-blind candidate) does not hold for a
// SemanticProposal's `focus`: a focus span has already been independently
// identified and provenance-verified (checked to be a literal substring of
// raw_phrase) by a different, non-positional mechanism before this function
// is ever consulted. Reapplying a position-in-raw-text heuristic to that
// already-verified span would test the wrong thing (regex-extraction
// confidence) rather than the right thing (does domain evidence for THIS
// candidate exist anywhere in the utterance). This function therefore
// reuses every genuinely reusable, position-independent evidence signal
// already in this file, and deliberately omits the floor's positional
// guards, which belong solely to the regex/token-extraction mechanism
// above and must never be copied here.
//
// One check is new here (not present in hasMedicationDomainEvidence at all):
// a candidate that is itself a filler/category word (DRUG_FILLER_WORDS) or
// bare medication terminology (MEDICATION_TERMINOLOGY_RE) — e.g. "medicine,"
// "pill," "prescription" — is never an admissible medication NAME, regardless
// of how much domain evidence surrounds it. This mirrors extractDrugName's
// own DRUG_FILLER_WORDS exclusion for its token walk, applied here to a
// model-identified focus instead of a regex-walked token.
export function hasIndependentMedicationEvidence(raw: string, focus?: string): boolean {
  if (focus) {
    const normalizedFocus = focus.trim().toLowerCase();
    if (!normalizedFocus) return false;
    if (DRUG_FILLER_WORDS.has(normalizedFocus)) return false;
    if (MEDICATION_TERMINOLOGY_RE.test(focus)) return false;
  }
  if (extractDosage(raw)) return true;
  if (MEDICATION_TERMINOLOGY_RE.test(raw)) return true;
  if (extractDoctorName(raw)) return true;
  if (extractSpecialty(raw)) return true;
  if (DISCONTINUATION_SHAPE_RE.test(raw)) return true;
  if (focus && /^[A-Z]/.test(focus)) return true;
  return false;
}

export function detectMedicalEvent(text: string): MedicalEvent | null {
  const raw = text.trim();
  if (!raw) return null;
  if (isReadShapedUtterance(raw)) return null;
  if (isMedicationInquirySpeechAct(raw)) return null;
  if (REMINDER_START.test(raw)) return null;
  // Build A: never read a list operation as a medical event.
  if (LIST_CONTEXT.test(raw)) return null;
  if (isListRemovalOperatorShape(raw)) return null;

  let hasPastVisit = PAST_VISIT.test(raw);
  let hasFutureVisit =
    FUTURE_VISIT.test(raw) || (FUTURE_SEE_DR.test(raw) && FORWARD_VISIT_EVIDENCE.test(raw));
  let hasMedication = MEDICATION.test(raw);
  const hasAdvice = ADVICE.test(raw);

  if (hasPastVisit && !hasMedicalVisitDomainEvidence(raw)) {
    hasPastVisit = false;
  }
  // Symmetric with hasPastVisit above: bare future "see/seeing" alternatives
  // (going to see / gonna see / will see / seeing my / scheduled with) carry
  // no doctor/medical token of their own and collide with ordinary future-
  // tense social/family/travel narrative ("going to see Sarah"). Require the
  // same domain evidence the past-tense path already requires. Alternatives
  // that already contain their own medical token ("appointment", "Dr. X",
  // "seeing the doctor") are unaffected, since that token itself satisfies
  // hasMedicalVisitDomainEvidence.
  if (hasFutureVisit && !hasMedicalVisitDomainEvidence(raw)) {
    hasFutureVisit = false;
  }
  // Medication admission guard (2026-09-06) — see hasMedicationDomainEvidence
  // above. Computed before the "nothing matched" early return below, exactly
  // mirroring hasPastVisit/hasFutureVisit's own guard shape. The candidate
  // is extracted once here and reused for the final drug_name field so
  // extractDrugName never runs twice.
  const medicationCandidate = hasMedication ? extractDrugName(raw) : undefined;
  if (hasMedication && !hasMedicationDomainEvidence(raw, medicationCandidate)) {
    hasMedication = false;
  }

  if (!hasPastVisit && !hasFutureVisit && !hasMedication && !hasAdvice) return null;

  let type: MedicalEvent['type'];
  let tense: MedicalEvent['tense'];

  if (hasPastVisit) {
    type = 'visit';
    tense = 'past';
  } else if (hasFutureVisit) {
    type = 'visit';
    tense = 'future';
  } else if (hasMedication) {
    type = 'medication';
    tense = 'past';
  } else {
    type = 'advice';
    tense = 'past';
  }

  const doctor_name = extractDoctorName(raw);
  const specialty = extractSpecialty(raw);
  const drug_name = hasMedication ? medicationCandidate : undefined;
  const dosage = raw.match(DOSAGE)?.[1];
  const frequency = hasMedication ? extractFrequency(raw) : undefined;
  const advice = hasAdvice ? extractAdvice(raw) : undefined;

  return {
    type,
    tense,
    doctor_name,
    specialty,
    drug_name,
    dosage,
    frequency,
    advice,
    raw,
  };
}

// ─── Diagnosis capture (Spine §3 verbatim) ────────────────────────────────────
// A diagnosis is NOT a medication and NOT a visit — its own verbatim path into
// medical_records.diagnosis. Biased to NOT capture (same guardrail as above):
// fires only on an explicit diagnosis cue or a medical-results frame. Bare
// "I have X" is deliberately not a trigger. The condition is carried
// CHARACTER-FOR-CHARACTER — the full phrase, never token-truncated.
const DIAGNOSIS_READ_GUARD =
  /\b(what('?s| is| are)|do i have|what do i have|tell me|show me|read me|what am i diagnosed|any diagnos)\b/i;
const DIAGNOSIS_CUE =
  /\b(?:diagnosed with|diagnosed me with|diagnosis is|i suffer from|i(?:'ve| have) been diagnosed with|i was diagnosed with)\s+(.+)/i;
const RESULTS_CUE =
  /\b(?:test results?|lab results?|labs?|blood ?work|biopsy|pathology|scan|mri|ct scan|x-?ray|screening)\b/i;
const RESULTS_HAVE =
  /\bi\s+(?:have|'ve got|have got|got)\s+(.+)/i;

function cleanCondition(raw: string): string {
  return raw.trim().replace(/[.!?]+$/, '').trim();
}

export function detectDiagnosisCapture(text: string): IntentRecord[] {
  const raw = text.trim();
  if (!raw) return [];
  if (DIAGNOSIS_READ_GUARD.test(raw)) return [];
  if (LIST_CONTEXT.test(raw)) return []; // never read a list op as a diagnosis
  if (isListRemovalOperatorShape(raw)) return [];

  const cue = raw.match(DIAGNOSIS_CUE);
  if (cue?.[1]) {
    const condition = cleanCondition(cue[1]);
    if (condition.length >= 2) return [{ type: 'diagnosis_capture', condition, raw }];
  }

  if (RESULTS_CUE.test(raw)) {
    const have = raw.match(RESULTS_HAVE);
    if (have?.[1]) {
      const condition = cleanCondition(have[1]);
      if (condition.length >= 2) return [{ type: 'diagnosis_capture', condition, raw }];
    }
  }

  return [];
}

// ─── Doctor-intro capture ("Dr X is my Y") ────────────────────────────────────
// A doctor-relationship statement is NOT a medication and NOT a visit — deterministic,
// runs BEFORE medication detection so "Dr Sarver is my General practitioner" can
// never misfire as a medication (MEDICAL_SURFACING_DESIGN_SPEC §2.2d). Name via
// extractDoctorName (verbatim "Dr. X"), specialty captured verbatim from the
// matched group. Confirm-gated per medical policy.
const DOCTOR_INTRO_CUE = /\bdr\.?\s+\w+\s+is\s+my\s+([a-z ]{3,40})\b/i;

export function detectDoctorIntroCapture(text: string): IntentRecord[] {
  const raw = text.trim();
  if (!raw) return [];
  if (LIST_CONTEXT.test(raw)) return [];

  const name = extractDoctorName(raw);
  const cue = raw.match(DOCTOR_INTRO_CUE);
  if (name && cue?.[1]) {
    const specialty = cue[1].trim().replace(/[.!?]+$/, '').trim();
    if (specialty.length >= 3) {
      return [{ type: 'doctor_intro_capture', name, specialty, raw }];
    }
  }
  return [];
}
