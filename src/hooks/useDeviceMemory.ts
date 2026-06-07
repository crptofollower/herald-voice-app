// src/hooks/useDeviceMemory.ts
// Herald device-first memory layer.
//
// THE NORTH STAR: The phone is the brain. The cloud is the library.
// Everything personal lives here. Backend gets an anonymous token only.
//
// Writers and readers delegate to herald_device.db (profileDB / medicalDB / factDB).
// Public API unchanged so callers (OnboardingScreen, ChatScreen) need no edits.
//
// WEIGHT SCALE (locked -- never changes order of top 4):
//   medical=10, medication=9, family=8, finance=7
//   work=6, routine=5, travel=4, sports=3, food=3, music=2, general=1
//
// What NEVER leaves this device:
//   name, location, medical records, medications, family, finances
//   All of the above stay in herald_device.db. Always.

import { useCallback } from "react";
import { getDB } from "../db/schema";
import { setProfileField, getProfile } from "../db/profileDB";
import {
  writeMedication,
  writeMedicalRecord,
  getActiveMedications,
  getMedicalRecords,
} from "../db/medicalDB";
import { writeFact, getTopFacts } from "../db/factDB";

// ─── Weight constants (locked) ────────────────────────────────────────────────

export const MEMORY_WEIGHTS: Record<string, number> = {
  medical:    10,
  medication:  9,
  family:      8,
  finance:     7,
  work:        6,
  routine:     5,
  travel:      4,
  sports:      3,
  food:        3,
  music:       2,
  general:     1,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LocalMemory {
  summary: string;
  category: string;
  weight: number;
  created_at: string;
}

export interface LocalProfile {
  name: string;
  ai_name: string;
  location: string;
  confirmed_city: string;
  email: string;
}

export interface LocalMedical {
  type: string;
  summary: string;
  detail: string;
  date: string;
  created_at: string;
}

function parseDrugName(s: string): string {
  const m = s.match(/(?:take|taking|on|prescribed|using)\s+([A-Za-z][\w-]*)/i);
  return (m?.[1] ?? s.split(/[\s,:]/).filter(Boolean)[0] ?? s).replace(/[.,;:!?]+$/, "");
}

// ─── Profile helpers ──────────────────────────────────────────────────────────

export function saveLocalProfile(key: string, value: string) {
  try {
    setProfileField(key, value);
  } catch (e) {
    console.warn("[Herald] saveLocalProfile failed:", e);
  }
}

export function getLocalProfile(): LocalProfile {
  try {
    const map = getProfile();
    return {
      name:           map.name           || "",
      ai_name:        map.ai_name        || "Herald",
      location:       map.location       || "",
      confirmed_city: map.confirmed_city || map.city || "",
      email:          map.email          || "",
    };
  } catch (e) {
    console.warn("[Herald] getLocalProfile failed:", e);
    return { name: "", ai_name: "Herald", location: "", confirmed_city: "", email: "" };
  }
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

export function saveLocalMemory(summary: string, category: string = "general") {
  try {
    writeFact(summary, category);
  } catch (e) {
    console.warn("[Herald] saveLocalMemory failed:", e);
  }
}

export function getTopLocalMemories(limit: number = 8): LocalMemory[] {
  try {
    return getTopFacts(limit).map((f) => ({
      summary: f.fact,
      category: f.category,
      weight: MEMORY_WEIGHTS[f.category] ?? 1,
      created_at: f.source_date,
    }));
  } catch (e) {
    console.warn("[Herald] getTopLocalMemories failed:", e);
    return [];
  }
}

// ─── Preference helpers ───────────────────────────────────────────────────────

export function saveLocalPreference(category: string, value: string) {
  try {
    const db = getDB();
    db.runSync(
      `INSERT INTO local_preferences (category, value, count) VALUES (?, ?, 1)
       ON CONFLICT(category, value) DO UPDATE SET count = count + 1`,
      [category, value]
    );
  } catch (e) {
    console.warn("[Herald] saveLocalPreference failed:", e);
  }
}

// ─── Medical helpers (never leaves device) ────────────────────────────────────

export function saveLocalMedical(type: string, summary: string, detail?: string, date?: string) {
  try {
    if (type === "medication") {
      writeMedication({
        name: parseDrugName(summary),
        notes: detail || summary,
        is_active: 1,
      });
    } else {
      writeMedicalRecord({
        notes: [summary, detail].filter(Boolean).join(" — "),
        visit_date: date || undefined,
      });
    }
  } catch (e) {
    console.warn("[Herald] saveLocalMedical failed:", e);
  }
}

function medicationToLocal(m: ReturnType<typeof getActiveMedications>[number]): LocalMedical {
  return {
    type: "medication",
    summary: m.name,
    detail: m.notes || "",
    date: m.start_date || "",
    created_at: m.created_at,
  };
}

function recordToLocal(r: ReturnType<typeof getMedicalRecords>[number]): LocalMedical {
  return {
    type: "visit",
    summary: r.notes || r.reason || r.diagnosis || "",
    detail: [r.doctor_name, r.facility].filter(Boolean).join(" — "),
    date: r.visit_date || "",
    created_at: r.created_at,
  };
}

export function getLocalMedical(type?: string): LocalMedical[] {
  try {
    if (type === "medication") {
      return getActiveMedications().map(medicationToLocal);
    }
    if (type) {
      return getMedicalRecords().map(recordToLocal);
    }
    return [
      ...getActiveMedications().map(medicationToLocal),
      ...getMedicalRecords().map(recordToLocal),
    ];
  } catch (e) {
    console.warn("[Herald] getLocalMedical failed:", e);
    return [];
  }
}

// ─── Instant local greeting ───────────────────────────────────────────────────
//
// Builds a greeting entirely from device data.
// No network call. Under 500ms. Herald speaks before the internet is touched.

export function buildLocalGreeting(aiName: string): string {
  try {
    const profile = getLocalProfile();
    const name = profile.name;
    const city = profile.confirmed_city || profile.location;

    const hour = new Date().getHours();
    let salutation = "Good morning";
    if (hour >= 12 && hour < 17) salutation = "Good afternoon";
    else if (hour >= 17) salutation = "Good evening";

    const namePart = name ? `, ${name}` : "";

    if (city) {
      return `${salutation}${namePart}. What can I help you with today?`;
    }

    return `${salutation}${namePart}. What's on your mind?`;
  } catch (e) {
    return "Good morning. What can I help you with today?";
  }
}

// ─── Context block for /ask payload ──────────────────────────────────────────
//
// Builds a compact memory context string to include in API calls.
// This replaces sending the full profile -- just the weighted top memories.
// Backend gets context without getting personal data fields.

export function buildLocalContextBlock(): string {
  try {
    const lines: string[] = [];

    const profile = getLocalProfile();
    if (profile.name)           lines.push(`name: ${profile.name}`);
    if (profile.ai_name)        lines.push(`ai_name: ${profile.ai_name}`);
    if (profile.confirmed_city) lines.push(`location: ${profile.confirmed_city}`);
    else if (profile.location)  lines.push(`location: ${profile.location}`);

    const memories = getTopLocalMemories(8);
    for (const m of memories) lines.push(m.summary);

    return lines.join("\n");
  } catch {
    return "";
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDeviceMemory() {
  const saveMemory = useCallback((summary: string, category?: string) => {
    saveLocalMemory(summary, category);
  }, []);

  const saveProfile = useCallback((key: string, value: string) => {
    saveLocalProfile(key, value);
  }, []);

  const savePreference = useCallback((category: string, value: string) => {
    saveLocalPreference(category, value);
  }, []);

  const saveMedical = useCallback(
    (type: string, summary: string, detail?: string, date?: string) => {
      saveLocalMedical(type, summary, detail, date);
    },
    []
  );

  const getLocalMedicalRecords = useCallback((type?: string) => {
    return getLocalMedical(type);
  }, []);

  const getTopMemories = useCallback((limit?: number) => {
    return getTopLocalMemories(limit);
  }, []);

  const getProfile = useCallback(() => {
    return getLocalProfile();
  }, []);

  const getLocalGreeting = useCallback((aiName: string) => {
    return buildLocalGreeting(aiName);
  }, []);

  const getContextBlock = useCallback(() => {
    return buildLocalContextBlock();
  }, []);

  return {
    saveMemory,
    saveProfile,
    savePreference,
    saveMedical,
    getLocalMedical: getLocalMedicalRecords,
    getTopMemories,
    getProfile,
    getLocalGreeting,
    getContextBlock,
  };
}
