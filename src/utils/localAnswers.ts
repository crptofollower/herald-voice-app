// src/utils/localAnswers.ts
// ─── Personal query interceptor ───────────────────────────────────────────────
// Checks if a message can be answered from device SQLite instantly.
// Returns an answer string if yes, null if the query should go to Railway.
// Zero network. Zero OpenRouter cost. Under 200ms.
//
// Build 8: reads the SQLite layer (profileDB / medicalDB / factDB) — the SAME
// store tierRouter and the onFacts pipeline write to. Previously this read the
// legacy useDeviceMemory hook, which diverged from SQLite: a med captured via
// onFacts landed in SQLite but was invisible here, so this path could answer
// "I don't have any medications saved" while Tier 1 answered correctly. One
// source of truth now.

import { getProfileField } from '../db/profileDB';
import { getActiveMedications, getMedicalRecords } from '../db/medicalDB';
import { getTopFacts } from '../db/factDB';

const NAME_PATTERNS = [
  /what('?s| is) my name/i,
  /who am i/i,
  /do you know my name/i,
  /what do you call me/i,
];

const LOCATION_PATTERNS = [
  /where (am i|do i live|am i from|do i stay)/i,
  /what('?s| is) my (city|location|town|address)/i,
  /where('?s| is) home/i,
];

const PROFILE_PATTERNS = [
  /what do you know about me/i,
  /tell me about (my)?self/i,
  /what have i told you/i,
  /what do you remember/i,
  /tell me what you know/i,
  // Tier-2 memory-probe phrasings that previously fell through to the backend.
  // Broad self-knowledge probes — answered from the device profile/facts summary,
  // never the network (Spine §2).
  /how well do you know me/i,
  /what do you have on me/i,
  /what did i tell you/i,
  /what('?s| is) in my (memory|profile|history)/i,
  /remind me what you know/i,
  /what do you know about my life/i,
  /do you remember (me|what i (said|told))/i,
];

const MEDICATION_PATTERNS = [
  /what (medications?|meds?|pills?|prescriptions?) am i (on|taking)/i,
  /my (medications?|meds?|pills?|prescriptions?)/i,
  /what do i take/i,
  /what am i taking/i,
  /list my (meds?|medications?|pills?)/i,
  /am i (on|taking) any (medications?|meds?|pills?|prescriptions?)/i,
  /am i on any (medications?|meds?|pills?)/i,
  /do you have (any )?medication (listed |saved )?(for me)?/i,
  /are there any medications (you have |saved )?(for me)?/i,
  /do i take (any )?(medications?|meds?|pills?)/i,
  /what pills (am i|do i) take/i,
  /do you have any medical information (on|about|for) me/i,
  /what medical information do you have/i,
  /do you have my (medical|health) (information|history|records?)/i,
  /what('?s| is) my (medical|health) history/i,
];

const PERSONAL_FACT_PATTERNS = [
  /do you know (anything about me|who i am)/i,
  /what do you know about me/i,
  /what have you (saved|stored|remembered) (about me|for me)/i,
  /do you (have|know) (anything|something) (about me|personal)/i,
];

const MEDICAL_PATTERNS = [
  /my (doctors?|physician|provider)/i,
  /who is my doctor/i,
  /my medical (history|records?|visits?)/i,
  /when did i (see|visit) (my|the) doctor/i,
  /my last (visit|appointment|checkup)/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// City may have been written under any of these keys depending on path:
//   'city'           — set by upgradeLiveGreeting (setProfileField)
//   'confirmed_city' — imported verbatim from Railway by migration.ts
//   'location'       — older Railway profile shape
function getCity(): string | null {
  return (
    getProfileField('city') ||
    getProfileField('confirmed_city') ||
    getProfileField('location') ||
    null
  );
}

function formatMedication(m: { name: string; dosage?: string; frequency?: string }): string {
  let s = m.name;
  if (m.dosage) s += ` ${m.dosage}`;
  if (m.frequency) s += `, ${m.frequency}`;
  return s;
}

export function answerFromDevice(message: string): string | null {
  const msg = message.trim();

  // If the DB isn't ready, fall through to Railway rather than throw.
  let name: string | null;
  let city: string | null;
  try {
    name = getProfileField('name');
    city = getCity();
  } catch {
    return null;
  }

  // ── Name query ──────────────────────────────────────────────────────────────
  if (matchesAny(msg, NAME_PATTERNS)) {
    if (name) return `Your name is ${name}.`;
    return `I don't have your name saved yet. You can tell me and I'll remember it.`;
  }

  // ── Location query ──────────────────────────────────────────────────────────
  if (matchesAny(msg, LOCATION_PATTERNS)) {
    if (city) return `You're based in ${city}.`;
    return `I don't have your location saved yet.`;
  }

  // ── Profile summary ─────────────────────────────────────────────────────────
  if (matchesAny(msg, PROFILE_PATTERNS)) {
    const lines: string[] = [];
    if (name) lines.push(`Your name is ${name}.`);
    if (city) lines.push(`You're based in ${city}.`);
    let facts: ReturnType<typeof getTopFacts> = [];
    try { facts = getTopFacts(5); } catch {}
    if (facts.length > 0) {
      lines.push(`Here's what I remember about you:`);
      facts.forEach((f) => lines.push(`• ${f.fact}`));
    }
    if (lines.length === 0) {
      return `I'm still learning about you. The more we talk, the more I'll know.`;
    }
    return lines.join(' ');
  }

  // ── Medication query ────────────────────────────────────────────────────────
  if (matchesAny(msg, MEDICATION_PATTERNS)) {
    let meds: ReturnType<typeof getActiveMedications> = [];
    try { meds = getActiveMedications(); } catch {}
    if (meds.length === 0) {
      return `I don't have any medications saved for you yet. You can tell me what you're taking and I'll remember it.`;
    }
    const list = meds.map((m) => `• ${formatMedication(m)}`).join(' ');
    return `Here are the medications I have on file for you: ${list}`;
  }

  // ── Medical history query ───────────────────────────────────────────────────
  if (matchesAny(msg, MEDICAL_PATTERNS)) {
    let records: ReturnType<typeof getMedicalRecords> = [];
    try { records = getMedicalRecords(); } catch {}
    if (records.length === 0) {
      return `I don't have any medical visits saved yet.`;
    }
    const list = records
      .slice(0, 5)
      .map((r) => {
        const who = r.doctor_name || 'a visit';
        const when = r.visit_date ? ` on ${r.visit_date}` : '';
        const what = r.diagnosis || r.reason || r.notes || '';
        return `• ${who}${when}${what ? ` — ${what}` : ''}`;
      })
      .join(' ');
    return `Here's what I have in your medical history: ${list}`;
  }

  // ── Personal facts query ─────────────────────────────────────────────────────
  if (matchesAny(msg, PERSONAL_FACT_PATTERNS)) {
    const lines: string[] = [];
    if (name) lines.push(`Your name is ${name}.`);
    if (city) lines.push(`You're in ${city}.`);
    let facts: ReturnType<typeof getTopFacts> = [];
    try { facts = getTopFacts(8); } catch {}
    if (facts.length > 0) {
      lines.push(`Here's what I know about you:`);
      facts.forEach(f => lines.push(`• ${f.fact}`));
    }
    if (lines.length === 0) {
      return `I'm still learning about you. The more we talk, the more I'll know.`;
    }
    return lines.join(' ');
  }

  // ── No local answer -- send to Railway ─────────────────────────────────────
  return null;
}