// src/utils/householdCapture.ts
// Herald household memory capture — service providers, insurance, legal documents.
// Same pattern as captureMedicalEvent.ts — deterministic regex, no LLM involvement.
// Tables: service_providers, insurance_policies, legal_documents (schema v7)
// Called from ChatScreen before extractFactsLocally, same order rule as phone/address capture.

import { getDB } from '../db/schema';
import { generateId } from './id';
import { normalizePhone } from './phone';
import { SERVICE_SYNONYMS, LEGAL_TYPES } from './householdRead';
import type { IntentRecord } from '../hooks/llmLayers';

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

export type HouseholdNeedsName = {
  type: 'needs_name';
  category: string;
  phone: string;
  ack: string;
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
  const cat = category.trim().toLowerCase();
  try {
    // Retire any existing active provider in this category before inserting, so a
    // changed provider supersedes rather than accumulating duplicate active rows.
    // Mirrors writeInsurancePolicy's retire-by-type. [SPINE §4a one-writer, §6 current≠historical]
    // Validate phone before write — never store an unvalidated string (Spine §3).
    // normalizePhone is already imported. Invalid phone → null (silently dropped).
    // Defense-in-depth: the capture path's phoneSuspect guard catches bad numbers
    // before reaching here; this protects future direct callers.
    let validPhone: string | null = null;
    if (phone) {
      const check = normalizePhone(phone);
      validPhone = check.valid ? check.normalized : null;
    }
    db.runSync(
      `UPDATE service_providers SET removed_at = ?
         WHERE category = ? AND removed_at IS NULL;`,
      [now, cat]
    );
    db.runSync(
      `INSERT OR REPLACE INTO service_providers
         (id, name, phone, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [id, name.trim(), validPhone, cat, now, now]
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

export function captureHousehold(text: string): HouseholdCaptureResult | HouseholdNeedsLLM | HouseholdNeedsName | null {

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
        const legId = writeLegalDocument(docType, location);
        if (!legId) {
          return {
            type: 'legal_document',
            captured: false,
            ack: `Hmm — I couldn't hold onto that just now. Mind telling me once more?`,
          };
        }
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
      if (phoneSuspect) {
        return {
          type: 'needs_name',
          category,
          phone: '',
          ack: `I didn't catch that number clearly — can you say it again?`,
        };
      }
      // If we have a phone but no real name, don't write a nameless row.
      // Ask for the name instead — the caller will set a pendingResumeRef.
      const PLACEHOLDER_NAMES = new Set([
        'unknown','unnamed','none','n/a','someone','somebody',
        'that','this','it','he','she','they','him','her','them',
      ]);
      const nameIsReal = (n: string | null | undefined): boolean => {
        if (!n) return false;
        const t = n.trim();
        return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
      };

      if (!nameIsReal(name) && phone) {
        // Phone present, name missing — return a needs_name signal.
        // ChatScreen will ask "Who's your [category] at [phone]?" and resume.
        return {
          type: 'needs_name',
          category,          // the service role (plumber, hvac, etc.)
          phone,             // the phone number that was captured
          ack: `Who's your ${category} at ${phone}?`,
        };
      }
      // Service-provider CAPTURE is owned by the routing authority (service_capture.add),
      // not this island. Fall through so the authority is the single writer. [Spine §4a]
      if (SERVICE_CATEGORIES.has(category) && name.length >= 2) {
        return null;
      }
    }
  }

  return null;
}

