// Automated Certification Evidence Transport V1 — local export only.
// Usage: npx tsx scripts/heraldTest/exportCertificationEvidence.mjs <journey_id>

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

export const TRANSPORT_SCHEMA = 'herald.cert-transport.v1';

export const REVIEW_MAP = {
  'med.eliquis.s17': null,
  'medical.doctor_visit.s18': 'DOCTOR_MEDICAL_S18_INDEPENDENT_REVIEW_PACKET.md',
  'todo.basic.s19': 'TODO_S19_INDEPENDENT_REVIEW_PACKET.md',
  'grocery.basic.s20': 'GROCERY_S20_INDEPENDENT_REVIEW_PACKET.md',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultRepoRoot() {
  return path.resolve(__dirname, '../..');
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

export function readLiveGitMeta(repoRoot) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const head = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
    const porcelain = execSync('git status --porcelain --untracked-files=no', {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return { branch, head, trackedDirty: porcelain !== '' };
  } catch {
    return { branch: 'unknown', head: 'unknown', trackedDirty: true };
  }
}

export function evidenceSourcePath(repoRoot, journeyId) {
  return path.join(repoRoot, 'scripts', 'heraldTest', 'evidence', `${journeyId}.json`);
}

export function exportRootPath(repoRoot) {
  return path.join(repoRoot, 'scripts', 'cert-export');
}

export function journeyExportDir(exportRoot, journeyId) {
  return path.join(exportRoot, 'qa', 'journeys', journeyId);
}

export function finalBundleDir(exportRoot, journeyId, runId) {
  return path.join(journeyExportDir(exportRoot, journeyId), runId);
}

export function parsePacketMetadata(evidenceBytes) {
  const packet = JSON.parse(evidenceBytes.toString('utf8'));
  if (typeof packet.journey_id !== 'string' || !packet.journey_id) {
    throw new Error('packet missing journey_id');
  }
  if (typeof packet.run_id !== 'string' || !packet.run_id) {
    throw new Error('packet missing run_id');
  }
  if (typeof packet.overall !== 'string') {
    throw new Error('packet missing overall');
  }
  if (typeof packet.failure_class !== 'string') {
    throw new Error('packet missing failure_class');
  }
  return {
    journey_id: packet.journey_id,
    run_id: packet.run_id,
    producer_overall: packet.overall,
    producer_failure_class: packet.failure_class,
  };
}

export function verifyBundle(bundleDir, manifest, expectedEvidenceSha) {
  const evidencePath = path.join(bundleDir, 'evidence.json');
  if (!fs.existsSync(evidencePath)) {
    return { ok: false, error: 'bundle verification failed: missing evidence.json' };
  }

  const evidenceBytes = fs.readFileSync(evidencePath);
  const evidenceSha = sha256Buffer(evidenceBytes);
  if (evidenceSha !== expectedEvidenceSha) {
    return { ok: false, error: 'bundle verification failed: evidence hash mismatch' };
  }

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'bundle verification failed: invalid manifest' };
  }

  if (manifest.journey_id !== parsePacketMetadata(evidenceBytes).journey_id) {
    return { ok: false, error: 'bundle verification failed: manifest journey_id mismatch' };
  }
  if (manifest.run_id !== parsePacketMetadata(evidenceBytes).run_id) {
    return { ok: false, error: 'bundle verification failed: manifest run_id mismatch' };
  }

  if (!Array.isArray(manifest.artifacts)) {
    return { ok: false, error: 'bundle verification failed: manifest missing artifacts[]' };
  }

  for (const art of manifest.artifacts) {
    const artPath = path.join(bundleDir, art.dest_path);
    if (!fs.existsSync(artPath)) {
      return { ok: false, error: `bundle verification failed: missing artifact ${art.dest_path}` };
    }
    const bytes = fs.readFileSync(artPath);
    if (bytes.length !== art.bytes) {
      return {
        ok: false,
        error: `bundle verification failed: byte count mismatch for ${art.dest_path}`,
      };
    }
    if (sha256Buffer(bytes) !== art.sha256) {
      return {
        ok: false,
        error: `bundle verification failed: SHA-256 mismatch for ${art.dest_path}`,
      };
    }
  }

  return { ok: true, evidenceSha };
}

export function validateExistingBundle(bundleDir) {
  const evidencePath = path.join(bundleDir, 'evidence.json');
  const manifestPath = path.join(bundleDir, 'MANIFEST.json');

  if (!fs.existsSync(evidencePath)) {
    return {
      ok: false,
      error: 'existing bundle incomplete or corrupt: missing evidence.json — operator review required',
    };
  }
  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      error: 'existing bundle incomplete or corrupt: missing MANIFEST.json — operator review required',
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: `existing bundle corrupt: invalid MANIFEST.json (${err.message}) — operator review required`,
    };
  }

  if (!Array.isArray(manifest.artifacts)) {
    return {
      ok: false,
      error: 'existing bundle corrupt: MANIFEST missing artifacts[] — operator review required',
    };
  }

  for (const art of manifest.artifacts) {
    const artPath = path.join(bundleDir, art.dest_path);
    if (!fs.existsSync(artPath)) {
      return {
        ok: false,
        error: `existing bundle incomplete: missing artifact ${art.dest_path} — operator review required`,
      };
    }
    const bytes = fs.readFileSync(artPath);
    if (bytes.length !== art.bytes) {
      return {
        ok: false,
        error: `existing bundle corrupt: byte count mismatch for ${art.dest_path} — operator review required`,
      };
    }
    if (sha256Buffer(bytes) !== art.sha256) {
      return {
        ok: false,
        error: `existing bundle corrupt: SHA-256 mismatch for ${art.dest_path} — operator review required`,
      };
    }
  }

  const evidenceSha = sha256File(evidencePath);
  const verify = verifyBundle(bundleDir, manifest, evidenceSha);
  if (!verify.ok) {
    return { ok: false, error: `${verify.error} — operator review required` };
  }

  return { ok: true, evidenceSha, manifest };
}

