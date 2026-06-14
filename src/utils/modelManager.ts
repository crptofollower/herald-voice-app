// src/utils/modelManager.ts
// On-device GGUF model storage and download management for Herald.
// Uses expo-file-system/legacy for download progress + atomic writes.

import * as FileSystem from 'expo-file-system/legacy';

export const MODEL_VERSION = '1.0.0';

export const SMALL_MODEL = {
  filename: 'llama-3.2-1b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
  size_mb: 650,
  purpose: 'immediate offline capability, loads fast',
} as const;

export const LARGE_MODEL = {
  filename: 'llama-3.2-3b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
  size_mb: 1900,
  purpose: 'higher quality, background download only',
} as const;

const MODEL_DIR_NAME = 'herald_models';
const VERSION_FILE = 'model_version.json';

function joinPath(base: string, ...parts: string[]): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return parts.reduce((acc, part) => {
    const segment = part.startsWith('/') ? part.slice(1) : part;
    return `${acc}/${segment}`;
  }, trimmedBase);
}

async function ensureModelDir(): Promise<string> {
  const dir = getModelDir();
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

export function getModelDir(): string {
  const base = FileSystem.documentDirectory;
  if (!base) {
    throw new Error('documentDirectory unavailable');
  }
  return joinPath(base, MODEL_DIR_NAME);
}

export async function getActiveModelPath(): Promise<string | null> {
  if (await isModelDownloaded(LARGE_MODEL.filename)) {
    return joinPath(getModelDir(), LARGE_MODEL.filename);
  }
  if (await isModelDownloaded(SMALL_MODEL.filename)) {
    return joinPath(getModelDir(), SMALL_MODEL.filename);
  }
  return null;
}

export async function isModelDownloaded(filename: string): Promise<boolean> {
  const path = joinPath(getModelDir(), filename);
  const info = await FileSystem.getInfoAsync(path);
  return info.exists && !info.isDirectory;
}

export async function downloadModel(
  filename: string,
  url: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const dir = await ensureModelDir();
  const finalPath = joinPath(dir, filename);
  const tmpPath = `${finalPath}.tmp`;

  // Clean up any stale partial download.
  const stale = await FileSystem.getInfoAsync(tmpPath);
  if (stale.exists) {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true });
  }

  const progressCallback: FileSystem.FileSystemNetworkTaskProgressCallback<
    FileSystem.DownloadProgressData
  > = (data) => {
    if (!onProgress) return;
    const { totalBytesWritten, totalBytesExpectedToWrite } = data;
    if (totalBytesExpectedToWrite > 0) {
      onProgress(Math.min(100, Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 100)));
    }
  };

  const download = FileSystem.createDownloadResumable(
    url,
    tmpPath,
    {},
    progressCallback,
  );

  try {
    const result = await download.downloadAsync();
    if (!result?.uri) {
      throw new Error(`Download failed for ${filename}`);
    }
    const fileInfo = await FileSystem.getInfoAsync(tmpPath);
    if (!fileInfo.exists || fileInfo.size < 100_000_000) {
      // File under 100MB is almost certainly an error page, not a model
      await FileSystem.deleteAsync(tmpPath, { idempotent: true });
      throw new Error(`Download appears invalid: ${(fileInfo as any).size ?? 0} bytes`);
    }
    // Atomic rename: tmp → final
    const existing = await FileSystem.getInfoAsync(finalPath);
    if (existing.exists) {
      await FileSystem.deleteAsync(finalPath, { idempotent: true });
    }
    await FileSystem.moveAsync({ from: tmpPath, to: finalPath });
    onProgress?.(100);
  } catch (err) {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function getModelVersion(): Promise<string | null> {
  try {
    const path = joinPath(getModelDir(), VERSION_FILE);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path);
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

export async function writeModelVersion(version: string): Promise<void> {
  await ensureModelDir();
  const path = joinPath(getModelDir(), VERSION_FILE);
  const payload = {
    version,
    updated_at: new Date().toISOString(),
  };
  await FileSystem.writeAsStringAsync(path, JSON.stringify(payload, null, 2));
}
