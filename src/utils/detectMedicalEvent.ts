// src/utils/detectMedicalEvent.ts
// On-device medical event detection — no LLM, no network.
//
// Build A guardrail: this is the deterministic FLOOR for medical capture.
// It must never misfire — a false medical event corrupts the medications
// table (the trust-critical store). The LLM router (later build) refines
// intent, but device-first, offline, this layer must fail toward NOT capturing.

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

const PAST_VISIT = /\b(saw|visited|went to|met with|had an appointment with)\b/i;
const FUTURE_VISIT = /\b(have an appointment|going to see|scheduled with|seeing my)\b/i;
const MEDICATION = /\b(take|taking|i'm on|prescribed|started)\b/i;
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
const DOSAGE = /(\d+\s*mg|\d+\s*mcg|\d+\s*ml)/i;

function extractDoctorName(text: string): string | undefined {
  const dr = text.match(DR_NAME);
  if (dr?.[1]) return `Dr. ${dr[1]}`;
  return undefined;
}

function extractSpecialty(text: string): string | undefined {
  return text.match(SPECIALTY)?.[1];
}

function extractDrugName(text: string): string | undefined {
  const m = text.match(
    /\b(?:take|taking|i'm on|prescribed|started)\s+([A-Z][\w-]*|[a-z]{3,}[\w-]*)/i
  );
  const candidate = m?.[1];
  if (!candidate) return undefined;
  const stop = /^(a|an|the|my|your|some|it|that|this|one|daily|twice|once)$/i;
  if (stop.test(candidate)) return undefined;
  return candidate.replace(/[.,;:!?]+$/, "");
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