function relPosix(repoRoot, absPath) {
  return path.relative(repoRoot, absPath).split(path.sep).join('/');
}

function removeDirIfExists(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

export function exportCertificationEvidence(journeyId, options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const exportRoot = options.exportRoot ?? exportRootPath(repoRoot);
  const gitMeta = options.gitMeta ?? readLiveGitMeta(repoRoot);
  const sourcePath = options.sourcePath ?? evidenceSourcePath(repoRoot, journeyId);

  if (!fs.existsSync(sourcePath)) {
    return {
      status: 'EXPORT_FAIL',
      error: `missing source evidence: ${sourcePath}`,
      exitCode: 1,
    };
  }

  const evidenceBytes = fs.readFileSync(sourcePath);
  let metadata;
  try {
    metadata = parsePacketMetadata(evidenceBytes);
  } catch (err) {
    return {
      status: 'EXPORT_FAIL',
      error: `invalid evidence JSON: ${err.message}`,
      exitCode: 1,
    };
  }

  if (metadata.journey_id !== journeyId) {
    return {
      status: 'EXPORT_FAIL',
      error: `journey_id argument "${journeyId}" != packet journey_id "${metadata.journey_id}"`,
      exitCode: 1,
    };
  }

  const evidenceSha = sha256Buffer(evidenceBytes);
  const { run_id, producer_overall, producer_failure_class } = metadata;
  const finalDir = finalBundleDir(exportRoot, journeyId, run_id);

  if (fs.existsSync(finalDir)) {
    const existing = validateExistingBundle(finalDir);
    if (!existing.ok) {
      return { status: 'EXPORT_FAIL', error: existing.error, exitCode: 1 };
    }
    if (existing.evidenceSha === evidenceSha) {
      return {
        status: 'EXPORT_NOOP',
        bundleDir: finalDir,
        manifest: existing.manifest,
        exitCode: 0,
      };
    }
    return {
      status: 'EXPORT_REFUSED',
      error: `run_id "${run_id}" already exists with different evidence SHA — operator review required`,
      bundleDir: finalDir,
      exitCode: 2,
    };
  }

  const parentDir = journeyExportDir(exportRoot, journeyId);
  fs.mkdirSync(parentDir, { recursive: true });
  const tempDir = path.join(parentDir, `${run_id}.tmp-${Date.now()}-${process.pid}`);

  try {
    fs.mkdirSync(tempDir, { recursive: false });

    fs.writeFileSync(path.join(tempDir, 'evidence.json'), evidenceBytes);

    const artifacts = [
      {
        role: 'evidence',
        source_path: relPosix(repoRoot, sourcePath),
        dest_path: 'evidence.json',
        sha256: evidenceSha,
        bytes: evidenceBytes.length,
      },
    ];

    const reviewFile = REVIEW_MAP[journeyId];
    if (reviewFile) {
      const reviewPath = path.join(repoRoot, reviewFile);
      if (fs.existsSync(reviewPath)) {
        const reviewBytes = fs.readFileSync(reviewPath);
        fs.writeFileSync(path.join(tempDir, 'independent_review.md'), reviewBytes);
        artifacts.push({
          role: 'independent_review',
          source_path: reviewFile,
          dest_path: 'independent_review.md',
          sha256: sha256Buffer(reviewBytes),
          bytes: reviewBytes.length,
        });
      }
    }

    const manifest = {
      transport_schema: TRANSPORT_SCHEMA,
      source_branch: gitMeta.branch,
      source_head: gitMeta.head,
      source_tracked_dirty: gitMeta.trackedDirty,
      journey_id: journeyId,
      run_id,
      producer_overall,
      producer_failure_class,
      artifacts,
      idempotency_key: `${journeyId}|${run_id}|${evidenceSha}`,
      export_status: 'EXPORT_OK',
      export_error: null,
    };

    fs.writeFileSync(
      path.join(tempDir, 'MANIFEST.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    const verify = verifyBundle(tempDir, manifest, evidenceSha);
    if (!verify.ok) {
      removeDirIfExists(tempDir);
      return { status: 'EXPORT_FAIL', error: verify.error, exitCode: 1 };
    }

    fs.renameSync(tempDir, finalDir);

    return {
      status: 'EXPORT_OK',
      bundleDir: finalDir,
      manifest,
      exitCode: 0,
    };
  } catch (err) {
    removeDirIfExists(tempDir);
    return {
      status: 'EXPORT_FAIL',
      error: err.message,
      exitCode: 1,
    };
  }
}

function isCliMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isCliMain()) {
  const journeyId = process.argv[2];
  if (!journeyId) {
    console.error('usage: npx tsx scripts/heraldTest/exportCertificationEvidence.mjs <journey_id>');
    process.exit(1);
  }

  const result = exportCertificationEvidence(journeyId);
  console.log(result.status);
  if (result.bundleDir) {
    console.log(result.bundleDir);
  }
  if (result.error) {
    console.error(result.error);
  }
  process.exit(result.exitCode);
}
