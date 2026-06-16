// src/utils/diag.ts
// Best-effort startup breadcrumbs for phones we can't logcat (e.g. Mickey's
// Motorola). A NATIVE crash (SIGSEGV in llama.rn etc.) cannot be caught by JS —
// but if we POST a beacon BEFORE each risky native touchpoint, the LAST beacon
// Railway received pinpoints where the process died. Fire-and-forget: never
// throws, never blocks, never delays startup. Silently no-ops if the endpoint
// doesn't exist yet (POST just fails).

import { API_BASE } from '../constants/api';
import { useStore } from '../store/useStore';

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
        ...(extra ?? {}),
      }),
    }).catch(() => {});
  } catch {}
}
