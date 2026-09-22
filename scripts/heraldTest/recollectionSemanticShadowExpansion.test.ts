// Natural Recollection Shadow Expansion V1 — generalized classes + R-safety accounting.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '../../src/db/schema.ts';
import {
  RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1,
  RECOLLECTION_SEMANTIC_EVAL_FIXTURES,
  RECOLLECTION_SEMANTIC_EXPANSION_V1,
  RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL,
} from '../../src/dev/recollectionSemanticEvalFixtures.ts';
import {
  collectRecollectionSemanticEvidence,
  recollectionWouldAdmitR,
} from '../../src/dev/recollectionSemanticEvidenceCollect.ts';

const BOLD = '\x1b[1m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const EXEC = {
  backend: 'test-shadow-expansion',
  llamaRnAvailable: true,
  remoteFallback: false as const,
  privacy: 'local',
  note: 'test',
  modelFilename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
  nCtx: 512,
  nGpuLayers: 0,
  interpreterStatus: 'ready',
};

function mockCtx(text: string) {
  return { completion: async () => ({ text }) };
}

export async function runRecollectionSemanticShadowExpansionV1Tests() {
  const failures: { label: string; got: unknown; expected: string }[] = [];
  let passed = 0;
  function assert(label: string, got: unknown, check: (v: unknown) => boolean, expected: string) {
    if (check(got)) {
      console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
      passed++;
    } else {
      console.log(`${RED}✗ FAIL${RESET}  ${label}\n       got: ${DIM}${JSON.stringify(got)}${RESET}\n       expected: ${DIM}${expected}${RESET}`);
      failures.push({ label, got, expected });
    }
  }

  console.log(`\n${BOLD}-- Natural Recollection Shadow Expansion V1 ---------------${RESET}\n`);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const collectSrc = fs.readFileSync(path.join(root, 'src/dev/recollectionSemanticEvidenceCollect.ts'), 'utf8');
  const nominatorSrc = fs.readFileSync(path.join(root, 'src/routing/recollectionSemanticNomination.ts'), 'utf8');
  const processSrc = fs.readFileSync(path.join(root, 'src/routing/processUtterance.ts'), 'utf8');
  const grocerySrc = fs.readFileSync(path.join(root, 'src/routing/grocerySemanticDecomposition.ts'), 'utf8');
  const todoSrc = fs.readFileSync(path.join(root, 'src/routing/todoSemanticCapture.ts'), 'utf8');

  assert('SCHEMA_VERSION remains 25', SCHEMA_VERSION, (v) => v === 25, '25');

  assert('frozen original 22 expected labels and utterances remain unchanged',
    RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.length === 22
      && RECOLLECTION_SEMANTIC_FROZEN_ORIGINAL.every((orig) => {
        const row = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.find((r) => r.class === orig.class);
        return row != null
          && row.utterance === orig.utterance
          && row.expected === orig.expected
          && row.arcOpen === orig.arcOpen
          && row.scoring === 'scored';
      }),
    (v) => v === true, '22 frozen scored rows');

  assert('expansion is appended after the frozen 32-row device matrix, not substituted',
    RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1.length === 32
      && RECOLLECTION_SEMANTIC_EXPANSION_V1.length === 6
      && RECOLLECTION_SEMANTIC_EVAL_FIXTURES.length === 38
      && RECOLLECTION_SEMANTIC_EVAL_FIXTURES.slice(0, 32).every((row, i) =>
        row.class === RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1[i].class
        && row.utterance === RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1[i].utterance
        && row.expected === RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1[i].expected
        && row.scoring === RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1[i].scoring)
      && RECOLLECTION_SEMANTIC_EVAL_FIXTURES.slice(32).every((row, i) =>
        row.class === RECOLLECTION_SEMANTIC_EXPANSION_V1[i].class),
    (v) => v === true, '32 prefix + 6 expansion');

  assert('wouldAdmitR is deterministic AUTO/CONTINUE true and all other labels false',
    recollectionWouldAdmitR('AUTOBIOGRAPHICAL') === true
      && recollectionWouldAdmitR('CONTINUE_ARC') === true
      && recollectionWouldAdmitR('TRANSIENT') === false
      && recollectionWouldAdmitR('SENSITIVE') === false
      && recollectionWouldAdmitR('THIRD_PARTY') === false
      && recollectionWouldAdmitR('UNCERTAIN') === false
      && recollectionWouldAdmitR(null) === false,
    (v) => v === true, 'AUTO|CONTINUE only');

  {
    const autoRow = RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1.find((r) => r.class === 'childhood_without_cue')!;
    const cont = await collectRecollectionSemanticEvidence(
      () => mockCtx('{"disposition":"CONTINUE_ARC","confidence":0.9}'),
      EXEC,
      [autoRow],
    );
    const row = cont.rows[0];
    assert('AUTO↔CONTINUE is an exact-label miss with no R-safety disagreement',
      row.verdict === 'MISS'
        && row.expected === 'AUTOBIOGRAPHICAL'
        && row.effectiveDisposition === 'CONTINUE_ARC'
        && row.expectedWouldAdmitR === true
        && row.actualWouldAdmitR === true
        && row.rSafetyVerdict === 'PASS',
      (v) => v === true, 'label MISS, R-safety PASS');
  }

  {
    const autoRow = RECOLLECTION_SEMANTIC_DEVICE_MATRIX_V1.find((r) => r.class === 'childhood_without_cue')!;
    const match = await collectRecollectionSemanticEvidence(
      () => mockCtx('{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}'),
      EXEC,
      [autoRow],
    );
    assert('matching AUTO records independent exact-label PASS and R-safety PASS',
      match.rows[0].verdict === 'PASS'
        && match.rows[0].rSafetyVerdict === 'PASS'
        && match.rows[0].expectedWouldAdmitR === true
        && match.rows[0].actualWouldAdmitR === true,
      (v) => v === true, 'both PASS');
  }

  {
    const obs = RECOLLECTION_SEMANTIC_EXPANSION_V1.find((r) => r.class === 'g8_mixed_stt_blob')!;
    const artifact = await collectRecollectionSemanticEvidence(
      () => mockCtx('{"disposition":"AUTOBIOGRAPHICAL","confidence":0.9}'),
      EXEC,
      [obs],
    );
    assert('observational rows cannot become scored even if the model returns AUTO',
      obs.scoring === 'observational' && obs.expected == null
        && artifact.rows[0].scoring === 'observational'
        && artifact.rows[0].verdict === 'OBSERVATIONAL'
        && artifact.rows[0].rSafetyVerdict === 'OBSERVATIONAL'
        && artifact.rows[0].expectedWouldAdmitR === null
        && artifact.rows[0].actualWouldAdmitR === true,
      (v) => v === true, 'stays OBSERVATIONAL');
  }

  {
    const byClass = new Map(RECOLLECTION_SEMANTIC_EXPANSION_V1.map((r) => [r.class, r]));
    const mm = byClass.get('g8_open_arc_backchannel_mmhmm');
    const thin = byClass.get('g8_open_arc_thin_that_one');
    const ret = byClass.get('g8_open_arc_contentful_return');
    const activity = byClass.get('g8_third_party_ordinary_activity');
    const privateLife = byClass.get('g8_third_party_private_life');
    const blob = byClass.get('g8_mixed_stt_blob');
    const scored = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.filter((r) => r.scoring === 'scored');
    const observational = RECOLLECTION_SEMANTIC_EVAL_FIXTURES.filter((r) => r.scoring === 'observational');
    assert('generalized expansion covers backchannel, thin referent, contentful return, THIRD_PARTY contrast, mixed blob',
      mm?.expected === 'UNCERTAIN' && mm.arcOpen === true && mm.scoring === 'scored'
        && thin?.expected === 'UNCERTAIN' && thin.arcOpen === true
        && ret?.expected === 'AUTOBIOGRAPHICAL' && ret.arcOpen === true
        && activity?.expected === 'THIRD_PARTY' && activity.arcOpen === false
        && privateLife?.expected === 'THIRD_PARTY'
        && blob?.scoring === 'observational' && blob.expected == null
        && scored.length === 35
        && observational.length === 3,
      (v) => v === true, '6 expansion classes; 35 scored / 3 observational');
  }

  assert('semantic proposal/evidence path does not write Track R; stub remains production admission',
    !collectSrc.includes('reminiscenceWrite')
      && !collectSrc.includes('admitReminiscenceVerbatim')
      && !nominatorSrc.includes('reminiscenceWrite')
      && !nominatorSrc.includes('admitReminiscenceVerbatim')
      && /const disposition = nominateReminiscence\(text, \{ arcOpen: arc\.isOpen\(\) \}\);[\s\S]*observeRecollectionSemanticShadow\([\s\S]*if \(disposition === 'AUTOBIOGRAPHICAL' \|\| disposition === 'CONTINUE_ARC'\)[\s\S]*admitReminiscenceVerbatim/.test(processSrc)
      && nominatorSrc.includes('RECOLLECTION_SEMANTIC_TIMEOUT_MS = 8000')
      && grocerySrc.includes('GROCERY_SEMANTIC_TIMEOUT_MS = 8000')
      && todoSrc.includes('TODO_SEMANTIC_TIMEOUT_MS = 8000'),
    (v) => v === true, 'shadow only; 8000 production deadlines');

  const total = passed + failures.length;
  console.log(`\n${BOLD}RecollectionSemanticShadowExpansionV1: ${passed}/${total} passed — ${
    failures.length === 0 ? `${GREEN}all green` : `${RED}${failures.length} failed`
  }${RESET}${RESET}\n`);
  return { passed, failed: failures.length, total };
}

if (process.argv[1] && path.normalize(process.argv[1]).includes('recollectionSemanticShadowExpansion')) {
  runRecollectionSemanticShadowExpansionV1Tests().then((r) => {
    process.exit(r.failed ? 1 : 0);
  });
}
