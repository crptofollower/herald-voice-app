// scripts/evidence/buildEvidencePacket.mjs
// Packet Builder V1 — local, deterministic, fail-closed evidence bridge.
// Contract: herald-operations governance/PACKET_BUILDER_V1.md @ 2d55208a
//
// No network. No production edits. No arbitrary paths. Node stdlib only.

import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getEvidenceProfile, PROFILE_NAMES } from './evidenceProfiles.mjs';

export const BUILDER_VERSION = 'packet-builder-v1';
export const SCHEMA_VERSION = 'packet-builder-v1';
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024;

const SECRET_NAME_RE =
  /(?:^|\/)(?:\.env(?:\..*)?|.*(?:credential|credentials|secret|secrets|token|tokens|keystore|service[-_]?account).*(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|sqlite|db|sqlite3))$/i;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function defaultRepoRoot() {
  // scripts/evidence → scripts → repo root
  return path.resolve(__dirname, '..', '..');
}

export function defaultArtifactRoot(repoRoot) {
  return path.join(repoRoot, 'artifacts', 'evidence');
}

/** Deny-list second fence — not a substitute for the profile allow-list. */
export function isDeniedSecretName(repoRelativePosix) {
  const norm = repoRelativePosix.replace(/\\/g, '/');
  return SECRET_NAME_RE.test(norm);
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Filesystem-canonical containment fence.
 * After realpath, candidate must equal the canonical repo root or reside strictly under it.
 * @returns {{ ok: true, rootReal: string, absReal: string } | { ok: false, error: string }}
 */
export function assertContainedInRepo(repoRoot, candidateAbs, label = 'path') {
  let rootReal;
  try {
    rootReal = realpathSync(repoRoot);
  } catch (e) {
    return { ok: false, error: `repo root realpath failed: ${e}` };
  }
  let absReal;
  try {
    absReal = realpathSync(candidateAbs);
  } catch (e) {
    return { ok: false, error: `${label} realpath failed: ${e}` };
  }
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (absReal !== rootReal && !absReal.startsWith(rootPrefix)) {
    return { ok: false, error: `path escape rejected (outside repo): ${label}` };
  }
  return { ok: true, rootReal, absReal };
}

/**
 * Canonical containment for a path that may not exist yet (e.g. artifact root).
 * Realpaths the deepest existing ancestor via assertContainedInRepo, then rebuilds
 * the target under that canonical ancestor. Rejects before any mkdir/write if an
 * in-repo symlink/junction ancestor would escape the repository.
 * @returns {{ ok: true, rootReal: string, absReal: string } | { ok: false, error: string }}
 */
export function resolveContainedArtifactRoot(repoRoot, artifactRootCandidate, label = 'artifact root') {
  const resolved = path.resolve(artifactRootCandidate);
  const missing = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return { ok: false, error: `${label} realpath failed: no existing ancestor` };
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  const ancestorGate = assertContainedInRepo(repoRoot, cursor, label);
  if (!ancestorGate.ok) {
    return ancestorGate;
  }

  const absReal =
    missing.length === 0
      ? ancestorGate.absReal
      : path.join(ancestorGate.absReal, ...missing);

  const rootReal = ancestorGate.rootReal;
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (absReal !== rootReal && !absReal.startsWith(rootPrefix)) {
    return { ok: false, error: `path escape rejected (outside repo): ${label}` };
  }
  return { ok: true, rootReal, absReal };
}

/**
 * Resolve and validate an allow-listed evidence path.
 * @returns {{ ok: true, abs: string, relPosix: string, size: number } | { ok: false, error: string }}
 */
export function validateEvidenceFile(repoRoot, repoRelativePosix) {
  if (typeof repoRelativePosix !== 'string' || !repoRelativePosix.trim()) {
    return { ok: false, error: 'empty path' };
  }
  const relPosix = repoRelativePosix.replace(/\\/g, '/').replace(/^\/+/, '');
  if (relPosix.includes('\0') || relPosix.split('/').some((p) => p === '..')) {
    return { ok: false, error: `path escape rejected: ${relPosix}` };
  }
  if (isDeniedSecretName(relPosix)) {
    return { ok: false, error: `secret/config/database name rejected: ${relPosix}` };
  }

  let rootResolved;
  try {
    rootResolved = path.resolve(repoRoot);
  } catch (e) {
    return { ok: false, error: `repo root resolve failed: ${e}` };
  }

  const absCandidate = path.resolve(rootResolved, ...relPosix.split('/'));
  if (!existsSync(absCandidate)) {
    return { ok: false, error: `missing required file: ${relPosix}` };
  }

  let st;
  try {
    st = lstatSync(absCandidate);
  } catch (e) {
    return { ok: false, error: `stat failed: ${relPosix}: ${e}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, error: `symlink rejected: ${relPosix}` };
  }
  if (!st.isFile()) {
    return { ok: false, error: `not a regular file: ${relPosix}` };
  }
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `oversize file (>${MAX_FILE_BYTES} bytes): ${relPosix} (${st.size})` };
  }

  const contained = assertContainedInRepo(rootResolved, absCandidate, relPosix);
  if (!contained.ok) {
    return { ok: false, error: contained.error };
  }

  return { ok: true, abs: contained.absReal, relPosix, size: st.size };
}

export function runGit(repoRoot, args) {
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    exitCode: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error ? String(r.error) : null,
  };
}

/**
 * Fail-closed gate for Git commands that contribute authoritative packet evidence.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function requireGitEvidence(label, result) {
  if (result.error) {
    return { ok: false, error: `required git evidence failed: ${label} (${result.error})` };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `required git evidence failed: ${label} (exit ${result.exitCode})`,
    };
  }
  return { ok: true };
}

function sha256File(absPath) {
  const h = createHash('sha256');
  h.update(readFileSync(absPath));
  return h.digest('hex');
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseArgs(argv) {
  const out = { profile: null, label: null, repoRoot: null, artifactRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--repo-root') out.repoRoot = argv[++i];
    else if (a === '--artifact-root') out.artifactRoot = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      return { error: `unknown or unsupported argument: ${a}` };
    }
  }
  return out;
}

function writeText(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, 'utf8');
}

function copyEvidenceFile(absSrc, destAbs) {
  mkdirSync(path.dirname(destAbs), { recursive: true });
  copyFileSync(absSrc, destAbs);
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.profileName
 * @param {string} opts.label
 * @param {string} [opts.artifactRoot]
 * @param {import('./evidenceProfiles.mjs').EvidenceProfile} [opts.profileOverride] test-only
 * @param {boolean} [opts.skipCommands]
 * @param {(repoRoot: string, args: string[]) => ReturnType<typeof runGit>} [opts.runGit] test-only
 */
export async function buildEvidencePacket(opts) {
  const repoRoot = path.resolve(opts.repoRoot);
  const execGit = typeof opts.runGit === 'function' ? opts.runGit : runGit;
  const label = (opts.label ?? '').trim();
  if (!label) {
    return failResult('missing --label');
  }

  const profile =
    opts.profileOverride ?? getEvidenceProfile(opts.profileName);
  if (!profile) {
    return failResult(
      `unknown profile: ${opts.profileName ?? ''} (known: ${PROFILE_NAMES.join(', ')})`,
    );
  }

  const artifactGate = resolveContainedArtifactRoot(
    repoRoot,
    opts.artifactRoot ?? defaultArtifactRoot(repoRoot),
    'artifact root',
  );
  if (!artifactGate.ok) {
    return failResult(artifactGate.error);
  }
  const artifactRoot = artifactGate.absReal;
  mkdirSync(artifactRoot, { recursive: true });

  const packetId = `pkt_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const tmpDir = mkdtempSync(path.join(artifactRoot, `.tmp_${packetId}_`));
  const failedSteps = [];
  let status = 'COMPLETE';

  try {
    // --- validate + copy allow-listed files ---
    const fileEntries = [];
    let totalBytes = 0;
    for (const rel of profile.files) {
      const v = validateEvidenceFile(repoRoot, rel);
      if (!v.ok) {
        failedSteps.push(v.error);
        status = 'FAILED_CLOSED';
        break;
      }
      totalBytes += v.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        failedSteps.push(`total payload exceeds ${MAX_TOTAL_BYTES} bytes`);
        status = 'FAILED_CLOSED';
        break;
      }
      const dest = path.join(tmpDir, 'files', ...v.relPosix.split('/'));
      copyEvidenceFile(v.abs, dest);
      const hash = sha256File(v.abs);
      fileEntries.push({
        path: v.relPosix,
        sha256: hash,
        bytes: v.size,
      });
    }

    if (status === 'FAILED_CLOSED') {
      return finalizeFailed(tmpDir, artifactRoot, packetId, failedSteps);
    }

    // --- git evidence ---
    const gitDir = path.join(tmpDir, 'git');
    mkdirSync(gitDir, { recursive: true });
    const head = execGit(repoRoot, ['rev-parse', 'HEAD']);
    const branch = execGit(repoRoot, ['branch', '--show-current']);
    const statusShort = execGit(repoRoot, ['status', '--short']);
    const diffStat = execGit(repoRoot, ['diff', '--stat']);
    const stashList = execGit(repoRoot, ['stash', 'list']);
    const allowed = profile.files;

    const unstagedDiff = execGit(repoRoot, [
      'diff',
      '--no-ext-diff',
      '--',
      ...allowed,
    ]);
    const stagedDiff = execGit(repoRoot, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--',
      ...allowed,
    ]);

    writeText(path.join(gitDir, 'head.txt'), head.stdout);
    writeText(path.join(gitDir, 'branch.txt'), branch.stdout);
    writeText(path.join(gitDir, 'status-short.txt'), statusShort.stdout);
    writeText(path.join(gitDir, 'diff-stat.txt'), diffStat.stdout);
    writeText(path.join(gitDir, 'diff.patch'), unstagedDiff.stdout);
    writeText(path.join(gitDir, 'staged-diff.patch'), stagedDiff.stdout);
    writeText(path.join(gitDir, 'stash-list.txt'), stashList.stdout);

    const requiredGit = [
      ['rev-parse HEAD', head],
      ['branch --show-current', branch],
      ['status --short', statusShort],
      ['diff --stat', diffStat],
      ['stash list', stashList],
      ['diff allow-list', unstagedDiff],
      ['diff --cached allow-list', stagedDiff],
    ];
    for (const [gitLabel, result] of requiredGit) {
      const gate = requireGitEvidence(gitLabel, result);
      if (!gate.ok) {
        failedSteps.push(gate.error);
        status = 'FAILED_CLOSED';
      }
    }

    if (status === 'FAILED_CLOSED') {
      return finalizeFailed(tmpDir, artifactRoot, packetId, failedSteps, {
        profile: profile.name,
        label,
        fileEntries,
      });
    }

    // --- test commands ---
    const commandResults = [];
    if (!opts.skipCommands) {
      for (const cmd of profile.commands) {
        const cwdCandidate = cmd.cwd
          ? path.resolve(repoRoot, cmd.cwd)
          : repoRoot;
        const cwdGate = assertContainedInRepo(
          repoRoot,
          cwdCandidate,
          `command cwd ${cmd.id}`,
        );
        if (!cwdGate.ok) {
          failedSteps.push(cwdGate.error);
          status = 'FAILED_CLOSED';
          commandResults.push({
            id: cmd.id,
            argv: cmd.argv,
            exitCode: 1,
            stdout: '',
            stderr: cwdGate.error,
          });
          continue;
        }
        const cwd = cwdGate.absReal;
        const r = spawnSync(cmd.argv[0], cmd.argv.slice(1), {
          cwd,
          encoding: 'utf8',
          env: { ...process.env },
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
        });
        const exitCode = r.status ?? 1;
        const stdout = r.stdout ?? '';
        const stderr = r.stderr ?? '';
        commandResults.push({
          id: cmd.id,
          argv: cmd.argv,
          cwd: toPosix(path.relative(repoRoot, cwd) || '.'),
          exitCode,
          stdout,
          stderr,
        });
        const outFile = path.join(tmpDir, 'tests', `${cmd.id}.txt`);
        writeText(
          outFile,
          [
            `# command: ${cmd.argv.join(' ')}`,
            `# cwd: ${path.relative(repoRoot, cwd) || '.'}`,
            `# exitCode: ${exitCode}`,
            '',
            '--- stdout ---',
            stdout,
            '--- stderr ---',
            stderr,
            '',
          ].join('\n'),
        );
        if (exitCode !== 0) {
          failedSteps.push(`test command failed: ${cmd.id} (exit ${exitCode})`);
          status = 'FAILED_CLOSED';
        }
      }
    }

    if (status === 'FAILED_CLOSED') {
      return finalizeFailed(tmpDir, artifactRoot, packetId, failedSteps, {
        profile: profile.name,
        label,
        fileEntries,
        commandResults,
      });
    }

    const dirtyTracked = (statusShort.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => !line.startsWith('??') && !line.startsWith('!!'));

    const generatedAt = new Date().toISOString();
    const repoBasename = path.basename(repoRoot);

    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      builderVersion: BUILDER_VERSION,
      packetId,
      profile: profile.name,
      label,
      generatedAtUtc: generatedAt,
      repositoryBasename: repoBasename,
      branch: (branch.stdout || '').trim(),
      headSha: (head.stdout || '').trim(),
      trackedTreeClean: !dirtyTracked,
      gitStatusShort: (statusShort.stdout || '').trimEnd(),
      stashList: (stashList.stdout || '').trimEnd(),
      files: fileEntries,
      commands: commandResults.map((c) => ({
        id: c.id,
        argv: c.argv,
        cwd: c.cwd,
        exitCode: c.exitCode,
        stdoutSha256: sha256Buffer(Buffer.from(c.stdout || '', 'utf8')),
        stderrSha256: sha256Buffer(Buffer.from(c.stderr || '', 'utf8')),
        stdoutBytes: Buffer.byteLength(c.stdout || '', 'utf8'),
        stderrBytes: Buffer.byteLength(c.stderr || '', 'utf8'),
      })),
      status: 'COMPLETE',
      failedSteps: [],
    };

    const readme = [
      '# Herald Evidence Packet',
      '',
      'Bounded diagnostic evidence for investigation — **not** production authority.',
      '',
      `- **Status:** COMPLETE`,
      `- **Profile:** ${profile.name}`,
      `- **Label:** ${label}`,
      `- **Branch:** ${manifest.branch}`,
      `- **HEAD:** ${manifest.headSha}`,
      `- **Tracked tree clean:** ${manifest.trackedTreeClean}`,
      `- **Packet id:** ${packetId}`,
      `- **Generated (UTC):** ${generatedAt}`,
      '',
      '## Included',
      '',
      ...fileEntries.map((f) => `- \`${f.path}\` (${f.bytes} bytes, sha256=${f.sha256})`),
      '',
      '## Intentionally excluded',
      '',
      '- Files outside this profile allow-list (even if dirty in the checkout)',
      '- Secrets, credentials, databases, environment values, machine paths',
      '- Full git history, remotes, and unrelated diffs',
      '- Device transcripts (separate user/device evidence)',
      '',
      '## Capture steps',
      '',
      failedSteps.length === 0 ? '- All required steps succeeded.' : failedSteps.map((s) => `- FAIL: ${s}`).join('\n'),
      '',
      '## Commands',
      '',
      commandResults.length === 0
        ? '- (none defined for this profile)'
        : commandResults.map((c) => `- \`${c.id}\` exit=${c.exitCode}`).join('\n'),
      '',
    ].join('\n');

    writeText(path.join(tmpDir, 'README.md'), readme);
    // Manifest last
    writeText(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const finalDir = path.join(artifactRoot, packetId);
    renameSync(tmpDir, finalDir);

    return {
      ok: true,
      status: 'COMPLETE',
      packetId,
      packetDir: finalDir,
      manifest,
      failedSteps: [],
    };
  } catch (e) {
    failedSteps.push(`builder exception: ${e && e.stack ? e.stack : e}`);
    return finalizeFailed(tmpDir, artifactRoot, packetId, failedSteps);
  }
}

function failResult(message) {
  return {
    ok: false,
    status: 'FAILED_CLOSED',
    packetId: null,
    packetDir: null,
    manifest: null,
    failedSteps: [message],
  };
}

function finalizeFailed(tmpDir, artifactRoot, packetId, failedSteps, partial = {}) {
  try {
    const readme = [
      '# Herald Evidence Packet',
      '',
      '**Status: FAILED_CLOSED** — not usable as complete evidence.',
      '',
      ...failedSteps.map((s) => `- ${s}`),
      '',
    ].join('\n');
    writeText(path.join(tmpDir, 'README.md'), readme);
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      builderVersion: BUILDER_VERSION,
      packetId,
      profile: partial.profile ?? null,
      label: partial.label ?? null,
      status: 'FAILED_CLOSED',
      failedSteps,
      files: partial.fileEntries ?? [],
      commands: (partial.commandResults ?? []).map((c) => ({
        id: c.id,
        argv: c.argv,
        exitCode: c.exitCode,
      })),
    };
    writeText(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const failedName = `${packetId}.failed`;
    const dest = path.join(artifactRoot, failedName);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(tmpDir, dest);
    return {
      ok: false,
      status: 'FAILED_CLOSED',
      packetId,
      packetDir: dest,
      manifest,
      failedSteps,
    };
  } catch {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return failResult(failedSteps.join('; '));
  }
}

function printHelp() {
  console.log(`Packet Builder V1

Usage:
  node scripts/evidence/buildEvidencePacket.mjs --profile <profile> --label <label>

Profiles: ${PROFILE_NAMES.join(', ')}

Writes atomically to artifacts/evidence/<packet-id>/
No network. No arbitrary paths. Fail-closed on fence violations.
`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.profile || !args.label) {
    console.error('required: --profile <name> --label <label>');
    printHelp();
    process.exit(2);
  }

  const result = await buildEvidencePacket({
    repoRoot: args.repoRoot ?? defaultRepoRoot(),
    profileName: args.profile,
    label: args.label,
    artifactRoot: args.artifactRoot ?? undefined,
  });

  if (!result.ok) {
    console.error(JSON.stringify({
      status: result.status,
      failedSteps: result.failedSteps,
      packetDir: result.packetDir,
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    status: result.status,
    packetId: result.packetId,
    packetDir: result.packetDir,
    files: result.manifest.files.length,
    headSha: result.manifest.headSha,
    branch: result.manifest.branch,
  }, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
