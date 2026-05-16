// useHealthData.ts -- Herald Health Connect Integration
// Reads steps, sleep, heart rate from Samsung Health / Google Health Connect
// Auto-detects source -- works with any app that writes to Health Connect
// Answers "how many steps today" INSTANTLY with no backend call
// Sends daily summary to backend for Herald memory

import { useEffect, useRef, useState } from "react";
import {
  initialize,
  requestPermission,
  readRecords,
  getSdkStatus,
  SdkAvailabilityStatus,
} from "react-native-health-connect";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "../store/useStore";
import { API_BASE } from "../constants/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HealthSummary {
  steps_today:       number;
  sleep_hours_last:  number;  // last night
  heart_rate_latest: number;  // most recent reading
  distance_today_km: number;
  calories_today:    number;
  last_updated:      string;
  available:         boolean; // false if Health Connect not installed
}

const EMPTY_SUMMARY: HealthSummary = {
  steps_today:       0,
  sleep_hours_last:  0,
  heart_rate_latest: 0,
  distance_today_km: 0,
  calories_today:    0,
  last_updated:      "",
  available:         false,
};

const HEALTH_CACHE_KEY    = "herald_health_summary";
const HEALTH_SYNC_KEY     = "herald_health_last_sync";
const SYNC_INTERVAL_MS    = 30 * 60 * 1000; // refresh every 30 min

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useHealthData() {
  const [summary, setSummary] = useState<HealthSummary>(EMPTY_SUMMARY);
  const userId  = useStore((s) => s.userId);
  const hasRun  = useRef(false);

  useEffect(() => {
    // Load cached data immediately so Herald can answer instantly
    AsyncStorage.getItem(HEALTH_CACHE_KEY).then((cached) => {
      if (cached) {
        try { setSummary(JSON.parse(cached)); } catch {}
      }
    });
  }, []);

  useEffect(() => {
    if (!userId || hasRun.current) return;
    hasRun.current = true;
    fetchHealthData(userId, setSummary);
  }, [userId]);

  return summary;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchHealthData(
  userId: string,
  setSummary: (s: HealthSummary) => void
) {
  try {
    // Check if Health Connect is available on this device
    const sdkStatus = await getSdkStatus();
    if (sdkStatus !== SdkAvailabilityStatus.SDK_AVAILABLE) {
      console.log("[HERALD] Health Connect not available on this device");
      return;
    }

    // Check sync interval
    const lastSync = await AsyncStorage.getItem(HEALTH_SYNC_KEY);
    if (lastSync) {
      const elapsed = Date.now() - parseInt(lastSync, 10);
      if (elapsed < SYNC_INTERVAL_MS) {
        // Use cache
        return;
      }
    }

    // Initialize Health Connect
    const initialized = await initialize();
    if (!initialized) return;

    // Request permissions for what we need
    await requestPermission([
      { accessType: "read", recordType: "Steps" },
      { accessType: "read", recordType: "SleepSession" },
      { accessType: "read", recordType: "HeartRate" },
      { accessType: "read", recordType: "Distance" },
      { accessType: "read", recordType: "TotalCaloriesBurned" },
    ]);

    // Today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const now = new Date();

    // Yesterday for sleep
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    // ── Steps today ───────────────────────────────────────────────────────────
    let stepsToday = 0;
    try {
      const stepsResult = await readRecords("Steps", {
        timeRangeFilter: {
          operator: "between",
          startTime: todayStart.toISOString(),
          endTime:   now.toISOString(),
        },
      });
      stepsToday = stepsResult.records.reduce(
        (sum, r: any) => sum + (r.count ?? 0), 0
      );
    } catch {}

    // ── Sleep last night ──────────────────────────────────────────────────────
    let sleepHours = 0;
    try {
      const sleepResult = await readRecords("SleepSession", {
        timeRangeFilter: {
          operator: "between",
          startTime: yesterdayStart.toISOString(),
          endTime:   now.toISOString(),
        },
      });
      if (sleepResult.records.length > 0) {
        const latest: any = sleepResult.records[sleepResult.records.length - 1];
        const start = new Date(latest.startTime).getTime();
        const end   = new Date(latest.endTime).getTime();
        sleepHours  = Math.round(((end - start) / 3_600_000) * 10) / 10;
      }
    } catch {}

    // ── Heart rate (latest reading) ───────────────────────────────────────────
    let heartRate = 0;
    try {
      const hrResult = await readRecords("HeartRate", {
        timeRangeFilter: {
          operator: "between",
          startTime: todayStart.toISOString(),
          endTime:   now.toISOString(),
        },
      });
      if (hrResult.records.length > 0) {
        const latest: any = hrResult.records[hrResult.records.length - 1];
        heartRate = latest.samples?.[0]?.beatsPerMinute ?? 0;
      }
    } catch {}

    // ── Distance today ────────────────────────────────────────────────────────
    let distanceKm = 0;
    try {
      const distResult = await readRecords("Distance", {
        timeRangeFilter: {
          operator: "between",
          startTime: todayStart.toISOString(),
          endTime:   now.toISOString(),
        },
      });
      distanceKm = distResult.records.reduce(
        (sum, r: any) => sum + ((r.distance?.inKilometers ?? 0)), 0
      );
      distanceKm = Math.round(distanceKm * 100) / 100;
    } catch {}

    // ── Calories today ────────────────────────────────────────────────────────
    let caloriesToday = 0;
    try {
      const calResult = await readRecords("TotalCaloriesBurned", {
        timeRangeFilter: {
          operator: "between",
          startTime: todayStart.toISOString(),
          endTime:   now.toISOString(),
        },
      });
      caloriesToday = Math.round(calResult.records.reduce(
        (sum, r: any) => sum + (r.energy?.inKilocalories ?? 0), 0
      ));
    } catch {}

    // ── Assemble summary ──────────────────────────────────────────────────────
    const health: HealthSummary = {
      steps_today:       stepsToday,
      sleep_hours_last:  sleepHours,
      heart_rate_latest: heartRate,
      distance_today_km: distanceKm,
      calories_today:    caloriesToday,
      last_updated:      now.toISOString(),
      available:         true,
    };

    // Update state and cache
    setSummary(health);
    await AsyncStorage.setItem(HEALTH_CACHE_KEY, JSON.stringify(health));
    await AsyncStorage.setItem(HEALTH_SYNC_KEY, Date.now().toString());

    // Send daily summary to backend (background, non-blocking)
    sendHealthToBackend(userId, health).catch(() => {});

    console.log(`[HERALD] Health sync: ${stepsToday} steps, ${sleepHours}h sleep`);

  } catch (err) {
    console.log("[HERALD] Health sync failed (non-fatal):", err);
  }
}

async function sendHealthToBackend(userId: string, health: HealthSummary) {
  await fetch(`${API_BASE}/health/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, health }),
  });
}

// ─── Helper for ChatScreen to format health answers ───────────────────────────
// Called when Herald detects a health question -- answers instantly, no backend

export function formatHealthAnswer(
  summary: HealthSummary,
  question: string
): string | null {
  if (!summary.available) return null;

  const q = question.toLowerCase();

  if (/steps/.test(q)) {
    if (summary.steps_today === 0) return "I don't have your step count yet today.";
    return `You've taken ${summary.steps_today.toLocaleString()} steps today.`;
  }

  if (/sleep/.test(q)) {
    if (summary.sleep_hours_last === 0) return "I don't have your sleep data for last night.";
    return `You got ${summary.sleep_hours_last} hours of sleep last night.`;
  }

  if (/heart rate|pulse/.test(q)) {
    if (summary.heart_rate_latest === 0) return "I don't have a recent heart rate reading.";
    return `Your latest heart rate reading is ${summary.heart_rate_latest} beats per minute.`;
  }

  if (/calorie/.test(q)) {
    if (summary.calories_today === 0) return "I don't have calorie data for today yet.";
    return `You've burned ${summary.calories_today.toLocaleString()} calories today.`;
  }

  if (/distance|walk|run/.test(q)) {
    if (summary.distance_today_km === 0) return "I don't have distance data for today yet.";
    const miles = Math.round(summary.distance_today_km * 0.621371 * 10) / 10;
    return `You've covered ${miles} miles today.`;
  }

  return null;
}
