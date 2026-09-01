// Isolated Qwen3-1.7B Q4_K_M download for the independent conversational engine.
// Not production Llama-3.2 herald_models. Not a src/dev dependency.

import * as FileSystem from 'expo-file-system/legacy';

/** Official Qwen GGUF repo currently ships Q8_0 only. Q4_K_M artifact used
 *  here is unsloth's GGUF of Apache-2.0 Qwen/Qwen3-1.7B. Card license is
 *  apache-2.0 with license_link to Qwen/Qwen3-1.7B/LICENSE. The unsloth repo
 *  has no sibling LICENSE file — recorded as a redistribution-terms caveat. */
export const EXPERIMENTAL_QWEN_ARTIFACT = {
  repo: 'unsloth/Qwen3-1.7B-GGUF',
  filename: 'Qwen3-1.7B-Q4_K_M.gguf',
  url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
  sizeBytes: 1_107_409_472,
  sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
  cardLicense: 'apache-2.0',
  licenseLink: 'https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE',
  officialGgufRepo: 'Qwen/Qwen3-1.7B-GGUF',
  officialGgufNote: 'main currently lists only Qwen3-1.7B-Q8_0.gguf (Apache-2.0 LICENSE in-repo)',
} as const;

const MODEL_DIR = 'herald_spike_b1';

function joinPath(base: string, ...parts: string[]): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return parts.reduce((acc, part) => {
    const segment = part.startsWith('/') ? part.slice(1) : part;
    return `${acc}/${segment}`;
  }, trimmedBase);
}

export async function ensureExperimentalQwenModelPath(
  onProgress?: (pct: number) => void,
): Promise<{ path: string; downloadedBytes: number; skippedDownload: boolean }> {
  const base = FileSystem.documentDirectory;
  if (!base) throw new Error('documentDirectory unavailable');
  const dir = joinPath(base, MODEL_DIR);
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  const finalPath = joinPath(dir, EXPERIMENTAL_QWEN_ARTIFACT.filename);
  const existing = await FileSystem.getInfoAsync(finalPath);
  if (existing.exists && !existing.isDirectory && (existing.size ?? 0) === EXPERIMENTAL_QWEN_ARTIFACT.sizeBytes) {
    return { path: finalPath, downloadedBytes: existing.size ?? 0, skippedDownload: true };
  }

  const tmpPath = `${finalPath}.tmp`;
  const stale = await FileSystem.getInfoAsync(tmpPath);
  if (stale.exists) await FileSystem.deleteAsync(tmpPath, { idempotent: true });

  const download = FileSystem.createDownloadResumable(
    EXPERIMENTAL_QWEN_ARTIFACT.url,
    tmpPath,
    {},
    (data) => {
      if (!onProgress) return;
      const { totalBytesWritten, totalBytesExpectedToWrite } = data;
      if (totalBytesExpectedToWrite > 0) {
        onProgress(Math.min(100, Math.round((totalBytesWritten / totalBytesExpectedToWrite) * 100)));
      }
    },
  );
  const result = await download.downloadAsync();
  if (!result?.uri) throw new Error('experimental Qwen download failed');
  const fileInfo = await FileSystem.getInfoAsync(tmpPath);
  const size = fileInfo.exists ? (fileInfo.size ?? 0) : 0;
  if (size !== EXPERIMENTAL_QWEN_ARTIFACT.sizeBytes) {
    await FileSystem.deleteAsync(tmpPath, { idempotent: true });
    throw new Error(`experimental Qwen size mismatch: got ${size} expected ${EXPERIMENTAL_QWEN_ARTIFACT.sizeBytes}`);
  }
  if (existing.exists) await FileSystem.deleteAsync(finalPath, { idempotent: true });
  await FileSystem.moveAsync({ from: tmpPath, to: finalPath });
  onProgress?.(100);
  return { path: finalPath, downloadedBytes: size, skippedDownload: false };
}
