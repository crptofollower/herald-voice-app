// scripts/evidence/buildEvidencePacket.test.mjs
// Deterministic Packet Builder V1 contract tests. No network. Node stdlib only.
//
// Run: node scripts/evidence/buildEvidencePacket.test.mjs

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildEvidencePacket,
  isDeniedSecretName,
  validateEvidenceFile,
  assertContainedInRepo,
  resolveContainedArtifactRoot,
  requireGitEvidence,
  runGit,
  MAX_FILE_BYTES,
  defaultRepoRoot,
} from './buildEvidencePacket.mjs';
import { getEvidenceProfile, PROFILE_NAMES } from './evidenceProfiles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = defaultRepoRoot();

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`${GREEN}✓ PASS${RESET}  ${label}`);
    passed++;
  } else {
    console.log(`${RED}✗ FAIL${RESET}  ${label}${detail ? `\n       ${detail}` : ''}`);
    failed++;
    failures.push(label);
  }
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function makeFixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'herald-pkt-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'packet-builder-test@example.com']);
  git(dir, ['config', 'user.name', 'Packet Builder Test']);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

console.log(`\n${BOLD}-- Packet Builder V1 Contract Tests ---------------------------${RESET}\n`);

// --- unit fences ---
assert('unknown profile name → null', getEvidenceProfile('no-such-profile') === null);
assert(
  'V1 ships exactly three named profiles',
  PROFILE_NAMES.length === 3 &&
    PROFILE_NAMES.includes('calendar-diagnosis') &&
    PROFILE_NAMES.includes('routing-diagnosis') &&
    PROFILE_NAMES.includes('memory-diagnosis'),
);

assert('deny .env', isDeniedSecretName('.env') === true);
assert('deny .env.local', isDeniedSecretName('config/.env.local') === true);
assert('deny credentials.json', isDeniedSecretName('secrets/credentials.json') === true);
assert('deny foo.sqlite', isDeniedSecretName('data/foo.sqlite') === true);
assert('allow calendarContinuation.ts', isDeniedSecretName('src/routing/calendarContinuation.ts') === false);

{
  const v = validateEvidenceFile(REPO_ROOT, '../outside.ts');
  assert('path escape .. rejected', v.ok === false && /escape/i.test(v.error));
}
{
  const v = validateEvidenceFile(REPO_ROOT, '.env');
  assert('secret name rejected even if missing', v.ok === false && /secret|config|database/i.test(v.error));
}
{
  const v = validateEvidenceFile(REPO_ROOT, 'src/routing/calendarContinuation.ts');
  assert(
    'normal in-repo evidence file accepted',
    v.ok === true && v.relPosix === 'src/routing/calendarContinuation.ts',
  );
}
{
  const gate = requireGitEvidence('status --short', {
    exitCode: 128,
    stdout: '',
    stderr: 'fatal: not a git repository',
    error: null,
  });
  assert(
    'requireGitEvidence rejects failed status',
    gate.ok === false && /status --short/i.test(gate.error),
  );
}

