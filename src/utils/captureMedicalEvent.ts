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
    recordId = writeMedication({
      name: event.drug_name ?? 'Unknown',
      dosage: event.dosage,
      notes: event.raw,
      is_active: 1,
    });
    if (!event.drug_name) {
      followUpSlot = 'drug_name';
      followUpQuestion = "I'll remember that. What medication is that for?";
    } else if (!event.dosage) {
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
