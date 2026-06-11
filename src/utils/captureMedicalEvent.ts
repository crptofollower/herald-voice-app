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
    recordId = writeMedicalRecord({
      doctor_name: event.doctor_name,
      notes: event.advice ? `${event.raw} — ${event.advice}` : event.raw,
      visit_date: new Date().toLocaleDateString('en-CA'),
    });
    if (!event.doctor_name) {
      followUpSlot = 'doctor_name';
      followUpQuestion = "Got it. Do you know the doctor's name?";
    }
  }

  if (followUpSlot) {
    writeClarification(recordId, followUpSlot);
  }

  return { recordId, followUpSlot, followUpQuestion };
}
