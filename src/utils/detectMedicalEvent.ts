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
const CATALOG_MED_NOUN = '(?:medication|medications|medicine|meds|pills|prescriptions)';
const CATALOG_MED_READ = new RegExp(
  '\\bdo i take (any )?(?:medication|meds|pills)\\b' +
    `|\\bwhat ${CATALOG_MED_NOUN} (?:am i|i(?:'m| am)) (?:currently )?(?:on|taking)\\b` +
    `|\\bthe ${CATALOG_MED_NOUN} (?:that )?i(?:'m| am) (?:currently )?(?:on|taking)\\b` +
    '|\\bwhat do i take\\b' +
    '|\\bwhat am i (?:currently )?(?:taking|on)\\b',
  'i',
);

/** Catalog medication list-read (not a named-drug inquiry, not a capture). */
export function isCatalogMedicationReadUtterance(text: string): boolean {
  const raw = text.trim();
  if (!raw) return false;
  if (CATALOG_MED_READ.test(raw)) return true;
  const unwrapped = afterLeadingReadRequestWrapper(raw);
  if (unwrapped !== raw && CATALOG_MED_READ.test(unwrapped)) return true;
  return false;
}

// General, domain-agnostic yes/no question shape: an utterance opening with
// subject-auxiliary inversion for first-person "I" ("Am I", "Should I", "Do
// I", "Have I", "Was I", ...). Sentence-initial inversion is the grammatical
// marker of English interrogative mood -- there is no natural first-person
// declarative sentence shaped this way. Pure sentence-initial word order,
// independent of any medication vocabulary, drug name, or brand. Closes the
// "Am I still supposed to take X?" / "Should I take X?" / "Am I taking X?"
// class generally (Semantic Interpretation V1 contract correction,
// 2026-09-07) -- not a per-utterance or per-drug-name patch.
const FIRST_PERSON_AUX_QUESTION_RE =
  /^(?:am|is|are|was|were|do|does|did|have|has|had|should|would|could|can|will|shall|may|might|must)\s+i\b/i;

export function isFirstPersonAuxiliaryQuestionShape(text: string): boolean {
  return FIRST_PERSON_AUX_QUESTION_RE.test(text.trim());
}

/** Medication taking/dose/frequency questions are reads, never capture. */
export function isMedicationInquirySpeechAct(text: string): boolean {
  const raw = text.trim();
  if (!raw || LIST_CONTEXT.test(raw)) return false;
  if (isCatalogMedicationReadUtterance(raw)) return false;
  if (isFirstPersonAuxiliaryQuestionShape(raw)) return true;
  if (FREQUENCY_INQUIRY.test(raw) && /\btake\b/i.test(raw)) return true;
  if (TIMING_INQUIRY.test(raw)) return true;
  if (DO_I_TAKE_INQUIRY.test(raw)) return true;
  if (DOSE_INQUIRY.test(raw) && (/\bmy\b/i.test(raw) || /\btake\b/i.test(raw) || /\b(?:of|for)\b/i.test(raw))) {
    return true;
  }
  return false;
}

