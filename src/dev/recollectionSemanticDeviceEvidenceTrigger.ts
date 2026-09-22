export const RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER =
  '__HERALD_RECOLLECTION_SEMANTIC_3B__';

export function isRecollectionSemanticDeviceEvidenceTrigger(text: string): boolean {
  return text.trim() === RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER;
}