// --- symlink-parent escapes (filesystem canonicalization) ---
{
  const fixture = makeFixtureRepo();
  const outside = mkdtempSync(path.join(tmpdir(), 'herald-pkt-out-'));
  writeFileSync(path.join(outside, 'escaped.ts'), 'export const leak = 1;\n', 'utf8');
  const linkDir = path.join(fixture, 'via_link');
  let linkOk = false;
  try {
    // Directory junction/symlink does not require elevation on Windows when type=junction.
    symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    linkOk = true;
  } catch (e) {
    assert(
      'symlink-parent fixture created (or platform cannot create dir link)',
      /EPERM|EACCES|privilege|not supported/i.test(String(e)),
      String(e),
    );
  }

  if (linkOk) {
    const vFile = validateEvidenceFile(fixture, 'via_link/escaped.ts');
    assert(
      'symlink-parent evidence-file escape rejected',
      vFile.ok === false && /escape|outside repo/i.test(vFile.error),
      vFile.ok ? 'unexpectedly accepted' : vFile.error,
    );

    const cwdGate = assertContainedInRepo(
      fixture,
      path.resolve(fixture, 'via_link'),
      'command cwd via_link',
    );
    assert(
      'symlink-parent command-cwd escape rejected',
      cwdGate.ok === false && /escape|outside repo/i.test(cwdGate.error),
      cwdGate.ok ? 'unexpectedly accepted' : cwdGate.error,
    );

    const artifactRoot = path.join(fixture, 'artifacts', 'evidence');
    const rCwd = await buildEvidencePacket({
      repoRoot: fixture,
      profileName: 'fixture-cwd-escape',
      label: 'cwd-escape',
      artifactRoot,
      profileOverride: {
        name: 'fixture-cwd-escape',
        description: 't',
        files: ['src/ok.ts'],
        commands: [
          {
            id: 'outside-cwd',
            argv: [process.execPath, '-e', 'process.exit(0)'],
            cwd: 'via_link',
          },
        ],
      },
      skipCommands: false,
    });
    assert(
      'symlink-parent command-cwd fails packet closed',
      rCwd.ok === false &&
        rCwd.status === 'FAILED_CLOSED' &&
        rCwd.failedSteps.some((s) => /escape|outside repo|command cwd/i.test(s)),
    );
  }

  rmSync(fixture, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// --- artifact-root canonical containment ---
{
  const fixture = makeFixtureRepo();
  const profile = {
    name: 'fixture-artifact',
    description: 't',
    files: ['src/ok.ts'],
    commands: [],
  };

  const normalRoot = path.join(fixture, 'artifacts', 'evidence');
  const rOk = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-artifact',
    label: 'artifact-ok',
    artifactRoot: normalRoot,
    profileOverride: profile,
    skipCommands: true,
  });
  assert(
    'normal in-repo artifact root succeeds',
    rOk.ok === true && rOk.status === 'COMPLETE' && existsSync(rOk.packetDir),
  );

  const lexicalEsc = resolveContainedArtifactRoot(
    fixture,
    path.join(fixture, '..', 'outside-artifacts'),
    'artifact root',
  );
  assert(
    'lexical ../ artifact-root escape fails closed (helper)',
    lexicalEsc.ok === false && /escape|outside repo/i.test(lexicalEsc.error),
  );
  const rLex = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-artifact-lex',
    label: 'artifact-lex-escape',
    artifactRoot: path.join(fixture, '..', 'outside-artifacts'),
    profileOverride: profile,
    skipCommands: true,
  });
  assert(
    'lexical ../ artifact-root escape fails closed',
    rLex.ok === false &&
      rLex.status === 'FAILED_CLOSED' &&
      rLex.packetDir === null &&
      rLex.failedSteps.some((s) => /escape|outside repo|artifact root/i.test(s)),
  );

  const outside = mkdtempSync(path.join(tmpdir(), 'herald-pkt-art-out-'));
  const outsideBefore = new Set(readdirSync(outside));
  const linkDir = path.join(fixture, 'art_link');
  let linkOk = false;
  try {
    symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    linkOk = true;
  } catch (e) {
    assert(
      'artifact-root symlink fixture created (or platform cannot create dir link)',
      /EPERM|EACCES|privilege|not supported/i.test(String(e)),
      String(e),
    );
  }

  if (linkOk) {
    const escapeRoot = path.join(linkDir, 'evidence');
    const rArt = await buildEvidencePacket({
      repoRoot: fixture,
      profileName: 'fixture-artifact-symlink',
      label: 'artifact-symlink-escape',
      artifactRoot: escapeRoot,
      profileOverride: profile,
      skipCommands: true,
    });
    assert(
      'artifact-root symlink/junction parent escape fails closed',
      rArt.ok === false &&
        rArt.status === 'FAILED_CLOSED' &&
        rArt.packetDir === null &&
        rArt.failedSteps.some((s) => /escape|outside repo|artifact root/i.test(s)),
    );
    const outsideAfter = readdirSync(outside);
    const newEntries = outsideAfter.filter((n) => !outsideBefore.has(n));
    assert(
      'outside target received no packet/temp writes on artifact-root escape',
      newEntries.length === 0,
      `unexpected outside entries: ${newEntries.join(', ')}`,
    );
    assert(
      'outside target has no pkt_ or .tmp_ publication',
      !outsideAfter.some((n) => n.startsWith('pkt_') || n.startsWith('.tmp_')),
    );
  }

  rmSync(fixture, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}

// --- required git evidence fail-closed ---
{
  const fixture = makeFixtureRepo();
  const artifactRoot = path.join(fixture, 'artifacts', 'evidence');
  const profile = {
    name: 'fixture-git-fail',
    description: 't',
    files: ['src/ok.ts'],
    commands: [],
  };
  const rGit = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-git-fail',
    label: 'git-status-fail',
    artifactRoot,
    profileOverride: profile,
    skipCommands: true,
    runGit: (root, args) => {
      if (args[0] === 'status' && args[1] === '--short') {
        return {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: simulated status failure',
          error: null,
        };
      }
      return runGit(root, args);
    },
  });
  assert(
    'required Git evidence failure cannot produce COMPLETE',
    rGit.ok === false && rGit.status === 'FAILED_CLOSED',
  );
  assert(
    'failed status capture cannot create false clean-tree assertion',
    rGit.ok === false &&
      rGit.status === 'FAILED_CLOSED' &&
      rGit.failedSteps.some((s) => /status --short/i.test(s)) &&
      !(rGit.manifest && rGit.manifest.status === 'COMPLETE') &&
      !(rGit.manifest && rGit.manifest.trackedTreeClean === true),
  );
  rmSync(fixture, { recursive: true, force: true });
}

