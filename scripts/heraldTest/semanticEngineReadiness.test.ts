// Readiness gate. Does not download a model or start Llama.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEMANTIC_ENGINE_READINESS_TIMEOUT_MS,
  classifySemanticEngineReadiness,
  emptySemanticEngineDiagnostic,
  type SemanticEngineDiagnostic,
} from '../../src/dev/semanticEngineReadiness.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function snap(patch: Partial<SemanticEngineDiagnostic>): SemanticEngineDiagnostic {
  return { ...emptySemanticEngineDiagnostic(), ...patch };
}

export async function runSemanticEngineReadinessV1Tests() {
  const failures: string[] = [];
  let passed = 0;
  function assert(label: string, ok: boolean) {
    if (ok) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}`);
      failures.push(label);
    }
  }

  console.log(`\n${BOLD}-- Semantic engine readiness --------------------------------${RESET}\n`);

  assert(
    'real ready after initLlama opens the gate',
    classifySemanticEngineReadiness(snap({
      semanticEngineStatus: 'ready',
      initLlama: 'succeeded',
      contextHeld: true,
      modelFilePresent: true,
      ensureStatus: 'ready',
    })) === 'READY',
  );
  assert(
    'a present model file without initLlama stays closed',
    classifySemanticEngineReadiness(snap({
      semanticEngineStatus: 'loading',
      provisioningAction: 'ready',
      ensureStatus: 'ready',
      initLlama: 'not_started',
      modelFilePresent: true,
      contextHeld: false,
    })) === 'PENDING',
  );
  assert(
    'waiting for Wi-Fi stays waiting',
    classifySemanticEngineReadiness(snap({
      semanticEngineStatus: 'unavailable',
      provisioningAction: 'wait',
      modelFilePresent: false,
    })) === 'PROVISIONING_WAITING_FOR_WIFI',
  );
  assert(
    'download failure is not an init failure',
    classifySemanticEngineReadiness(snap({
      semanticEngineStatus: 'error',
      provisioningAction: 'provision',
      ensureStatus: 'error',
      initLlama: 'not_started',
    })) === 'MODEL_DOWNLOAD_FAILED',
  );
  assert(
    'initLlama failure is closed',
    classifySemanticEngineReadiness(snap({
      semanticEngineStatus: 'error',
      ensureStatus: 'ready',
      initLlama: 'failed',
      modelFilePresent: true,
      contextHeld: false,
    })) === 'MODEL_INIT_FAILED',
  );
  assert(
    'readiness ceiling is 25 minutes',
    SEMANTIC_ENGINE_READINESS_TIMEOUT_MS === 25 * 60 * 1000,
  );

  const proof = fs.readFileSync(
    path.join(ROOT, 'android/app/src/androidTest/java/ai/apexempire/herald/journey/HeraldSemanticProofV1Test.kt'),
    'utf8',
  );
  const readyAt = proof.indexOf('awaitSemanticEngineReady');
  const scenariosAt = proof.indexOf('loadContract()');
  assert(
    'semantic scenarios start only after the readiness wait',
    readyAt > 0 && scenariosAt > readyAt && proof.includes('25L * 60L * 1000L') && proof.includes('TURN_TIMEOUT_MS = 120_000L'),
  );
  assert(
    'the gate does not treat a filename as personal evidence',
    !JSON.stringify(snap({ modelFilePresent: true })).match(/patel|maya|metoprolol|512/),
  );

  console.log(`\n${BOLD}SemanticEngineReadinessV1: ${passed} passed, ${failures.length} failed${RESET}`);
  return { passed, failed: failures.length, total: passed + failures.length, failures };
}

const isDirect = process.argv[1]?.includes('semanticEngineReadiness');
if (isDirect) {
  runSemanticEngineReadinessV1Tests().then((r) => {
    if (r.failed) process.exit(1);
  });
}
