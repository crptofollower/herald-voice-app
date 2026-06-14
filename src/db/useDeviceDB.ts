// src/db/useDeviceDB.ts
// Herald device SQLite — init wrapper.
// Session L — Device-First Intelligence Layer
//
// Call initDB() once on app mount (in App.tsx) before any screen reads SQLite.
// Safe to call again — concurrent and repeat calls share the same promise.
// isDBReady() is true only after schema migrations and post-migration hooks finish.

import { runMigrations } from "./schema";

let _initialized = false;
let _initPromise: Promise<void> | null = null;

export async function initDB(): Promise<void> {
  if (_initialized) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      await runMigrations();
      try {
        const { importLegacyDatabases } = await import("./legacyMigration");
        await importLegacyDatabases();
      } catch (e) {
        console.warn("[Herald] legacy import skipped:", e);
      }

      // Expire temporal facts — wrapped in try-catch so a failure here
      // never blocks app init. Import is lazy to avoid circular dependency.
      try {
        const { expireTemporalFacts } = await import("./factDB");
        if (typeof expireTemporalFacts === "function") {
          expireTemporalFacts();
        }
      } catch {
        // Non-critical — app continues without expiry on this open
      }

      // Register contact extractor — lazy import for same reason
      try {
        const { _registerContactExtractor } = await import("./factDB");
        const { extractContactFromFact } = await import("./contactsDB");
        if (typeof _registerContactExtractor === "function" &&
            typeof extractContactFromFact === "function") {
          _registerContactExtractor(extractContactFromFact);
        }
      } catch {
        // Non-critical
      }

      _initialized = true;
      _initPromise = null;
    } catch (e) {
      _initPromise = null;
      console.error("[Herald] DB init failed:", e);
      throw e;
    }
  })();

  return _initPromise;
}

/** True only after schema migrations and init hooks have completed successfully. */
export function isDBReady(): boolean {
  return _initialized;
}