// --- fixture: unknown profile ---
{
  const r = await buildEvidencePacket({
    repoRoot: REPO_ROOT,
    profileName: 'not-a-real-profile',
    label: 'neg-unknown',
    skipCommands: true,
  });
  assert(
    'unknown profile fails before evidence collection',
    r.ok === false && r.status === 'FAILED_CLOSED' && r.packetDir === null,
  );
}

// --- fixture repo tests ---
{
  const fixture = makeFixtureRepo();
  const artifactRoot = path.join(fixture, 'artifacts', 'evidence');
  const profile = {
    name: 'fixture-ok',
    description: 'test',
    files: ['src/ok.ts'],
    commands: [],
  };

  const r1 = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-ok',
    label: 'clean-build',
    artifactRoot,
    profileOverride: profile,
    skipCommands: true,
  });
  assert('fixture clean profile builds COMPLETE', r1.ok === true && r1.status === 'COMPLETE');
  assert('manifest schema', r1.manifest?.schemaVersion === 'packet-builder-v1');
  assert('manifest has file hash', r1.manifest?.files?.[0]?.sha256?.length === 64);
  assert(
    'packet has files/src/ok.ts',
    existsSync(path.join(r1.packetDir, 'files', 'src', 'ok.ts')),
  );
  assert(
    'packet has git/head.txt',
    existsSync(path.join(r1.packetDir, 'git', 'head.txt')),
  );
  assert(
    'manifest omits home-directory paths',
    !JSON.stringify(r1.manifest).includes(REPO_ROOT.replace(/\\/g, '\\\\')) &&
      !JSON.stringify(r1.manifest).includes('C:\\Users'),
  );

  // dirty inside profile
  writeFileSync(path.join(fixture, 'src', 'ok.ts'), 'export const x = 2;\n', 'utf8');
  const r2 = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-ok',
    label: 'dirty-inside',
    artifactRoot,
    profileOverride: profile,
    skipCommands: true,
  });
  assert('dirty inside profile still builds', r2.ok === true);
  assert(
    'dirty status recorded',
    r2.manifest.trackedTreeClean === false &&
      r2.manifest.gitStatusShort.includes('ok.ts'),
  );
  assert(
    'profile path contents copied (dirty bytes)',
    readFileSync(path.join(r2.packetDir, 'files', 'src', 'ok.ts'), 'utf8').includes('x = 2'),
  );
  assert(
    'diff.patch mentions ok.ts',
    readFileSync(path.join(r2.packetDir, 'git', 'diff.patch'), 'utf8').includes('ok.ts'),
  );

  // dirty outside profile — create another file, do not include in allow-list
  writeFileSync(path.join(fixture, 'OUTSIDE.txt'), 'secret-ish outside\n', 'utf8');
  const r3 = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-ok',
    label: 'dirty-outside',
    artifactRoot,
    profileOverride: profile,
    skipCommands: true,
  });
  assert('dirty outside still COMPLETE', r3.ok === true);
  assert(
    'status reports outside file',
    r3.manifest.gitStatusShort.includes('OUTSIDE.txt'),
  );
  assert(
    'outside contents NOT copied',
    !existsSync(path.join(r3.packetDir, 'files', 'OUTSIDE.txt')),
  );
  assert(
    'outside not in profile diff.patch',
    !readFileSync(path.join(r3.packetDir, 'git', 'diff.patch'), 'utf8').includes('OUTSIDE'),
  );

  // symlink fail-closed
  const linkPath = path.join(fixture, 'src', 'link.ts');
  try {
    symlinkSync(path.join(fixture, 'src', 'ok.ts'), linkPath);
    const rSym = await buildEvidencePacket({
      repoRoot: fixture,
      profileName: 'fixture-symlink',
      label: 'symlink',
      artifactRoot,
      profileOverride: {
        name: 'fixture-symlink',
        description: 't',
        files: ['src/link.ts'],
        commands: [],
      },
      skipCommands: true,
    });
    assert(
      'symlink evidence fails closed',
      rSym.ok === false && rSym.status === 'FAILED_CLOSED' &&
        rSym.failedSteps.some((s) => /symlink/i.test(s)),
    );
  } catch (e) {
    // Windows may require elevation for symlinks — fence code still covered by unit path.
    assert(
      'symlink evidence fails closed (or platform cannot create symlink)',
      /EPERM|EACCES|privilege|not supported/i.test(String(e)),
      String(e),
    );
  }

  // secret name in profile
  writeFileSync(path.join(fixture, '.env'), 'TOKEN=abc\n', 'utf8');
  const rSec = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-secret',
    label: 'secret',
    artifactRoot,
    profileOverride: {
      name: 'fixture-secret',
      description: 't',
      files: ['.env'],
      commands: [],
    },
    skipCommands: true,
  });
  assert(
    'secret filename fails closed',
    rSec.ok === false && rSec.failedSteps.some((s) => /secret|config|database/i.test(s)),
  );

  // oversize
  const big = path.join(fixture, 'src', 'big.ts');
  writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  const rOver = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-oversize',
    label: 'oversize',
    artifactRoot,
    profileOverride: {
      name: 'fixture-oversize',
      description: 't',
      files: ['src/big.ts'],
      commands: [],
    },
    skipCommands: true,
  });
  assert(
    'oversize fails closed',
    rOver.ok === false && rOver.failedSteps.some((s) => /oversize/i.test(s)),
  );

  // failed command → FAILED_CLOSED
  const rCmd = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-cmd',
    label: 'cmd-fail',
    artifactRoot,
    profileOverride: {
      name: 'fixture-cmd',
      description: 't',
      files: ['src/ok.ts'],
      commands: [{ id: 'boom', argv: [process.execPath, '-e', 'process.exit(7)'] }],
    },
    skipCommands: false,
  });
  assert(
    'failed hard-coded command → FAILED_CLOSED',
    rCmd.ok === false &&
      rCmd.status === 'FAILED_CLOSED' &&
      rCmd.failedSteps.some((s) => /boom|exit 7/i.test(s)),
  );

  // hash stability across rebuilds (reset ok.ts)
  writeFileSync(path.join(fixture, 'src', 'ok.ts'), 'export const x = 1;\n', 'utf8');
  git(fixture, ['checkout', '--', 'src/ok.ts']);
  const profileStable = {
    name: 'fixture-stable',
    description: 't',
    files: ['src/ok.ts'],
    commands: [],
  };
  const a = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-stable',
    label: 'hash-a',
    artifactRoot,
    profileOverride: profileStable,
    skipCommands: true,
  });
  const b = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-stable',
    label: 'hash-b',
    artifactRoot,
    profileOverride: profileStable,
    skipCommands: true,
  });
  assert(
    'identical included-file hashes on re-run',
    a.ok && b.ok && a.manifest.files[0].sha256 === b.manifest.files[0].sha256,
  );
  assert(
    'packet ids may differ',
    a.packetId !== b.packetId,
  );

  // path escape via abs-looking allow entry
  const rEsc = await buildEvidencePacket({
    repoRoot: fixture,
    profileName: 'fixture-escape',
    label: 'escape',
    artifactRoot,
    profileOverride: {
      name: 'fixture-escape',
      description: 't',
      files: ['../../etc/passwd'],
      commands: [],
    },
    skipCommands: true,
  });
  assert(
    'allow-list path escape fails closed',
    rEsc.ok === false && rEsc.failedSteps.some((s) => /escape|missing/i.test(s)),
  );

  rmSync(fixture, { recursive: true, force: true });
}

// --- calendar-diagnosis profile structural check against real checkout ---
{
  const cal = getEvidenceProfile('calendar-diagnosis');
  assert('calendar-diagnosis profile exists', !!cal);
  const missing = (cal?.files ?? []).filter(
    (f) => !existsSync(path.join(REPO_ROOT, ...f.split('/'))),
  );
  assert(
    'calendar-diagnosis files all present in checkout',
    missing.length === 0,
    missing.join(', '),
  );
  let total = 0;
  for (const f of cal.files) {
    const v = validateEvidenceFile(REPO_ROOT, f);
    if (!v.ok) {
      assert(`validate ${f}`, false, v.error);
    } else {
      total += v.size;
    }
  }
  assert(
    'calendar-diagnosis payload under 1 MiB',
    total > 0 && total <= 1024 * 1024,
    `total=${total}`,
  );
}

console.log(
  `\n${BOLD}Packet Builder V1 tests:${RESET} ${passed} passed, ${failed} failed\n`,
);
process.exit(failed > 0 ? 1 : 0);
