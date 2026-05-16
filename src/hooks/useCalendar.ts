// useCalendar.ts -- Herald Calendar Integration
// Reads ALL calendars on the device (Google, Samsung, any synced calendar)
// Auto-detects -- user never has to choose which calendar app they use
// Runs once per day on app open, sends appointments to backend
// Backend stores them in life_tracker so Herald remembers forever

import { useEffect, useRef } from "react";
import * as Calendar from "expo-calendar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useStore } from "../store/useStore";
import { API_BASE } from "../constants/api";

// ─── Config ──────────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS  = 24 * 60 * 60 * 1000; // once per day
const LAST_SYNC_KEY     = "herald_calendar_last_sync";
const MONTHS_PAST       = 12;  // look back 12 months
const MONTHS_FUTURE     = 6;   // look ahead 6 months

// Keywords that signal a meaningful appointment Herald should remember
const APPOINTMENT_KEYWORDS = [
  // Medical
  "dentist", "dental", "doctor", "dr.", "physician", "clinic", "hospital",
  "appointment", "checkup", "check-up", "physical", "exam", "screening",
  "specialist", "therapy", "therapist", "counseling", "psychiatrist",
  "optometrist", "eye doctor", "vision", "dermatologist", "cardiologist",
  "orthopedic", "surgeon", "surgery", "procedure", "lab", "blood work",
  "mammogram", "colonoscopy", "vaccination", "vaccine", "shot", "flu shot",
  "prescription", "pharmacy", "refill",
  // Automotive
  "oil change", "car service", "tire", "mechanic", "auto",
  // Home
  "ac service", "hvac", "plumber", "electrician", "pest control", "inspection",
  // Wellness
  "gym", "trainer", "massage", "chiropractor", "acupuncture",
  // Financial
  "financial advisor", "accountant", "tax", "insurance",
  // Travel
  "flight", "hotel", "trip", "vacation", "travel",
  // Family
  "birthday", "anniversary", "graduation", "wedding",
];

// Category mapping
function detectCategory(title: string, notes: string): string {
  const text = (title + " " + notes).toLowerCase();
  if (/dentist|dental/.test(text)) return "dental";
  if (/doctor|dr\.|physician|specialist|clinic|hospital|medical|health/.test(text)) return "medical";
  if (/therapy|therapist|counseling|psychiatrist|mental/.test(text)) return "mental_health";
  if (/oil change|car service|mechanic|tire|auto/.test(text)) return "automotive";
  if (/ac|hvac|plumber|electrician|pest|home inspection/.test(text)) return "home";
  if (/gym|trainer|massage|chiropractor|acupuncture|fitness/.test(text)) return "wellness";
  if (/flight|hotel|trip|vacation|travel/.test(text)) return "travel";
  if (/birthday|anniversary|graduation|wedding/.test(text)) return "family";
  if (/financial|accountant|tax|insurance/.test(text)) return "finance";
  return "appointment";
}

// Estimate typical interval in days for recurring appointments
function estimateInterval(category: string): number {
  const intervals: Record<string, number> = {
    dental:       180,  // every 6 months
    medical:      365,  // annual physical
    mental_health:  7,  // weekly therapy
    automotive:   180,  // oil change every 6 months
    home:         365,  // annual service
    wellness:      30,  // monthly
    travel:         0,  // no recurrence
    family:       365,  // annual
    finance:      365,  // annual
    appointment:   90,  // quarterly default
  };
  return intervals[category] ?? 90;
}

function isAppointmentWorth(title: string, notes: string = ""): boolean {
  const text = (title + " " + notes).toLowerCase();
  return APPOINTMENT_KEYWORDS.some(kw => text.includes(kw));
}

// ─── Main hook ────────────────────────────────────────────────────────────────

export function useCalendar() {
  const userId  = useStore((s) => s.userId);
  const hasRun  = useRef(false);

  useEffect(() => {
    if (!userId || hasRun.current) return;
    hasRun.current = true;
    syncCalendar(userId);
  }, [userId]);
}

async function syncCalendar(userId: string) {
  try {
    // Check if we synced today already
    const lastSync = await AsyncStorage.getItem(LAST_SYNC_KEY);
    if (lastSync) {
      const elapsed = Date.now() - parseInt(lastSync, 10);
      if (elapsed < SYNC_INTERVAL_MS) return;
    }

    // Request permission
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== "granted") {
      console.log("[HERALD] Calendar permission denied");
      return;
    }

    // Get ALL calendars on the device (Google, Samsung, all of them)
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const calendarIds = calendars.map((c) => c.id);

    if (calendarIds.length === 0) return;

    // Date range: 12 months back, 6 months forward
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - MONTHS_PAST);
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + MONTHS_FUTURE);

    // Pull all events across all calendars
    const allEvents = await Calendar.getEventsAsync(
      calendarIds,
      startDate,
      endDate
    );

    // Filter to only meaningful appointments
    const appointments = allEvents
      .filter((e) => isAppointmentWorth(e.title, e.notes ?? ""))
      .map((e) => ({
        title:     e.title,
        date:      e.startDate,
        end_date:  e.endDate,
        notes:     e.notes ?? "",
        location:  e.location ?? "",
        category:  detectCategory(e.title, e.notes ?? ""),
        interval:  estimateInterval(detectCategory(e.title, e.notes ?? "")),
        all_day:   e.allDay,
      }));

    if (appointments.length === 0) {
      await AsyncStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
      return;
    }

    // Send to backend
    const response = await fetch(`${API_BASE}/calendar/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, appointments }),
    });

    if (response.ok) {
      await AsyncStorage.setItem(LAST_SYNC_KEY, Date.now().toString());
      console.log(`[HERALD] Calendar sync: ${appointments.length} appointments sent`);
    }

  } catch (err) {
    // Non-fatal -- calendar sync failing should never crash the app
    console.log("[HERALD] Calendar sync failed (non-fatal):", err);
  }
}
