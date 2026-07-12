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
  advice?: string;
  raw: string;
};

const PAST_VISIT = /\b(saw|visited|visiting|went to|met with|meeting with|had an appointment with|was seeing|were seeing|'ve been seeing|have been seeing|had been seeing)\b/i;
const FUTURE_VISIT = /\b(have (?:a |an )?(?:doctor'?s?|dentist|dental|follow-?up)?\s?appointment|appointment with|going to see|scheduled with|seeing my|seeing (?:dr\.?|the doctor)|see (?:dr\.?|the doctor))\b/i;
const MEDICATION = /\b(take|taking|i'm on|prescribed|started|using|use)\b/i;
const ADVICE = /\b(says i need to|told me to|advised me to|wants me to)\b/i;
const CALENDAR_READ_START = /^\s*\b(what|when|do i have|show me)\b/i;
const REMINDER_START = /\b(remind me|don't let me forget|set a reminder|reminder to)\b/i;

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

const DR_NAME = /Dr\.?\s+(\w+)/i;
const SPECIALTY =
  /my (cardiologist|doctor|physician|specialist|therapist|dentist|neurologist|oncologist|psychiatrist)/i;
const DOSAGE = /(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|milligrams?|micrograms?)|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty(?:-?five)?|thirty|forty|fifty|seventy-five|(?:one|two|five)\s+hundred(?:\s+(?:fifty|twenty-five))?)\s+(?:mg|mcg|ml|milligrams?|micrograms?))/i;

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
  'take', 'taking', 'on', 'prescribed', 'started', 'me', 'called', 'named',
  'something', 'anything', 'stuff',
  'medication', 'medications', 'meds', 'med', 'pill', 'pills',
  'tablet', 'tablets', 'capsule', 'capsules', 'prescription', 'prescriptions',
  'medicine', 'medicines', 'dose', 'dosage',
  'blood', 'pressure', 'sugar', 'heart', 'thyroid', 'cholesterol', 'pain',
]);

export function extractDrugName(text: string): string | undefined {
  const triggerMatch = text.match(DRUG_TRIGGER);
  if (!triggerMatch) return undefined;

  // Bounded lookahead — walk up to 6 tokens past the trigger, skip fillers,
  // stop at the first real candidate. Nothing real in that span → undefined.
  const afterTrigger = text.slice(triggerMatch.index! + triggerMatch[0].length);
  const tokens = afterTrigger.split(/\s+/).filter(Boolean).slice(0, 6);

  for (const rawToken of tokens) {
    const token = rawToken.replace(/[.,;:!?]+$/, "");
    if (!token) continue;
    if (DRUG_FILLER_WORDS.has(token.toLowerCase())) continue;
    if (/^\d+$/.test(token)) continue; // bare number — dosage handled separately
    if (token.length < 3 && !/^[A-Z]/.test(token)) continue; // short lowercase noise
    return token;
  }
  return undefined;
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

function extractAdvice(text: string): string | undefined {
  const m =
    text.match(/\b(?:says i need to|told me to|advised me to|wants me to)\s+(.+)/i);
  return m?.[1]?.trim().replace(/[.,;:!?]+$/, "");
}

export function detectMedicalEvent(text: string): MedicalEvent | null {
  const raw = text.trim();
  if (!raw) return null;
  if (CALENDAR_READ_START.test(raw)) return null;
  if (REMINDER_START.test(raw)) return null;
  // Build A: never read a list operation as a medical event.
  if (LIST_CONTEXT.test(raw)) return null;

  const hasPastVisit = PAST_VISIT.test(raw);
  const hasFutureVisit = FUTURE_VISIT.test(raw);
  const hasMedication = MEDICATION.test(raw);
  const hasAdvice = ADVICE.test(raw);

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
  const drug_name = hasMedication ? extractDrugName(raw) : undefined;
  const dosage = raw.match(DOSAGE)?.[1];
  const advice = hasAdvice ? extractAdvice(raw) : undefined;

  return {
    type,
    tense,
    doctor_name,
    specialty,
    drug_name,
    dosage,
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
