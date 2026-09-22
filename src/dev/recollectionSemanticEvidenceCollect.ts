// Shared matrix collector. Observational. No Track R/T. No UI.

import { generateRecollectionSemanticProposal } from '../routing/recollectionSemanticNomination';
import { nominateReminiscence } from '../utils/reminiscenceNominator';
import { hasSensitiveRecollectionBackstop } from '../utils/reminiscenceAdmission';
import {
  RECOLLECTION_SEMANTIC_EVAL_FIXTURES,
  type RecollectionSemanticEvalRow,
} from './recollectionSemanticEvalFixtures';
import type { ReminiscenceDisposition } from '../utils/reminiscenceDisposition';

export const RECOLLECTION_SEMANTIC_EVIDENCE_SCHEMA =
  'herald.recollection.semantic.device.evidence.v1';

export type RecollectionSemanticEvidenceRow = {
  id: string;
  class: string;
  utterance: string;
  arcOpen: boolean;
  scoring: 'scored' | 'observational';
  sequenceId: string | null;
  turnIndex: number | null;
  expected: ReminiscenceDisposition | null;
  stubDisposition: ReminiscenceDisposition;
  rawSemanticOutput: string | null;
  parsedModelDisposition: ReminiscenceDisposition | null;
  effectiveDisposition: ReminiscenceDisposition;
  verdict: 'PASS' | 'MISS' | 'UNAVAILABLE' | 'OBSERVATIONAL';
  generationStatus: string;
  unavailableReason: string | null;
  sensitiveOverride: boolean;
  durationMs: number;
  notes: string;
};

export type RecollectionSemanticEvidenceArtifact = {
  schema: typeof RECOLLECTION_SEMANTIC_EVIDENCE_SCHEMA;
  capturedAt: string;
  execution: {
    backend: string;
    llamaRnAvailable: boolean;
    remoteFallback: false;
    privacy: string;
    note: string;
    modelFilename: string;
    nCtx: number;
    nGpuLayers: number;
    interpreterStatus: string;
  };
  latency: {
    n: number;
    minMs: number | null;
    maxMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    durationsMs: number[];
  };
  rows: RecollectionSemanticEvidenceRow[];
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function latencyBlock(rows: RecollectionSemanticEvidenceRow[]) {
  const durationsMs = rows
    .filter((r) =>
      r.generationStatus === 'ok'
      || r.generationStatus === 'parse_fail'
      || r.unavailableReason === 'error'
      || r.unavailableReason === 'timeout')
    .map((r) => r.durationMs)
    .filter((n) => Number.isFinite(n));
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    minMs: sorted.length ? sorted[0] : null,
    maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    durationsMs,
  };
}

export async function collectRecollectionSemanticEvidence(
  getCtx: () => { completion: (args: unknown) => Promise<unknown> | unknown } | null,
  execution: RecollectionSemanticEvidenceArtifact['execution'],
  fixtures: RecollectionSemanticEvalRow[] = RECOLLECTION_SEMANTIC_EVAL_FIXTURES,
): Promise<RecollectionSemanticEvidenceArtifact> {
  const rows: RecollectionSemanticEvidenceRow[] = [];
  for (const fixture of fixtures) {
    const stubDisposition = nominateReminiscence(fixture.utterance, { arcOpen: fixture.arcOpen });
    const gen = await generateRecollectionSemanticProposal(fixture.utterance, getCtx, {
      arcOpen: fixture.arcOpen,
      waitForNativeSettlement: true,
    });
    const parsed = gen.status === 'ok' ? gen.disposition : null;
    const raw = gen.status === 'ok' || gen.status === 'parse_fail' ? gen.raw : null;
    let effective: ReminiscenceDisposition = parsed ?? 'UNCERTAIN';
    const sensitiveOverride = hasSensitiveRecollectionBackstop(fixture.utterance)
      && effective !== 'SENSITIVE';
    if (hasSensitiveRecollectionBackstop(fixture.utterance)) {
      effective = 'SENSITIVE';
    }
    let verdict: RecollectionSemanticEvidenceRow['verdict'] = 'UNAVAILABLE';
    if (gen.status === 'ok' || gen.status === 'parse_fail') {
      if (fixture.scoring === 'observational' || fixture.expected == null) {
        verdict = 'OBSERVATIONAL';
      } else {
        verdict = effective === fixture.expected ? 'PASS' : 'MISS';
      }
    }
    rows.push({
      id: fixture.sequenceId ? `${fixture.sequenceId}:${fixture.turnIndex}:${fixture.class}` : fixture.class,
      class: fixture.class,
      utterance: fixture.utterance,
      arcOpen: fixture.arcOpen,
      scoring: fixture.scoring,
      sequenceId: fixture.sequenceId ?? null,
      turnIndex: fixture.turnIndex ?? null,
      expected: fixture.expected,
      stubDisposition,
      rawSemanticOutput: raw,
      parsedModelDisposition: parsed,
      effectiveDisposition: effective,
      verdict,
      generationStatus: gen.status,
      unavailableReason: gen.status === 'unavailable' ? gen.reason : (gen.status === 'parse_fail' ? 'parse_fail' : null),
      sensitiveOverride,
      durationMs: gen.durationMs,
      notes: fixture.notes,
    });
  }
  return {
    schema: RECOLLECTION_SEMANTIC_EVIDENCE_SCHEMA,
    capturedAt: new Date().toISOString(),
    execution,
    latency: latencyBlock(rows),
    rows,
  };
}
