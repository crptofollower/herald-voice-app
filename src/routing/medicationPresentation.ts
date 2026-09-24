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
  /** One near-miss repair remaining. Not medical truth. Not a retry budget system. */
  repairAvailable: boolean;
};

export const MEDICATION_ORDINAL_CONFUSION = `I'm not sure which one you mean.`;
export const MEDICATION_ORDINAL_STALE =
  `I don't see that medication on your list right now.`;

// V1: first/second + "one". Determiner is optional the|that. Optional "again"
// on what-was. Optional trailing punctuation. Not third/last/this/it/other.
const TELL_ABOUT_ORDINAL_RE =
  /^\s*tell\s+me\s+about\s+(?:(?:the|that)\s+)?(first|second)\s+one\s*[?.!]?\s*$/i;
const WHAT_WAS_ORDINAL_RE =
  /^\s*what\s+was\s+(?:(?:the|that)\s+)?(first|second)\s+one(?:\s+again)?\s*[?.!]?\s*$/i;

export function parseMedicationOrdinalIndex(text: string): number | null {
  const tell = text.match(TELL_ABOUT_ORDINAL_RE);
  const was = tell ?? text.match(WHAT_WAS_ORDINAL_RE);
  if (!was) return null;
  const word = was[1].toLowerCase();
  if (word === 'first') return 0;
  if (word === 'second') return 1;
  return null;
}

// Bounded near-miss of THIS speech-act family only: tell/telling-me-about or
// what-was, plus first|second + one, but not an exact V1 parse. Not a generic
// ordinal/anaphora detector.
export function isMedicationOrdinalNearMiss(text: string): boolean {
  if (parseMedicationOrdinalIndex(text) !== null) return false;
  const tellAbout =
    /\btell(?:ing)?\s+me\b[\s\S]*\babout\b[\s\S]*\b(?:(?:the|that)\s+)?(first|second)\s+one\b/i.test(text);
  const whatWas =
    /\bwhat\s+was\b[\s\S]*\b(?:(?:the|that)\s+)?(first|second)\s+one\b/i.test(text);
  return tellAbout || whatWas;
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
      repairAvailable: true,
    };
  }

  renew(): void {
    if (!this.presentation) return;
    this.presentation = {
      medicationIds: this.presentation.medicationIds,
      establishedAtTurn: this.turn,
      repairAvailable: true,
    };
  }

  consumeRepair(): void {
    if (!this.presentation) return;
    this.presentation = {
      ...this.presentation,
      repairAvailable: false,
    };
  }
}

/** Names come from the stored rows. The presentation still holds ids only. */
export function clarifyRetainedMedications(ids: readonly string[]): string | null {
  const names = ids
    .map((id) => getActiveMedicationById(id)?.name?.trim())
    .filter((name): name is string => !!name);
  if (names.length < 2) return null;
  const spoken = names.length === 2 ? `${names[0]} or ${names[1]}` : names.join(', ');
  return `I found more than one match — ${spoken}. Which one?`;
}