// Pure detector for the routing authority's deterministic capture floor (spec §2.3 step 3).
// No DB write, no ACK — emits IntentRecord[] only. The DOMAIN_WRITERS.service_capture
// writer owns the commit + the missing-name pending flow. Reuses the SAME patterns/
// synonym resolver the reads and removes use (one source of truth, §4a). Emits the
// CANONICAL category head so the stored value aligns with read/remove resolution.
export function detectServiceCapture(text: string): IntentRecord[] {
  // Same guards captureHousehold applies: never fire on a read question or a
  // supersession ("remove X replace with Y" → LLM's job, defer).
  const READ_GUARD = /\b(what('s| is| are)|tell (me )?my|show (me )?my|read (me )?my|what do i have|do i have|who('s| is)|where('s| is))\b/i;
  if (READ_GUARD.test(text)) return [];
  const REPLACE_GUARD = /\b(remove|replace|switch|change|update)\b.{1,60}\b(replace|with|to)\b/i;
  if (REPLACE_GUARD.test(text)) return [];

  for (const pattern of SERVICE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const spoken = m[1]?.trim().toLowerCase() ?? '';
    const resolved = resolveSpokenCategory(spoken);
    if (!resolved || resolved.length === 0) continue; // not a service category → defer (LLM/backend)
    const category = resolved[0];                      // canonical head — aligns writes with reads
    const name = m[2]?.trim() ?? '';                   // '' is fine — writer asks for the name
    const phoneCheck = m[3] ? normalizePhone(m[3]) : null;
    const phone = phoneCheck?.valid ? phoneCheck.normalized : undefined;
    return [{ type: 'service_capture', category, name, phone }];
  }
  return [];
}

// Pure detector for contact phone captures — not service providers.
// No DB write, no ACK. Reuses normalizePhone + the same name guard as captureHousehold.
export function detectPhoneCapture(text: string, _contacts?: string[]): IntentRecord[] {
  const SERVICE_ROLE_GUARD =
    /\b(my|our)\s+(plumber|electrician|hvac|mechanic|roofer|handyman|contractor|painter|landscaper|cleaner|vet|dentist|doctor|pool)\b/i;
  if (SERVICE_ROLE_GUARD.test(text)) return [];

  // Possessive name + phone keyword — always a contact capture, never a service provider.
  // "My sister Linda's cell is 469-505-0213" must not be blocked by SERVICE_PATTERNS.
  const POSSESSIVE_PHONE = /\b(?:my|our)\s+(?:\w+\s+)?([\w]+)'s\s+(?:phone|cell|mobile|number)/i;
  if (!POSSESSIVE_PHONE.test(text)) {
    for (const pattern of SERVICE_PATTERNS) {
      if (pattern.test(text)) return [];
    }
  }

  const PLACEHOLDER_NAMES = new Set([
    'unknown', 'unnamed', 'none', 'n/a', 'someone', 'somebody',
    'that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them',
  ]);
  const isRealName = (n: string | null | undefined): boolean => {
    if (!n) return false;
    const t = n.trim();
    return t.length >= 2 && !PLACEHOLDER_NAMES.has(t.toLowerCase());
  };

  const PHONE_CAPTURE_PATTERNS = [
    /\b([\w]+)'s\s+(?:(?:phone|cell|mobile)\s+)?numbers?\s+(?:is\s+)?([\d\s\-\(\)\+\.]{7,})/i,
    /\b([\w]+)'s\s+(?:phone|cell|mobile)\s+(?:is\s+)?([\d\s\-\(\)\+\.]{7,})/i,
    /\bcall\s+([\w\s\-']+?)\s+at\s+([\d\s\-\(\)\+\.]{7,})/i,
    /\bmy\s+(?:\w+\s+)([\w\-']+)\s+([\d\s\-\(\)\+\.]{7,})/i,
  ];

  for (const pattern of PHONE_CAPTURE_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;
    const name = m[1]?.trim() ?? '';
    const phoneCheck = normalizePhone(m[2] ?? '');
    if (!isRealName(name) || !phoneCheck.valid) continue;
    return [{ type: 'phone_capture', name, phone: phoneCheck.normalized }];
  }
  return [];
}

// ─── detectServiceRemove ───────────────────────────────────────────────────────
// Deterministic service-provider remove detector. Called by tierRouter so
// removal utterances ("delete my plumber", "remove my electrician") are
// classified as tier-1 device_actions BEFORE the LLM classifier sees them.
// Reuses SERVICE_REMOVE_PATTERNS + resolveSpokenCategory — one algorithm,
// one source of truth for detection. Legal removes are NOT handled here;
// they stay in captureHousehold's own branch.
// Returns null if the text is not a service-provider removal utterance.
export function detectServiceRemove(
  text: string,
): { categories: string[]; spoken: string } | null {
  for (const pattern of SERVICE_REMOVE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const spoken = m[1]?.trim().toLowerCase() ?? '';
      const categories = resolveSpokenCategory(spoken);
      if (categories) return { categories, spoken };
    }
  }
  return null;
}