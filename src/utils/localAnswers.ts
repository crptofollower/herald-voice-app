import { getLocalProfile, getLocalMedical, getTopLocalMemories } from '../hooks/useDeviceMemory';

// ─── Personal query interceptor ───────────────────────────────────────────────
// Checks if a message can be answered from device SQLite instantly.
// Returns an answer string if yes, null if the query should go to Railway.
// Zero network. Zero OpenRouter cost. Under 200ms.

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
];

const MEDICATION_PATTERNS = [
  /what (medications?|meds?|pills?|prescriptions?) am i (on|taking)/i,
  /my (medications?|meds?|pills?|prescriptions?)/i,
  /what do i take/i,
  /what am i taking/i,
  /list my (meds?|medications?|pills?)/i,
];

const MEDICAL_PATTERNS = [
  /my (doctors?|physician|provider)/i,
  /who is my doctor/i,
  /my medical (history|records?|visits?)/i,
  /when did i (see|visit) (my|the) doctor/i,
  /my last (visit|appointment|checkup)/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

export function answerFromDevice(message: string): string | null {
  const msg = message.trim();
  const profile = getLocalProfile();
  const name = profile.name || null;
  const aiName = profile.ai_name || "Herald";
  const city = profile.confirmed_city || profile.location || null;

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
    const memories = getTopLocalMemories(5);
    if (memories.length > 0) {
      lines.push(`Here's what I remember about you:`);
      memories.forEach(m => lines.push(`• ${m.summary}`));
    }
    if (lines.length === 0) {
      return `I'm still learning about you. The more we talk, the more I'll know.`;
    }
    return lines.join(' ');
  }

  // ── Medication query ────────────────────────────────────────────────────────
  if (matchesAny(msg, MEDICATION_PATTERNS)) {
    const meds = getLocalMedical('medication');
    if (meds.length === 0) {
      return `I don't have any medications saved for you yet. You can tell me what you're taking and I'll remember it.`;
    }
    const list = meds.map(m => `• ${m.summary}`).join(' ');
    return `Here are the medications I have on file for you: ${list}`;
  }

  // ── Medical history query ───────────────────────────────────────────────────
  if (matchesAny(msg, MEDICAL_PATTERNS)) {
    const visits = getLocalMedical('visit');
    const followups = getLocalMedical('followup');
    const all = [...visits, ...followups];
    if (all.length === 0) {
      return `I don't have any medical visits saved yet.`;
    }
    const list = all.slice(0, 5).map(m => `• ${m.summary}`).join(' ');
    return `Here's what I have in your medical history: ${list}`;
  }

  // ── No local answer -- send to Railway ─────────────────────────────────────
  return null;
}
