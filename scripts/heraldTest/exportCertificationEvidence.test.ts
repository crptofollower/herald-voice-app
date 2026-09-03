// Deterministic tests for local certification evidence export.
// Runner: npx tsx scripts/heraldTest/exportCertificationEvidence.test.ts

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  exportCertificationEvidence,
  sha256Buffer,
  sha256File,
  validateExistingBundle,
  verifyBundle,
} from './exportCertificationEvidence.mjs';

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

type Fixture = {
  journeyId: string;
  runId: string;
  overall: string;
  failureClass: string;
  reviewText?: string;
};

function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeEvidenceFixture(
  dir: string,
  fixture: Fixture,
  contentSuffix = '',
): { sourcePath: string; bytes: Buffer } {
  const sourcePath = path.join(dir, `${fixture.journeyId}.json`);
  const payload = {
    schema_version: 'herald.journey.v1',
    journey_id: fixture.journeyId,
    run_id: fixture.runId,
    overall: fixture.overall,
    failure_class: fixture.failureClass,
    turns: [],
    note: contentSuffix,
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(sourcePath, bytes);
  return { sourcePath, bytes };
}

function writeReviewFixture(dir: string, filename: string, text: string): string {
  const reviewPath = path.join(dir, filename);
  fs.writeFileSync(reviewPath, text, 'utf8');
  return reviewPath;
}

function snapshotBundle(bundleDir: string): Map<string, { mtimeMs: number; sha256: string }> {
  const out = new Map<string, { mtimeMs: number; sha256: string }>();
  for (const name of fs.readdirSync(bundleDir)) {
    const filePath = path.join(bundleDir, name);
    if (!fs.statSync(filePath).isFile()) continue;
    out.set(name, {
      mtimeMs: fs.statSync(filePath).mtimeMs,
      sha256: sha256File(filePath),
    });
  }
  return out;
}

export async function runExportCertificationEvidenceTests() {
  let passed = 0;
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    if (cond) passed++;
    else failures.push(label);
  };

  // 1. fresh valid export -> EXPORT_OK
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-001',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);
    const reviewPath = writeReviewFixture(
      tempRoot,
      'TODO_S19_INDEPENDENT_REVIEW_PACKET.md',
      '# review packet\n',
    );

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test-branch', head: 'abc123', trackedDirty: false },
    });

    check('1. fresh valid export -> EXPORT_OK', result.status === 'EXPORT_OK');
    check('1b. bundle directory created', fs.existsSync(result.bundleDir ?? ''));
    check('1c. review copied when present', fs.existsSync(path.join(result.bundleDir!, 'independent_review.md')));
    check('1d. review source exists', fs.existsSync(reviewPath));
  }

  // 2. evidence bytes identical source vs export
  // 3. manifest hashes/bytes validate
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'grocery.basic.s20',
      runId: 'test-run-002',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath, bytes } = writeEvidenceFixture(tempRoot, fixture, 'hash-check');
    writeReviewFixture(tempRoot, 'GROCERY_S20_INDEPENDENT_REVIEW_PACKET.md', '# grocery review\n');

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'capability-surface', head: 'deadbeef', trackedDirty: true },
    });

    const exportedEvidence = fs.readFileSync(path.join(result.bundleDir!, 'evidence.json'));
    check('2. evidence bytes identical', Buffer.compare(bytes, exportedEvidence) === 0);
    check('2b. source/export SHA equal', sha256Buffer(bytes) === sha256Buffer(exportedEvidence));

    const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir!, 'MANIFEST.json'), 'utf8'));
    const verify = verifyBundle(result.bundleDir!, manifest, sha256Buffer(bytes));
    check('3. manifest hashes/bytes validate', verify.ok);
    check('3b. manifest lists evidence artifact', manifest.artifacts.some((a: { role: string }) => a.role === 'evidence'));
    check('3c. manifest lists review artifact', manifest.artifacts.some((a: { role: string }) => a.role === 'independent_review'));
  }

  // 4. optional review copied and hashed when present
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'medical.doctor_visit.s18',
      runId: 'test-run-003',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);
    const reviewText = '# doctor review\nline2\n';
    writeReviewFixture(tempRoot, 'DOCTOR_MEDICAL_S18_INDEPENDENT_REVIEW_PACKET.md', reviewText);

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '111', trackedDirty: false },
    });

    const reviewBytes = fs.readFileSync(path.join(result.bundleDir!, 'independent_review.md'));
    const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir!, 'MANIFEST.json'), 'utf8'));
    const reviewArt = manifest.artifacts.find((a: { role: string }) => a.role === 'independent_review');
    check('4. review copied', reviewBytes.toString('utf8') === reviewText);
    check('4b. review hashed in manifest', reviewArt?.sha256 === sha256Buffer(reviewBytes));
    check('4c. review byte count in manifest', reviewArt?.bytes === reviewBytes.length);
  }

  // 5. S17/no review remains valid
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'med.eliquis.s17',
      runId: 'test-run-004',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '222', trackedDirty: false },
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir!, 'MANIFEST.json'), 'utf8'));
    check('5. S17 export ok', result.status === 'EXPORT_OK');
    check('5b. no review file written', !fs.existsSync(path.join(result.bundleDir!, 'independent_review.md')));
    check('5c. manifest has only evidence artifact', manifest.artifacts.length === 1);
  }

  // 6. rerun same run_id + same evidence -> EXPORT_NOOP and no files rewritten
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-006',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);
    const opts = {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '333', trackedDirty: false },
    };

    const first = exportCertificationEvidence(fixture.journeyId, opts);
    const before = snapshotBundle(first.bundleDir!);
    const second = exportCertificationEvidence(fixture.journeyId, opts);
    const after = snapshotBundle(first.bundleDir!);

    check('6. rerun -> EXPORT_NOOP', second.status === 'EXPORT_NOOP');
    check('6b. bundle path unchanged', first.bundleDir === second.bundleDir);
    let unchanged = true;
    for (const [name, snap] of before.entries()) {
      const later = after.get(name);
      if (!later || later.mtimeMs !== snap.mtimeMs || later.sha256 !== snap.sha256) {
        unchanged = false;
        break;
      }
    }
    check('6c. no files rewritten', unchanged);
  }

  // 7. same run_id + different evidence -> EXPORT_REFUSED; original untouched
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-007',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath, bytes: originalBytes } = writeEvidenceFixture(tempRoot, fixture, 'v1');
    const opts = {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '444', trackedDirty: false },
    };
    const first = exportCertificationEvidence(fixture.journeyId, opts);
    writeEvidenceFixture(tempRoot, fixture, 'v2-changed');
    const refused = exportCertificationEvidence(fixture.journeyId, opts);
    const exported = fs.readFileSync(path.join(first.bundleDir!, 'evidence.json'));

    check('7. different evidence -> EXPORT_REFUSED', refused.status === 'EXPORT_REFUSED');
    check('7b. original bundle untouched', Buffer.compare(originalBytes, exported) === 0);
  }

  // 8. existing incomplete final bundle -> EXPORT_FAIL, not NOOP
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-008',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath, bytes } = writeEvidenceFixture(tempRoot, fixture);
    const finalDir = path.join(exportRoot, 'qa', 'journeys', fixture.journeyId, fixture.runId);
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'evidence.json'), bytes);

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '555', trackedDirty: false },
    });

    check('8. incomplete bundle -> EXPORT_FAIL', result.status === 'EXPORT_FAIL');
    check('8b. not NOOP', result.status !== 'EXPORT_NOOP');
    check('8c. no MANIFEST written', !fs.existsSync(path.join(finalDir, 'MANIFEST.json')));
  }

  // 9. existing corrupt manifest/hash -> EXPORT_FAIL
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-009',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath, bytes } = writeEvidenceFixture(tempRoot, fixture);
    const finalDir = path.join(exportRoot, 'qa', 'journeys', fixture.journeyId, fixture.runId);
    fs.mkdirSync(finalDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'evidence.json'), bytes);
    const badManifest = {
      transport_schema: 'herald.cert-transport.v1',
      journey_id: fixture.journeyId,
      run_id: fixture.runId,
      artifacts: [
        {
          role: 'evidence',
          source_path: 'scripts/heraldTest/evidence/todo.basic.s19.json',
          dest_path: 'evidence.json',
          sha256: '0'.repeat(64),
          bytes: bytes.length,
        },
      ],
    };
    fs.writeFileSync(path.join(finalDir, 'MANIFEST.json'), JSON.stringify(badManifest, null, 2));

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '666', trackedDirty: false },
    });

    check('9. corrupt manifest -> EXPORT_FAIL', result.status === 'EXPORT_FAIL');
    check('9b. validateExistingBundle fails', !validateExistingBundle(finalDir).ok);
  }

  // 10. journey_id argument != packet journey_id -> EXPORT_FAIL
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'todo.basic.s19',
      runId: 'test-run-010',
      overall: 'PASS',
      failureClass: 'none',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);

    const result = exportCertificationEvidence('grocery.basic.s20', {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '777', trackedDirty: false },
    });

    check('10. journey_id mismatch -> EXPORT_FAIL', result.status === 'EXPORT_FAIL');
  }

  // 11. missing source evidence -> EXPORT_FAIL
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const result = exportCertificationEvidence('todo.basic.s19', {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath: path.join(tempRoot, 'missing.json'),
      gitMeta: { branch: 'test', head: '888', trackedDirty: false },
    });
    check('11. missing source -> EXPORT_FAIL', result.status === 'EXPORT_FAIL');
  }

  // 12. producer_overall=FAIL still permits EXPORT_OK
  {
    const tempRoot = makeTempRoot('herald-export-');
    const exportRoot = path.join(tempRoot, 'cert-export');
    const fixture: Fixture = {
      journeyId: 'med.eliquis.s17',
      runId: 'test-run-012',
      overall: 'FAIL',
      failureClass: 'PRODUCT_FAIL',
    };
    const { sourcePath } = writeEvidenceFixture(tempRoot, fixture);

    const result = exportCertificationEvidence(fixture.journeyId, {
      repoRoot: tempRoot,
      exportRoot,
      sourcePath,
      gitMeta: { branch: 'test', head: '999', trackedDirty: false },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.bundleDir!, 'MANIFEST.json'), 'utf8'));

    check('12. FAIL producer still exports', result.status === 'EXPORT_OK');
    check('12b. manifest preserves producer_overall FAIL', manifest.producer_overall === 'FAIL');
    check('12c. export_status independent', manifest.export_status === 'EXPORT_OK');
  }

  const total = passed + failures.length;
  console.log(`${BOLD}exportCertificationEvidence tests${RESET}`);
  console.log(`${GREEN}${passed}/${total} passed${RESET}`);
  if (failures.length) {
    console.log(`${RED}Failures:${RESET}`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runExportCertificationEvidenceTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
