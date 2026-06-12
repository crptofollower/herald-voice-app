// src/utils/householdRead.ts
// Herald household memory READ-BACK — the read twin of householdCapture.ts.
// Deterministic regex + SQL. No LLM. Answers "who's my plumber" style questions
// on-device, zero network, zero backend cost.
//
// Tables queried (schema v7, written by householdCapture.ts):
//   service_providers (category, name, phone)
//   insurance_policies (type, carrier, agent_name, agent_phone)
//   legal_documents   (type, location)
//
// HARD RULES (carry forward to Session W LLM era):
//   - Answer ONLY from real stored rows. Never fabricate a name, number, or fact.
//   - No match → honest-friend response ("I don't have a plumber saved yet").
//   - Synonym normalization matches the SPOKEN word to the STORED category.
//     Capture stores categories lowercased (see householdCapture SERVICE_CATEGORIES).
//   - TASK-based recall ("who fixed our tub") is Session W — service_records is
//     empty today. This file handles CATEGORY recall only (Type A).

import { getDB } from '../db/schema';

export type HouseholdReadType = 'service_provider' | 'insurance' | 'legal_document';

export interface HouseholdReadIntent {
  type: HouseholdReadType;
  // The normalized category/type values to query (already synonym-expanded).
  categories: string[];
  // The word the user actually said — used in the spoken response and the
  // honest-friend gap message ("I don't have a {spoken} saved yet").
  spoken: string;
}

// ─── Synonym map: SPOKEN word → STORED category values ────────────────────────
// Left side = how the user lazily talks. Right side = exact lowercased strings
// householdCapture.ts writes into service_providers.category.
// Each spoken key may expand to several stored categories (e.g. "ac" → hvac+ac+...).
const SERVICE_SYNONYMS: Record<string, string[]> = {
  // lawn / yard — user treats all outdoor work as one bucket:
  // grass, sprinklers, irrigation, flower beds, trees all map to lawn/landscaper.
  grass: ['lawn', 'landscaper'],
  yard: ['lawn', 'landscaper'],
  'yard work': ['lawn', 'landscaper'],
  mowing: ['lawn', 'landscaper'],
  mow: ['lawn', 'landscaper'],
  lawn: ['lawn', 'landscaper'],
  landscaper: ['lawn', 'landscaper'],
  landscaping: ['lawn', 'landscaper'],
  sprinkler: ['lawn', 'landscaper'],
  sprinklers: ['lawn', 'landscaper'],
  irrigation: ['lawn', 'landscaper'],
  'flower bed': ['lawn', 'landscaper'],
  'flower beds': ['lawn', 'landscaper'],
  flowerbed: ['lawn', 'landscaper'],
  flowerbeds: ['lawn', 'landscaper'],
  garden: ['lawn', 'landscaper'],
  gardener: ['lawn', 'landscaper'],
  tree: ['lawn', 'landscaper'],
  trees: ['lawn', 'landscaper'],
  'tree guy': ['lawn', 'landscaper'],
  // hvac / cooling / heating
  ac: ['hvac', 'ac', 'air conditioning'],
  'a/c': ['hvac', 'ac', 'air conditioning'],
  air: ['hvac', 'ac', 'air conditioning'],
  'air conditioning': ['hvac', 'ac', 'air conditioning'],
  hvac: ['hvac', 'ac', 'air conditioning', 'heating'],
  heat: ['hvac', 'heating'],
  heating: ['hvac', 'heating'],
  furnace: ['hvac', 'heating'],
  // plumbing
  plumber: ['plumber'],
  plumbing: ['plumber'],
  pipes: ['plumber'],
  // pest
  pest: ['pest control', 'exterminator'],
  'pest control': ['pest control', 'exterminator'],
  bugs: ['pest control', 'exterminator'],
  exterminator: ['pest control', 'exterminator'],
  // roof
  roof: ['roofer'],
  roofer: ['roofer'],
  roofing: ['roofer'],
  // auto
  car: ['mechanic'],
  auto: ['mechanic'],
  mechanic: ['mechanic'],
  // cleaning
  cleaner: ['cleaner', 'housekeeper'],
  cleaning: ['cleaner', 'housekeeper'],
  maid: ['cleaner', 'housekeeper'],
  housekeeper: ['cleaner', 'housekeeper'],
  // pool
  pool: ['pool'],
  // straight-through trades (spoken == stored)
  electrician: ['electrician'],
  handyman: ['handyman'],
  contractor: ['contractor'],
  painter: ['painter'],
  vet: ['vet', 'veterinarian'],
  veterinarian: ['vet', 'veterinarian'],
  dentist: ['dentist'],
  accountant: ['accountant'],
  lawyer: ['lawyer', 'attorney'],
  attorney: ['lawyer', 'attorney'],
};

