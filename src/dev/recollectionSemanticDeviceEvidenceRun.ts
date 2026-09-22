// Bounded Android evidence run. Exact chat token trigger. No general debug UI.
// Uses existing llama.rn semantic ctx. Stub remains Track-R writer.

import { Share } from 'react-native';
import { LARGE_MODEL } from '../utils/modelManager';
import { MEDICATION_INTERPRETER_INIT } from '../hooks/useMedicationSemanticInterpreterEngine';
import {
  collectRecollectionSemanticEvidence,
  type RecollectionSemanticEvidenceArtifact,
} from './recollectionSemanticEvidenceCollect';
import {
  RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER,
  isRecollectionSemanticDeviceEvidenceTrigger,
} from './recollectionSemanticDeviceEvidenceTrigger';

export {
  RECOLLECTION_SEMANTIC_DEVICE_EVIDENCE_TRIGGER,
  isRecollectionSemanticDeviceEvidenceTrigger,
};

export {
  collectRecollectionSemanticEvidence,
  RECOLLECTION_SEMANTIC_EVIDENCE_SCHEMA,
} from './recollectionSemanticEvidenceCollect';
export type {
  RecollectionSemanticEvidenceArtifact,
  RecollectionSemanticEvidenceRow,
} from './recollectionSemanticEvidenceCollect';

async function persistArtifact(artifact: RecollectionSemanticEvidenceArtifact): Promise<string | null> {
  try {
    const FileSystem = await import('expo-file-system/legacy');
    const base = FileSystem.documentDirectory;
    if (!base) return null;
    const dir = `${base}herald_diagnostics`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    const path = `${dir}/recollection-semantic-device-evidence.latest.json`;
    await FileSystem.writeAsStringAsync(path, `${JSON.stringify(artifact, null, 2)}\n`);
    return path;
  } catch {
    return null;
  }
}

function summarize(artifact: RecollectionSemanticEvidenceArtifact): string {
  const scored = artifact.rows.filter((r) => r.scoring === 'scored');
  const pass = scored.filter((r) => r.verdict === 'PASS').length;
  const miss = scored.filter((r) => r.verdict === 'MISS').length;
  const unavailable = artifact.rows.filter((r) => r.verdict === 'UNAVAILABLE').length;
  const observational = artifact.rows.filter((r) => r.verdict === 'OBSERVATIONAL').length;
  const lat = artifact.latency;
  return [
    'Recollection 3B evidence finished.',
    `scored PASS ${pass} / MISS ${miss}; observational ${observational}; unavailable ${unavailable}.`,
    lat.n > 0
      ? `inference n=${lat.n} min=${lat.minMs}ms p50=${lat.p50Ms}ms p95=${lat.p95Ms}ms max=${lat.maxMs}ms.`
      : 'inference latency unmeasured.',
    `${artifact.execution.modelFilename} n_ctx=${artifact.execution.nCtx} n_gpu_layers=${artifact.execution.nGpuLayers} status=${artifact.execution.interpreterStatus}.`,
    'Full JSON is on the share sheet. Not a memory write.',
  ].join(' ');
}

export async function runRecollectionSemanticDeviceEvidence(opts: {
  getCtx: () => { completion: (args: unknown) => Promise<unknown> | unknown } | null;
  interpreterStatus: string;
}): Promise<{ summary: string; artifact: RecollectionSemanticEvidenceArtifact; outputPath: string | null }> {
  const ctx = opts.getCtx();
  const artifact = await collectRecollectionSemanticEvidence(opts.getCtx, {
    backend: ctx ? 'llama.rn-medication-semantic-interpreter' : 'no_ctx',
    llamaRnAvailable: !!ctx,
    remoteFallback: false,
    privacy: 'local ctx.completion only; no Railway/OpenRouter/fetch',
    note: 'Natural Recollection semantic matrix. Observational. Stub remains Track-R writer.',
    modelFilename: LARGE_MODEL.filename,
    nCtx: MEDICATION_INTERPRETER_INIT.n_ctx,
    nGpuLayers: MEDICATION_INTERPRETER_INIT.n_gpu_layers,
    interpreterStatus: opts.interpreterStatus,
  });
  const outputPath = await persistArtifact(artifact);
  try {
    await Share.share({
      title: 'Herald recollection 3B evidence',
      message: JSON.stringify(artifact, null, 2),
    });
  } catch {
    /* share cancelled — file still persisted */
  }
  return { summary: summarize(artifact), artifact, outputPath };
}
