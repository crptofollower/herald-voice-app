// src/db/useDeviceDB.ts
// Herald device SQLite — init wrapper.
// Session L — Device-First Intelligence Layer
//
// Call initDB() once on app mount (in App.tsx).
// All other db/ modules import getDB() from schema.ts directly.
//
// Usage in App.tsx:
//   import { initDB } from './src/db/useDeviceDB';
//   useEffect(() => { initDB(); }, []);

import { runMigrations } from "./schema";

let _initialized = false;
let _initPromise: Promise<void> | null = null;

// ─── initDB ───────────────────────────────────────────────────────────────────
//
// Idempotent — safe to call multiple times, only runs once.
// Awaitable — callers that need DB ready before proceeding can await this.

export async function initDB(): Promise<void> {
  if (_initialized) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      await runMigrations();
      _initialized = true;
    } catch (e) {
      // Reset so next call retries
      _initPromise = null;
      console.error("[Herald] DB init failed:", e);
      throw e;
    }
  })();

  return _initPromise;
}

// ─── isDBReady ────────────────────────────────────────────────────────────────
//
// Synchronous check — use this in components that want to skip DB reads
// until init is confirmed, without awaiting.

export function isDBReady(): boolean {
  return _initialized;
}
