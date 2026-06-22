import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initialize,
  requestPermission,
  readRecords,
  type RecordResult,
  type SleepSessionRecord,
} from 'react-native-health-connect';

// Fix #9 -- named constants replace magic numbers
const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

// Fix #10 -- initialize called once, not on every sync
let healthInitialized = false;
async function ensureInitialized(): Promise<boolean> {
  if (healthInitialized) return true;
  const ok = await initialize();
  if (ok) healthInitialized = true;
  return ok;
}

// Fix #7 -- null instead of 0 for missing metrics
export interface HealthSummary {
  steps: number;
  calories: number;
  sleepHours: number;
  heartRateAvg: number | null; // null = no data, 0 would be misleading
}

export function useHealthConnect() {
  // Fix #3 -- loading and error state so callers know what's happening
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Fix #5 -- unmount safety
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fix #8 -- dead useEffect removed entirely (manifest not ready)
  // Uncomment the block below once AndroidManifest.xml entries are confirmed:
  //
  // useEffect(() => {
  //   syncHealth();
  // }, [syncHealth]);

  // Fix #4 -- useCallback so this is stable across renders
  const syncHealth = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fix #10 -- one-time initialize via module-level guard
      const initialized = await ensureInitialized();
      if (!initialized) {
        setLoading(false);
        return;
      }

      // Fix #2 -- check what permissions were actually granted
      const granted = await requestPermission([
        { accessType: 'read', recordType: 'Steps' },
        { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
        { accessType: 'read', recordType: 'HeartRate' },
        { accessType: 'read', recordType: 'SleepSession' },
      ]);
      const grantedTypes = new Set(granted.map((p) => p.recordType));

      const now = new Date();
      const yesterday = new Date(now.getTime() - MS_PER_DAY);
      const timeRangeFilter = {
        operator: 'between' as const,
        startTime: yesterday.toISOString(),
        endTime: now.toISOString(),
      };

      // Fix #1 -- parallel reads instead of sequential
      const [stepsResult, calResult, hrResult, sleepResult] = await Promise.all([
        grantedTypes.has('Steps')
          ? readRecords('Steps', { timeRangeFilter })
          : Promise.resolve({ records: [] }),
        grantedTypes.has('ActiveCaloriesBurned')
          ? readRecords('ActiveCaloriesBurned', { timeRangeFilter })
          : Promise.resolve({ records: [] }),
        grantedTypes.has('HeartRate')
          ? readRecords('HeartRate', { timeRangeFilter })
          : Promise.resolve({ records: [] }),
        grantedTypes.has('SleepSession')
          ? readRecords('SleepSession', { timeRangeFilter })
          : Promise.resolve({ records: [] }),
      ]);

      // Fix #6 -- typed records replace any
      const steps = (stepsResult.records as RecordResult<'Steps'>[]).reduce(
        (sum, r) => sum + (r.count ?? 0),
        0
      );

      const calories = (calResult.records as RecordResult<'ActiveCaloriesBurned'>[]).reduce(
        (sum, r) => sum + (r.energy?.inKilocalories ?? 0),
        0
      );

      const hrSamples = (hrResult.records as RecordResult<'HeartRate'>[]).flatMap(
        (r) => r.samples ?? []
      );
      // Fix #7 -- null when no HR data instead of misleading 0
      const heartRateAvg =
        hrSamples.length > 0
          ? Math.round(
              hrSamples.reduce((s, x) => s + x.beatsPerMinute, 0) /
                hrSamples.length
            )
          : null;

      const sleepMs = (sleepResult.records as SleepSessionRecord[]).reduce(
        (sum, r) => {
          const start = new Date(r.startTime).getTime();
          const end = new Date(r.endTime).getTime();
          return sum + (end - start);
        },
        0
      );
      const sleepHours = Math.round((sleepMs / MS_PER_HOUR) * 10) / 10;

      // Fix #5 -- only set state if still mounted
      if (mountedRef.current) {
        setSummary({ steps, calories, sleepHours, heartRateAvg });
        setLoading(false);
      }
    } catch (e) {
      // Log unexpected errors -- silent fail hides bugs
      // Permission denial is expected; other errors are not
      console.warn('[useHealthConnect] syncHealth error:', e);
      if (mountedRef.current) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    }
  }, []); // stable ref -- no deps needed

  return { summary, loading, error, syncHealth };
}