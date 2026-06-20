// src/utils/householdCapture.ts
// Herald household memory capture — service providers, insurance, legal documents.
// Same pattern as captureMedicalEvent.ts — deterministic regex, no LLM involvement.
// Tables: service_providers, insurance_policies, legal_documents (schema v7)
// Called from ChatScreen before extractFactsLocally, same order rule as phone/address capture.

import { getDB } from '../db/schema';
import { generateId } from './id';
import { normalizePhone } from './phone';
import { SERVICE_SYNONYMS, LEGAL_TYPES } from './householdRead';

export type HouseholdCaptureType = 'service_provider' | 'insurance' | 'legal_document';

export type HouseholdCaptureResult = {
  type: HouseholdCaptureType;
  captured: boolean;
  ack: string;
  pendingConfirm?: { type: string; carrier: string };
};

export type HouseholdNeedsLLM = {
  type: 'needs_llm';
  reason: 'supersession' | 'ambiguous';
};

// ─── Service provider patterns ────────────────────────────────────────────────
// "my plumber is Joe, his number is 555-1234"
// "my electrician's name is Mike, 972-555-0100"
// "the guy who fixes my AC is Bob"
const SERVICE_PATTERNS = [
  /\b(?:my|our)\s+([\w\s\-']+?)\s+is\s+([\w]+)(?:[,.]?\s+(?:his|her|their)\s+(?:phone\s+number|number|phone|cell)\s+is\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
  /\b(?:my|our)\s+([\w\s\-']+?)'?s?\s+name\s+is\s+([\w\s\-']+?)(?:[,.]?\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
  /\bthe (?:guy|person|woman|man|lady)\s+(?:who\s+)?(?:fixes?|does?|handles?|takes?\s+care\s+of)\s+(?:my|our)\s+([\w\s\-']+?)\s+is\s+([\w\s]+)[.!?]?$/i,
  /\b(?:my|our)\s+(plumber|electrician|hvac|mechanic|roofer|handyman|contractor|painter|landscaper|cleaner|accountant|lawyer|attorney|vet|dentist|doctor|pool)\s+([\w]+)(?:[,.]?\s+(?:his|her|their)\s+(?:phone\s+number|number|phone|cell)\s+is\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
];

const SERVICE_CATEGORIES = new Set([
  'plumber', 'electrician', 'hvac', 'ac', 'air conditioning', 'heating',
  'roofer', 'handyman', 'contractor', 'painter', 'landscaper', 'lawn',
  'pest control', 'exterminator', 'cleaner', 'housekeeper', 'pool',
  'mechanic', 'vet', 'veterinarian', 'dentist', 'doctor', 'cardiologist',
  'accountant', 'lawyer', 'attorney', 'financial advisor', 'insurance agent',
]);

// ─── Service provider removal patterns ────────────────────────────────────────
// "remove my plumber", "delete my electrician", "I don't have a plumber anymore",
// "I no longer use my landscaper". Checked BEFORE the add patterns so a removal
// sentence is never mis-read as a new service-provider statement.
const SERVICE_REMOVE_PATTERNS = [
  /\b(?:remove|delete|clear)\s+(?:my|our)\s+([\w\s\-']+?)[.!?]?$/i,
  /\bi\s+(?:don'?t|do not)\s+have\s+(?:a|an|my|our)?\s*([\w\s\-']+?)\s+anymore[.!?]?$/i,
  /\bi\s+(?:no longer|don'?t)\s+use\s+(?:my|our)\s+([\w\s\-']+?)[.!?]?$/i,
];

// Resolves what the user said to the stored category values, reusing the same
// synonym map householdRead.ts already uses for reads — one source of truth,
// so "remove my AC guy" clears the same rows "who's my AC guy" would find.
function resolveSpokenCategory(spoken: string): string[] | null {
  const lower = spoken.trim().toLowerCase();
  if (SERVICE_SYNONYMS[lower]) return SERVICE_SYNONYMS[lower];
  if (SERVICE_CATEGORIES.has(lower)) return [lower];
  const spokenKeys = Object.keys(SERVICE_SYNONYMS).sort((a, b) => b.length - a.length);
  for (const key of spokenKeys) {
    const re = new RegExp(`\\b${key.replace(/[/]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return SERVICE_SYNONYMS[key];
  }
  return null;
}

// ─── Insurance patterns ───────────────────────────────────────────────────────
// "my home insurance is State Farm, agent is Karen, 800-555-0100"
// "my car insurance carrier is Allstate"
// "my health insurance is Blue Cross"
const INSURANCE_PATTERNS = [
  /\bmy ([\w\s]+?)\s+insurance\s+(?:is|carrier\s+is|company\s+is|provider\s+is)\s+([\w\s\-']+?)(?:[,.]?\s+(?:agent\s+is\s+([\w\s]+?))?(?:[,.]?\s+([\d\s\-\(\)\+\.]{7,}))?)?[.!?]?$/i,
  /\bmy ([\w\s]+?)\s+(?:insurance\s+)?(?:policy|plan)\s+is\s+(?:with\s+)?([\w\s\-']+?)[.!?]?$/i,
];

// ─── Legal document patterns ──────────────────────────────────────────────────
// "my will is with my attorney Karen Smith"
// "my power of attorney is at the bank"
// "my living will is in the safe"
const LEGAL_PATTERNS = [
  /\bmy (will|power of attorney|living will|trust|healthcare proxy|advance directive|deed)\s+is\s+(?:with\s+|at\s+|in\s+)?([\w\s\-',]+?)[.!?]?$/i,
];

// ─── Carrier name normalization (STT mishearing correction) ──────────────────
// Deterministic alias table for known major carriers STT commonly mis-hears.
// Lookup only — NEVER invents a carrier not on this list; unmatched input
// passes through unchanged. This runs BEFORE the existing confirm gate, so
// the user always hears the corrected name read back and can say no.
// Extend this list as real mishearings surface in use — it will never be complete.
const CARRIER_ALIASES: Record<string, string> = {
  'all state': 'Allstate', 'allstate': 'Allstate',
  'state farm': 'State Farm', 'statefarm': 'State Farm',
  'geico': 'GEICO', 'gyco': 'GEICO', 'gecko': 'GEICO',
  'progressive': 'Progressive',
  'liberty mutual': 'Liberty Mutual', 'liberty mutal': 'Liberty Mutual',
  'farmers': 'Farmers', 'farmers insurance': 'Farmers',
  'nationwide': 'Nationwide',
  'usaa': 'USAA', 'u.s.a.a': 'USAA',
  'travelers': 'Travelers',
  'american family': 'American Family', 'amfam': 'American Family', 'am fam': 'American Family',
  'erie': 'Erie', 'erie insurance': 'Erie',
  'metlife': 'MetLife', 'met life': 'MetLife',
  'safeco': 'Safeco', 'safe co': 'Safeco',
  'auto owners': 'Auto-Owners', 'auto-owners': 'Auto-Owners',
  'chubb': 'Chubb',
  'hartford': 'The Hartford', 'the hartford': 'The Hartford',
  'mutual of omaha': 'Mutual of Omaha',
  'blue cross': 'Blue Cross Blue Shield', 'blue cross blue shield': 'Blue Cross Blue Shield', 'blue shield': 'Blue Cross Blue Shield',
  'aetna': 'Aetna', 'cigna': 'Cigna', 'humana': 'Humana',
  'united healthcare': 'UnitedHealthcare', 'united health care': 'UnitedHealthcare', 'unitedhealthcare': 'UnitedHealthcare',
  'kaiser': 'Kaiser Permanente', 'kaiser permanente': 'Kaiser Permanente',
};

function normalizeCarrier(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return CARRIER_ALIASES[key] ?? raw.trim();
}

// ─── writeServiceProvider ─────────────────────────────────────────────────────
export function writeServiceProvider(category: string, name: string, phone?: string): string {
  const db = getDB();
  const now = new Date().toISOString();
  const id = generateId('sp');
  try {
    db.runSync(
      `INSERT OR REPLACE INTO service_providers
         (id, name, phone, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, name.trim(), phone ?? null, category.trim().toLowerCase(), now, now]
    );
    return id;
  } catch {
    return '';
  }
}

// ─── removeServiceProvider ─────────────────────────────────────────────────────
// Soft-delete only — stamps removed_at, never a hard DELETE (CLAUDE.md).
// Clears EVERY active row in the matched category set, not just the newest,
// since writeServiceProvider can leave duplicate rows behind (fresh id each
// write) — clearing only the top row would let a stale duplicate resurface.
export function removeServiceProvider(categories: string[]): number {
  const db = getDB();
  const now = new Date().toISOString();
  const placeholders = categories.map(() => '?').join(',');
  try {
    const result = db.runSync(
      `UPDATE service_providers SET removed_at = ?
       WHERE category IN (${placeholders}) AND removed_at IS NULL;`,
      [now, ...categories]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── removeLegalDocument ───────────────────────────────────────────────────────
// Soft-delete only — same shape as removeServiceProvider. Clears EVERY active
// row of this type, not just the newest (writeLegalDocument leaves a fresh id
// each write, so duplicates by type are possible — write-side dedup is a
// separate banked item, not part of this change).
export function removeLegalDocument(docType: string): number {
  const db = getDB();
  const now = new Date().toISOString();
  try {
    const result = db.runSync(
      `UPDATE legal_documents SET removed_at = ?
       WHERE type = ? AND removed_at IS NULL;`,
      [now, docType.trim().toLowerCase()]
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
}

// ─── writeInsurancePolicy ─────────────────────────────────────────────────────
function writeInsurancePolicy(type: string, carrier: string, agentName?: string, agentPhone?: string): string {
  const db = getDB();
  const now = new Date().toISOString();
  const id = generateId('ins');
  try {
    // Retire any existing active policy of the same type before inserting
    db.runSync(
      `UPDATE insurance_policies SET is_active = 0, updated_at = ? WHERE LOWER(type) = LOWER(?) AND is_active = 1;`,
      [now, type.trim().toLowerCase()]
    );
    db.runSync(
      `INSERT OR REPLACE INTO insurance_policies
         (id, type, carrier, agent_name, agent_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [id, type.trim().toLowerCase(), carrier.trim(), agentName ?? null, agentPhone ?? null, now, now]
    );
    return id;
  } catch {
    return '';
  }
}

// ─── writeLegalDocument ───────────────────────────────────────────────────────
function writeLegalDocument(type: string, location: string): string {
  const db = getDB();
  const now = new Date().toISOString();
  const id = generateId('leg');
  try {
    db.runSync(
      `INSERT OR REPLACE INTO legal_documents
         (id, type, location, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?);`,
      [id, type.trim().toLowerCase(), location.trim(), now, now]
    );
    return id;
  } catch {
    return '';
  }
}

// ─── captureHouseholdInsurance ────────────────────────────────────────────────
// Confirmed write path — called from ChatScreen after user says yes.
export function captureHouseholdInsurance(type: string, carrier: string): string {
  return writeInsurancePolicy(type, carrier);
}

// ─── captureHousehold ─────────────────────────────────────────────────────────
// Main entry point — called from ChatScreen.
// Returns null if no household pattern matched (caller falls through normally).
// Returns HouseholdCaptureResult if matched — caller returns early with ack.

export function captureHousehold(text: string): HouseholdCaptureResult | HouseholdNeedsLLM | null {

  // Guard: never capture from list/calendar/profile read questions.
  // These look like statements but are actually read intents — "tell me my grocery list"
  // can match service provider patterns ("my grocery" = category, "list" = name).
  const READ_GUARD = /\b(what('s| is| are)|tell (me )?my|show (me )?my|read (me )?my|what do i have|do i have|who('s| is)|where('s| is))\b/i;
  if (READ_GUARD.test(text)) return null;

  // Guard: "remove X replace with Y" is an insurance update — route to LLM classifier.
  // captureHousehold can't handle supersession, so let it fall through to classifyWithLLM.
  const REPLACE_GUARD = /\b(remove|replace|switch|change|update)\b.{1,60}\b(replace|with|to)\b/i;
  if (REPLACE_GUARD.test(text)) return { type: 'needs_llm', reason: 'supersession' };

  // ── Legal document removal — checked BEFORE service removal. Matches an
  // explicit LEGAL_TYPES word only (never a generic captured phrase), so it
  // can't mis-fire, and it must run first so "remove my power of attorney"
  // doesn't get caught by the SERVICE_SYNONYMS "attorney" → lawyer/attorney entry.
  const LEGAL_REMOVE_PATTERNS = [
    new RegExp(`\\b(?:remove|delete|clear)\\s+(?:my|our)\\s+(${LEGAL_TYPES.join('|')})\\b`, 'i'),
    new RegExp(`\\bi\\s+(?:don'?t|do not)\\s+have\\s+(?:a|an|my|our)?\\s*(${LEGAL_TYPES.join('|')})\\s+anymore\\b`, 'i'),
  ];
  for (const pattern of LEGAL_REMOVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const docType = m[1].trim().toLowerCase();
      const changed = removeLegalDocument(docType);
      if (changed > 0) {
        return {
          type: 'legal_document',
          captured: true,
          ack: `Got it — I'll stop keeping your ${docType} location.`,
        };
      }
      return {
        type: 'legal_document',
        captured: false,
        ack: `I don't have a ${docType} saved to remove.`,
      };
    }
  }

  // ── Service provider removal — checked before ADD patterns ─────────────────
  for (const pattern of SERVICE_REMOVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const spoken = m[1]?.trim().toLowerCase() ?? '';
      const categories = resolveSpokenCategory(spoken);
      if (categories) {
        const changed = removeServiceProvider(categories);
        if (changed > 0) {
          return {
            type: 'service_provider',
            captured: true,
            ack: `Got it — I'll stop keeping a ${spoken} for you.`,
          };
        }
        return {
          type: 'service_provider',
          captured: false,
          ack: `I don't have a ${spoken} saved to remove.`,
        };
      }
    }
  }

  // ── Legal documents (check first — most specific patterns) ─────────────────
  for (const pattern of LEGAL_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const docType = m[1].trim().toLowerCase();
      const location = m[2]?.trim() ?? '';
      if (location.length >= 2) {
        writeLegalDocument(docType, location);
        return {
          type: 'legal_document',
          captured: true,
          ack: `Got it — I'll remember your ${docType} is with ${location}.`,
        };
      }
    }
  }

  // ── Insurance ──────────────────────────────────────────────────────────────
  for (const pattern of INSURANCE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const insType = m[1]?.trim().toLowerCase() ?? '';
      const carrierRaw = (m[2]?.trim() ?? '').replace(/^with\s+/i, '').split(/\s+and\s+/i)[0].trim();
      const carrier = normalizeCarrier(carrierRaw);
      const agent = m[3]?.trim();
      const phoneCheck = m[4] ? normalizePhone(m[4]) : null;
      const phone = phoneCheck?.valid ? phoneCheck.normalized : undefined;
      const phoneSuspect = !!phoneCheck && !phoneCheck.valid && phoneCheck.issue !== 'empty';
      if (insType.length >= 2 && carrier.length >= 2) {
        // Don't write yet — confirm first
        // Return a special result that ChatScreen uses to set pendingInsuranceRef
        return {
          type: 'insurance',
          captured: false,
          pendingConfirm: { type: insType, carrier },
          ack: `Got it — ${carrier} for your ${insType} insurance, right?`,
        };
      }
    }
  }

  // ── Service providers (broadest — check last) ──────────────────────────────
  for (const pattern of SERVICE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const category = m[1]?.trim().toLowerCase() ?? '';
      const name = m[2]?.trim() ?? '';
      const phoneCheck = m[3] ? normalizePhone(m[3]) : null;
      const phone = phoneCheck?.valid ? phoneCheck.normalized : undefined;
      const phoneSuspect = !!phoneCheck && !phoneCheck.valid && phoneCheck.issue !== 'empty';
      if (SERVICE_CATEGORIES.has(category) && name.length >= 2) {
        writeServiceProvider(category, name, phone);
        return {
          type: 'service_provider',
          captured: true,
          ack: phone
            ? `Got it — ${name} is your ${category}, number saved as ${phoneCheck!.spoken}.`
            : phoneSuspect
              ? `Got it — ${name} is your ${category}. That number didn't sound complete, though — say "${name}'s number is ..." and I'll add it.`
              : `Got it — ${name} is your ${category}.`,
        };
      }
    }
  }

  return null;
}