// Insurance spoken → stored type
const INSURANCE_SYNONYMS: Record<string, string[]> = {
  home: ['home', 'homeowners', 'homeowner', 'house'],
  homeowners: ['home', 'homeowners', 'homeowner', 'house'],
  house: ['home', 'homeowners', 'homeowner', 'house'],
  car: ['car', 'auto', 'vehicle'],
  auto: ['car', 'auto', 'vehicle'],
  vehicle: ['car', 'auto', 'vehicle'],
  health: ['health', 'medical'],
  life: ['life'],
  dental: ['dental'],
  renters: ['renters', 'renter'],
};

const LEGAL_TYPES = [
  'will', 'power of attorney', 'living will', 'trust',
  'healthcare proxy', 'advance directive', 'deed',
];

// ─── Read-intent signals ──────────────────────────────────────────────────────
// These confirm the user is ASKING (not stating). Capture handles statements;
// this only fires on question shapes so we never hijack a capture sentence.
const SERVICE_READ_SIGNALS = [
  /\bwho('s| is| was)?\s+(my|our|the)\b/i,
  /\bwhat('s| is| was)?\s+the\s+(name|number|phone)\b/i,
  /\bwho\s+(did|does|cuts?|fixes?|handles?|takes?\s+care)\b/i,
  /\bwho\s+do\s+(i|we)\s+use\b/i,
  /\bdo\s+(i|we)\s+have\s+a\b/i,
  /\bnumber\s+for\s+(my|our|the)\b/i,
];

const INSURANCE_READ_SIGNALS = [
  /\bwho('s| is)?\s+(my|our)\s+([\w\s]+?)\s+insurance\b/i,
  /\bwhat('s| is)?\s+(my|our)\s+([\w\s]+?)\s+insurance\b/i,
  /\bwhat\s+insurance\b/i,
  /\b(my|our)\s+([\w\s]+?)\s+insurance\b/i,
];

const LEGAL_READ_SIGNALS = [
  /\bwhere('s| is)?\s+(my|our)\s+(will|power of attorney|living will|trust|healthcare proxy|advance directive|deed)\b/i,
  /\bwho\s+has\s+(my|our)\s+(will|power of attorney|living will|trust|healthcare proxy|advance directive|deed)\b/i,
];

// ─── detectHouseholdRead ──────────────────────────────────────────────────────
// Returns a read intent if the text is a household question we can answer from
// stored categories. Returns null if not a household read (caller falls through).
export function detectHouseholdRead(text: string): HouseholdReadIntent | null {
  const lower = text.toLowerCase();

  // ── Legal (most specific — check first) ────────────────────────────────────
  if (LEGAL_READ_SIGNALS.some((p) => p.test(text))) {
    const docType = LEGAL_TYPES.find((t) => lower.includes(t));
    if (docType) {
      return { type: 'legal_document', categories: [docType], spoken: docType };
    }
  }

  // ── Insurance ──────────────────────────────────────────────────────────────
  if (/\binsurance\b/i.test(text) && INSURANCE_READ_SIGNALS.some((p) => p.test(text))) {
    // Pull the word before "insurance": "my home insurance" → "home"
    const m = lower.match(/(?:my|our)\s+([\w\s]+?)\s+insurance/);
    const spoken = m?.[1]?.trim() ?? '';
    const lastWord = spoken.split(/\s+/).pop() ?? spoken;
    const categories = INSURANCE_SYNONYMS[lastWord] ?? (lastWord ? [lastWord] : []);
    // Even with an unknown type, fire — we'll honestly say what we have/don't.
    return { type: 'insurance', categories, spoken: spoken || 'insurance' };
  }

  // ── Service providers ──────────────────────────────────────────────────────
  if (SERVICE_READ_SIGNALS.some((p) => p.test(text))) {
    // Find any known spoken trade word present in the text.
    // Longest match first so "air conditioning" beats "air".
    const spokenKeys = Object.keys(SERVICE_SYNONYMS).sort((a, b) => b.length - a.length);
    for (const key of spokenKeys) {
      const re = new RegExp(`\\b${key.replace(/[/]/g, '\\$&')}\\b`, 'i');
      if (re.test(lower)) {
        return { type: 'service_provider', categories: SERVICE_SYNONYMS[key], spoken: key };
      }
    }
    // Signal matched but no known trade → not a household read we can answer.
    // Fall through (return null) so it routes normally.
  }

  return null;
}

// ─── answerHouseholdRead ──────────────────────────────────────────────────────
// Queries the real stored rows and returns a spoken answer string.
// Never fabricates — no row means the honest-friend gap message.
export function answerHouseholdRead(intent: HouseholdReadIntent): string {
  const db = getDB();

  try {
    if (intent.type === 'service_provider') {
      const placeholders = intent.categories.map(() => '?').join(',');
      const rows = db.getAllSync<{ name: string; phone: string | null; category: string }>(
        `SELECT name, phone, category FROM service_providers
         WHERE category IN (${placeholders})
         ORDER BY updated_at DESC;`,
        intent.categories
      );
      if (rows.length === 0) {
        return `I don't have a ${intent.spoken} saved yet. Tell me who and I'll remember.`;
      }
      const r = rows[0];
      if (r.phone) {
        return `Your ${intent.spoken} is ${r.name} — ${formatPhone(r.phone)}.`;
      }
      return `Your ${intent.spoken} is ${r.name}. I don't have a number for them yet — tell me and I'll remember.`;
    }

    if (intent.type === 'insurance') {
      let rows: Array<{ carrier: string; agent_name: string | null; agent_phone: string | null; type: string }> = [];
      if (intent.categories.length > 0) {
        const placeholders = intent.categories.map(() => '?').join(',');
        rows = db.getAllSync(
          `SELECT carrier, agent_name, agent_phone, type FROM insurance_policies
           WHERE type IN (${placeholders})
           ORDER BY updated_at DESC;`,
          intent.categories
        );
      }
      if (rows.length === 0) {
        return `I don't have your ${intent.spoken} insurance saved yet. Tell me the carrier and I'll remember.`;
      }
      const r = rows[0];
      if (r.agent_name && r.agent_phone) {
        return `Your ${intent.spoken} insurance is ${r.carrier}. Your agent is ${r.agent_name} — ${formatPhone(r.agent_phone)}.`;
      }
      if (r.agent_name) {
        return `Your ${intent.spoken} insurance is ${r.carrier}, and your agent is ${r.agent_name}.`;
      }
      return `Your ${intent.spoken} insurance is ${r.carrier}.`;
    }

    if (intent.type === 'legal_document') {
      const rows = db.getAllSync<{ location: string; type: string }>(
        `SELECT location, type FROM legal_documents WHERE type = ? ORDER BY updated_at DESC;`,
        [intent.categories[0]]
      );
      if (rows.length === 0) {
        return `I don't have your ${intent.spoken} saved yet. Tell me where it is and I'll remember.`;
      }
      return `Your ${intent.spoken} is with ${rows[0].location}.`;
    }
  } catch {
    return `I couldn't pull that up right now. Try again in a moment.`;
  }

  return `I don't have that one saved yet.`;
}

// ─── formatPhone ──────────────────────────────────────────────────────────────
// 10-digit → (xxx) xxx-xxxx for natural speech. Leaves other lengths as-is.
function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) {
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return raw;
}
