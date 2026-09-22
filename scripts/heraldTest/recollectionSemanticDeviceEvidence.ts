// Node wrapper around the device evidence collector. Not Track R/T.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRecollectionSemanticEvidence,
  type RecollectionSemanticEvidenceArtifact,
} from '../../src/dev/recollectionSemanticEvidenceCollect.ts';

export {
  RECOLLECTION_SEMANTIC_EVIDENCE_SCHEMA,
  collectRecollectionSemanticEvidence,
} from '../../src/dev/recollectionSemanticEvidenceCollect.ts';
export type {
  RecollectionSemanticEvidenceArtifact,
  RecollectionSemanticEvidenceRow,
} from '../../src/dev/recollectionSemanticEvidenceCollect.ts';

export function writeRecollectionSemanticEvidenceArtifact(
  artifact: RecollectionSemanticEvidenceArtifact,
): string {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'recollection-semantic-device-evidence.latest.json');
  fs.writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  return out;
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('recollectionSemanticDeviceEvidence')) {
  const artifact = await collectRecollectionSemanticEvidence(() => null, {
    backend: 'node-no-llama.rn',
    llamaRnAvailable: false,
    remoteFallback: false,
    privacy: 'local generateRecollectionSemanticProposal only; no Railway/OpenRouter/fetch',
    note: 'Node has no llama.rn; unavailable baseline until device run.',
    modelFilename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
    nCtx: 512,
    nGpuLayers: 0,
    interpreterStatus: 'unavailable',
  });
  console.log(writeRecollectionSemanticEvidenceArtifact(artifact));
}
