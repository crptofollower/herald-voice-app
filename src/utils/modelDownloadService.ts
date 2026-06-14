// src/utils/modelDownloadService.ts
// Two-phase model download orchestration — WiFi-only downloads, large in background.

import NetInfo from '@react-native-community/netinfo';
import {
  downloadModel,
  isModelDownloaded,
  LARGE_MODEL,
  MODEL_VERSION,
  SMALL_MODEL,
  writeModelVersion,
} from './modelManager';

export interface ModelDownloadServiceOptions {
  onSmallModelReady: () => void;
  onLargeModelReady: () => void;
  onProgress: (phase: 'small' | 'large', pct: number) => void;
  onError: (phase: 'small' | 'large', err: Error) => void;
}

async function isOnWifi(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.type === 'wifi' && state.isConnected === true;
  } catch {
    return false;
  }
}

let cachedOptions: ModelDownloadServiceOptions | null = null;
let largeModelDownloading = false;

async function executeModelDownloadService(
  options: ModelDownloadServiceOptions,
): Promise<void> {
  const { onSmallModelReady, onLargeModelReady, onProgress, onError } = options;

  const onWifi = await isOnWifi();
  const smallReady = await isModelDownloaded(SMALL_MODEL.filename);

  // Cellular or offline — never download; surface banner if small missing
  if (!onWifi) {
    if (!smallReady) {
      onError('small', new Error('wifi_required'));
    } else {
      onSmallModelReady();
    }
    return;
  }

  // ── Phase 1: small model on WiFi (blocking with progress) ─────────────────
  try {
    if (!smallReady) {
      await downloadModel(
        SMALL_MODEL.filename,
        SMALL_MODEL.url,
        (pct) => onProgress('small', pct),
      );
      await writeModelVersion(MODEL_VERSION);
    }
    onSmallModelReady();
  } catch (err) {
    onError('small', err instanceof Error ? err : new Error(String(err)));
    return;
  }

  // ── Phase 2: large model (WiFi background download) ─────────────────────────
  try {
    const largeReady = await isModelDownloaded(LARGE_MODEL.filename);
    if (largeReady) {
      onLargeModelReady();
      return;
    }

    if (largeModelDownloading) return;
    largeModelDownloading = true;

    // Fire-and-forget background download — do not block app startup.
    void downloadModel(
      LARGE_MODEL.filename,
      LARGE_MODEL.url,
      (pct) => onProgress('large', pct),
    )
      .then(async () => {
        await writeModelVersion(MODEL_VERSION);
        onLargeModelReady();
      })
      .catch((err) => {
        onError('large', err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        largeModelDownloading = false;
      });
  } catch (err) {
    onError('large', err instanceof Error ? err : new Error(String(err)));
  }
}

export async function runModelDownloadService(
  options: ModelDownloadServiceOptions,
): Promise<void> {
  cachedOptions = options;
  try {
    await executeModelDownloadService(options);
  } catch (err) {
    options.onError(
      'small',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/** Re-run download logic when WiFi becomes available (uses last registered options). */
export async function retriggerOnWifi(): Promise<void> {
  if (!cachedOptions) return;
  if (largeModelDownloading) return;
  try {
    await executeModelDownloadService(cachedOptions);
  } catch (err) {
    cachedOptions.onError(
      'small',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}