// Narrower sibling of isMedicationInquirySpeechAct, for the Semantic
// Interpretation V1 seam's admission gate specifically (contract correction,
// 2026-09-07). Composed only of checks that require a genuine interrogative
// marker (a WH-word via isReadShapedUtterance at the call site, an inverted
// auxiliary, or an explicit "how often"/"when do I take"/"do I take" frame).
// Deliberately excludes isMedicationInquirySpeechAct's own DOSE_INQUIRY
// branch, which requires no question marker at all -- just "dose"/"dosage"
// co-occurring anywhere with "my"/"take"/"of"/"for". That looser rule is
// correct and load-bearing for the floor's own narrower callers (verified:
// every existing floor-level DOSE_INQUIRY test case already opens with a
// WH-word caught by isReadShapedUtterance first, so nothing here changes
// floor behavior) but is unsafe to reuse verbatim at the seam, which
// evaluates a materially wider range of genuine assertions than the floor
// ever does -- confirmed by direct execution: "I'm switching to a new dose
// of Synthroid, 75 micrograms." is a plain first-person assertion, not a
// question, yet satisfies DOSE_INQUIRY's co-occurrence check purely by
// mentioning "dose" and "of" together.
export function isMedicationQuestionShape(text: string): boolean {
  const raw = text.trim();
  if (!raw || LIST_CONTEXT.test(raw)) return false;
  if (isFirstPersonAuxiliaryQuestionShape(raw)) return true;
  if (FREQUENCY_INQUIRY.test(raw) && /\btake\b/i.test(raw)) return true;
  if (TIMING_INQUIRY.test(raw)) return true;
  if (DO_I_TAKE_INQUIRY.test(raw)) return true;
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

/** Polar/cleft verification of a past visit — capture-decline only. Does not authorize a read. */
export function isVisitHistoryVerificationQuestion(text: string): boolean {
  const raw = afterLeadingReadRequestWrapper(text.trim());
  return (
    /^was it\b[\s\S]*\bthat i\b[\s\S]*\b(?:saw|see|visited)\b/i.test(raw)
    || /^didn(?:['’]t| not)\s+i\s+(?:see|saw|visited)\b/i.test(raw)
    || /^did\s+i\s+(?:see|saw|visited)\b/i.test(raw)
    || /^was\b[\s\S]*\bthe (?:doctor|physician) i\b[\s\S]*\b(?:saw|see|visited)\b/i.test(raw)
  );
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

// ─── Medication domain evidence (Tier-H only — 2026-09-07 mechanism-tier
//     closure, superseding the 2026-09-06 repair and its 2026-09-06 residual
//     follow-up below) ───────────────────────────────────────────────────
// The 2026-09-06 repairs (see git history / superseded comment previously
// here) closed the "bare trigger + arbitrary noun" false-positive class
// (vacation/trip/class/router/camera/walks/...) but retained two remaining
// admission paths that were never actually evidence about MEDICATION: (a)
// candidate capitalization ("the shape a recognized brand name typically
// takes"), and (b) unconditional trust of five "historically lenient"
// trigger verbs for any bare candidate that survived the walk. Both are
// SYNTACTIC-SHAPE proxies, not domain evidence — a bounded 3B
// semantic-discrimination experiment (28 cases, 84 generations) proved
// neither proxy discriminates medication from ordinary proper nouns or
// activities: "I started CrossFit." / "I started Toastmasters." (lenient
// trigger, capitalized) and "I'm on LinkedIn." (capitalization alone) all
// satisfied the old rule with zero medication-specific evidence, while
// "I started skydiving." (lowercase, unambiguously non-medical) proved the
// lenient-trigger fallback was never actually about capitalization at all —
// it admitted any bare candidate of a trusted verb, case-blind.
//
// This function now recognizes ONLY genuine, non-positional domain evidence
// (Tier H): dosage, explicit medication/pharmacological terminology, doctor
// attribution, specialty attribution, and the existing discontinuation
// shape. A candidate with none of these no longer receives deterministic
// authority — the floor ABSTAINS (returns false) rather than guessing from
// grammar or capitalization; an abstained utterance is eligible for the
// Semantic Interpretation V1 seam (deterministic first refusal is
// preserved: this function still runs first, and Tier-H evidence still
// grants full, unchanged deterministic authority). No drug-name dictionary,
// no brand allowlist/blacklist, no replacement capitalization heuristic, no
// model-derived authority — only the removal of the two proxies that were
// never evidence in the first place.
//
// Known, disclosed, accepted consequence: bare medication statements that
// previously relied SOLELY on capitalization or lenient-trigger membership
// (e.g. "I take Eliquis", "I'm taking Lipitor.", "I'm taking metformin")
// no longer receive deterministic authority either — they are
// structurally indistinguishable from "I started CrossFit." to any
// grammar-only rule, proven by the same experiment. This is not a partial
// fix that happens to spare "real" drug names; it is the honest
// consequence of the floor no longer pretending grammar can tell them
// apart. See HERALD_MEDICATION_SEMANTIC_INTERPRETATION_V1 follow-up docs.
const MEDICATION_TERMINOLOGY_RE =
  /\b(?:medication|medications|meds|med|pill|pills|tablet|tablets|capsule|capsules|prescription|prescriptions|prescribed|medicine|medicines|dose|dosage)\b/i;

const DISCONTINUATION_SHAPE_RE = /\btake\s+(?:me|us|him|her|them)\s+off(?:\s+of)?\s+/i;

export function hasMedicationDomainEvidence(text: string, _drugName?: string): boolean {
  if (extractDosage(text)) return true;
  if (MEDICATION_TERMINOLOGY_RE.test(text)) return true;
  if (extractDoctorName(text)) return true;
  if (extractSpecialty(text)) return true;
  if (DISCONTINUATION_SHAPE_RE.test(text)) return true;
  return false;
}

// ─── Independent medication evidence (Semantic Interpretation V1 seam) ────
// Additive sibling to hasMedicationDomainEvidence. Does not replace that
// function or change detectMedicalEvent's extraction role. This function is
// only consulted after a SemanticProposal focus has already been
// independently identified and provenance-verified (checked to be a literal
// substring of raw_phrase) by a different, non-positional mechanism —
// deliberately reuses only genuinely reusable, position-independent Tier-H
// evidence signals (dosage, terminology, doctor/specialty attribution,
// discontinuation shape); the floor's OWN positional walk/determiner
// machinery was never applicable here and was never copied into this
// function.
//
// CAPITALIZATION REMOVED (2026-09-07, same failure-class closure as
// hasMedicationDomainEvidence above, not a separate feature). This function
// previously admitted a capitalized focus with zero other evidence — the
// identical syntactic-shape proxy the floor closure above removes, living
// in this sibling function instead. Direct execution proved it was equally
// non-discriminating here: hasIndependentMedicationEvidence(raw, focus)
// returned true for a hypothetical capitalized "CrossFit" focus exactly as
// readily as for "Lipitor" — a capitalized model focus is not, by itself,
// evidence the model got the domain right. A SemanticProposal's own
// confidence and the model's `focus`-emptiness judgment remain the seam's
// actual domain signal (validated separately, non-dictionary, non-model-
// authoritative — confidence still never grants ADMIT by itself); this
// function no longer adds a redundant, unsafe capitalization shortcut on
// top of them. Every other independent evidence mechanism — dosage,
// terminology, doctor/specialty attribution, discontinuation shape, and the
// filler/category-word focus exclusion below — is unchanged.
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
  return false;
}

export function detectMedicalEvent(text: string): MedicalEvent | null {
  const raw = text.trim();
  if (!raw) return null;
  if (isReadShapedUtterance(raw)) return null;
  if (isVisitHistoryVerificationQuestion(raw)) return null;
  if (isCatalogMedicationReadUtterance(raw)) return null;
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
