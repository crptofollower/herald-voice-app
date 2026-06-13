// src/utils/householdCapture.ts
// Herald household memory capture — service providers, insurance, legal documents.
// Same pattern as captureMedicalEvent.ts — deterministic regex, no LLM involvement.
// Tables: service_providers, insurance_policies, legal_documents (schema v7)
// Called from ChatScreen before extractFactsLocally, same order rule as phone/address capture.

import { getDB } from '../db/schema';
import { generateId } from './id';
import { normalizePhone } from './phone';

export type HouseholdCaptureType = 'service_provider' | 'insurance' | 'legal_document';

export type HouseholdCaptureResult = {
  type: HouseholdCaptureType;
  captured: boolean;
  ack: string;
};

// ─── Service provider patterns ────────────────────────────────────────────────
// "my plumber is Joe, his number is 555-1234"
// "my electrician's name is Mike, 972-555-0100"
// "the guy who fixes my AC is Bob"
const SERVICE_PATTERNS = [
  /\bmy ([\w\s\-']+?)\s+is\s+([\w\s\-']+?)(?:[,.]?\s+(?:his|her|their)\s+(?:number|phone)\s+is\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
  /\bmy ([\w\s\-']+?)'?s?\s+name\s+is\s+([\w\s\-']+?)(?:[,.]?\s+([\d\s\-\(\)\+\.]{7,}))?[.!?]?$/i,
  /\bthe (?:guy|person|woman|man|lady)\s+(?:who\s+)?(?:fixes?|does?|handles?|takes?\s+care\s+of)\s+my\s+([\w\s\-']+?)\s+is\s+([\w\s]+)[.!?]?$/i,
];

const SERVICE_CATEGORIES = new Set([
  'plumber', 'electrician', 'hvac', 'ac', 'air conditioning', 'heating',
  'roofer', 'handyman', 'contractor', 'painter', 'landscaper', 'lawn',
  'pest control', 'exterminator', 'cleaner', 'housekeeper', 'pool',
  'mechanic', 'vet', 'veterinarian', 'dentist', 'doctor', 'cardiologist',
  'accountant', 'lawyer', 'attorney', 'financial advisor', 'insurance agent',
]);

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

// ─── writeServiceProvider ─────────────────────────────────────────────────────
function writeServiceProvider(category: string, name: string, phone?: string): string {
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

// ─── writeInsurancePolicy ─────────────────────────────────────────────────────
function writeInsurancePolicy(type: string, carrier: string, agentName?: string, agentPhone?: string): string {
  const db = getDB();
  const now = new Date().toISOString();
  const id = generateId('ins');
  try {
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

// ─── captureHousehold ─────────────────────────────────────────────────────────
// Main entry point — called from ChatScreen.
// Returns null if no household pattern matched (caller falls through normally).
// Returns HouseholdCaptureResult if matched — caller returns early with ack.

export function captureHousehold(text: string): HouseholdCaptureResult | null {

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
      const carrier = m[2]?.trim() ?? '';
      const agent = m[3]?.trim();
      const phoneCheck = m[4] ? normalizePhone(m[4]) : null;
      const phone = phoneCheck?.valid ? phoneCheck.normalized : undefined;
      const phoneSuspect = !!phoneCheck && !phoneCheck.valid && phoneCheck.issue !== 'empty';
      if (insType.length >= 2 && carrier.length >= 2) {
        writeInsurancePolicy(insType, carrier, agent, phone);
        const baseAck = agent
          ? `Got it — ${carrier} for your ${insType} insurance, ${agent} is the agent.`
          : `Got it — ${carrier} for your ${insType} insurance.`;
        return {
          type: 'insurance',
          captured: true,
          ack: phoneSuspect
            ? `${baseAck} I didn't catch the number clearly, though — you can tell me again anytime.`
            : baseAck,
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