// Conversational Response Realization — Track R recollection.
//
// Pure, synchronous, local, zero imports. No LLM, no I/O.
// PROVENANCE IS STRUCTURAL: RECOLLECTION_PREFIX is module-private. It is
// never a parameter and never omitted. Callers cannot request an unframed
// remembered claim from this module.

const RECOLLECTION_PREFIX = 'You told me';

export function realizeRecollectionTold(rawText: string): string {
  const raw = rawText.trim();
  return `${RECOLLECTION_PREFIX} ${raw}`;
}

export function realizeRecollectionMiss(): string {
  return "You haven't told me that kind of thing yet.";
}

export function realizeRecollectionSuppressed(): string {
  return "Okay — I won't keep that.";
}

export function realizeRecollectionNothingToForget(): string {
  return "I don't have anything like that to forget.";
}
