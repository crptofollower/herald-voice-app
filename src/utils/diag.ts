// src/utils/diag.ts
// Best-effort startup breadcrumbs for phones we can't logcat (e.g. Mickey's
// Motorola). A NATIVE crash (SIGSEGV in llama.rn etc.) cannot be caught by JS —
// but if we POST a beacon BEFORE each risky native touchpoint, the LAST beacon
// Railway received pinpoints where the process died. Fire-and-forget: never
// throws, never blocks, never delays startup. Silently no-ops if the endpoint
// doesn't exist yet (POST just fails).

import { API_BASE } from '../constants/api';
import { useStore } from '../store/useStore';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Coarse, non-personal device/build metadata attached to every beacon so a
// single breadcrumb row can be tied to the install that produced it.
// D-observability slice, 2026-08-12. Never includes serials, advertising
// IDs, coordinates, or any personal content. Each field is read
// defensively -- one unavailable field must never block the others or
// beacon() itself.
function getDeviceDiagnosticMeta(): Record<string, string> {
  const meta: Record<string, string> = {};
  try {
    if (Constants.nativeAppVersion) meta.appVersion = String(Constants.nativeAppVersion);
    if (Constants.nativeBuildVersion) meta.nativeBuildVersion = String(Constants.nativeBuildVersion);
  } catch {}
  try {
    if (Platform.Version != null) meta.platformApi = String(Platform.Version);
  } catch {}
  try {
    const c = (Platform as any).constants ?? {};
    if (c.Manufacturer) meta.manufacturer = String(c.Manufacturer);
    if (c.Model) meta.model = String(c.Model);
  } catch {}
  return meta;
}

export function beacon(stage: string, extra?: Record<string, unknown>): void {
  try {
    const userId = useStore.getState().userId ?? 'unknown';
    fetch(`${API_BASE}/diag/breadcrumb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        stage,
        ts: new Date().toISOString(),
        ...getDeviceDiagnosticMeta(),
        ...(extra ?? {}),
      }),
    }).catch(() => {});
  } catch {}
}
