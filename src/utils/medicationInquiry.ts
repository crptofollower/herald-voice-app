// Deterministic named-medication inquiry (read) — not capture.
// Speech-act + named entity + stored fields. No fuzzy match. No LLM facts.

import { isMedicationInquirySpeechAct } from './detectMedicalEvent';
import {
  formatCurrentMedicationReadback,
  getActiveMedications,
  type Medication,
} from '../db/medicalDB';

const LIST_CONTEXT =
  /\b(grocery|shopping|to-?do|todo)\s+lists?\b|\b(off|from|on|to)\s+(my|the)\s+lists?\b|\bmy\s+lists?\b/i;

const CATALOG_READ = [
  /what (medication|medications|meds|pills) am i (on|taking)/i,
  /my (medication|medications|meds|prescriptions)/i,
  /\bwhat do i take\b/i,
  /\bwhat am i (taking|on)\b/i,
  /\bwhat (should i|do i) take\b/i,
  /\bmy (meds|medications|pills|prescriptions)\b/i,
  /\bdo i take (any )?(medication|meds|pills)\b/i,
  /\bwhat (medication|medications|medicine|meds|pills|prescriptions) do i take\b/i,
  /\bam i (on|taking) (any )?(medication|medications|meds|pills|prescriptions)\b/i,
];

const NAME_FILLERS = new Set([
  'a', 'an', 'the', 'my', 'your', 'some', 'it', 'that', 'this', 'one', 'any',
  'me', 'you', 'us', 'life', 'day', 'name', 'myself', 'yourself',
  'medication', 'medications', 'meds', 'med', 'pill', 'pills',
  'tablet', 'tablets', 'dose', 'dosage', 'medicine', 'prescription',
]);

export type MedicationInquiryField = 'frequency' | 'dosage' | 'timing' | 'record' | 'presence';

export type MedicationInquiry = {
  name: string | null;
  field: MedicationInquiryField;
};

function isCatalogMedicationRead(text: string): boolean {
  return CATALOG_READ.some((re) => re.test(text));
}

function cleanNameToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().replace(/[.,;:!?]+$/, '');
  if (token.length < 3) return null;
  if (NAME_FILLERS.has(token.toLowerCase())) return null;
  if (/^\d+$/.test(token)) return null;
  return token;
}

const INQUIRY_NAME_FRAMES: Array<{ re: RegExp; field: MedicationInquiryField }> = [
  { re: /\bhow\s+often\b[\s\S]*?\btake\s+([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'frequency' },
  { re: /\bhow\s+many\s+times\b[\s\S]*?\btake\s+([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'frequency' },
  { re: /\bwhen\s+do\s+i\s+take\s+([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'timing' },
  { re: /\bwhat(?:'s|\s+is)\s+my\s+([A-Za-z][A-Za-z0-9-]{1,40})\s+(?:dose|dosage)\b/i, field: 'dosage' },
  { re: /\bwhat\s+dosage\s+do\s+i\s+take\s+(?:for\s+)?([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'dosage' },
  { re: /\bwhat\s+(?:is\s+the\s+)?(?:dose|dosage)\s+(?:of|for)\s+(?:my\s+)?([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'dosage' },
  { re: /\bdo\s+i\s+take\s+([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'presence' },
  { re: /\bwhat\s+did\s+i\s+tell\s+you\s+about\s+([A-Za-z][A-Za-z0-9-]{1,40})\b/i, field: 'record' },
];

const FREQUENCY_SHAPE =
  /\bhow\s+often\b|\bhow\s+many\s+times\b/i;
const TIMING_SHAPE = /\bwhen\s+do\s+i\s+take\b/i;
const DOSAGE_SHAPE =
  /\b(?:dose|dosage)\b/i;
const DO_I_TAKE_SHAPE = /\bdo\s+i\s+take\b/i;
const NAMED_RECALL_SHAPE = /\bwhat\s+did\s+i\s+tell\s+you\s+about\b/i;

export { isMedicationInquirySpeechAct } from './detectMedicalEvent';

export function detectMedicationInquiry(text: string): MedicationInquiry | null {
  const raw = text.trim();
  if (!raw) return null;
  if (LIST_CONTEXT.test(raw)) return null;
  if (isCatalogMedicationRead(raw)) return null;

  for (const frame of INQUIRY_NAME_FRAMES) {
    const m = raw.match(frame.re);
    const name = cleanNameToken(m?.[1]);
    if (name) {
      if (frame.field === 'record') {
        return { name, field: 'record' };
      }
      return { name, field: frame.field };
    }
  }

  if (!isMedicationInquirySpeechAct(raw)) {
    if (NAMED_RECALL_SHAPE.test(raw)) return null;
    return null;
  }

  let field: MedicationInquiryField = 'record';
  if (FREQUENCY_SHAPE.test(raw)) field = 'frequency';
  else if (TIMING_SHAPE.test(raw)) field = 'timing';
  else if (DOSAGE_SHAPE.test(raw)) field = 'dosage';
  else if (DO_I_TAKE_SHAPE.test(raw)) field = 'presence';
  return { name: null, field };
}

function findActiveMedicationExact(name: string): Medication | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  try {
    const hits = getActiveMedications().filter((m) => m.name.trim().toLowerCase() === needle);
    if (hits.length !== 1) return null;
    return hits[0];
  } catch {
    return null;
  }
}

function storedFrequency(m: Medication): string {
  return (m.frequency ?? '').trim();
}

function storedDosage(m: Medication): string {
  return (m.dosage ?? '').trim();
}

function answerField(m: Medication, field: MedicationInquiryField): string {
  const freq = storedFrequency(m);
  const dose = storedDosage(m);
  if (field === 'dosage') {
    if (dose) return `Your ${m.name} dose is ${dose}.`;
    return `I have ${m.name} saved, but I don't have a dosage recorded.`;
  }
  if (field === 'frequency' || field === 'timing') {
    if (freq) {
      return field === 'timing'
        ? `I have you taking ${m.name} ${freq}.`
        : `I have you taking ${m.name} ${freq}.`;
    }
    return `I have ${m.name} saved, but I don't have how often you take it.`;
  }
  if (field === 'presence') {
    if (freq) return `I have you taking ${m.name} ${freq}.`;
    if (dose) return `I have ${m.name} saved at ${dose}, but I don't have how often you take it.`;
    return `I have ${m.name} saved, but I don't have how often you take it.`;
  }
  return formatCurrentMedicationReadback(m);
}

/**
 * Owns named medication questions. Returns a device-authoritative reply
 * (including honest miss). Null = not this owner.
 */
export function answerNamedMedicationInquiry(text: string): string | null {
  const inquiry = detectMedicationInquiry(text);
  if (!inquiry) return null;

  // Unnamed questions ("how often do I take it?") stay unowned here — no last-mentioned slot.
  if (!inquiry.name) return null;

  if (inquiry.field === 'record') {
    const row = findActiveMedicationExact(inquiry.name);
    if (!row) return null;
    return formatCurrentMedicationReadback(row);
  }

  const row = findActiveMedicationExact(inquiry.name);
  if (!row) {
    return `I don't have ${inquiry.name} in your current medications.`;
  }
  return answerField(row, inquiry.field);
}
