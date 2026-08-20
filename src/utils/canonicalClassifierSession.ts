// src/utils/canonicalClassifierSession.ts
// Canonical classifier KV snapshot: save ONLY from the fixed warmup ping
// (empty hints), nested under the classifier exclusive hold — never via a
// separate re-acquire. Restore before real classify when the prior consumer
// was ephemeral. Snapshot failure never gates llm readiness.
//
// FileSystem is dynamically imported so the headless heraldTest harness
// (which loads llmLayers) never pulls react-native via expo-file-system.

import type { LlamaContext } from 'llama.rn';
import { log as latLog, mono as latMono } from './latencyInstrument';

const SESSION_FILENAME = 'herald_canonical_classifier_session.bin';

let snapshotReady = false;
let snapshotCtxId: number | null = null;
let snapshotModelKind: 'small' | 'large' | null = null;
let snapshotModelPath: string | null = null;

type LegacyFS = typeof import('expo-file-system/legacy');

export type CanonicalSessionModelIdentity = {
  modelKind: 'small' | 'large';
  modelPath: string;
};

async function loadFileSystem(): Promise<LegacyFS | null> {
  try {
    return await import('expo-file-system/legacy');
  } catch {
    return null;
  }
}

function cacheSessionUri(FileSystem: LegacyFS): string | null {
  const base = FileSystem.cacheDirectory;
  if (!base) return null;
  return `${base}${SESSION_FILENAME}`;
}

function toNativeFsPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice(7) : uri;
}

function clearArming(): void {
  snapshotReady = false;
  snapshotCtxId = null;
  snapshotModelKind = null;
  snapshotModelPath = null;
}

/** Clear in-memory arming only (file may still exist until deleted). */
export function invalidateCanonicalClassifierSession(): void {
  clearArming();
}

/** Delete the cache file if present and clear arming. Best-effort. */
export async function deleteCanonicalClassifierSessionFile(): Promise<void> {
  clearArming();
  try {
    const FileSystem = await loadFileSystem();
    if (!FileSystem) return;
    const uri = cacheSessionUri(FileSystem);
    if (!uri) return;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      latLog('canonicalSession FILE deleted', { outcome: 'ok' });
    }
  } catch (e) {
    latLog('canonicalSession FILE deleted', {
      outcome: 'error',
      errorName: e instanceof Error ? e.name : 'unknown',
    });
  }
}

/**
 * Nested under classifier exclusive hold after successful warmup completion.
 * Must NOT acquire the exclusivity gate (would deadlock / reopen an interleave
 * window). Failure is logged only — never throws to readiness.
 */
export async function saveCanonicalClassifierSessionWhileHoldingExclusive(
  ctx: LlamaContext,
  identity: CanonicalSessionModelIdentity,
): Promise<void> {
  try {
    if (
      snapshotReady &&
      snapshotCtxId === ctx.id &&
      snapshotModelKind === identity.modelKind &&
      snapshotModelPath === identity.modelPath
    ) {
      latLog('canonicalSession SAVE skipped', {
        reason: 'already-saved',
        ctxId: ctx.id,
        modelKind: identity.modelKind,
      });
      return;
    }

    const FileSystem = await loadFileSystem();
    if (!FileSystem) {
      latLog('canonicalSession SAVE skipped', { reason: 'no-filesystem' });
      return;
    }
    const uri = cacheSessionUri(FileSystem);
    if (!uri) {
      latLog('canonicalSession SAVE skipped', { reason: 'no-cache-dir' });
      return;
    }

    snapshotCtxId = ctx.id;
    snapshotModelKind = identity.modelKind;
    snapshotModelPath = identity.modelPath;
    latLog('canonicalSession SAVE START', {
      ctxId: ctx.id,
      modelKind: identity.modelKind,
    });
    const t0 = latMono();
    const tokensSaved = await ctx.saveSession(toNativeFsPath(uri));
    const durationMs = Math.round((latMono() - t0) * 100) / 100;

    let fileBytes: number | null = null;
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && 'size' in info && typeof info.size === 'number') {
        fileBytes = info.size;
      }
    } catch {
      // size is best-effort
    }

    snapshotReady = true;
    latLog('canonicalSession SAVE END', {
      outcome: 'ok',
      ctxId: ctx.id,
      modelKind: identity.modelKind,
      durationMs,
      tokensSaved: typeof tokensSaved === 'number' ? tokensSaved : null,
      fileBytes,
    });
  } catch (e) {
    snapshotReady = false;
    latLog('canonicalSession SAVE END', {
      outcome: 'error',
      errorName: e instanceof Error ? e.name : 'unknown',
    });
  }
}

/**
 * Nested under classifier exclusive hold — must NOT acquire the gate.
 * Call on real (non-warmup) classify when previous completion consumer was ephemeral.
 * On failure: log and return false — caller proceeds with existing behavior.
 */
export async function maybeLoadCanonicalClassifierSessionBeforeClassify(
  ctx: LlamaContext,
  identity: CanonicalSessionModelIdentity,
): Promise<boolean> {
  try {
    if (!snapshotReady || snapshotCtxId !== ctx.id) {
      latLog('canonicalSession LOAD skipped', {
        reason: !snapshotReady ? 'no-snapshot' : 'ctx-mismatch',
        ctxId: ctx.id,
        snapshotCtxId,
      });
      return false;
    }
    if (
      snapshotModelKind !== identity.modelKind ||
      snapshotModelPath !== identity.modelPath
    ) {
      latLog('canonicalSession LOAD skipped', {
        reason: 'model-mismatch',
        ctxId: ctx.id,
        modelKind: identity.modelKind,
        snapshotModelKind,
      });
      return false;
    }
    const FileSystem = await loadFileSystem();
    if (!FileSystem) {
      latLog('canonicalSession LOAD skipped', { reason: 'no-filesystem' });
      return false;
    }
    const uri = cacheSessionUri(FileSystem);
    if (!uri) {
      latLog('canonicalSession LOAD skipped', { reason: 'no-cache-dir' });
      return false;
    }

    latLog('canonicalSession LOAD START', {
      ctxId: ctx.id,
      modelKind: identity.modelKind,
    });
    const t0 = latMono();
    const loaded = await ctx.loadSession(toNativeFsPath(uri));
    const durationMs = Math.round((latMono() - t0) * 100) / 100;
    const tokensLoaded =
      loaded && typeof (loaded as { tokens_loaded?: unknown }).tokens_loaded === 'number'
        ? (loaded as { tokens_loaded: number }).tokens_loaded
        : null;
    latLog('canonicalSession LOAD END', {
      outcome: 'ok',
      ctxId: ctx.id,
      modelKind: identity.modelKind,
      durationMs,
      tokensLoaded,
    });
    return true;
  } catch (e) {
    latLog('canonicalSession LOAD END', {
      outcome: 'error',
      errorName: e instanceof Error ? e.name : 'unknown',
    });
    return false;
  }
}
