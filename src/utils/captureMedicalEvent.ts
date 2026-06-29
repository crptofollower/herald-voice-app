import { writeMedicalRecord, writeMedication } from '../db/medicalDB';
import { writeClarification } from '../db/clarificationDB';
import { MedicalEvent } from './detectMedicalEvent';

export type CaptureResult = {
  recordId: string;
  followUpSlot: string | null;
  followUpQuestion: string | null;
};

export function captureMedicalEvent(event: MedicalEvent): CaptureResult {
  let recordId = '';
  let followUpSlot: string | null = null;
  let followUpQuestion: string | null = null;

  if (event.type === 'medication') {
    if (!event.drug_name) {
      return {
        recordId: '',
        followUpSlot: 'drug_name',
        followUpQuestion: "What medication is that?",
      };
    }
    const NON_DRUG_WORDS = new Set([
      'any', 'some', 'my', 'the', 'a', 'an', 'medication', 'medications',
      'meds', 'pills', 'prescription', 'prescriptions', 'medicine', 'medicines'
    ]);
    if (NON_DRUG_WORDS.has(event.drug_name.trim().toLowerCase())) {
      return {
        recordId: '',
        followUpSlot: 'drug_name',
        followUpQuestion: "What medication is that?",
      };
    }
    recordId = writeMedication({
      name: event.drug_name,
      dosage: event.dosage,
      notes: event.raw,
      is_active: 1,
    });
    if (!event.dosage) {
      followUpSlot = 'dosage';
      followUpQuestion = "Got it. What's the dosage?";
    }
  } else {
    // Spine §5: never write a confident-wrong row. A clean doctor name is HEARD
    // (Dr. X), not guessed — write it. A specialty-only or nameless visit
    // ("I saw my cardiologist") names no one — a specialty resolves to multiple
    // people over time, so writing it as doctor_name poisons the §6 graph. Ask
    // instead of inventing (Graceful Confusion); write NOTHING until we have a name.
    if (!event.doctor_name) {
      return {
        recordId: '',
        followUpSlot: 'doctor_name',
        followUpQuestion: "Got it — who did you see?",
      };
    }
    recordId = writeMedicalRecord({
      doctor_name: event.doctor_name,
      notes: event.advice ? `${event.raw} — ${event.advice}` : event.raw,
      visit_date: new Date().toLocaleDateString('en-CA'),
    });
  }

  if (followUpSlot) {
    writeClarification(recordId, followUpSlot);
  }

  return { recordId, followUpSlot, followUpQuestion };
}
