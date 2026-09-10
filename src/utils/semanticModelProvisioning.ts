// src/utils/semanticModelProvisioning.ts
// Native LARGE_MODEL provisioning for the shared semantic llama context.
// Independent of LOCAL_LLM_ENABLED and of the retired runModelDownloadService
// classifier path. Downloads only the certified 3B artifact via the existing
// downloadModel primitive, WiFi-gated, with model-version bookkeeping.

import NetInfo from '@react-native-community/netinfo';
import {
  downloadModel,
  isModelDownloaded,
  LARGE_MODEL,
  MODEL_VERSION,
  writeModelVersion,
} from './modelManager';
import {
  resolveSemanticProvisioningAction,
  type SemanticConsumerFlags,
  type SemanticProvisioningAction,
} from './semanticProvisioningPolicy';

export type EnsureSemanticModelResult =
  | { status: 'skipped' }
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

let semanticDownloadGate: Promise<void> | null = null;

function logSemanticProvision(event: string, extra: Record<string, unknown> = {}) {
  console.warn('[semanticModelProvisioning] ' + JSON.stringify({ event, ...extra }));
}

function isPermittedWifi(state: { type?: string | null; isConnected?: boolean | null }): boolean {
  return state.type === 'wifi' && state.isConnected === true;
}

async function isOnWifi(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return isPermittedWifi(state);
  } catch {
    return false;
  }
}

async function waitForPermittedWifi(signal: AbortSignal): Promise<'wifi' | 'cancelled'> {
  if (signal.aborted) return 'cancelled';
  if (await isOnWifi()) return 'wifi';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: 'wifi' | 'cancelled') => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish('cancelled');
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (isPermittedWifi(state)) finish('wifi');
    });
    if (signal.aborted) {
      finish('cancelled');
      return;
    }
    signal.addEventListener('abort', onAbort);
  });
}

async function provisionLargeModelExclusive(): Promise<void> {
  if (semanticDownloadGate) {
    await semanticDownloadGate;
    return;
  }
  semanticDownloadGate = (async () => {
    logSemanticProvision('download_begin');
    await downloadModel(LARGE_MODEL.filename, LARGE_MODEL.url);
    await writeModelVersion(MODEL_VERSION);
    logSemanticProvision('download_complete');
  })();
  try {
    await semanticDownloadGate;
  } finally {
    semanticDownloadGate = null;
  }
}

export async function ensureSemanticLargeModel(opts: {
  consumers: SemanticConsumerFlags;
  signal: AbortSignal;
  onAction?: (action: SemanticProvisioningAction) => void;
}): Promise<EnsureSemanticModelResult> {
  const { consumers, signal, onAction } = opts;
  if (signal.aborted) return { status: 'cancelled' };

  while (!signal.aborted) {
    let modelPresent = false;
    try {
      modelPresent = await isModelDownloaded(LARGE_MODEL.filename);
    } catch {
      modelPresent = false;
    }
    const wifiPermitted = await isOnWifi();
    const action = resolveSemanticProvisioningAction({
      ...consumers,
      modelPresent,
      wifiPermitted,
    });
    onAction?.(action);
    logSemanticProvision('decision', { action });

    if (action === 'none') return { status: 'skipped' };
    if (action === 'ready') return { status: 'ready' };
    if (action === 'wait') {
      logSemanticProvision('wait_wifi');
      const wifi = await waitForPermittedWifi(signal);
      if (wifi === 'cancelled') return { status: 'cancelled' };
      continue;
    }

    try {
      await provisionLargeModelExclusive();
    } catch (e) {
      logSemanticProvision('download_failed', { error: String(e) });
      return { status: 'error', error: String(e) };
    }
  }

  return { status: 'cancelled' };
}
