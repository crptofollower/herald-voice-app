// scripts/heraldTest/semanticProvisioningPolicy.test.ts
// Headless Semantic Context Provisioning policy. Imports the real policy
// module — no React Native / NetInfo / expo / llama.rn, no mocked native
// path pretending to be production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_LLM_ENABLED } from '../../src/constants/features.ts';
import {
  resolveSemanticProvisioningAction,
  semanticConsumersRequireContext,
  type SemanticProvisioningFacts,
} from '../../src/utils/semanticProvisioningPolicy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const OFF: SemanticProvisioningFacts = {
  medicationSemanticEnabled: false,
  capabilityDispatchEnabled: false,
  grocerySemanticEnabled: false,
  modelPresent: false,
  wifiPermitted: false,
};

export async function runSemanticProvisioningPolicyTests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) { console.log(`${GREEN}✓ PASS${RESET}  ${label}`); passed++; }
    else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Semantic Context Provisioning Policy --${RESET}\n`);

  assert('DISABLED all consumers off → none (no provisioning)',
    resolveSemanticProvisioningAction({ ...OFF, modelPresent: false, wifiPermitted: true }),
    (v) => v === 'none', 'none');
  assert('DISABLED all consumers off even if model already present → none',
    resolveSemanticProvisioningAction({ ...OFF, modelPresent: true, wifiPermitted: true }),
    (v) => v === 'none', 'none');
  assert('DISABLED semanticConsumersRequireContext is false',
    semanticConsumersRequireContext(OFF), (v) => v === false, 'false');

  assert('PRESENT medication consumer + model on disk → ready',
    resolveSemanticProvisioningAction({ ...OFF, medicationSemanticEnabled: true, modelPresent: true, wifiPermitted: false }),
    (v) => v === 'ready', 'ready');
  assert('PRESENT dispatch-only + model on disk → ready',
    resolveSemanticProvisioningAction({ ...OFF, capabilityDispatchEnabled: true, modelPresent: true, wifiPermitted: false }),
    (v) => v === 'ready', 'ready');
  assert('PRESENT grocery-only + model on disk → ready',
    resolveSemanticProvisioningAction({ ...OFF, grocerySemanticEnabled: true, modelPresent: true, wifiPermitted: false }),
    (v) => v === 'ready', 'ready');

  assert('PROVISION absent + permitted WiFi (medication) → provision',
    resolveSemanticProvisioningAction({ ...OFF, medicationSemanticEnabled: true, modelPresent: false, wifiPermitted: true }),
    (v) => v === 'provision', 'provision');
  assert('PROVISION absent + permitted WiFi (dispatch only) → provision',
    resolveSemanticProvisioningAction({ ...OFF, capabilityDispatchEnabled: true, modelPresent: false, wifiPermitted: true }),
    (v) => v === 'provision', 'provision');
  assert('PROVISION absent + permitted WiFi (grocery only) → provision',
    resolveSemanticProvisioningAction({ ...OFF, grocerySemanticEnabled: true, modelPresent: false, wifiPermitted: true }),
    (v) => v === 'provision', 'provision');

  assert('WAIT absent + no WiFi → wait',
    resolveSemanticProvisioningAction({ ...OFF, medicationSemanticEnabled: true, modelPresent: false, wifiPermitted: false }),
    (v) => v === 'wait', 'wait');

  assert('NOT LOCAL_LLM policy ignores a localLlmEnabled extra field (consumers off → none)',
    resolveSemanticProvisioningAction({ ...OFF, modelPresent: false, wifiPermitted: true, localLlmEnabled: true } as SemanticProvisioningFacts),
    (v) => v === 'none', 'none');
  assert('NOT LOCAL_LLM consumers on still provision while LOCAL_LLM_ENABLED is false',
    LOCAL_LLM_ENABLED === false
      && resolveSemanticProvisioningAction({ ...OFF, grocerySemanticEnabled: true, modelPresent: false, wifiPermitted: true }) === 'provision',
    (v) => v === true, 'true');

  {
    const policyPath = path.join(__dirname, '..', '..', 'src', 'utils', 'semanticProvisioningPolicy.ts');
    const policySrc = fs.readFileSync(policyPath, 'utf8');
    const policyCode = policySrc.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert('HEADLESS policy module never mentions LOCAL_LLM_ENABLED',
      policyCode.includes('LOCAL_LLM_ENABLED'), (v) => v === false, 'false');
    assert('HEADLESS policy module has no react-native / NetInfo / expo / llama.rn imports',
      /from ['"]|require\(/.test(policyCode) === false
        && /react-native|@react-native-community\/netinfo|expo-file-system|llama\.rn/.test(policyCode) === false,
      (v) => v === true, 'true');
  }

  {
    const nativePath = path.join(__dirname, '..', '..', 'src', 'utils', 'semanticModelProvisioning.ts');
    const nativeSrc = fs.readFileSync(nativePath, 'utf8');
    const nativeCode = nativeSrc.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert('NATIVE uses resolveSemanticProvisioningAction',
      nativeCode.includes('resolveSemanticProvisioningAction'), (v) => v === true, 'true');
    assert('NATIVE reuses downloadModel',
      /\bdownloadModel\b/.test(nativeCode), (v) => v === true, 'true');
    assert('NATIVE targets LARGE_MODEL only',
      /\bLARGE_MODEL\b/.test(nativeCode) && !/\bSMALL_MODEL\b/.test(nativeCode), (v) => v === true, 'true');
    assert('NATIVE preserves writeModelVersion / MODEL_VERSION',
      /\bwriteModelVersion\b/.test(nativeCode) && /\bMODEL_VERSION\b/.test(nativeCode), (v) => v === true, 'true');
    assert('NATIVE does not call runModelDownloadService',
      nativeCode.includes('runModelDownloadService'), (v) => v === false, 'false');
    assert('NATIVE never references LOCAL_LLM_ENABLED',
      nativeCode.includes('LOCAL_LLM_ENABLED'), (v) => v === false, 'false');
  }

  {
    const hookPath = path.join(__dirname, '..', '..', 'src', 'hooks', 'useMedicationSemanticInterpreterEngine.ts');
    const hookSrc = fs.readFileSync(hookPath, 'utf8');
    const hookCode = hookSrc.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
    assert('HOOK provisions via ensureSemanticLargeModel (same-session init after ensure)',
      /\bensureSemanticLargeModel\b/.test(hookCode), (v) => v === true, 'true');
    assert('HOOK still inits the existing shared semantic context (initLlama + LARGE_MODEL)',
      /\binitLlama\b/.test(hookCode) && /\bLARGE_MODEL\b/.test(hookCode), (v) => v === true, 'true');
    assert('HOOK never references LOCAL_LLM_ENABLED',
      hookCode.includes('LOCAL_LLM_ENABLED'), (v) => v === false, 'false');
    const ensureIdx = hookCode.indexOf('ensureSemanticLargeModel');
    const initIdx = hookCode.indexOf('initLlama(');
    assert('HOOK ensure completes before initLlama',
      ensureIdx >= 0 && initIdx >= 0 && ensureIdx < initIdx, (v) => v === true, 'true');
  }

  const total = passed + failures.length;
  console.log(
    `\n${BOLD}SemanticProvisioningPolicy: ${passed}/${total} passed` +
    (failures.length > 0 ? ` — ${RED}${failures.length} FAILED${RESET}` : ` — ${GREEN}all green${RESET}`) +
    `${RESET}\n`
  );
  return { passed, failed: failures.length, total, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('semanticProvisioningPolicy.test.ts')) {
  runSemanticProvisioningPolicyTests().catch(console.error);
}
