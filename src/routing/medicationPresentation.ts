// Medication ordinal continuation V1 — RAM presentation of ordered IDs only.
// Sibling to ConversationalSubjectHolder, NOT a subject union member and NOT
// a PendingSlot. Holds the medication IDs Herald just presented so a closed
// ordinal phrase can identify one row for a fresh authoritative reread.
//
// Identity/reference only. Never medication truth. No name/dose/frequency.
// RAM only. Process death/restart: gone. No SQLite.

import {
  formatCurrentMedicationReadback,
  getActiveMedicationById,
} from '../db/medicalDB';

export type MedicationPresentation = {
  medicationIds: string[];
  establishedAtTurn: number;
};

export const MEDICATION_ORDINAL_CONFUSION = `I'm not sure which one you mean.`;
export const MEDICATION_ORDINAL_STALE =
  `I don't see that medication on your list right now.`;

// V1 only: first/second + "one". Optional "the", optional "again" on what-was,
// optional trailing punctuation. Not third/last/that/it.
const TELL_ABOUT_ORDINAL_RE =
  /^\s*tell\s+me\s+about\s+(?:the\s+)?(first|second)\s+one\s*[?.!]?\s*$/i;
const WHAT_WAS_ORDINAL_RE =
  /^\s*what\s+was\s+(?:the\s+)?(first|second)\s+one(?:\s+again)?\s*[?.!]?\s*$/i;

export function parseMedicationOrdinalIndex(text: string): number | null {
  const tell = text.match(TELL_ABOUT_ORDINAL_RE);
  const was = tell ?? text.match(WHAT_WAS_ORDINAL_RE);
  if (!was) return null;
  const word = was[1].toLowerCase();
  if (word === 'first') return 0;
  if (word === 'second') return 1;
  return null;
}

export function answerMedicationOrdinal(
  presentation: MedicationPresentation,
  index: number,
): { kind: 'ok' | 'oor' | 'stale'; responseText: string } {
  if (index < 0 || index >= presentation.medicationIds.length) {
    return { kind: 'oor', responseText: MEDICATION_ORDINAL_CONFUSION };
  }
  const row = getActiveMedicationById(presentation.medicationIds[index]);
  if (!row) {
    return { kind: 'stale', responseText: MEDICATION_ORDINAL_STALE };
  }
  return { kind: 'ok', responseText: formatCurrentMedicationReadback(row) };
}

export class MedicationPresentationHolder {
  private presentation: MedicationPresentation | null = null;
  private turn = 0;

  beginUserTurn(): void {
    this.turn += 1;
  }

  peek(): MedicationPresentation | null {
    return this.presentation;
  }

  hasLive(): boolean {
    return this.presentation !== null;
  }

  clear(): void {
    this.presentation = null;
  }

  establish(medicationIds: string[]): void {
    this.presentation = {
      medicationIds: [...medicationIds],
      establishedAtTurn: this.turn,
    };
  }

  renew(): void {
    if (!this.presentation) return;
    this.presentation = {
      medicationIds: this.presentation.medicationIds,
      establishedAtTurn: this.turn,
    };
  }
}
