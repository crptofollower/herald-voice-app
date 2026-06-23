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
export const SERVICE_SYNONYMS: Record<string, string[]> = {
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

export const LEGAL_TYPES = [
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

// Insurance is detected in two steps: (1) is this an insurance QUESTION at all,
// (2) optionally pull a type word ("home", "car"). We fire even with no type —
// real phrasings often omit it ("who's my insurance with", "who's my insurance").
const INSURANCE_READ_SIGNALS = [
  // typed: "who's my home insurance", "what's my car insurance with"
  /\b(who|what)('s| is| do)?\s+(i|we)?\s*(have|got)?\s*(my|our)\s+([\w\s]+?)\s+insurance\b/i,
  // typed with trailing "with": "who's my home insurance with"
  /\b(my|our)\s+([\w\s]+?)\s+insurance\b/i,
  // typeless: "who's my insurance with", "who's my insurance", "what insurance do i have"
  /\b(who|what)('s| is| do)?\s+(i|we)?\s*(have|got)?\s*(my|our)\s+insurance\b/i,
  /\bwho\s+do\s+(i|we)\s+have\s+insurance\s+with\b/i,
  /\bwhat\s+insurance\b/i,
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

  // Guard: this is the READ path. Statements ("my X is Y") are CAPTURE, handled
  // upstream. If the text looks like a statement assigning a value, never treat
  // it as a read — return null so it routes to capture / normal handling.
  // A read is a question; a statement contains "is/are/'s <value>" after the noun.
  const looksLikeStatement = /\bmy\s+[\w\s]+?\s+(?:is|are|'s)\s+\w+/i.test(text)
    && !/^\s*(who|what|where|when|which|do|does|did)\b/i.test(text.trim());
  if (looksLikeStatement) return null;

  // ── Legal (most specific — check first) ────────────────────────────────────
  if (LEGAL_READ_SIGNALS.some((p) => p.test(text))) {
    const docType = LEGAL_TYPES.find((t) => lower.includes(t));
    if (docType) {
      return { type: 'legal_document', categories: [docType], spoken: docType };
    }
  }

  // ── Insurance ──────────────────────────────────────────────────────────────
  if (/\binsurance\b/i.test(text) && INSURANCE_READ_SIGNALS.some((p) => p.test(text))) {
    // Try to pull a type word sitting directly before "insurance":
    // "my home insurance" → "home". "my insurance with" → no type (null).
    const m = lower.match(/(?:my|our)\s+([\w\s]+?)\s+insurance\b/);
    let spoken = m?.[1]?.trim() ?? '';
    // Guard: don't treat filler as a type. If the captured word is a stopword
    // (e.g. matched nothing meaningful), drop it and query all policies.
    const STOP = new Set(['', 'the', 'a', 'an', 'do', 'i', 'we', 'have', 'got']);
    const lastWord = spoken.split(/\s+/).pop() ?? '';
    if (STOP.has(lastWord)) spoken = '';
    const categories = spoken
      ? (INSURANCE_SYNONYMS[lastWord] ?? [lastWord])
      : []; // empty categories → answerHouseholdRead queries ALL policies
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
         WHERE category IN (${placeholders}) AND removed_at IS NULL
         ORDER BY updated_at DESC;`,
        intent.categories
      );
      if (rows.length === 0) {
        return `I don't have a ${intent.spoken} saved yet. Tell me who and I'll remember.`;
      }
      const r = rows.find((row) => row.name?.trim());
      if (!r) {
        return `I don't have a ${intent.spoken} saved yet. Tell me who and I'll remember.`;
      }
      const name = r.name.trim();
      const phone = r.phone?.trim();
      if (phone) {
        return `Your ${intent.spoken} is ${name} — you can reach them at ${formatPhone(phone)}.`;
      }
      return `Your ${intent.spoken} is ${name}.`;
    }

    if (intent.type === 'insurance') {
      type InsRow = { carrier: string; agent_name: string | null; agent_phone: string | null; type: string };
      let rows: InsRow[] = [];
      if (intent.categories.length > 0) {
        // Typed question ("home insurance") — query that type.
        const placeholders = intent.categories.map(() => '?').join(',');
        rows = db.getAllSync<InsRow>(
          `SELECT carrier, agent_name, agent_phone, type FROM insurance_policies
           WHERE type IN (${placeholders}) AND is_active = 1
           ORDER BY updated_at DESC;`,
          intent.categories
        );
      } else {
        // Typeless question ("who's my insurance with") — query ALL policies.
        rows = db.getAllSync<InsRow>(
          `SELECT carrier, agent_name, agent_phone, type FROM insurance_policies
           WHERE is_active = 1
           ORDER BY updated_at DESC;`,
          []
        );
      }

      if (rows.length === 0) {
        const what = intent.categories.length > 0 ? `${intent.spoken} insurance` : 'insurance';
        return `I don't have your ${what} saved yet. Tell me the carrier and I'll remember.`;
      }

      // Typeless with multiple policies → list them all by type.
      if (intent.categories.length === 0 && rows.length > 1) {
        const parts = rows
          .filter((row) => row.carrier?.trim())
          .map((row) => {
            const carrier = row.carrier.trim();
            return row.type ? `${carrier} for ${row.type}` : carrier;
          });
        if (parts.length === 0) {
          return `I don't have your insurance saved yet. Tell me the carrier and I'll remember.`;
        }
        return `You have ${joinNaturally(parts)}.`;
      }

      const r = rows.find((row) => row.carrier?.trim());
      if (!r) {
        const what = intent.categories.length > 0 ? `${intent.spoken} insurance` : 'insurance';
        return `I don't have your ${what} saved yet. Tell me the carrier and I'll remember.`;
      }
      const carrier = r.carrier.trim();
      // Use the stored type as the label when the question was typeless.
      const label = intent.categories.length > 0 ? intent.spoken : (r.type || '');
      const lead = label ? `Your ${label} insurance is ${carrier}` : `Your insurance is with ${carrier}`;
      const agentName = r.agent_name?.trim();
      const agentPhone = r.agent_phone?.trim();
      if (agentName && agentPhone) {
        return `${lead}. Your agent is ${agentName} — ${formatPhone(agentPhone)}.`;
      }
      if (agentName) {
        return `${lead}, and your agent is ${agentName}.`;
      }
      return `${lead}.`;
    }

    if (intent.type === 'legal_document') {
      const rows = db.getAllSync<{ location: string; type: string }>(
        `SELECT location, type FROM legal_documents
         WHERE type = ? AND removed_at IS NULL ORDER BY updated_at DESC;`,
        [intent.categories[0]]
      );
      if (rows.length === 0) {
        return `I don't have your ${intent.spoken} saved yet. Tell me where it is and I'll remember.`;
      }
      const row = rows.find((r) => r.location?.trim());
      if (!row) {
        return `I don't have your ${intent.spoken} saved yet. Tell me where it is and I'll remember.`;
      }
      return `Your ${intent.spoken} is with ${row.location.trim()}.`;
    }
  } catch {
    return `I couldn't pull that up right now. Try again in a moment.`;
  }

  return `I don't have that one saved yet.`;
}

// ─── joinNaturally ────────────────────────────────────────────────────────────
// ["A", "B", "C"] → "A, B, and C"  |  ["A", "B"] → "A and B"  |  ["A"] → "A"
function joinNaturally(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
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