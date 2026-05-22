// src/hooks/useLocation.ts
// Provides GPS coords + human-readable label to ChatScreen and greeting calls.
//
// DESIGN:
//   - Requests foreground permission only (no background location)
//   - Caches result in AsyncStorage for 30 min (avoids hammering GPS)
//   - CONUS guard rejects garbage coords before they hit the backend
//   - Falls back to profile location string if GPS unavailable
//   - Returns { lat, lng, label, available } -- callers check available first
//
// v8.8: reverseGeocode() now passes user_id so backend can cache confirmed city.
//       Fixes "Arlington" showing instead of "The Colony" on every open.

import { useEffect, useState } from "react";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "../constants/api";
import { useStore } from "../store/useStore";

const CACHE_KEY = "herald_location_cache";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface LocationResult {
  lat: number | null;
  lng: number | null;
  label: string | null;  // e.g. "The Colony, TX"
  available: boolean;
}

const UNAVAILABLE: LocationResult = {
  lat: null,
  lng: null,
  label: null,
  available: false,
};

// CONUS guard -- same rule as PWA V55.97 and backend geocode_reverse()
function isValidCONUS(lat: number, lng: number): boolean {
  return lat >= 18 && lat <= 72 && lng >= -180 && lng <= -66;
}

async function getCachedLocation(): Promise<LocationResult | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { result, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) return null; // expired
    return result;
  } catch {
    return null;
  }
}

async function setCachedLocation(result: LocationResult): Promise<void> {
  try {
    await AsyncStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ result, timestamp: Date.now() })
    );
  } catch {
    // Non-critical -- if cache write fails, next open will re-fetch
  }
}

async function reverseGeocode(lat: number, lng: number, userId?: string): Promise<string | null> {
  try {
    const userParam = userId ? `&user_id=${userId}` : "";
    const res = await fetch(`${API_BASE}/geocode?lat=${lat}&lng=${lng}${userParam}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.label ?? null; // e.g. "The Colony, TX"
  } catch {
    return null;
  }
}

export function useLocation(): LocationResult {
  const [location, setLocation] = useState<LocationResult>(UNAVAILABLE);

  useEffect(() => {
    let cancelled = false;
    const userId = useStore.getState().userId;

    async function fetchLocation() {
      // 1. Return cached result immediately if fresh
      const cached = await getCachedLocation();
      if (cached && !cancelled) {
        setLocation(cached);
        return;
      }

      // 2. Request foreground permission
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!cancelled) setLocation(UNAVAILABLE);
        return;
      }

      // 3. Get current position
      let coords: { latitude: number; longitude: number };
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        coords = pos.coords;
      } catch {
        if (!cancelled) setLocation(UNAVAILABLE);
        return;
      }

      const { latitude: lat, longitude: lng } = coords;

      // 4. CONUS guard
      if (!isValidCONUS(lat, lng)) {
        console.warn(`[Herald] GPS rejected: out of CONUS bounds (${lat}, ${lng})`);
        if (!cancelled) setLocation(UNAVAILABLE);
        return;
      }

      // 5. Reverse geocode via backend -- passes user_id for city caching (v8.8)
      const label = await reverseGeocode(lat, lng, userId);

      const result: LocationResult = {
        lat,
        lng,
        label,
        available: true,
      };

      // 6. Cache + return
      await setCachedLocation(result);
      if (!cancelled) setLocation(result);
    }

    fetchLocation();
    return () => { cancelled = true; };
  }, []);

  return location;
}